// Bilgisayar durumu yardımcısı (features/durum.js başlatır; yalnızca durum paneli açıkken ya da bir izleyici varken çalışır).
// PowerShell/WMI'yı her saniye çalıştırmak pahalı olduğu için ölçümler doğrudan Windows API'siyle yapılır:
//   CPU: GetSystemTimes · RAM: GlobalMemoryStatusEx · pil: GetSystemPowerStatus · süreçler: NtQuerySystemInformation
//   GPU: NVIDIA sürücüsünün nvml.dll'i (yoksa gizlenir) · ağ: NetworkInterface · disk: DriveInfo
//   CPU sıcaklığı: WMI MSAcpi_ThermalZoneTemperature — genelde yönetici ister; izin yoksa "ölçülemiyor" (izin İSTENMEZ).
// Kullanım: Durum.exe <sunucu pid>   (sunucunun kendi süreç ağacı ve konsol penceresini taşıyan süreç "biz" diye işaretlenir, kapatılamaz)
// stdout: her saniye bir satır JSON (yalnızca ASCII): {"t":"olcum", cpu, ramKul, ramTop, uptime, ag, pil, gpu, diskler, cpuSic, cpuSicNeden, surecler, oz}
// stdin komutları (her biri tek satır cevap):
//   ayrinti 0|1          süreç listesi + GPU ölçülsün mü (yalnızca panel açıkken 1; izleyiciler için 0 yeter)
//   bilgi <pid>          -> {"t":"bilgi","pid":..,"var":true,"ad":"..","ct":"..","biz":false}
//   kapat <pid> <ct>     -> pencerelerine WM_CLOSE (CloseMainWindow gibi, nazik) {"t":"kapat","ok":..,"pencere":<adet>,"msg":..}
//   zorla <pid> <ct>     -> TerminateProcess {"t":"zorla","ok":..,"msg":..}
//   ct: sürecin başlama zamanı (FILETIME). Eşleşmezse (PID başka sürece geçtiyse) hiçbir şey yapılmaz. "0" = denetleme.
// stdin kapanınca çıkar.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Durum
{
    // ---------- Windows API ----------
    [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr LoadLibrary(string path);
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();

    [StructLayout(LayoutKind.Sequential)]
    class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX m);

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_POWER_STATUS { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public int BatteryLifeTime, BatteryFullLifeTime; }
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);

    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    // NVML (NVIDIA sürücüsüyle gelir)
    [StructLayout(LayoutKind.Sequential)] struct NvUtil { public uint gpu, memory; }
    [StructLayout(LayoutKind.Sequential)] struct NvMem { public ulong total, free, used; }
    [DllImport("nvml.dll")] static extern int nvmlInit_v2();
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetCount_v2(out uint n);
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetHandleByIndex_v2(uint i, out IntPtr d);
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetName(IntPtr d, byte[] name, uint len);
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetUtilizationRates(IntPtr d, out NvUtil u);
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetTemperature(IntPtr d, int sensor, out uint t);
    [DllImport("nvml.dll")] static extern int nvmlDeviceGetMemoryInfo(IntPtr d, out NvMem m);

    // ---------- Durum ----------
    static readonly object kilit = new object();
    static Stream cikis;
    static int sunucuPid;
    static List<long[]> konsol = new List<long[]>(); // sunucunun konsolunu taşıyan süreçler: { pid, ct }
    static volatile bool ayrinti = false;
    static readonly int cekirdek = Environment.ProcessorCount;

    class Surec { public int pid, ppid; public string ad; public long ct, zaman, ram; }
    static Dictionary<int, Surec> anlik = new Dictionary<int, Surec>();
    static Dictionary<int, long[]> oncekiZaman = new Dictionary<int, long[]>(); // pid -> { ct, cpu zamanı }
    static IntPtr tampon = IntPtr.Zero;
    static int tamponBoyu = 0;

    static int Main(string[] args)
    {
        cikis = Console.OpenStandardOutput();
        var giris = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        if (args.Length > 0) int.TryParse(args[0], out sunucuPid);
        if (IntPtr.Size != 8) { Yaz("{\"t\":\"error\",\"msg\":\"64 bit gerekli\"}"); return 1; }
        try { KonsolBul(); } catch { /* konsolsuz (ör. tepsiden başlatıldı) */ }
        var olcer = new Thread(OlcumDongusu) { IsBackground = true };
        olcer.Start();
        new Thread(SicaklikDongusu) { IsBackground = true }.Start();
        string satir;
        while ((satir = giris.ReadLine()) != null)
        {
            try { Komut(satir.Trim()); }
            catch (Exception e) { Yaz("{\"t\":\"error\",\"msg\":" + Json(e.Message) + "}"); }
        }
        return 0;
    }

    static void Komut(string satir)
    {
        var p = satir.Split(' ');
        if (p[0] == "ayrinti" && p.Length == 2) { ayrinti = p[1] == "1"; return; }
        int pid;
        if (p.Length < 2 || !int.TryParse(p[1], out pid)) { Yaz("{\"t\":\"error\",\"msg\":\"bilinmeyen komut\"}"); return; }
        long ct = 0;
        if (p.Length > 2 && !long.TryParse(p[2], out ct)) ct = -1;
        Dictionary<int, Surec> s;
        lock (kilit) s = Anlik();
        Surec x;
        bool var = s.TryGetValue(pid, out x) && pid > 4;
        if (p[0] == "bilgi")
        {
            if (!var) { Yaz("{\"t\":\"bilgi\",\"pid\":" + pid + ",\"var\":false}"); return; }
            Yaz("{\"t\":\"bilgi\",\"pid\":" + pid + ",\"var\":true,\"ad\":" + Json(x.ad) + ",\"ct\":\"" + x.ct + "\",\"biz\":" + (Biz(s).Contains(pid) ? "true" : "false") + "}");
            return;
        }
        if (p[0] != "kapat" && p[0] != "zorla") { Yaz("{\"t\":\"error\",\"msg\":\"bilinmeyen komut\"}"); return; }
        string t = p[0];
        if (!var || (ct != 0 && ct != x.ct)) { Yaz("{\"t\":\"" + t + "\",\"ok\":false,\"msg\":\"Program zaten kapanmış.\"}"); return; }
        if (Biz(s).Contains(pid)) { Yaz("{\"t\":\"" + t + "\",\"ok\":false,\"msg\":\"Uzaktan Bağlantı'nın kendi süreci.\"}"); return; }
        if (t == "kapat")
        {
            // Process.CloseMainWindow'un yaptığı gibi: görünür üst düzey pencerelerine WM_CLOSE (kaydetmek isteyen program sorabilir).
            int adet = 0, hata = 0;
            foreach (var h in Pencereler(pid)) { if (PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) adet++; else hata++; }
            if (adet > 0) Yaz("{\"t\":\"kapat\",\"ok\":true,\"pencere\":" + adet + "}");
            else Yaz("{\"t\":\"kapat\",\"ok\":true,\"pencere\":0,\"msg\":" + Json(hata > 0 ? "Pencereye ulaşılamadı (yönetici olarak çalışıyor olabilir)." : "Penceresi yok; nazikçe kapatılamıyor.") + "}");
            return;
        }
        IntPtr hp = OpenProcess(0x0001 /* PROCESS_TERMINATE */, false, pid);
        if (hp == IntPtr.Zero) { Yaz("{\"t\":\"zorla\",\"ok\":false,\"msg\":\"Erişim reddedildi (yönetici olarak çalışan bir program olabilir).\"}"); return; }
        bool ok = TerminateProcess(hp, 1);
        int err = Marshal.GetLastWin32Error();
        CloseHandle(hp);
        Yaz(ok ? "{\"t\":\"zorla\",\"ok\":true}" : "{\"t\":\"zorla\",\"ok\":false,\"msg\":\"Kapatılamadı (hata " + err + ").\"}");
    }

    // ---------- Ölçüm döngüsü ----------
    static void OlcumDongusu()
    {
        long oIdle = 0, oKer = 0, oUser = 0, oAgIn = -1, oAgOut = -1, oOz = 0;
        long oZaman = DateTime.UtcNow.Ticks;
        string diskler = "[]";
        int tur = 0;
        bool ilk = true; // ilk turda önceki değer yok (CPU %0 görünürdü): yalnızca sayaçlar hazırlanır
        GetSystemTimes(out oIdle, out oKer, out oUser);
        var sb = new StringBuilder(8192);
        while (true)
        {
            long hedef = DateTime.UtcNow.Ticks + 10000000;
            try
            {
                long simdi = DateTime.UtcNow.Ticks;
                double gecen = Math.Max(1, simdi - oZaman); // 100 ns
                oZaman = simdi;
                sb.Clear();
                sb.Append("{\"t\":\"olcum\"");

                long idle, ker, user;
                GetSystemTimes(out idle, out ker, out user);
                long dTop = (ker - oKer) + (user - oUser), dIdle = idle - oIdle;
                double cpu = dTop > 0 ? 100.0 * (dTop - dIdle) / dTop : 0;
                oIdle = idle; oKer = ker; oUser = user;
                sb.Append(",\"cpu\":").Append(Sayi(Math.Max(0, Math.Min(100, cpu))));

                var m = new MEMORYSTATUSEX();
                GlobalMemoryStatusEx(m);
                sb.Append(",\"ramTop\":").Append(m.ullTotalPhys).Append(",\"ramKul\":").Append(m.ullTotalPhys - m.ullAvailPhys);
                sb.Append(",\"uptime\":").Append(GetTickCount64() / 1000);

                SYSTEM_POWER_STATUS ps;
                if (GetSystemPowerStatus(out ps) && ps.BatteryFlag != 128 && ps.BatteryFlag != 255 && ps.BatteryLifePercent <= 100)
                    sb.Append(",\"pil\":{\"yuzde\":").Append(ps.BatteryLifePercent).Append(",\"fis\":").Append(ps.ACLineStatus == 1 ? "true" : "false")
                      .Append(",\"sarj\":").Append((ps.BatteryFlag & 8) != 0 ? "true" : "false").Append("}");
                else sb.Append(",\"pil\":null");

                long agIn, agOut;
                AgSayaclari(out agIn, out agOut);
                if (oAgIn >= 0 && agIn >= oAgIn && agOut >= oAgOut)
                    sb.Append(",\"ag\":{\"in\":").Append((long)((agIn - oAgIn) * 1e7 / gecen)).Append(",\"out\":").Append((long)((agOut - oAgOut) * 1e7 / gecen)).Append("}");
                else sb.Append(",\"ag\":null");
                oAgIn = agIn; oAgOut = agOut;

                if (tur++ % 10 == 0) diskler = Diskler();
                sb.Append(",\"diskler\":").Append(diskler);

                lock (kilit)
                {
                    sb.Append(",\"cpuSic\":").Append(cpuSic < 0 ? "null" : Sayi(cpuSic)).Append(",\"cpuSicNeden\":").Append(Json(cpuSicNeden));
                }

                if (ayrinti)
                {
                    sb.Append(",\"gpu\":").Append(Gpu());
                    sb.Append(",\"surecler\":").Append(Surecler(gecen));
                }

                long c, e, k, u;
                GetProcessTimes(GetCurrentProcess(), out c, out e, out k, out u);
                double oz = oOz > 0 ? 100.0 * (k + u - oOz) / (gecen * cekirdek) : 0;
                oOz = k + u;
                sb.Append(",\"oz\":").Append(Sayi(oz)).Append("}");
                if (!ilk) Yaz(sb.ToString());
                ilk = false;
            }
            catch (Exception ex) { Yaz("{\"t\":\"error\",\"msg\":" + Json(ex.Message) + "}"); }
            long kalan = (hedef - DateTime.UtcNow.Ticks) / 10000;
            if (kalan > 0) Thread.Sleep((int)kalan);
        }
    }

    static string Sayi(double d) { return d.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture); }

    // Yalnızca gerçek ağ kartları (sanal / VPN / Tailscale bağdaştırıcıları aynı trafiği bir kez daha sayar).
    static void AgSayaclari(out long gelen, out long giden)
    {
        gelen = 0; giden = 0;
        foreach (var n in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (n.OperationalStatus != OperationalStatus.Up) continue;
            var t = n.NetworkInterfaceType;
            if (t == NetworkInterfaceType.Loopback || t == NetworkInterfaceType.Tunnel) continue;
            string d = (n.Description + " " + n.Name).ToLowerInvariant();
            if (d.Contains("virtual") || d.Contains("hyper-v") || d.Contains("tailscale") || d.Contains("wintun") || d.Contains("vmware")
                || d.Contains("virtualbox") || d.Contains("loopback") || d.Contains("vethernet") || d.Contains("wsl")) continue;
            try { var s = n.GetIPStatistics(); gelen += s.BytesReceived; giden += s.BytesSent; } catch { }
        }
    }

    static string Diskler()
    {
        var sb = new StringBuilder("[");
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (d.DriveType != DriveType.Fixed || !d.IsReady) continue;
                if (sb.Length > 1) sb.Append(',');
                sb.Append("{\"ad\":").Append(Json(d.Name)).Append(",\"etiket\":").Append(Json(d.VolumeLabel))
                  .Append(",\"top\":").Append(d.TotalSize).Append(",\"bos\":").Append(d.TotalFreeSpace).Append('}');
            }
            catch { }
        }
        return sb.Append(']').ToString();
    }

    // ---------- GPU (NVML) ----------
    static int nvDurum = 0; // 0: denenmedi, 1: hazır, -1: yok
    static IntPtr[] nvAygit = new IntPtr[0];
    static string[] nvAd = new string[0];
    static string Gpu()
    {
        if (nvDurum == 0)
        {
            nvDurum = -1;
            try
            {
                string sys = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nvml.dll");
                string eski = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvml.dll");
                if ((File.Exists(sys) && LoadLibrary(sys) != IntPtr.Zero) || (File.Exists(eski) && LoadLibrary(eski) != IntPtr.Zero))
                {
                    uint n;
                    if (nvmlInit_v2() == 0 && nvmlDeviceGetCount_v2(out n) == 0 && n > 0)
                    {
                        nvAygit = new IntPtr[n]; nvAd = new string[n];
                        for (uint i = 0; i < n; i++)
                        {
                            nvmlDeviceGetHandleByIndex_v2(i, out nvAygit[i]);
                            var b = new byte[96];
                            nvmlDeviceGetName(nvAygit[i], b, (uint)b.Length);
                            nvAd[i] = Encoding.ASCII.GetString(b).TrimEnd('\0');
                        }
                        nvDurum = 1;
                    }
                }
            }
            catch { nvDurum = -1; }
        }
        if (nvDurum != 1) return "null";
        var sb = new StringBuilder("[");
        for (int i = 0; i < nvAygit.Length; i++)
        {
            NvUtil u; NvMem m; uint t;
            if (i > 0) sb.Append(',');
            sb.Append("{\"ad\":").Append(Json(nvAd[i]));
            sb.Append(",\"kul\":").Append(nvmlDeviceGetUtilizationRates(nvAygit[i], out u) == 0 ? u.gpu.ToString() : "null");
            sb.Append(",\"sic\":").Append(nvmlDeviceGetTemperature(nvAygit[i], 0, out t) == 0 ? t.ToString() : "null");
            if (nvmlDeviceGetMemoryInfo(nvAygit[i], out m) == 0) sb.Append(",\"vramKul\":").Append(m.used).Append(",\"vramTop\":").Append(m.total);
            sb.Append('}');
        }
        return sb.Append(']').ToString();
    }

    // ---------- CPU sıcaklığı (WMI, seyrek) ----------
    static double cpuSic = -1;
    static string cpuSicNeden = "Ölçülüyor...";
    static void SicaklikDongusu()
    {
        while (true)
        {
            double d = -1; string neden = "";
            try
            {
                using (var s = new System.Management.ManagementObjectSearcher("root\\WMI", "SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature"))
                {
                    foreach (System.Management.ManagementObject o in s.Get())
                    {
                        double k = Convert.ToDouble(o["CurrentTemperature"]) / 10.0 - 273.15;
                        if (k > 0 && k < 150) d = Math.Max(d, k);
                    }
                }
                if (d < 0) neden = "Ölçülemiyor (bu bilgisayar bildirmiyor).";
            }
            catch (System.Management.ManagementException e)
            {
                neden = e.ErrorCode == System.Management.ManagementStatus.AccessDenied ? "Ölçülemiyor (yönetici izni gerekir)." : "Ölçülemiyor (Windows bu bilgisayarda bildirmiyor ya da yönetici izni gerekir).";
            }
            catch (UnauthorizedAccessException) { neden = "Ölçülemiyor (yönetici izni gerekir)."; }
            catch (Exception) { neden = "Ölçülemiyor."; }
            lock (kilit) { cpuSic = d; cpuSicNeden = neden; }
            if (d < 0) return; // izin yok / desteklenmiyor: bir daha denenmez
            Thread.Sleep(10000);
        }
    }

    // ---------- Süreçler ----------
    // SYSTEM_PROCESS_INFORMATION (x64) alan konumları
    const int O_SONRAKI = 0, O_OZEL_RAM = 8, O_OLUSMA = 32, O_KULLANICI = 40, O_CEKIRDEK = 48, O_AD_UZ = 56, O_AD = 64, O_PID = 80, O_PPID = 88;

    static Dictionary<int, Surec> Anlik()
    {
        if (tampon == IntPtr.Zero) { tamponBoyu = 1 << 20; tampon = Marshal.AllocHGlobal(tamponBoyu); }
        int ret, st;
        while ((st = NtQuerySystemInformation(5, tampon, tamponBoyu, out ret)) == unchecked((int)0xC0000004))
        {
            Marshal.FreeHGlobal(tampon);
            tamponBoyu = Math.Max(ret + 65536, tamponBoyu * 2);
            tampon = Marshal.AllocHGlobal(tamponBoyu);
        }
        var d = new Dictionary<int, Surec>();
        if (st != 0) return d;
        long ofs = 0;
        while (true)
        {
            IntPtr p = new IntPtr(tampon.ToInt64() + ofs);
            var s = new Surec();
            s.pid = (int)Marshal.ReadInt64(p, O_PID);
            s.ppid = (int)Marshal.ReadInt64(p, O_PPID);
            s.ct = Marshal.ReadInt64(p, O_OLUSMA);
            s.zaman = Marshal.ReadInt64(p, O_KULLANICI) + Marshal.ReadInt64(p, O_CEKIRDEK);
            s.ram = Marshal.ReadInt64(p, O_OZEL_RAM);
            int uz = Marshal.ReadInt16(p, O_AD_UZ) & 0xFFFF;
            IntPtr ad = Marshal.ReadIntPtr(p, O_AD);
            s.ad = s.pid == 0 ? "Idle" : ad == IntPtr.Zero ? "System" : Marshal.PtrToStringUni(ad, uz / 2);
            d[s.pid] = s;
            int sonraki = Marshal.ReadInt32(p, O_SONRAKI);
            if (sonraki == 0) break;
            ofs += sonraki;
        }
        anlik = d;
        return d;
    }

    // Sunucunun konsol penceresi (baslat.bat) başka bir süreçte durur: klasik conhost.exe (cmd'nin çocuğu, sunucunun kardeşi) ya da
    // Windows Terminal'de OpenConsole.exe + WindowsTerminal.exe (sunucunun ne atası ne çocuğu). Kapatılırsa sunucu da kapanır.
    // Bu program konsolsuz başlar (windowsHide): sunucunun konsoluna kısa süre bağlanıp pencereyi, ondan sahibini bulur.
    // Std akışları önceden açıldığı için bağlanmak onları etkilemez.
    static void KonsolBul()
    {
        if (sunucuPid <= 0 || GetConsoleWindow() != IntPtr.Zero || !AttachConsole(sunucuPid)) return;
        IntPtr h = GetConsoleWindow();
        int sahip = 0;
        if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out sahip);
        FreeConsole();
        var s = Anlik();
        Surec x;
        if (sahip <= 4 || sahip == sunucuPid || !s.TryGetValue(sahip, out x)) return;
        konsol.Add(new long[] { x.pid, x.ct });
        // OpenConsole.exe'yi başlatan Windows Terminal da (ata zincirinde konsol barındıran adlar).
        for (int i = 0; i < 4; i++)
        {
            Surec ata;
            if (x.ppid <= 4 || !s.TryGetValue(x.ppid, out ata) || ata.ct > x.ct) break;
            string ad = (ata.ad ?? "").ToLowerInvariant();
            if (ad != "windowsterminal.exe" && ad != "openconsole.exe" && ad != "conhost.exe") break;
            konsol.Add(new long[] { ata.pid, ata.ct });
            x = ata;
        }
    }

    // Sunucunun kendisi, ataları (onu başlatan konsol/tepsi), konsol penceresinin sahibi ve tüm alt süreçleri (RemoteHelper, Pano, Ses, ffmpeg, bu program...).
    // Ebeveyn PID'i yeniden kullanılmış olabilir: ebeveyn, çocuktan önce başlamış olmalı.
    static HashSet<int> Biz(Dictionary<int, Surec> s)
    {
        var biz = new HashSet<int>();
        Surec x;
        if (sunucuPid <= 0 || !s.TryGetValue(sunucuPid, out x)) return biz;
        biz.Add(sunucuPid);
        foreach (var k in konsol) { Surec ks; if (s.TryGetValue((int)k[0], out ks) && ks.ct == k[1]) biz.Add(ks.pid); }
        for (int i = 0; i < 32; i++)
        {
            Surec ata;
            if (x.ppid <= 4 || !s.TryGetValue(x.ppid, out ata) || ata.ct > x.ct || !biz.Add(ata.pid)) break;
            x = ata;
        }
        foreach (var c in s.Values)
        {
            var y = c;
            for (int i = 0; i < 32; i++)
            {
                if (y.pid == sunucuPid) { biz.Add(c.pid); break; }
                Surec ata;
                if (y.ppid <= 4 || !s.TryGetValue(y.ppid, out ata) || ata.ct > y.ct) break;
                y = ata;
            }
        }
        return biz;
    }

    static List<IntPtr> Pencereler(int pid)
    {
        var l = new List<IntPtr>();
        EnumWindows((h, _) =>
        {
            int p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h) && GetWindow(h, 4 /* GW_OWNER */) == IntPtr.Zero && !Gizli(h)) l.Add(h);
            return true;
        }, IntPtr.Zero);
        return l;
    }
    static bool Gizli(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out v, 4) == 0 && v != 0; }

    static Dictionary<int, string> Basliklar()
    {
        var d = new Dictionary<int, string>();
        var sb = new StringBuilder(256);
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0 || Gizli(h)) return true;
            int p;
            GetWindowThreadProcessId(h, out p);
            if (d.ContainsKey(p)) return true;
            sb.Clear();
            GetWindowText(h, sb, 256);
            d[p] = sb.ToString();
            return true;
        }, IntPtr.Zero);
        return d;
    }

    // En çok CPU kullanan 15 + en çok RAM kullanan 15 (birleşimi). CPU yüzdesi tüm çekirdeklere göredir (Görev Yöneticisi gibi).
    static string Surecler(double gecen)
    {
        Dictionary<int, Surec> s;
        HashSet<int> biz;
        lock (kilit) { s = Anlik(); biz = Biz(s); }
        var yeni = new Dictionary<int, long[]>();
        var cpu = new Dictionary<int, double>();
        foreach (var x in s.Values)
        {
            if (x.pid == 0) continue;
            long[] o;
            double c = 0;
            if (oncekiZaman.TryGetValue(x.pid, out o) && o[0] == x.ct) c = Math.Max(0, 100.0 * (x.zaman - o[1]) / (gecen * cekirdek));
            cpu[x.pid] = c;
            yeni[x.pid] = new long[] { x.ct, x.zaman };
        }
        bool hazir = oncekiZaman.Count > 0;
        oncekiZaman = yeni;
        if (!hazir) return "null"; // CPU yüzdesi için bir önceki ölçüm gerekir
        var liste = s.Values.Where(x => x.pid != 0).ToList();
        var secilen = new HashSet<int>(liste.OrderByDescending(x => cpu[x.pid]).Take(15).Select(x => x.pid));
        foreach (var x in liste.OrderByDescending(x => x.ram).Take(15)) secilen.Add(x.pid);
        var basliklar = Basliklar();
        var sb = new StringBuilder("[");
        foreach (int pid in secilen)
        {
            var x = s[pid];
            string b;
            if (sb.Length > 1) sb.Append(',');
            sb.Append("{\"pid\":").Append(pid).Append(",\"ad\":").Append(Json(x.ad)).Append(",\"ct\":\"").Append(x.ct).Append("\"")
              .Append(",\"cpu\":").Append(Sayi(cpu[pid])).Append(",\"ram\":").Append(x.ram);
            if (basliklar.TryGetValue(pid, out b)) sb.Append(",\"baslik\":").Append(Json(b));
            if (biz.Contains(pid)) sb.Append(",\"biz\":true");
            sb.Append('}');
        }
        return sb.Append(']').ToString();
    }

    // ---------- Çıktı ----------
    static void Yaz(string json)
    {
        var b = Encoding.ASCII.GetBytes(json + "\n");
        lock (cikis) { cikis.Write(b, 0, b.Length); cikis.Flush(); }
    }

    static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
