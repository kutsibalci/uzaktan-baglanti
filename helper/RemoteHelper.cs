// Ekran yakalama + fare/klavye simülasyonu yapan yardımcı süreç.
// stdin'den satır satır komut okur, cevapları stdout'a [tip:1][uzunluk:4 LE][veri] olarak yazar.
// Ekranlar cihaz adıyla seçilir (ör. \\.\DISPLAY1).
// Süreç monitör başına DPI farkındadır (Per-Monitor v2): tüm koordinatlar FİZİKSEL pikseldir. Sistem DPI farkındalığında
// (SetProcessDPIAware) ölçeklemesi ana ekrandan farklı olan monitörün sınırları sanal (ölçeklenmiş) gelir, oysa ekran
// yakalama (BitBlt) fiziksel piksel okur: ör. %125 ana ekran + %100 ikinci ekranda ikinci ekran 2400x1350 @2400 görünüyordu,
// gerçekte 1920x1080 @1920 — yakalanan karenin yalnızca bir kısmı o ekrandı, kalanı siyahtı.
//   cap <kalite> <maxGenislik> <ekran>  -> tip 1: JPEG
//   info                                -> tip 2: JSON (ekran listesi, fiziksel piksel; dpi, scale, adapter; üstte "dpiMode")
//   setmode <ekran> <gen> <yuk>         -> tip 2: JSON {"ok":bool}
//   move <ekran> <nx> <ny>              -> fareyi ekranda 0..1 normalize konuma taşır
//   map <ekran> <nx> <ny>               -> tip 2: JSON {"name","x","y"} move/pen'in gideceği fiziksel piksel (girdi göndermez)
//   down|up <left|right|middle>
//   wheel <dy> <dx>
//   key <vk> <1|0>
//   text <base64-utf8>
//   pen <ekran> <nx> <ny> <basınç 0-1024> <hover|down|move|up|out> <eğimX -90..90> <eğimY -90..90> <silgi 0|1>
//                                       -> sentetik tablet kalemi (Windows 10 1809+); geçersiz satır reddedilir
//   pentest                             -> tip 2: JSON {"ok":bool,...} kalem cihazı oluşturulabiliyor mu (girdi göndermez)
// Ayrıca: RemoteHelper.exe ask <base64 başlık> <base64 mesaj>  -> Evet=0, Hayır=1 çıkış kodu
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

class RemoteHelper
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
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

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try { Handle(line.Trim().Split(' ')); }
            catch (Exception e) { Console.Error.WriteLine("hata: " + e.Message); }
        }
        return 0;
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

    static void Capture(int quality, int maxWidth, string screen)
    {
        var m = Find(screen);
        if (m == null) { Write(1, new byte[0]); return; }
        var b = m.Bounds;
        if (frame == null || frame.Width != b.Width || frame.Height != b.Height)
        {
            if (frame != null) frame.Dispose();
            frame = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb);
        }
        using (var g = Graphics.FromImage(frame))
        {
            g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
            DrawCursor(g, b);
        }

        Bitmap toEncode = frame;
        bool scaled = false;
        if (maxWidth > 0 && b.Width > maxWidth)
        {
            int h = (int)((long)b.Height * maxWidth / b.Width);
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
            Write(1, ms.ToArray());
        }
        if (scaled) toEncode.Dispose();
    }

    static void DrawCursor(Graphics g, Rectangle b)
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
        DrawIconEx(hdc, ci.pt.x - b.X - ii.xHotspot, ci.pt.y - b.Y - ii.yHotspot, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
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

    // Cihaz bir kez oluşturulur ve yeniden kullanılır; başarısızsa en fazla 5 sn'de bir yeniden denenir.
    static bool PenDevice()
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
