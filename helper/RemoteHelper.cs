// Ekran yakalama + fare/klavye simülasyonu yapan yardımcı süreç.
// stdin'den satır satır komut okur, cevapları stdout'a [tip:1][uzunluk:4 LE][veri] olarak yazar.
// Ekranlar cihaz adıyla seçilir (ör. \\.\DISPLAY1).
// Süreç monitör başına DPI farkındadır (Per-Monitor v2): tüm koordinatlar FİZİKSEL pikseldir. Sistem DPI farkındalığında
// (SetProcessDPIAware) ölçeklemesi ana ekrandan farklı olan monitörün sınırları sanal (ölçeklenmiş) gelir, oysa ekran
// yakalama (BitBlt) fiziksel piksel okur: ör. %125 ana ekran + %100 ikinci ekranda ikinci ekran 2400x1350 @2400 görünüyordu,
// gerçekte 1920x1080 @1920 — yakalanan karenin yalnızca bir kısmı o ekrandı, kalanı siyahtı.
//   cap <kalite> <maxGenislik> <ekran>  -> tip 1: JPEG (masaüstü çoğaltma ile; olmazsa GDI. REMOTE_YAKALAMA=gdi: hep GDI)
//   info                                -> tip 2: JSON (ekran listesi, fiziksel piksel; dpi, scale, adapter; üstte "dpiMode")
//   setmode <ekran> <gen> <yuk>         -> tip 2: JSON {"ok":bool}
//   move <ekran> <nx> <ny>              -> fareyi ekranda 0..1 normalize konuma taşır
//   map <ekran> <nx> <ny>               -> tip 2: JSON {"name","x","y"} move/pen'in gideceği fiziksel piksel (girdi göndermez)
//   cursor                              -> tip 2: JSON {"ok","x","y"} imlecin şu anki yeri, fiziksel piksel (girdi göndermez; kumanda modu)
//   down|up <left|right|middle>
//   wheel <dy> <dx>
//   key <vk> <1|0>
//   text <base64-utf8>
//   pen <ekran> <nx> <ny> <basınç 0-1024> <hover|down|move|up|out> <eğimX -90..90> <eğimY -90..90> <silgi 0|1>
//                                       -> sentetik tablet kalemi (Windows 10 1809+); geçersiz satır reddedilir
//   pentest                             -> tip 2: JSON {"ok":bool,...} kalem cihazı oluşturulabiliyor mu (girdi göndermez)
// Ayrıca: RemoteHelper.exe ask <base64 başlık> <base64 mesaj>  -> Evet=0, Hayır=1 çıkış kodu
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class RemoteHelper
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint devNum, ref DISPLAY_DEVICE dd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int modeNum, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public uint StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields;
        public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    class Monitor { public string Name; public string Label; public string Adapter; public Rectangle Bounds; public bool Primary; public int Dpi; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;

    static Stream output;
    static Bitmap frame;
    static ImageCodecInfo jpegCodec;
    // Yalnızca ölçüm testleri için (test/ozellik-akicilik.js): REMOTE_TEST_DEGISEN=1 iken yakalanan görüntü her karede
    // biraz aşağı kaydırılır (sarmal). Böylece kullanıcının ekranına hiçbir şey açmadan "sürekli değişen ekran" elde edilir.
    // Kaydırma kopyalama sırasında yapılır (GDI'de iki şerit, çoğaltmada satır sırası); yakalama maliyeti gerçek yakalamayla aynıdır.
    // "a/b" biçiminde verilirse a ms kaydırır, b ms durur (durağan ekran: kareler aynı kalır, sunucu göndermez).
    static readonly string testEnv = Environment.GetEnvironmentVariable("REMOTE_TEST_DEGISEN") ?? "";
    static readonly bool testScroll = testEnv == "1" || testEnv.Contains("/");
    static int testOffset;
    static byte[] testLastJpeg;
    static string testLastKey;

    static bool TestMoving()
    {
        var p = testEnv.Split('/');
        if (p.Length != 2) return true;
        int a, b;
        if (!int.TryParse(p[0], out a) || !int.TryParse(p[1], out b) || a + b <= 0) return true;
        return (Environment.TickCount & int.MaxValue) % (a + b) < a;
    }
    static List<Monitor> monitors = new List<Monitor>();
    static DateTime monitorsAt = DateTime.MinValue;
    static string dpiMode = "yok";

    // En iyi DPI farkındalığını seç: Per-Monitor v2 (Windows 10 1703+) -> Per-Monitor (8.1+) -> sistem (eski yedek).
    static void DpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { dpiMode = "pmv2"; return; } } // PER_MONITOR_AWARE_V2
        catch (EntryPointNotFoundException) { }
        try { if (SetProcessDpiAwareness(2) == 0) { dpiMode = "pm"; return; } } // PROCESS_PER_MONITOR_DPI_AWARE
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
        if (SetProcessDPIAware()) dpiMode = "sistem";
    }

    static int Main(string[] args)
    {
        DpiAware();
        if (args.Length == 3 && args[0] == "ask") return Ask(B64(args[1]), B64(args[2]));

        output = Console.OpenStandardOutput();
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") jpegCodec = c;

        // Cevap üreten komutlar (cap, info, setmode, pentest...) sırayla ayrı bir iş parçacığında çalışır; cevapların
        // sırası korunur. Cevapsız girdi komutları (fare/klavye/metin) beklemeden burada çalışır: ekran yakalanırken
        // fare hareketi kuyrukta beklemez. pen de burada çalışır: JPEG yakalama (cap) sürerken kalem noktaları beklemesin;
        // pentest ile paylaşılan kalem aygıtının oluşturulması kilitlidir (PenDevice).
        var work = new BlockingCollection<string[]>();
        var worker = new Thread(() =>
        {
            foreach (var a in work.GetConsumingEnumerable())
            {
                if (a == null) { DxgiCapture.CloseIdle(null); continue; } // boşta kalan ekran çoğaltmalarını kapat
                try { Handle(a); }
                catch (Exception e) { Console.Error.WriteLine("hata: " + e.Message); }
            }
        });
        worker.IsBackground = true;
        worker.Start();
        var idle = new System.Threading.Timer((o) => { try { work.Add(null); } catch (InvalidOperationException) { } }, null, 5000, 5000);

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var a = line.Trim().Split(' ');
            if (!Immediate(a[0])) { work.Add(a); continue; }
            try { Handle(a); }
            catch (Exception e) { Console.Error.WriteLine("hata: " + e.Message); }
        }
        idle.Dispose();
        work.CompleteAdding();
        worker.Join(5000);
        return 0;
    }

    static bool Immediate(string cmd)
    {
        switch (cmd)
        {
            case "move": case "down": case "up": case "wheel": case "key": case "text": case "pen": return true;
            default: return false;
        }
    }

    static string B64(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }
    static double D(string s) { return double.Parse(s, CultureInfo.InvariantCulture); }
    static int I(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }

    static int Ask(string title, string message)
    {
        using (var owner = new Form { TopMost = true, ShowInTaskbar = false, Width = 0, Height = 0, StartPosition = FormStartPosition.CenterScreen })
        {
            owner.Show();
            owner.Activate();
            var r = MessageBox.Show(owner, message, title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            return r == DialogResult.Yes ? 0 : 1;
        }
    }

    // Ekran listesi kısa süre önbelleğe alınır; ekran eklenip çıkarılınca kendiliğinden güncellenir.
    static List<Monitor> Monitors(bool fresh)
    {
        if (!fresh && (DateTime.UtcNow - monitorsAt).TotalMilliseconds < 1000) return monitors;
        var list = new List<Monitor>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) =>
        {
            var mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(h, ref mi))
            {
                var b = mi.rcMonitor; // Per-Monitor farkındalıkta fiziksel piksel (negatif konum olabilir: solda/üstte)
                list.Add(new Monitor
                {
                    Name = mi.szDevice,
                    Label = MonitorLabel(mi.szDevice),
                    Adapter = AdapterLabel(mi.szDevice),
                    Bounds = new Rectangle(b.left, b.top, b.right - b.left, b.bottom - b.top),
                    Primary = (mi.dwFlags & 1) != 0,
                    Dpi = MonitorDpi(h)
                });
            }
            return true;
        }, IntPtr.Zero);
        // DISPLAY2 DISPLAY10'dan önce gelsin (sayısal sıra).
        list.Sort((a, b) => { int c = DisplayNo(a.Name).CompareTo(DisplayNo(b.Name)); return c != 0 ? c : string.CompareOrdinal(a.Name, b.Name); });
        monitors = list;
        monitorsAt = DateTime.UtcNow;
        return list;
    }

    static int DisplayNo(string name)
    {
        int i = name.Length;
        while (i > 0 && char.IsDigit(name[i - 1])) i--;
        int n;
        return int.TryParse(name.Substring(i), NumberStyles.None, CultureInfo.InvariantCulture, out n) ? n : int.MaxValue;
    }

    static int MonitorDpi(IntPtr h)
    {
        try { uint x, y; if (GetDpiForMonitor(h, 0, out x, out y) == 0) return (int)x; } // MDT_EFFECTIVE_DPI
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
        return 0;
    }

    static string MonitorLabel(string adapter)
    {
        var dd = new DISPLAY_DEVICE();
        dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        return EnumDisplayDevices(adapter, 0, ref dd, 0) ? dd.DeviceString : "";
    }

    // Ekran kartı / sürücü adı (sanal ekran sürücüsünü tanımak için, ör. "Virtual Display Driver").
    static string AdapterLabel(string name)
    {
        var dd = new DISPLAY_DEVICE();
        dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++)
        {
            if (dd.DeviceName == name) return dd.DeviceString;
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        }
        return "";
    }

    // Normalize (0..1) konumu ekranın fiziksel pikseline çevirir; move, pen ve map aynı hesabı kullanır.
    static Point MapPoint(Rectangle b, double nx, double ny)
    {
        nx = Math.Max(0, Math.Min(1, nx));
        ny = Math.Max(0, Math.Min(1, ny));
        return new Point(b.X + (int)Math.Round(nx * (b.Width - 1)), b.Y + (int)Math.Round(ny * (b.Height - 1)));
    }

    static Monitor Find(string name)
    {
        var list = Monitors(false);
        foreach (var m in list) if (m.Name == name) return m;
        foreach (var m in list) if (m.Primary) return m;
        return list.Count > 0 ? list[0] : null;
    }

    static void Handle(string[] a)
    {
        switch (a[0])
        {
            case "cap": Capture(I(a[1]), I(a[2]), a.Length > 3 ? a[3] : ""); break;
            case "info": Info(); break;
            case "setmode": SetMode(a[1], I(a[2]), I(a[3])); break;
            case "move":
                {
                    var m = Find(a[1]);
                    if (m == null) break;
                    var p = MapPoint(m.Bounds, D(a[2]), D(a[3]));
                    SetCursorPos(p.X, p.Y);
                    break;
                }
            case "map":
                {
                    // Yalnızca hesaplar, fareyi hareket ettirmez (testler için).
                    var m = Find(a.Length > 1 ? a[1] : "");
                    double nx, ny;
                    if (m == null || a.Length < 4 || !ParseUnit(a[2], out nx) || !ParseUnit(a[3], out ny)) { Write(2, Encoding.UTF8.GetBytes("{\"ok\":false}")); break; }
                    var p = MapPoint(m.Bounds, nx, ny);
                    Write(2, Encoding.UTF8.GetBytes(string.Format(CultureInfo.InvariantCulture, "{{\"ok\":true,\"name\":{0},\"x\":{1},\"y\":{2}}}", Json(m.Name), p.X, p.Y)));
                    break;
                }
            case "cursor":
                {
                    // Yalnızca okur (kumanda modu göreli hareketi buradan hesaplar).
                    POINT p;
                    bool ok = GetCursorPos(out p);
                    Write(2, Encoding.UTF8.GetBytes(string.Format(CultureInfo.InvariantCulture, "{{\"ok\":{0},\"x\":{1},\"y\":{2}}}", ok ? "true" : "false", p.x, p.y)));
                    break;
                }
            case "down":
            case "up": MouseButton(a[1], a[0] == "down"); break;
            case "wheel":
                {
                    int dy = I(a[1]), dx = a.Length > 2 ? I(a[2]) : 0;
                    if (dy != 0) Mouse(0x0800, (uint)dy);
                    if (dx != 0) Mouse(0x1000, (uint)dx);
                    break;
                }
            case "key": Key((ushort)I(a[1]), a[2] == "1"); break;
            case "text": Text(B64(a[1])); break;
            case "pen": Pen(a); break;
            case "pentest": PenTest(); break;
        }
    }

    static void Write(byte type, byte[] data)
    {
        var header = new byte[5];
        header[0] = type;
        BitConverter.GetBytes(data.Length).CopyTo(header, 1);
        output.Write(header, 0, 5);
        output.Write(data, 0, data.Length);
        output.Flush();
    }

    static string Json(string s)
    {
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    static void Info()
    {
        var sb = new StringBuilder("{\"dpiMode\":" + Json(dpiMode) + ",\"screens\":[");
        var list = Monitors(true);
        for (int i = 0; i < list.Count; i++)
        {
            var m = list[i];
            if (i > 0) sb.Append(',');
            // x, y, w, h: fiziksel piksel. scale: Windows ölçeklemesi (1.25 = %125), dpi 0 ise bilinmiyor.
            sb.AppendFormat(CultureInfo.InvariantCulture, "{{\"name\":{0},\"label\":{1},\"adapter\":{2},\"x\":{3},\"y\":{4},\"w\":{5},\"h\":{6},\"primary\":{7},\"dpi\":{8},\"scale\":{9}}}",
                Json(m.Name), Json(m.Label), Json(m.Adapter), m.Bounds.X, m.Bounds.Y, m.Bounds.Width, m.Bounds.Height, m.Primary ? "true" : "false",
                m.Dpi, m.Dpi > 0 ? Math.Round(m.Dpi / 96.0, 2) : 1);
        }
        sb.Append("]}");
        Write(2, Encoding.UTF8.GetBytes(sb.ToString()));
    }

    static void SetMode(string name, int w, int h)
    {
        var dm = new DEVMODE();
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        bool ok = EnumDisplaySettings(name, -1, ref dm); // ENUM_CURRENT_SETTINGS
        if (ok)
        {
            dm.dmPelsWidth = w;
            dm.dmPelsHeight = h;
            dm.dmFields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
            ok = ChangeDisplaySettingsEx(name, ref dm, IntPtr.Zero, 0x1, IntPtr.Zero) == 0; // CDS_UPDATEREGISTRY
        }
        monitorsAt = DateTime.MinValue;
        Write(2, Encoding.UTF8.GetBytes("{\"ok\":" + (ok ? "true" : "false") + "}"));
    }

    // Ekran değişmediyse (çoğaltma yeni kare vermedi, imleç ve ayarlar aynı) son JPEG yeniden gönderilir: kopyalama ve
    // sıkıştırma atlanır. Sunucu aynı kareyi zaten istemciye yollamaz; bu yalnızca durağan ekranda işlemciyi boşa harcamamak için.
    static byte[] lastJpeg;
    static string lastJpegKey;

    static void Capture(int quality, int maxWidth, string screen)
    {
        var m = Find(screen);
        if (m == null) { Write(1, new byte[0]); return; }
        var b = m.Bounds;

        // Önce masaüstü çoğaltma (hızlı); kullanılamazsa GDI. Çoğaltmanın boyutu ekranın gerçek piksel boyutudur.
        bool newImage;
        int dw, dh;
        bool dxgi = DxgiCapture.Poll(m.Name, out dw, out dh, out newImage);
        int fw = dxgi ? dw : b.Width, fh = dxgi ? dh : b.Height;
        if (frame == null || frame.Width != fw || frame.Height != fh)
        {
            if (frame != null) frame.Dispose();
            frame = new Bitmap(fw, fh, PixelFormat.Format32bppRgb);
            lastJpeg = null;
        }
        string testKey = quality + " " + maxWidth + " " + m.Name;
        if (testScroll && fh > 16)
        {
            // Test: durma anında gerçek ekran değişse de son kare aynen verilir (durağan ekran kesin olsun).
            if (!TestMoving() && testLastJpeg != null && testKey == testLastKey) { Write(1, testLastJpeg); return; }
            testOffset += Math.Max(1, fh / 60);
        }
        int k = testScroll ? testOffset % fh : 0;

        string key = quality + " " + maxWidth + " " + m.Name + " " + k + " " + CursorKey();
        if (dxgi && !newImage && lastJpeg != null && key == lastJpegKey) { Write(1, lastJpeg); return; }
        if (dxgi && !DxgiCapture.CopyTo(m.Name, frame, k))
        {
            dxgi = false;
            if (frame.Width != b.Width || frame.Height != b.Height) { frame.Dispose(); frame = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb); }
            fw = b.Width; fh = b.Height; k = testScroll ? testOffset % fh : 0;
        }
        using (var g = Graphics.FromImage(frame))
        {
            if (dxgi) { }
            else if (k > 0)
            {
                g.CopyFromScreen(b.X, b.Y + b.Height - k, 0, 0, new Size(b.Width, k), CopyPixelOperation.SourceCopy);
                g.CopyFromScreen(b.X, b.Y, 0, k, new Size(b.Width, b.Height - k), CopyPixelOperation.SourceCopy);
            }
            else g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
            DrawCursor(g, b, fw, fh);
        }

        Bitmap toEncode = frame;
        bool scaled = false;
        if (maxWidth > 0 && fw > maxWidth)
        {
            int h = (int)((long)fh * maxWidth / fw);
            toEncode = new Bitmap(maxWidth, h, PixelFormat.Format24bppRgb);
            scaled = true;
            using (var g = Graphics.FromImage(toEncode))
            {
                g.InterpolationMode = InterpolationMode.Bilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
                g.DrawImage(frame, 0, 0, maxWidth, h);
            }
        }

        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(10, Math.Min(95, quality)));
        using (var ms = new MemoryStream())
        {
            toEncode.Save(ms, jpegCodec, ep);
            var jpeg = ms.ToArray();
            lastJpeg = dxgi ? jpeg : null;
            lastJpegKey = key;
            if (testScroll) { testLastJpeg = jpeg; testLastKey = testKey; }
            Write(1, jpeg);
        }
        if (scaled) toEncode.Dispose();
    }

    static string CursorKey()
    {
        var ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci)) return "?";
        return ci.flags + "," + ci.hCursor + "," + ci.pt.x + "," + ci.pt.y;
    }

    // fw, fh: görüntünün boyutu. Ekranın bu süreçteki (DPI'ya göre sanallaştırılmış olabilen) boyutundan farklıysa konum ölçeklenir.
    static void DrawCursor(Graphics g, Rectangle b, int fw, int fh)
    {
        var ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci) || ci.flags != 1 || ci.hCursor == IntPtr.Zero) return;
        if (!b.Contains(ci.pt.x, ci.pt.y)) return;
        ICONINFO ii;
        if (!GetIconInfo(ci.hCursor, out ii)) return;
        if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
        if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
        IntPtr hdc = g.GetHdc();
        int x = (int)((long)(ci.pt.x - b.X) * fw / Math.Max(1, b.Width)), y = (int)((long)(ci.pt.y - b.Y) * fh / Math.Max(1, b.Height));
        DrawIconEx(hdc, x - ii.xHotspot, y - ii.yHotspot, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
        g.ReleaseHdc(hdc);
    }

    static void Mouse(uint flags, uint data)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dwFlags = flags;
        inp[0].u.mi.mouseData = data;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MouseButton(string button, bool down)
    {
        uint f;
        switch (button)
        {
            case "right": f = down ? 0x0008u : 0x0010u; break;
            case "middle": f = down ? 0x0020u : 0x0040u; break;
            default: f = down ? 0x0002u : 0x0004u; break;
        }
        Mouse(f, 0);
    }

    static bool IsExtended(ushort vk)
    {
        return (vk >= 33 && vk <= 40) || vk == 45 || vk == 46 || vk == 91 || vk == 92 || vk == 93
            || vk == 111 || vk == 144 || vk == 163 || vk == 165;
    }

    static void Key(ushort vk, bool down)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].u.ki.wVk = vk;
        inp[0].u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        inp[0].u.ki.dwFlags = (down ? 0 : KEYEVENTF_KEYUP) | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Text(string s)
    {
        var inp = new INPUT[s.Length * 2];
        for (int i = 0; i < s.Length; i++)
        {
            for (int k = 0; k < 2; k++)
            {
                var x = new INPUT();
                x.type = INPUT_KEYBOARD;
                x.u.ki.wScan = s[i];
                x.u.ki.dwFlags = KEYEVENTF_UNICODE | (k == 1 ? KEYEVENTF_KEYUP : 0);
                inp[i * 2 + k] = x;
            }
        }
        if (inp.Length > 0) SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    // ---------- Tablet kalemi (sentetik işaretçi, Windows 10 1809+) ----------
    // Yapılar winuser.h ile birebir. x64'te: POINTER_INFO 96, POINTER_PEN_INFO 120, POINTER_TYPE_INFO 152 bayt
    // (POINTER_TYPE_INFO'daki birlik 8 bayta hizalı; en büyük üyesi POINTER_TOUCH_INFO 144 bayt).

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr CreateSyntheticPointerDevice(int pointerType, uint maxCount, int mode);
    [DllImport("user32.dll", SetLastError = true)] static extern bool InjectSyntheticPointerInput(IntPtr device, [In] POINTER_TYPE_INFO[] info, uint count);

    [StructLayout(LayoutKind.Sequential)]
    struct POINTER_INFO
    {
        public int pointerType;
        public uint pointerId, frameId, pointerFlags;
        public IntPtr sourceDevice, hwndTarget;
        public POINT ptPixelLocation, ptHimetricLocation, ptPixelLocationRaw, ptHimetricLocationRaw;
        public uint dwTime, historyCount;
        public int InputData;
        public uint dwKeyStates;
        public ulong PerformanceCount;
        public int ButtonChangeType;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINTER_PEN_INFO
    {
        public POINTER_INFO pointerInfo;
        public uint penFlags, penMask, pressure, rotation;
        public int tiltX, tiltY;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct POINTER_TYPE_INFO
    {
        [FieldOffset(0)] public int type;
        [FieldOffset(8)] public POINTER_PEN_INFO penInfo;
        [FieldOffset(148)] public int touchInfoTail; // birliğin dokunmatik üyesi daha büyük: yapı boyutu winuser.h ile aynı olsun
    }

    const int PT_PEN = 3, POINTER_FEEDBACK_DEFAULT = 1;
    const uint PF_INRANGE = 0x2, PF_INCONTACT = 0x4, PF_PRIMARY = 0x2000, PF_DOWN = 0x10000, PF_UPDATE = 0x20000, PF_UP = 0x40000;
    const uint PEN_FLAG_INVERTED = 0x2, PEN_FLAG_ERASER = 0x4;
    const uint PEN_MASK_PRESSURE = 0x1, PEN_MASK_TILT_X = 0x4, PEN_MASK_TILT_Y = 0x8;

    static IntPtr penDevice = IntPtr.Zero;
    static string penDeviceError;
    static DateTime penDeviceTriedAt = DateTime.MinValue;
    static DateTime penErrorAt = DateTime.MinValue;
    static bool penInRange, penContact;
    static readonly object penLock = new object(); // pen (ana iş parçacığı) ve pentest (iş parçacığı) aygıtı paylaşır

    // Cihaz bir kez oluşturulur ve yeniden kullanılır; başarısızsa en fazla 5 sn'de bir yeniden denenir.
    static bool PenDevice()
    {
        lock (penLock) return PenDeviceLocked();
    }

    static bool PenDeviceLocked()
    {
        if (penDevice != IntPtr.Zero) return true;
        if (penDeviceError != null && (DateTime.UtcNow - penDeviceTriedAt).TotalSeconds < 5) return false;
        penDeviceTriedAt = DateTime.UtcNow;
        try
        {
            penDevice = CreateSyntheticPointerDevice(PT_PEN, 1, POINTER_FEEDBACK_DEFAULT);
            penDeviceError = penDevice == IntPtr.Zero ? "CreateSyntheticPointerDevice başarısız (hata " + Marshal.GetLastWin32Error() + ")" : null;
        }
        catch (EntryPointNotFoundException)
        {
            penDeviceError = "Bu Windows sürümü sentetik kalemi desteklemiyor (Windows 10 1809 veya üstü gerekir)";
        }
        return penDevice != IntPtr.Zero;
    }

    // Saniyede yüzlerce kalem olayı gelebilir; günlüğü boğmamak için en fazla 2 sn'de bir yaz.
    static void PenError(string msg)
    {
        if ((DateTime.UtcNow - penErrorAt).TotalSeconds < 2) return;
        penErrorAt = DateTime.UtcNow;
        Console.Error.WriteLine("hata: kalem: " + msg);
    }

    static bool ParseUnit(string s, out double v)
    {
        // Yalnızca "0.123" biçimi; NaN/Infinity aralık kontrolünü geçemez.
        return double.TryParse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out v) && v >= 0 && v <= 1;
    }

    static bool ParseInt(string s, int min, int max, out int v)
    {
        return int.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out v) && v >= min && v <= max;
    }

    static void Pen(string[] a)
    {
        double nx, ny;
        int pressure, tiltX, tiltY;
        if (a.Length != 9) { PenError("argüman sayısı yanlış"); return; }
        if (!ParseUnit(a[2], out nx) || !ParseUnit(a[3], out ny)) { PenError("konum geçersiz"); return; }
        if (!ParseInt(a[4], 0, 1024, out pressure)) { PenError("basınç geçersiz"); return; }
        string state = a[5];
        if (state != "hover" && state != "down" && state != "move" && state != "up" && state != "out") { PenError("durum geçersiz"); return; }
        if (!ParseInt(a[6], -90, 90, out tiltX) || !ParseInt(a[7], -90, 90, out tiltY)) { PenError("eğim geçersiz"); return; }
        if (a[8] != "0" && a[8] != "1") { PenError("silgi geçersiz"); return; }
        bool eraser = a[8] == "1";

        var m = Find(a[1]);
        if (m == null) return;
        if (!PenDevice()) { PenError(penDeviceError); return; }
        var pt = MapPoint(m.Bounds, nx, ny);
        int x = pt.X, y = pt.Y;

        // Geçerli olay sırası korunur: menzil (hover) -> temas (down/move) -> kalkış (up) -> menzil dışı (out).
        if (state == "down" && penContact) state = "move";
        if (state == "move" && !penContact) state = "hover";
        switch (state)
        {
            case "down":
                if (!penInRange && !PenSend(PF_INRANGE | PF_UPDATE, x, y, 0, tiltX, tiltY, eraser)) return;
                penInRange = true;
                penContact = PenSend(PF_INRANGE | PF_INCONTACT | PF_DOWN, x, y, pressure, tiltX, tiltY, eraser);
                break;
            case "move":
                PenSend(PF_INRANGE | PF_INCONTACT | PF_UPDATE, x, y, pressure, tiltX, tiltY, eraser);
                break;
            case "hover":
                if (penContact) { PenSend(PF_INRANGE | PF_UP, x, y, 0, tiltX, tiltY, eraser); penContact = false; }
                penInRange = PenSend(PF_INRANGE | PF_UPDATE, x, y, 0, tiltX, tiltY, eraser);
                break;
            case "up":
                if (!penContact) return;
                PenSend(PF_INRANGE | PF_UP, x, y, 0, tiltX, tiltY, eraser);
                penContact = false;
                break;
            case "out":
                if (penContact) { PenSend(PF_INRANGE | PF_UP, x, y, 0, tiltX, tiltY, eraser); penContact = false; }
                if (!penInRange) return;
                PenSend(PF_UPDATE, x, y, 0, tiltX, tiltY, eraser);
                penInRange = false;
                break;
        }
    }

    static bool PenSend(uint flags, int x, int y, int pressure, int tiltX, int tiltY, bool eraser)
    {
        bool contact = (flags & PF_INCONTACT) != 0;
        var info = new POINTER_TYPE_INFO[1];
        info[0].type = PT_PEN;
        info[0].penInfo.pointerInfo.pointerType = PT_PEN;
        info[0].penInfo.pointerInfo.pointerFlags = flags | PF_PRIMARY;
        info[0].penInfo.pointerInfo.ptPixelLocation.x = x;
        info[0].penInfo.pointerInfo.ptPixelLocation.y = y;
        // Silgi ucu: menzildeyken INVERTED, temas halindeyken ayrıca ERASER.
        info[0].penInfo.penFlags = eraser ? PEN_FLAG_INVERTED | (contact ? PEN_FLAG_ERASER : 0) : 0;
        info[0].penInfo.penMask = PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y;
        info[0].penInfo.pressure = contact ? (uint)pressure : 0;
        info[0].penInfo.tiltX = tiltX;
        info[0].penInfo.tiltY = tiltY;
        if (InjectSyntheticPointerInput(penDevice, info, 1)) return true;
        PenError("InjectSyntheticPointerInput başarısız (hata " + Marshal.GetLastWin32Error() + ")");
        return false;
    }

    // Yalnızca cihazın oluşturulabildiğini sınar; hiçbir girdi göndermez.
    static void PenTest()
    {
        bool ok = PenDevice();
        Write(2, Encoding.UTF8.GetBytes(string.Format("{{\"ok\":{0},\"hata\":{1},\"boyut\":[{2},{3},{4}],\"x64\":{5}}}",
            ok ? "true" : "false", Json(penDeviceError ?? ""),
            Marshal.SizeOf(typeof(POINTER_INFO)), Marshal.SizeOf(typeof(POINTER_PEN_INFO)), Marshal.SizeOf(typeof(POINTER_TYPE_INFO)),
            IntPtr.Size == 8 ? "true" : "false")));
    }
}

// Masaüstü çoğaltma (DXGI Desktop Duplication) ile hızlı ekran yakalama. GDI (CopyFromScreen) bu bilgisayarda kare başına
// 30-80 ms sürüyordu ve JPEG kare hızını sınırlıyordu; çoğaltma değişen kareyi GPU'dan birkaç ms'de verir, ekran değişmediyse
// hiç kopyalamaz. Kullanılamazsa (eski sürücü, güvenli masaüstü/UAC, döndürülmüş ya da HDR ekran, boyut uyuşmazlığı)
// Grab false döner ve çağıran GDI'ye döner; birkaç saniye sonra yeniden denenir. REMOTE_YAKALAMA=gdi ile tamamen kapatılır.
// Ek kütüphane yok: COM arayüzleri sanal tablo sırasıyla çağrılır. Yalnızca tek bir iş parçacığından kullanılmalı.
class DxgiCapture
{
    public static readonly bool Disabled = (Environment.GetEnvironmentVariable("REMOTE_YAKALAMA") ?? "").ToLowerInvariant() == "gdi";

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] static extern void MoveMemory(IntPtr dst, IntPtr src, UIntPtr n);

    static Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    static Guid IID_IDXGIOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
    static Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    const int DXGI_ERROR_NOT_FOUND = unchecked((int)0x887A0002);
    const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);
    const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OUTPUT_DESC
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public int Left, Top, Right, Bottom;
        public int AttachedToDesktop, Rotation;
        public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct OUTDUPL_DESC { public uint Width, Height, RefreshNum, RefreshDen, Format, ScanlineOrdering, Scaling, Rotation; public int DesktopImageInSystemMemory; }
    [StructLayout(LayoutKind.Sequential)]
    struct FRAME_INFO
    {
        public long LastPresentTime, LastMouseUpdateTime;
        public uint AccumulatedFrames; public int RectsCoalesced, ProtectedContentMaskedOut;
        public int PointerX, PointerY, PointerVisible;
        public uint TotalMetadataBufferSize, PointerShapeBufferSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct TEX2D_DESC { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
    [StructLayout(LayoutKind.Sequential)]
    struct MAPPED { public IntPtr Data; public uint RowPitch, DepthPitch; }

    delegate int EnumFn(IntPtr self, uint i, out IntPtr o);
    delegate int OutDescFn(IntPtr self, out OUTPUT_DESC d);
    delegate int DuplicateFn(IntPtr self, IntPtr device, out IntPtr dup);
    delegate void DuplDescFn(IntPtr self, out OUTDUPL_DESC d);
    delegate int AcquireFn(IntPtr self, uint ms, out FRAME_INFO fi, out IntPtr resource);
    delegate int ReleaseFrameFn(IntPtr self);
    delegate int CreateTexFn(IntPtr self, ref TEX2D_DESC d, IntPtr init, out IntPtr tex);
    delegate void CopyResFn(IntPtr self, IntPtr dst, IntPtr src);
    delegate int MapFn(IntPtr self, IntPtr res, uint sub, uint type, uint flags, out MAPPED m);
    delegate void UnmapFn(IntPtr self, IntPtr res, uint sub);

    static T Fn<T>(IntPtr obj, int index) where T : class
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, index * IntPtr.Size), typeof(T));
    }
    static void Rel(ref IntPtr p) { if (p != IntPtr.Zero) { Marshal.Release(p); p = IntPtr.Zero; } }

    class Session
    {
        public IntPtr Device, Context, Dup, Staging;
        public int W, H;
        public bool HasImage, Waited;
        public AcquireFn Acquire; public ReleaseFrameFn ReleaseFrame;
        public CopyResFn CopyResource; public MapFn Map; public UnmapFn Unmap;
        public void Close()
        {
            Rel(ref Staging); Rel(ref Dup); Rel(ref Context); Rel(ref Device);
        }
    }

    static readonly Dictionary<string, Session> sessions = new Dictionary<string, Session>();
    static readonly Dictionary<string, DateTime> retryAt = new Dictionary<string, DateTime>();
    static readonly Dictionary<string, string> lastError = new Dictionary<string, string>();
    static readonly Dictionary<string, DateTime> lastUse = new Dictionary<string, DateTime>();

    // Ekranın son görüntüsünü GPU'daki ara dokuya alır. newImage: son çağrıdan beri ekran görüntüsü değişti mi
    // (yalnızca fare hareketi değişiklik sayılmaz; imleci çağıran çizer). false: çoğaltma kullanılamıyor, GDI kullanılmalı.
    // w, h: çoğaltmanın verdiği gerçek piksel boyutu. Sistem DPI farkındalığında farklı ölçeklemeli ikinci ekranın
    // GDI'deki (sanallaştırılmış) boyutundan farklı olabilir; görüntü yine ekranın tamamıdır.
    public static bool Poll(string name, out int w, out int h, out bool newImage)
    {
        newImage = true;
        w = h = 0;
        if (Disabled) return false;
        CloseIdle(name);
        Session s;
        if (!sessions.TryGetValue(name, out s))
        {
            DateTime t;
            if (retryAt.TryGetValue(name, out t) && DateTime.UtcNow < t) return false;
            try { s = Open(name); }
            catch (Exception e) { Fail(name, e.Message); return false; }
            sessions[name] = s;
        }
        try
        {
            // Çoğaltma yeni açıldığında ilk kare boş (siyah, LastPresentTime 0) gelir; gerçek görüntü hemen ardından gelir.
            // Görüntü yokken birkaç kez kısa bekleyerek denenir (yalnızca ilk çağrıda; sonra beklemeden), yine yoksa GDI.
            int tries = s.HasImage ? 1 : (s.Waited ? 1 : 4);
            uint timeout = s.HasImage || s.Waited ? 0u : 50u;
            s.Waited = true;
            newImage = false;
            for (int i = 0; i < tries && !newImage; i++)
            {
                FRAME_INFO fi;
                IntPtr res;
                int hr = s.Acquire(s.Dup, timeout, out fi, out res);
                if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue;
                if (hr < 0) throw new Exception("AcquireNextFrame 0x" + hr.ToString("X8"));
                try
                {
                    // Yalnızca fare hareketi olduysa (LastPresentTime 0) görüntü değişmedi; imleci zaten biz çiziyoruz.
                    if (fi.LastPresentTime != 0)
                    {
                        IntPtr tex;
                        Guid iid = IID_ID3D11Texture2D;
                        if (Marshal.QueryInterface(res, ref iid, out tex) < 0) throw new Exception("ID3D11Texture2D yok");
                        s.CopyResource(s.Context, s.Staging, tex);
                        Marshal.Release(tex);
                        s.HasImage = true;
                        newImage = true;
                    }
                }
                finally
                {
                    Marshal.Release(res);
                    s.ReleaseFrame(s.Dup);
                }
            }
            w = s.W;
            h = s.H;
            return s.HasImage;
        }
        catch (Exception e)
        {
            // Erişim kaybı (ekran modu değişti, UAC/kilit ekranı) vb.: oturumu kapat, birkaç saniye sonra yeniden aç.
            Drop(name, e.Message);
            return false;
        }
    }

    // Ara dokudaki son görüntüyü frame'e (Format32bppRgb, ekran boyutunda) yazar. scroll > 0 ise satırlar o kadar
    // aşağı kaydırılarak (sarmal) yazılır: yalnızca ölçüm testi için (REMOTE_TEST_DEGISEN).
    public static bool CopyTo(string name, Bitmap frame, int scroll)
    {
        Session s;
        if (!sessions.TryGetValue(name, out s) || !s.HasImage || frame.Width != s.W || frame.Height != s.H) return false;
        try
        {
            MAPPED m;
            int hr = s.Map(s.Context, s.Staging, 0, 1 /* D3D11_MAP_READ */, 0, out m);
            if (hr < 0) throw new Exception("Map 0x" + hr.ToString("X8"));
            var bd = frame.LockBits(new Rectangle(0, 0, s.W, s.H), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            try
            {
                var row = new UIntPtr((uint)(s.W * 4));
                int k = ((scroll % s.H) + s.H) % s.H;
                for (int y = 0; y < s.H; y++)
                    MoveMemory(bd.Scan0 + ((y + k) % s.H) * bd.Stride, m.Data + y * (int)m.RowPitch, row);
            }
            finally
            {
                frame.UnlockBits(bd);
                s.Unmap(s.Context, s.Staging, 0);
            }
            return true;
        }
        catch (Exception e)
        {
            Drop(name, e.Message);
            return false;
        }
    }

    // Bir süredir yakalanmayan ekranın çoğaltmasını kapat (izleyen ekran değiştirdi ya da izleme bitti).
    public static void CloseIdle(string current)
    {
        var now = DateTime.UtcNow;
        if (current != null) lastUse[current] = now;
        List<string> old = null;
        foreach (var kv in sessions)
        {
            DateTime t;
            if (kv.Key != current && (!lastUse.TryGetValue(kv.Key, out t) || (now - t).TotalSeconds > 10)) (old = old ?? new List<string>()).Add(kv.Key);
        }
        if (old != null) foreach (var n in old) { sessions[n].Close(); sessions.Remove(n); }
    }

    static void Drop(string name, string msg)
    {
        Session s;
        if (sessions.TryGetValue(name, out s)) { s.Close(); sessions.Remove(name); }
        Fail(name, msg);
    }

    static void Fail(string name, string msg)
    {
        retryAt[name] = DateTime.UtcNow.AddSeconds(3);
        string old;
        if (!lastError.TryGetValue(name, out old) || old != msg)
        {
            lastError[name] = msg;
            Console.Error.WriteLine("DXGI yakalama kullanılamıyor (" + name + "): " + msg + " — GDI kullanılıyor");
        }
    }

    static Session Open(string name)
    {
        IntPtr factory = IntPtr.Zero, adapter = IntPtr.Zero, output = IntPtr.Zero, output1 = IntPtr.Zero;
        var s = new Session();
        try
        {
            Guid iid = IID_IDXGIFactory1;
            int hr = CreateDXGIFactory1(ref iid, out factory);
            if (hr < 0) throw new Exception("CreateDXGIFactory1 0x" + hr.ToString("X8"));
            var enumAdapters = Fn<EnumFn>(factory, 12); // IDXGIFactory1::EnumAdapters1
            for (uint a = 0; output == IntPtr.Zero; a++)
            {
                if (enumAdapters(factory, a, out adapter) == DXGI_ERROR_NOT_FOUND) break;
                var enumOutputs = Fn<EnumFn>(adapter, 7); // IDXGIAdapter::EnumOutputs
                for (uint o = 0; ; o++)
                {
                    IntPtr cand;
                    if (enumOutputs(adapter, o, out cand) == DXGI_ERROR_NOT_FOUND) break;
                    OUTPUT_DESC d;
                    Fn<OutDescFn>(cand, 7)(cand, out d); // IDXGIOutput::GetDesc
                    if (d.DeviceName == name) { output = cand; break; }
                    Marshal.Release(cand);
                }
                if (output == IntPtr.Zero) Rel(ref adapter);
            }
            if (output == IntPtr.Zero) throw new Exception("çıkış bulunamadı");

            int level;
            hr = D3D11CreateDevice(adapter, 0 /* D3D_DRIVER_TYPE_UNKNOWN */, IntPtr.Zero, 0x20 /* BGRA_SUPPORT */, IntPtr.Zero, 0, 7, out s.Device, out level, out s.Context);
            if (hr < 0) throw new Exception("D3D11CreateDevice 0x" + hr.ToString("X8"));
            iid = IID_IDXGIOutput1;
            hr = Marshal.QueryInterface(output, ref iid, out output1);
            if (hr < 0) throw new Exception("IDXGIOutput1 yok");
            hr = Fn<DuplicateFn>(output1, 22)(output1, s.Device, out s.Dup); // IDXGIOutput1::DuplicateOutput
            if (hr < 0) throw new Exception("DuplicateOutput 0x" + hr.ToString("X8"));

            OUTDUPL_DESC dd;
            Fn<DuplDescFn>(s.Dup, 7)(s.Dup, out dd); // IDXGIOutputDuplication::GetDesc
            if (dd.Width < 16 || dd.Height < 16 || dd.Width > 16384 || dd.Height > 16384) throw new Exception("boyut geçersiz: " + dd.Width + "x" + dd.Height);
            s.W = (int)dd.Width;
            s.H = (int)dd.Height;
            int w = s.W, h = s.H;
            if (dd.Rotation > 1) throw new Exception("ekran döndürülmüş");
            if (dd.DesktopImageInSystemMemory != 0) throw new Exception("masaüstü sistem belleğinde");
            if (dd.Format != DXGI_FORMAT_B8G8R8A8_UNORM) throw new Exception("biçim " + dd.Format);

            var td = new TEX2D_DESC
            {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1, Format = DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleCount = 1, Usage = 3 /* STAGING */, CPUAccessFlags = 0x20000 /* READ */,
            };
            hr = Fn<CreateTexFn>(s.Device, 5)(s.Device, ref td, IntPtr.Zero, out s.Staging); // ID3D11Device::CreateTexture2D
            if (hr < 0) throw new Exception("CreateTexture2D 0x" + hr.ToString("X8"));

            s.Acquire = Fn<AcquireFn>(s.Dup, 8);
            s.ReleaseFrame = Fn<ReleaseFrameFn>(s.Dup, 14);
            s.Map = Fn<MapFn>(s.Context, 14);
            s.Unmap = Fn<UnmapFn>(s.Context, 15);
            s.CopyResource = Fn<CopyResFn>(s.Context, 47);
            lastError.Remove(name);
            return s;
        }
        catch
        {
            s.Close();
            throw;
        }
        finally
        {
            Rel(ref output1); Rel(ref output); Rel(ref adapter); Rel(ref factory);
        }
    }
}
