// Görev çubuğu (tepsi) uygulaması: Node sunucusunu gizli pencerede başlatır ve simgeden yönetir.
// Derleme (tepsi-baslat.bat bunu kendisi yapar):
//   csc /target:winexe /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /out:helper\Tepsi.exe helper\Tepsi.cs
// Kök klasör = Tepsi.exe'nin bulunduğu helper klasörünün bir üstü.
//   - Tek örnek (adlandırılmış Mutex). İkinci kez açılırsa çalışan örneğe "arayüzü aç" der ve çıkar.
//   - Sunucu: <kök>\runtime\node.exe varsa o, yoksa PATH'teki node. Rastgele TRAY_TOKEN ortam değişkeniyle verilir.
//   - Çıktı <veri>\sunucu.log dosyasına yazılır (en fazla ~2 MB). Veri klasörü: REMOTE_DATA_DIR ya da <kök>\data.
//   - Sunucu ve alt süreçleri (yardımcı, ffmpeg) bir Windows iş nesnesine (Job) konur; tepsi kapanınca hepsi kapanır.
//   - Biri ekranı izlerken uyku engellenir (ES_SYSTEM_REQUIRED); ekranın kapanmasına izin verilir.
// Komut satırı:
//   Tepsi.exe --cikis                  çalışan örneği düzgün kapatır (sunucu dahil), kapanınca 0 döner
//   Tepsi.exe --baslangic ac|kapat|durum   "Windows açılınca başlat" kısayolu (durum: varsa 0, yoksa 1)
//   Tepsi.exe --oturum-acilisi         başlangıç kısayolunun kullandığı sessiz açılış (karşılama balonu yok)
// Ortam: PORT (varsayılan 3080), TEPSI_SESSIZ=1 (balon bildirimi gösterme; testler için),
//        TEPSI_BASLANGIC_KLASORU (Başlangıç klasörü yerine; testler için)
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(Application.ExecutablePath)));
        // Aynı klasör + aynı port için tek örnek (başka kopyanın ya da başka porttaki tepsinin — ör. testlerin — tepsisiyle
        // karışmasın diye ada klasörün ve portun özeti eklenir).
        int portNo;
        if (!int.TryParse(Environment.GetEnvironmentVariable("PORT"), out portNo) || portNo <= 0 || portNo >= 65536) portNo = 3080;
        string id = Hash(root.ToLowerInvariant() + "|" + portNo);
        string mutexName = "Local\\UzaktanBaglanti.Tepsi." + id;
        string acName = mutexName + ".Ac";
        string cikisName = mutexName + ".Cikis";

        if (args.Length >= 1 && args[0] == "--baslangic")
        {
            string islem = args.Length >= 2 ? args[1] : "durum";
            return Baslangic.Komut(islem);
        }
        if (args.Length >= 1 && args[0] == "--cikis") return CikisIste(mutexName, cikisName);

        bool created;
        Mutex mutex = new Mutex(true, mutexName, out created);
        if (!created)
        {
            // Zaten çalışıyor: ona arayüzü açmasını söyle.
            Sinyal(acName);
            return 0;
        }
        try
        {
            EventWaitHandle ac = new EventWaitHandle(false, EventResetMode.AutoReset, acName);
            EventWaitHandle cikis = new EventWaitHandle(false, EventResetMode.AutoReset, cikisName);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool sessizAcilis = args.Length >= 1 && args[0] == "--oturum-acilisi";
            Application.Run(new TepsiUygulamasi(root, ac, cikis, sessizAcilis));
        }
        finally
        {
            mutex.ReleaseMutex();
        }
        return 0;
    }

    static string Hash(string s)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
            return BitConverter.ToString(h, 0, 6).Replace("-", "");
        }
    }

    static bool Sinyal(string name)
    {
        try
        {
            using (EventWaitHandle e = EventWaitHandle.OpenExisting(name)) e.Set();
            return true;
        }
        catch (WaitHandleCannotBeOpenedException) { return false; }
    }

    static int CikisIste(string mutexName, string cikisName)
    {
        if (!Sinyal(cikisName)) return 0; // çalışan örnek yok
        // Çalışan örnek kapanıp kilidi bırakana kadar bekle.
        using (Mutex m = new Mutex(false, mutexName))
        {
            try
            {
                if (m.WaitOne(20000)) { m.ReleaseMutex(); return 0; }
            }
            catch (AbandonedMutexException) { return 0; }
        }
        return 1;
    }
}

// "Windows açılınca başlat": Başlangıç klasöründe Tepsi.exe'ye kısayol (yönetici izni gerekmez).
static class Baslangic
{
    public static string KisayolYolu()
    {
        string dir = Environment.GetEnvironmentVariable("TEPSI_BASLANGIC_KLASORU");
        if (string.IsNullOrEmpty(dir)) dir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        return Path.Combine(dir, "Uzaktan Bağlantı.lnk");
    }

    public static bool Acik() { return File.Exists(KisayolYolu()); }

    public static void Ac()
    {
        string exe = Path.GetFullPath(Application.ExecutablePath);
        // WScript.Shell COM nesnesi geç bağlama ile kullanılır (ek başvuru gerektirmez).
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        try
        {
            object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { KisayolYolu() });
            try
            {
                Type st = sc.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { exe });
                st.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { "--oturum-acilisi" });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(exe) });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Uzaktan Bağlantı tepsi simgesi" });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            finally { Marshal.ReleaseComObject(sc); }
        }
        finally { Marshal.ReleaseComObject(shell); }
    }

    public static void Kapat()
    {
        string p = KisayolYolu();
        if (File.Exists(p)) File.Delete(p);
    }

    public static int Komut(string islem)
    {
        try
        {
            if (islem == "ac") { Ac(); return Acik() ? 0 : 2; }
            if (islem == "kapat") { Kapat(); return Acik() ? 2 : 0; }
            return Acik() ? 0 : 1;
        }
        catch (Exception) { return 2; }
    }
}

// Bir sunucu çalıştırması: Node süreci + onu ve alt süreçlerini kapsayan iş nesnesi.
class SunucuSureci
{
    public Process P;
    public IntPtr Job = IntPtr.Zero;
}

class TepsiUygulamasi : ApplicationContext
{
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
        public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const long LOG_MAX = 2 * 1024 * 1024, LOG_KEEP = 1024 * 1024;
    const string BASLIK = "Uzaktan Bağlantı";

    readonly string root, dataDir, logPath, token;
    readonly int port;
    readonly bool sessiz;
    readonly NotifyIcon icon;
    readonly ContextMenuStrip menu;
    readonly Control ui; // arka plan iş parçacıklarından arayüz iş parçacığına geçmek için
    readonly Icon iconNormal, iconAktif;
    readonly object logLock = new object();

    readonly List<DateTime> cokmeler = new List<DateTime>();
    readonly System.Windows.Forms.Timer yoklama;

    SunucuSureci sunucu;           // yalnızca arayüz iş parçacığında değişir
    volatile bool cikiliyor;       // uygulama kapanıyor
    bool durduruluyor;             // sunucu bilerek durduruluyor (çökme sayılmaz)
    bool mesgul;                   // yeniden başlatma sürüyor
    bool yoklamaSuruyor;
    Dictionary<string, object> durum; // son /api/tepsi/durum cevabı (null: sunucuya ulaşılamıyor)
    bool uykuEngelli;
    bool akisBagli;
    long logBoyut = -1;

    public TepsiUygulamasi(string root, EventWaitHandle ac, EventWaitHandle cikis, bool sessizAcilis)
    {
        this.root = root;
        string envData = Environment.GetEnvironmentVariable("REMOTE_DATA_DIR");
        dataDir = string.IsNullOrEmpty(envData) ? Path.Combine(root, "data") : envData;
        Directory.CreateDirectory(dataDir);
        logPath = Path.Combine(dataDir, "sunucu.log");
        int p;
        port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out p) && p > 0 && p < 65536 ? p : 3080;
        sessiz = Environment.GetEnvironmentVariable("TEPSI_SESSIZ") == "1";
        string envToken = Environment.GetEnvironmentVariable("TRAY_TOKEN");
        token = !string.IsNullOrEmpty(envToken) && envToken.Length >= 16 ? envToken : RastgeleBelirtec();
        ServicePointManager.Expect100Continue = false;

        ui = new Control();
        ui.CreateControl();
        IntPtr unused = ui.Handle; // tutamacın oluşması için

        iconNormal = SimgeCiz(false);
        iconAktif = SimgeCiz(true);
        menu = new ContextMenuStrip();
        menu.Opening += (s, e) => { MenuyuKur(); e.Cancel = false; YoklaArkaPlanda(); };
        icon = new NotifyIcon();
        icon.Icon = iconNormal;
        icon.Text = BASLIK;
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (s, e) => ArayuzuAc();
        icon.Visible = true;

        Application.ThreadException += (s, e) => Log("[tepsi] hata: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("[tepsi] hata: " + e.ExceptionObject);

        ThreadPool.RegisterWaitForSingleObject(ac, (st, to) => ArayuzdeCalistir(ArayuzuAc), null, -1, false);
        ThreadPool.RegisterWaitForSingleObject(cikis, (st, to) => ArayuzdeCalistir(Cik), null, -1, false);

        yoklama = new System.Windows.Forms.Timer();
        yoklama.Interval = 5000;
        yoklama.Tick += (s, e) => YoklaArkaPlanda();
        yoklama.Start();

        Thread akis = new Thread(OlayAkisi);
        akis.IsBackground = true;
        akis.Start();

        Log("[tepsi] başladı (port " + port + ", kök " + root + ")");
        SunucuyuBaslat();
        if (!sessizAcilis) Balon("Arka planda çalışıyor. Menü için simgeye sağ tıklayın.");
    }

    // ---------- Günlük ----------

    void Log(string satir)
    {
        lock (logLock)
        {
            try
            {
                if (logBoyut < 0) logBoyut = File.Exists(logPath) ? new FileInfo(logPath).Length : 0;
                string s = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + satir + Environment.NewLine;
                File.AppendAllText(logPath, s, Encoding.UTF8);
                logBoyut += Encoding.UTF8.GetByteCount(s);
                if (logBoyut > LOG_MAX) LoguKirp();
            }
            catch (Exception) { /* günlük yazılamazsa sunucu yine çalışsın */ }
        }
    }

    // Eski kısmı at, son ~1 MB'ı (satır başından itibaren) tut.
    void LoguKirp()
    {
        byte[] all = File.ReadAllBytes(logPath);
        int start = (int)Math.Max(0, all.Length - LOG_KEEP);
        while (start < all.Length && all[start] != (byte)'\n') start++;
        start = Math.Min(all.Length, start + 1);
        byte[] kalan = new byte[all.Length - start];
        Array.Copy(all, start, kalan, 0, kalan.Length);
        File.WriteAllBytes(logPath, kalan);
        logBoyut = kalan.Length;
    }

    // ---------- Sunucu süreci ----------

    string NodeBul()
    {
        string paket = Path.Combine(root, "runtime\\node.exe");
        if (File.Exists(paket)) return paket;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string d in path.Split(';'))
        {
            try
            {
                string dd = d.Trim().Trim('"');
                if (dd.Length == 0) continue;
                string f = Path.Combine(dd, "node.exe");
                if (File.Exists(f)) return f;
            }
            catch (ArgumentException) { /* geçersiz PATH girdisi */ }
        }
        return null;
    }

    void SunucuyuBaslat()
    {
        string node = NodeBul();
        if (node == null)
        {
            Log("[tepsi] Node.js bulunamadı.");
            Balon("Node.js bulunamadı. Taşınabilir paketi kullanın ya da Node.js kurun.", ToolTipIcon.Error);
            return;
        }
        if (!File.Exists(Path.Combine(root, "server.js")))
        {
            Log("[tepsi] server.js bulunamadı: " + root);
            Balon("server.js bulunamadı. Tepsi.exe helper klasöründe olmalı.", ToolTipIcon.Error);
            return;
        }
        ProcessStartInfo psi = new ProcessStartInfo(node, "server.js");
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["TRAY_TOKEN"] = token;
        psi.EnvironmentVariables["PORT"] = port.ToString();

        SunucuSureci s = new SunucuSureci();
        Process p = new Process();
        p.StartInfo = psi;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += (o, e) => { if (e.Data != null) Log(e.Data); };
        p.ErrorDataReceived += (o, e) => { if (e.Data != null) Log(e.Data); };
        p.Exited += (o, e) => ArayuzdeCalistir(() => SunucuKapandi(s));
        s.P = p;
        try
        {
            p.Start();
        }
        catch (Exception ex)
        {
            Log("[tepsi] sunucu başlatılamadı: " + ex.Message);
            Balon("Sunucu başlatılamadı: " + ex.Message, ToolTipIcon.Error);
            return;
        }
        s.Job = IsNesnesi(p);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        sunucu = s;
        Log("[tepsi] sunucu başlatıldı (pid " + p.Id + ")");
    }

    // Sunucuyu bir iş nesnesine koyar: iş nesnesi kapanınca içindeki tüm süreçler (yardımcı, ffmpeg) kapanır.
    IntPtr IsNesnesi(Process p)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint len = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, len) || !AssignProcessToJobObject(job, p.Handle))
        {
            Log("[tepsi] uyarı: iş nesnesi kurulamadı (hata " + Marshal.GetLastWin32Error() + "), alt süreçler ağaçla kapatılacak");
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    void IsNesnesiniKapat(SunucuSureci s)
    {
        lock (s)
        {
            if (s.Job == IntPtr.Zero) return;
            CloseHandle(s.Job); // KILL_ON_JOB_CLOSE: kalan alt süreçler sonlanır
            s.Job = IntPtr.Zero;
        }
    }

    void SunucuKapandi(SunucuSureci s)
    {
        IsNesnesiniKapat(s);
        if (s != sunucu) return;
        sunucu = null;
        durum = null;
        AkisDurumu(false);
        UykuAyarla(false);
        SimgeyiGuncelle();
        if (durduruluyor || cikiliyor) return;

        int kod = -1;
        try { kod = s.P.ExitCode; } catch (Exception) { }
        DateTime simdi = DateTime.Now;
        cokmeler.Add(simdi);
        cokmeler.RemoveAll(t => (simdi - t).TotalMinutes > 2);
        Log("[tepsi] sunucu beklenmedik şekilde kapandı (kod " + kod + ")");
        if (cokmeler.Count > 4)
        {
            Balon("Sunucu sürekli kapanıyor, durduruldu. Ayrıntı için menüden \"Günlüğü aç\". Port " + port + " başka bir programca kullanılıyor olabilir.", ToolTipIcon.Error);
            return;
        }
        Balon("Sunucu beklenmedik şekilde kapandı (kod " + kod + "), yeniden başlatılıyor...", ToolTipIcon.Warning);
        System.Windows.Forms.Timer t2 = new System.Windows.Forms.Timer();
        t2.Interval = 2000;
        t2.Tick += (o, e) => { t2.Stop(); t2.Dispose(); if (!cikiliyor && !durduruluyor && sunucu == null) SunucuyuBaslat(); };
        t2.Start();
    }

    // Arka plan iş parçacığında çağrılır: önce sunucudan kendini kapatmasını ister, olmazsa zorla kapatır.
    void SunucuyuDurdur(SunucuSureci s)
    {
        if (s == null) return;
        try
        {
            if (!s.P.HasExited)
            {
                try { Istek("POST", "/api/tepsi/kapat", "{}", 3000); } catch (Exception) { }
                if (!s.P.WaitForExit(6000))
                {
                    Log("[tepsi] sunucu kapanmadı, sonlandırılıyor");
                    bool bitti = false;
                    lock (s) { if (s.Job != IntPtr.Zero) bitti = TerminateJobObject(s.Job, 1); }
                    if (!bitti) AgaciSonlandir(s.P.Id);
                    s.P.WaitForExit(5000);
                }
            }
        }
        catch (Exception ex) { Log("[tepsi] durdurma hatası: " + ex.Message); }
        IsNesnesiniKapat(s);
    }

    static void AgaciSonlandir(int pid)
    {
        try
        {
            ProcessStartInfo k = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F");
            k.CreateNoWindow = true;
            k.UseShellExecute = false;
            using (Process kp = Process.Start(k)) kp.WaitForExit(5000);
        }
        catch (Exception) { }
    }

    void YenidenBaslat()
    {
        if (mesgul || cikiliyor) return;
        mesgul = true;
        durduruluyor = true;
        SunucuSureci s = sunucu;
        Log("[tepsi] yeniden başlatılıyor");
        Thread t = new Thread(() =>
        {
            SunucuyuDurdur(s);
            ArayuzdeCalistir(() =>
            {
                if (sunucu == s) sunucu = null;
                durduruluyor = false;
                mesgul = false;
                cokmeler.Clear();
                if (!cikiliyor) SunucuyuBaslat();
            });
        });
        t.IsBackground = true;
        t.Start();
    }

    void Cik()
    {
        if (cikiliyor) return;
        cikiliyor = true;
        durduruluyor = true;
        yoklama.Stop();
        icon.Text = BASLIK + " — kapanıyor...";
        Log("[tepsi] çıkılıyor");
        SunucuSureci s = sunucu;
        Thread t = new Thread(() =>
        {
            SunucuyuDurdur(s);
            ArayuzdeCalistir(() =>
            {
                SetThreadExecutionState(ES_CONTINUOUS);
                icon.Visible = false;
                icon.Dispose();
                Log("[tepsi] kapandı");
                ExitThread();
            });
        });
        t.IsBackground = true;
        t.Start();
    }

    // ---------- Sunucuyla konuşma (yalnızca 127.0.0.1 + belirteç) ----------

    string Istek(string method, string yol, string govde, int zamanAsimi)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + yol);
        req.Method = method;
        req.Proxy = null;
        req.Timeout = zamanAsimi;
        req.ReadWriteTimeout = zamanAsimi;
        req.KeepAlive = false;
        req.Headers["X-Tepsi"] = token;
        if (govde != null)
        {
            byte[] b = Encoding.UTF8.GetBytes(govde);
            req.ContentType = "application/json";
            req.ContentLength = b.Length;
            using (Stream st = req.GetRequestStream()) st.Write(b, 0, b.Length);
        }
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return r.ReadToEnd();
    }

    void YoklaArkaPlanda()
    {
        if (yoklamaSuruyor || cikiliyor || sunucu == null) return;
        yoklamaSuruyor = true;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            Dictionary<string, object> d = null;
            try { d = Json<Dictionary<string, object>>(Istek("GET", "/api/tepsi/durum", null, 3000)); }
            catch (Exception) { }
            ArayuzdeCalistir(() =>
            {
                yoklamaSuruyor = false;
                durum = d;
                if (d != null) UykuAyarla(Sayi(d, "izleyen") > 0);
                SimgeyiGuncelle();
            });
        });
    }

    // Sunucu olaylarını (SSE) dinler; koparsa 2 sn sonra yeniden bağlanır.
    void OlayAkisi()
    {
        while (!cikiliyor)
        {
            if (sunucu == null) { Thread.Sleep(1000); continue; }
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/tepsi/olaylar");
                req.Proxy = null;
                req.Timeout = 5000;
                req.ReadWriteTimeout = 45000; // sunucu 15 sn'de bir canlılık satırı yollar
                req.Headers["X-Tepsi"] = token;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    ArayuzdeCalistir(() => AkisDurumu(true));
                    string satir;
                    while (!cikiliyor && (satir = r.ReadLine()) != null)
                    {
                        if (!satir.StartsWith("data: ")) continue;
                        Dictionary<string, object> olay;
                        try { olay = Json<Dictionary<string, object>>(satir.Substring(6)); }
                        catch (Exception) { continue; }
                        ArayuzdeCalistir(() => OlayGeldi(olay));
                    }
                }
            }
            catch (Exception) { /* sunucu henüz hazır değil ya da kapandı */ }
            ArayuzdeCalistir(() => AkisDurumu(false));
            Thread.Sleep(2000);
        }
    }

    void AkisDurumu(bool bagli)
    {
        if (bagli == akisBagli) return;
        akisBagli = bagli;
        if (!cikiliyor) Log(bagli ? "[tepsi] olay akışı bağlandı" : "[tepsi] olay akışı koptu");
        if (bagli) YoklaArkaPlanda();
    }

    void OlayGeldi(Dictionary<string, object> o)
    {
        string tur = Yazi(o, "tur");
        UykuAyarla(Sayi(o, "izleyen") > 0);
        Dictionary<string, object> k = Nesne(o, "kisi");
        if (k != null && (tur == "baglandi" || tur == "ayrildi"))
        {
            string cihaz = Yazi(k, "cihaz");
            string metin = Yazi(k, "kullanici") + (tur == "baglandi" ? " bağlandı" : " ayrıldı")
                + " — " + (cihaz.Length > 0 ? cihaz + " " : "") + "(" + Yazi(k, "viaAd") + ")";
            Log("[tepsi] bildirim: " + metin);
            // Bu bilgisayardaki tarayıcı için balon gösterme (arayüzü her açışta çıkmasın).
            if (Yazi(k, "via") != "local") Balon(metin);
        }
        else if (k != null && (tur == "izleme-basladi" || tur == "izleme-bitti"))
        {
            Log("[tepsi] " + Yazi(k, "kullanici") + (tur == "izleme-basladi" ? " ekranı izliyor" : " izlemeyi bıraktı"));
        }
        else if (tur == "dosya-geldi")
        {
            // Telefondan gönderilen dosya nereye kaydedildi: bilgisayarın başındaki kişi de görsün.
            Dictionary<string, object> d = Nesne(o, "dosya");
            if (d != null)
            {
                string metin = "Dosya geldi: " + Yazi(d, "ad") + " → " + Yazi(d, "yer");
                Log("[tepsi] " + metin + " (" + Yazi(d, "kullanici") + ")");
                if (Yazi(d, "via") != "local") Balon(metin);
            }
        }
        YoklaArkaPlanda();
    }

    // Biri ekranı izlerken bilgisayar uykuya geçmesin; ekranın kapanmasına izin verilir (DISPLAY_REQUIRED yok).
    // SetThreadExecutionState iş parçacığına bağlıdır; hep arayüz iş parçacığından çağrılır.
    void UykuAyarla(bool engelle)
    {
        if (engelle == uykuEngelli) return;
        uykuEngelli = engelle;
        SetThreadExecutionState(engelle ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS);
        Log(engelle ? "[tepsi] uyku engellendi (ekran izleniyor)" : "[tepsi] uyku engeli kaldırıldı");
        SimgeyiGuncelle();
    }

    // ---------- Menü ----------

    void MenuyuKur()
    {
        menu.Items.Clear();
        ToolStripMenuItem ac = new ToolStripMenuItem("Arayüzü aç", null, (s, e) => ArayuzuAc());
        ac.Font = new Font(ac.Font, FontStyle.Bold);
        menu.Items.Add(ac);
        menu.Items.Add(new ToolStripSeparator());

        if (durum == null)
        {
            ToolStripMenuItem yok = new ToolStripMenuItem(sunucu == null ? "Sunucu çalışmıyor" : "Sunucu başlatılıyor...");
            yok.Enabled = false;
            menu.Items.Add(yok);
        }
        else
        {
            string kod = Yazi(durum, "misafirKodu");
            if (kod.Length > 0)
            {
                menu.Items.Add(new ToolStripMenuItem("Misafir kodu: " + kod + "  (kopyala)", null, (s, e) =>
                {
                    try { Clipboard.SetText(kod); Balon("Misafir kodu kopyalandı: " + kod); }
                    catch (Exception) { }
                }));
            }
            Dictionary<string, object> ts = Nesne(durum, "tailscale");
            if (ts != null)
            {
                string adres = Yazi(ts, "httpsUrl");
                if (adres.Length == 0 && Yazi(ts, "dns").Length > 0) adres = "http://" + Yazi(ts, "dns") + ":" + port;
                if (adres.Length > 0)
                {
                    menu.Items.Add(new ToolStripMenuItem("Her yerden: " + Kacir(adres) + "  (kopyala)", null, (s, e) =>
                    {
                        try { Clipboard.SetText(adres); } catch (Exception) { }
                    }));
                }
            }

            List<Dictionary<string, object>> kisiler = Liste(durum, "kisiler");
            ToolStripMenuItem bagli = new ToolStripMenuItem("Bağlı kişiler (" + kisiler.Count + ")");
            foreach (Dictionary<string, object> k in kisiler)
            {
                int id = Sayi(k, "id");
                string ad = Yazi(k, "kullanici");
                string cihaz = Yazi(k, "cihaz");
                string metin = ad + " — " + (cihaz.Length > 0 ? cihaz + " " : "") + "(" + Yazi(k, "viaAd") + ")"
                    + (Mantik(k, "izliyor") ? " · izliyor" : "");
                bagli.DropDownItems.Add(new ToolStripMenuItem(Kacir(Kisalt(metin, 80)) + " — kes", null, (s, e) =>
                {
                    if (MessageBox.Show("\"" + ad + "\" bağlantısı kesilsin mi?", BASLIK, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                        Kes("{\"id\":" + id + "}");
                }));
            }
            if (kisiler.Count == 0)
            {
                ToolStripMenuItem bos = new ToolStripMenuItem("Kimse bağlı değil");
                bos.Enabled = false;
                bagli.DropDownItems.Add(bos);
            }
            bagli.DropDownItems.Add(new ToolStripSeparator());
            ToolStripMenuItem hepsi = new ToolStripMenuItem("Tüm bağlantıları kes", null, (s, e) =>
            {
                if (MessageBox.Show("Tüm bağlantılar kesilsin mi?", BASLIK, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    Kes("{\"hepsi\":true}");
            });
            hepsi.Enabled = kisiler.Count > 0;
            bagli.DropDownItems.Add(hepsi);
            menu.Items.Add(bagli);
        }

        menu.Items.Add(new ToolStripSeparator());
        ToolStripMenuItem bas = new ToolStripMenuItem("Windows açılınca başlat", null, (s, e) => BaslangicDegistir());
        bas.Checked = Baslangic.Acik();
        menu.Items.Add(bas);
        menu.Items.Add(new ToolStripMenuItem("Günlüğü aç", null, (s, e) => GunluguAc()));
        ToolStripMenuItem yb = new ToolStripMenuItem("Yeniden başlat", null, (s, e) => YenidenBaslat());
        yb.Enabled = !mesgul;
        menu.Items.Add(yb);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Çıkış", null, (s, e) => Cik()));
    }

    void Kes(string govde)
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            string hata = null;
            try { Istek("POST", "/api/tepsi/kes", govde, 3000); }
            catch (Exception ex) { hata = ex.Message; }
            ArayuzdeCalistir(() =>
            {
                if (hata != null) Balon("Bağlantı kesilemedi: " + hata, ToolTipIcon.Error);
                YoklaArkaPlanda();
            });
        });
    }

    void BaslangicDegistir()
    {
        try
        {
            if (Baslangic.Acik()) { Baslangic.Kapat(); Log("[tepsi] başlangıç kısayolu silindi"); }
            else { Baslangic.Ac(); Log("[tepsi] başlangıç kısayolu oluşturuldu: " + Baslangic.KisayolYolu()); }
        }
        catch (Exception ex)
        {
            Balon("Başlangıç ayarı değiştirilemedi: " + ex.Message, ToolTipIcon.Error);
        }
    }

    void ArayuzuAc()
    {
        try { Process.Start("http://localhost:" + port + "/"); }
        catch (Exception ex) { Balon("Tarayıcı açılamadı: " + ex.Message, ToolTipIcon.Error); }
    }

    void GunluguAc()
    {
        try
        {
            if (!File.Exists(logPath)) Log("[tepsi] günlük oluşturuldu");
            Process.Start("notepad.exe", "\"" + logPath + "\"");
        }
        catch (Exception ex) { Balon("Günlük açılamadı: " + ex.Message, ToolTipIcon.Error); }
    }

    // ---------- Simge ----------

    void SimgeyiGuncelle()
    {
        if (cikiliyor) return;
        int n = durum != null ? Liste(durum, "kisiler").Count : 0;
        icon.Icon = n > 0 ? iconAktif : iconNormal;
        string metin = sunucu == null ? BASLIK + " — sunucu kapalı"
            : n == 0 ? BASLIK + " — kimse bağlı değil"
            : BASLIK + " — " + n + " bağlı" + (uykuEngelli ? ", izleniyor" : "");
        icon.Text = Kisalt(metin, 63); // NotifyIcon metni en fazla 63 karakter
    }

    void Balon(string metin) { Balon(metin, ToolTipIcon.Info); }
    void Balon(string metin, ToolTipIcon tur)
    {
        if (sessiz || cikiliyor) return;
        icon.ShowBalloonTip(5000, BASLIK, Kisalt(metin, 250), tur);
    }

    // Koyu zemin üzerinde mavi ekran; biri bağlıyken sağ altta yeşil nokta.
    static Icon SimgeCiz(bool aktif)
    {
        Bitmap bmp = new Bitmap(32, 32);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using (GraphicsPath zemin = YuvarlakDikdortgen(new Rectangle(0, 0, 31, 31), 7))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(26, 29, 36)))
                g.FillPath(b, zemin);
            using (SolidBrush mavi = new SolidBrush(Color.FromArgb(59, 130, 246)))
                g.FillRectangle(mavi, 5, 6, 22, 15);
            using (SolidBrush acik = new SolidBrush(Color.FromArgb(200, 205, 215)))
            {
                g.FillRectangle(acik, 14, 21, 4, 3);
                g.FillRectangle(acik, 10, 24, 12, 2);
            }
            if (aktif)
            {
                using (SolidBrush koyu = new SolidBrush(Color.FromArgb(26, 29, 36)))
                    g.FillEllipse(koyu, 18, 16, 14, 14);
                using (SolidBrush yesil = new SolidBrush(Color.FromArgb(52, 211, 153)))
                    g.FillEllipse(yesil, 20, 18, 10, 10);
            }
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    static GraphicsPath YuvarlakDikdortgen(Rectangle r, int y)
    {
        GraphicsPath p = new GraphicsPath();
        int d = y * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ---------- Yardımcılar ----------

    void ArayuzdeCalistir(Action a)
    {
        try { if (!ui.IsDisposed) ui.BeginInvoke(a); }
        catch (InvalidOperationException) { /* kapanıyor */ }
    }

    static string RastgeleBelirtec()
    {
        byte[] b = new byte[32];
        using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
        return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    }

    // JavaScriptSerializer iş parçacığı güvenli sayılmadığı için her çağrıda yenisi.
    static T Json<T>(string s) { return new JavaScriptSerializer().Deserialize<T>(s); }

    // Menü metninde & işareti kısayol harfi sayılır; olduğu gibi göster.
    static string Kacir(string s) { return s.Replace("&", "&&"); }
    static string Kisalt(string s, int n) { return s.Length <= n ? s : s.Substring(0, n - 1) + "…"; }

    static string Yazi(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : "";
    }
    static int Sayi(Dictionary<string, object> d, string k)
    {
        object v;
        try { return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : 0; }
        catch (Exception) { return 0; }
    }
    static bool Mantik(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
    }
    static Dictionary<string, object> Nesne(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
    }
    static List<Dictionary<string, object>> Liste(Dictionary<string, object> d, string k)
    {
        List<Dictionary<string, object>> l = new List<Dictionary<string, object>>();
        object v;
        if (d != null && d.TryGetValue(k, out v) && v is IEnumerable && !(v is string))
            foreach (object x in (IEnumerable)v)
            {
                Dictionary<string, object> o = x as Dictionary<string, object>;
                if (o != null) l.Add(o);
            }
        return l;
    }
}
