// Pano (kopyala-yapıştır) eşitleme yardımcısı — yalnızca Unicode metin.
// Görünmez bir mesaj penceresiyle (HWND_MESSAGE) AddClipboardFormatListener kullanarak panoyu dinler.
// stdout'a her olay için tek satır JSON yazar (yalnızca ASCII; ASCII dışı karakterler \uXXXX ile kaçışlanır):
//   {"t":"ready"}                              başladı
//   {"t":"change","text":"..."}                pano metni değişti (metin olmayan içerik bildirilmez)
//   {"t":"change","tooBig":true}               metin 1 MB'tan büyük
// stdin'den satır satır komut okur:
//   get              -> {"t":"get","text":"..."} | {"t":"get","tooBig":true} | {"t":"get","text":"","empty":true} | {"t":"get","error":true}
//   set <base64-utf8> -> {"t":"set","ok":true} | {"t":"set","ok":false,"msg":"..."}
// stdin kapanınca çıkar.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Pano
{
    const int WM_CLIPBOARDUPDATE = 0x031D;
    const int WM_KOMUT = 0x8001; // WM_APP + 1: kuyrukta komut var
    const int WM_CIK = 0x8002;   // WM_APP + 2: stdin kapandı
    const int MAX_BAYT = 1024 * 1024;
    const int MAX_SATIR = 2 * 1024 * 1024; // base64 ile 1 MB metin ~1,4 MB eder

    [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    static readonly Queue<string> komutlar = new Queue<string>();
    static Stream cikis;

    // Yalnızca mesaj alan, ekranda hiç görünmeyen pencere.
    class Dinleyici : NativeWindow
    {
        public Dinleyici()
        {
            var cp = new CreateParams();
            cp.Parent = new IntPtr(-3); // HWND_MESSAGE
            CreateHandle(cp);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_CLIPBOARDUPDATE) { MetniBildir("change"); m.Result = IntPtr.Zero; return; }
            if (m.Msg == WM_KOMUT) { KomutlariIsle(); return; }
            if (m.Msg == WM_CIK) { Application.ExitThread(); return; }
            base.WndProc(ref m);
        }
    }

    [STAThread]
    static int Main()
    {
        cikis = Console.OpenStandardOutput();
        var pencere = new Dinleyici();
        IntPtr h = pencere.Handle;
        if (!AddClipboardFormatListener(h))
        {
            Yaz("{\"t\":\"error\",\"msg\":\"AddClipboardFormatListener " + Marshal.GetLastWin32Error() + "\"}");
            return 1;
        }

        // stdin ayrı bir iş parçacığında okunur; pano işlemleri STA ana iş parçacığında (pencere mesajıyla) yapılır.
        var okuyucu = new Thread(() =>
        {
            try
            {
                var sr = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string satir;
                while ((satir = sr.ReadLine()) != null)
                {
                    if (satir.Length > MAX_SATIR) continue;
                    lock (komutlar) komutlar.Enqueue(satir);
                    PostMessage(h, WM_KOMUT, IntPtr.Zero, IntPtr.Zero);
                }
            }
            catch (Exception) { }
            PostMessage(h, WM_CIK, IntPtr.Zero, IntPtr.Zero);
        });
        okuyucu.IsBackground = true;
        okuyucu.Start();

        Yaz("{\"t\":\"ready\"}");
        Application.Run();
        RemoveClipboardFormatListener(h);
        pencere.DestroyHandle();
        return 0;
    }

    static void KomutlariIsle()
    {
        for (;;)
        {
            string satir;
            lock (komutlar)
            {
                if (komutlar.Count == 0) return;
                satir = komutlar.Dequeue();
            }
            satir = satir.Trim();
            if (satir == "get") MetniBildir("get");
            else if (satir.StartsWith("set ")) Ayarla(satir.Substring(4));
            else Yaz("{\"t\":\"error\",\"msg\":\"bilinmeyen komut\"}");
        }
    }

    // Panodaki metni okuyup "tur" türüyle bildirir. change olayında metin olmayan içerik sessizce geçilir.
    static void MetniBildir(string tur)
    {
        string metin = null;
        bool okundu = false;
        for (int i = 0; i < 5 && !okundu; i++)
        {
            try
            {
                metin = Clipboard.ContainsText(TextDataFormat.UnicodeText) ? Clipboard.GetText(TextDataFormat.UnicodeText) : null;
                okundu = true;
            }
            catch (Exception) { Thread.Sleep(60); } // pano başka süreçte açık
        }
        if (!okundu) { if (tur == "get") Yaz("{\"t\":\"get\",\"error\":true}"); return; }
        if (metin == null)
        {
            if (tur == "get") Yaz("{\"t\":\"get\",\"text\":\"\",\"empty\":true}");
            return;
        }
        if (Encoding.UTF8.GetByteCount(metin) > MAX_BAYT) { Yaz("{\"t\":\"" + tur + "\",\"tooBig\":true}"); return; }
        Yaz("{\"t\":\"" + tur + "\",\"text\":" + Json(metin) + "}");
    }

    static void Ayarla(string b64)
    {
        string metin;
        try
        {
            byte[] bayt = Convert.FromBase64String(b64);
            if (bayt.Length > MAX_BAYT) { Yaz("{\"t\":\"set\",\"ok\":false,\"msg\":" + Json("Metin çok büyük.") + "}"); return; }
            metin = new UTF8Encoding(false, true).GetString(bayt);
        }
        catch (Exception)
        {
            Yaz("{\"t\":\"set\",\"ok\":false,\"msg\":" + Json("Geçersiz veri.") + "}");
            return;
        }
        // Pano başka bir süreç tarafından açık tutuluyorsa birkaç kez yeniden dene.
        for (int i = 0; i < 3; i++)
        {
            try
            {
                if (metin.Length == 0) Clipboard.Clear();
                else Clipboard.SetDataObject(new DataObject(DataFormats.UnicodeText, metin), true, 5, 100);
                Yaz("{\"t\":\"set\",\"ok\":true}");
                return;
            }
            catch (Exception) { Thread.Sleep(150); }
        }
        Yaz("{\"t\":\"set\",\"ok\":false,\"msg\":" + Json("Pano başka bir program tarafından kilitli.") + "}");
    }

    // JSON dizgesi; çıktı tamamen ASCII olsun diye 0x7F ve üstü de \uXXXX ile yazılır
    // (eşleşmemiş vekil karakterler de böylece bozulmadan taşınır).
    static string Json(string s)
    {
        var sb = new StringBuilder(s.Length + 16);
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c >= 0x7F) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static void Yaz(string satir)
    {
        try
        {
            byte[] b = Encoding.ASCII.GetBytes(satir + "\n");
            cikis.Write(b, 0, b.Length);
            cikis.Flush();
        }
        catch (IOException) { Environment.Exit(0); } // sunucu kapandı
    }
}
