// Gizlilik perdesi: uzaktan bağlıyken bilgisayarın kendi ekranını karartır.
// Her monitörde tam ekran, en üstte, siyah, tıklama-geçirgen bir pencere açar. Pencereler
// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) ile ekran yakalamadan hariç tutulur; böylece
// uzaktaki kişi (GDI/BitBlt, gdigrab) masaüstünü normal görür. Bu çağrı başarısız olursa perde AÇILMAZ.
//
// Sunucu ile konuşma (stdout, satır başına bir JSON):
//   açıldı      -> {"ok":true,"pencereler":[{...}]}
//   açılamadı   -> {"ok":false,"hata":"..."}   (çıkış kodu 2)
//   kapandı     -> {"kapandi":"tus"|"hata","hata"?:"..."}
// stdin kapanınca ya da "kapat" satırı gelince kapanır (sunucu ölünce perde kalmaz).
// Yerel kaçış: Ctrl+Alt+Shift+P perdeyi kapatır (bilgisayarın başındaki kişi kilitli kalmasın).
//
// Yalnızca testler için: --yakalamaya-goster (yakalama hariç tutma YAPILMAZ; testin duyarlılığını kanıtlamak için)
//                       --desen (perde değil, ana ekranın ortasında açık renkli bir test deseni gösterir)
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class Perde : ApplicationContext
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    public const int WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80,
        WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000;
    const uint WDA_EXCLUDEFROMCAPTURE = 0x11, LWA_ALPHA = 0x2;
    const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
    const uint SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const int HOTKEY_ID = 0x5045; // "PE"
    const int WM_HOTKEY = 0x0312;

    static StreamWriter output;
    static readonly object outputLock = new object();

    readonly bool gorunur, desen;
    readonly List<PerdePenceresi> pencereler = new List<PerdePenceresi>();
    readonly Kontrol kontrol;
    readonly System.Windows.Forms.Timer zamanlayici;
    bool kapaniyor;
    public int CikisKodu;

    [STAThread]
    static int Main(string[] args)
    {
        // Çoklu monitörde farklı ölçekler olsa bile fiziksel piksellerle çalış.
        bool dpi = false;
        try { dpi = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { } // PER_MONITOR_AWARE_V2
        if (!dpi) SetProcessDPIAware();

        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        bool gorunur = Array.IndexOf(args, "--yakalamaya-goster") >= 0;
        bool desen = Array.IndexOf(args, "--desen") >= 0;

        var perde = new Perde(gorunur, desen);
        string hata;
        if (!perde.Ac(out hata))
        {
            perde.Temizle();
            Yaz("{\"ok\":false,\"hata\":" + Json(hata) + "}");
            return 2;
        }
        Yaz("{\"ok\":true,\"pencereler\":[" + perde.PencereBilgisi() + "]}");

        // Sunucu ölünce (stdin kapanınca) perde de kapanır.
        var okuyucu = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                    if (line.Trim() == "kapat") break;
            }
            catch { }
            perde.Kapat(0, null, null);
        });
        okuyucu.IsBackground = true;
        okuyucu.Start();

        Application.Run(perde);
        return perde.CikisKodu;
    }

    static void Yaz(string line)
    {
        lock (outputLock)
        {
            try { output.WriteLine(line); output.Flush(); } catch { /* sunucu kapanmış */ }
        }
    }

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    Perde(bool gorunur, bool desen)
    {
        this.gorunur = gorunur;
        this.desen = desen;
        kontrol = new Kontrol(this);
        zamanlayici = new System.Windows.Forms.Timer { Interval = 1000 };
        zamanlayici.Tick += (s, e) => Denetle();
        SystemEvents.DisplaySettingsChanged += EkranlarDegisti;
    }

    // Pencereleri oluşturur. Yakalamadan hariç tutma doğrulanmadan hiçbir pencere gösterilmez.
    bool Ac(out string hata)
    {
        hata = null;
        if (!desen && !RegisterHotKey(kontrol.Handle, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, (uint)Keys.P))
        {
            hata = "Ctrl+Alt+Shift+P kısayolu kaydedilemedi (başka bir program kullanıyor olabilir); perde açılmadı.";
            return false;
        }
        var alanlar = new List<Rectangle>();
        if (desen)
        {
            var b = Screen.PrimaryScreen.Bounds;
            alanlar.Add(new Rectangle(b.X + b.Width / 4, b.Y + b.Height / 4, b.Width / 2, b.Height / 2));
        }
        else
        {
            foreach (var s in Screen.AllScreens) alanlar.Add(s.Bounds);
        }
        if (alanlar.Count == 0) { hata = "Ekran bulunamadı."; return false; }

        foreach (var alan in alanlar)
        {
            var p = new PerdePenceresi(alan, desen);
            pencereler.Add(p);
            IntPtr h = p.Handle; // pencere oluşturulur ama henüz gösterilmez
            if (!gorunur && !desen)
            {
                uint a;
                if (!SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) || !GetWindowDisplayAffinity(h, out a) || a != WDA_EXCLUDEFROMCAPTURE)
                {
                    hata = "Perde ekran yakalamadan hariç tutulamadı (Windows 10 2004 veya üstü gerekir, hata " + Marshal.GetLastWin32Error()
                        + "). Perde açılsaydı uzaktaki kişi de siyah ekran görecekti; açılmadı.";
                    return false;
                }
            }
        }
        foreach (var p in pencereler)
        {
            p.Show();
            SetWindowPos(p.Handle, HWND_TOPMOST, p.Alan.X, p.Alan.Y, p.Alan.Width, p.Alan.Height, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
        zamanlayici.Start();
        return true;
    }

    string PencereBilgisi()
    {
        var sb = new StringBuilder();
        foreach (var p in pencereler)
        {
            if (sb.Length > 0) sb.Append(',');
            uint a;
            if (!GetWindowDisplayAffinity(p.Handle, out a)) a = 0;
            // Pencerenin ortasındaki noktada sistemin isabet testi hangi pencereyi buluyor?
            // Tıklama-geçirgen perde asla bulunmamalı (tıklama alttaki pencereye gider).
            var orta = new POINT { x = p.Alan.X + p.Alan.Width / 2, y = p.Alan.Y + p.Alan.Height / 2 };
            IntPtr bulunan = WindowFromPoint(orta);
            bool gecer = bulunan == IntPtr.Zero || GetAncestor(bulunan, 2) != p.Handle; // GA_ROOT
            sb.AppendFormat("{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3},\"exstyle\":{4},\"affinity\":{5},\"tiklamaGecer\":{6}}}",
                p.Alan.X, p.Alan.Y, p.Alan.Width, p.Alan.Height, GetWindowLong(p.Handle, -20), a, gecer ? "true" : "false");
        }
        return sb.ToString();
    }

    // Saniyede bir: en üstte kal, konumu koru, yakalama hariç tutması kaybolduysa kapan.
    void Denetle()
    {
        if (desen) return; // test deseni perdenin önüne geçmesin
        foreach (var p in pencereler)
        {
            if (p.IsDisposed) continue;
            if (!gorunur && !desen)
            {
                uint a;
                if (!GetWindowDisplayAffinity(p.Handle, out a) || a != WDA_EXCLUDEFROMCAPTURE)
                {
                    if (!SetWindowDisplayAffinity(p.Handle, WDA_EXCLUDEFROMCAPTURE))
                    {
                        Kapat(3, "hata", "Perdenin yakalama hariç tutması kayboldu; perde kapatıldı.");
                        return;
                    }
                }
            }
            SetWindowPos(p.Handle, HWND_TOPMOST, p.Alan.X, p.Alan.Y, p.Alan.Width, p.Alan.Height, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
    }

    // Monitör eklenip çıkarılınca pencereleri yeniden kur.
    void EkranlarDegisti(object sender, EventArgs e)
    {
        if (kapaniyor) return;
        zamanlayici.Stop();
        Temizle();
        string hata;
        if (!Ac(out hata)) Kapat(3, "hata", hata);
    }

    void Temizle()
    {
        UnregisterHotKey(kontrol.Handle, HOTKEY_ID);
        foreach (var p in pencereler) { try { p.Close(); p.Dispose(); } catch { } }
        pencereler.Clear();
    }

    // Her iş parçacığından çağrılabilir.
    public void Kapat(int kod, string neden, string hata)
    {
        if (kontrol.IsDisposed) return;
        try
        {
            kontrol.BeginInvoke((MethodInvoker)(() =>
            {
                if (kapaniyor) return;
                kapaniyor = true;
                zamanlayici.Stop();
                SystemEvents.DisplaySettingsChanged -= EkranlarDegisti;
                Temizle();
                if (neden != null) Yaz("{\"kapandi\":" + Json(neden) + (hata != null ? ",\"hata\":" + Json(hata) : "") + "}");
                CikisKodu = kod;
                ExitThread();
            }));
        }
        catch (InvalidOperationException) { }
    }

    // Kısayol tuşunu alan, hiç gösterilmeyen yardımcı pencere.
    class Kontrol : Form
    {
        readonly Perde perde;
        public Kontrol(Perde perde) { this.perde = perde; ShowInTaskbar = false; CreateHandle(); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID) perde.Kapat(0, "tus", null);
            base.WndProc(ref m);
        }
    }

    class PerdePenceresi : Form
    {
        public Rectangle Alan { get; private set; }
        readonly bool desen;

        public PerdePenceresi(Rectangle alan, bool desen)
        {
            Alan = alan;
            this.desen = desen;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = alan;
            ShowInTaskbar = false;
            BackColor = desen ? Color.FromArgb(235, 235, 235) : Color.Black;
            DoubleBuffered = true;
            Text = desen ? "Perde test deseni" : "Gizlilik perdesi";
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Katmanlı pencere, saydamlık verilmeden görünmez; tamamen opak yap.
            SetLayeredWindowAttributes(Handle, 0, 255, LWA_ALPHA);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            var r = ClientRectangle;
            if (desen)
            {
                // Siyah olmayan, belirgin bir desen: test, perdenin yakalamada görünmediğini bununla ölçer.
                using (var b = new SolidBrush(Color.FromArgb(60, 120, 220)))
                    for (int y = 0; y < r.Height; y += 80)
                        for (int x = (y / 80) % 2 * 80; x < r.Width; x += 160)
                            g.FillRectangle(b, x, y, 80, 80);
                return;
            }
            using (var f1 = new Font("Segoe UI", 13f))
            using (var f2 = new Font("Segoe UI", 9f))
            using (var b1 = new SolidBrush(Color.FromArgb(110, 110, 110)))
            using (var b2 = new SolidBrush(Color.FromArgb(70, 70, 70)))
            {
                const string s1 = "Bu bilgisayar uzaktan kullanılıyor";
                const string s2 = "Perdeyi kaldırmak için: Ctrl+Alt+Shift+P";
                var z1 = g.MeasureString(s1, f1);
                var z2 = g.MeasureString(s2, f2);
                float y = r.Height / 2f - (z1.Height + z2.Height) / 2f;
                g.DrawString(s1, f1, b1, (r.Width - z1.Width) / 2f, y);
                g.DrawString(s2, f2, b2, (r.Width - z2.Width) / 2f, y + z1.Height + 4);
            }
        }
    }
}
