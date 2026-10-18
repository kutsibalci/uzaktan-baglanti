// Pano (kopyala-yapıştır) eşitleme yardımcısı — Unicode metin ve resim.
// Görünmez bir mesaj penceresiyle (HWND_MESSAGE) AddClipboardFormatListener kullanarak panoyu dinler.
// stdout'a her olay için tek satır JSON yazar (yalnızca ASCII; ASCII dışı karakterler \uXXXX ile kaçışlanır):
//   {"t":"ready"}                              başladı
//   {"t":"change","text":"..."}                pano metni değişti
//   {"t":"change","tooBig":true}               metin 1 MB'tan büyük
//   {"t":"change","image":true,"w":..,"h":..,"hash":"..","bytes":..,"png":"<base64>"}
//                                              panoda (metin yok) resim var: "PNG" biçimi (ekran alıntısı) ya da
//                                              CF_DIB/CF_DIBV5/CF_BITMAP; PNG'ye çevrilip gönderilir. hash = piksellerin SHA-1'i
//   {"t":"change","image":true,"tooBig":true,"w":..,"h":..,"hash":".."}   PNG 20 MB'tan büyük / çok fazla piksel
//   Metin ya da resim olmayan içerik (dosya listesi vb.) bildirilmez.
// stdin'den satır satır komut okur:
//   get                  -> {"t":"get","text":"..."} | {"t":"get","tooBig":true} | {"t":"get", <resim alanları>}
//                           | {"t":"get","text":"","empty":true} | {"t":"get","error":true}
//   set <base64-utf8>    -> {"t":"set","ok":true} | {"t":"set","ok":false,"msg":"..."}
//   setimg <base64-resim> (PNG/JPEG/GIF/BMP) -> panoya "PNG" akışı + CF_DIB (24 bit, saydamlık beyaza) olarak konur
//                        -> {"t":"set","ok":true,"image":true,"w":..,"h":..,"hash":".."} | {"t":"set","ok":false,"msg":"..."}
// stdin kapanınca çıkar.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Pano
{
    const int WM_CLIPBOARDUPDATE = 0x031D;
    const int WM_KOMUT = 0x8001; // WM_APP + 1: kuyrukta komut var
    const int WM_CIK = 0x8002;   // WM_APP + 2: stdin kapandı
    const int MAX_BAYT = 1024 * 1024;
    const int MAX_RESIM = 20 * 1024 * 1024;        // PNG/gelen resim en fazla 20 MB
    const long MAX_PIKSEL = 50L * 1000 * 1000;     // ~8000x6000; daha büyüğü belleği şişirir
    const int MAX_SATIR = 28 * 1024 * 1024;        // base64 ile 20 MB resim ~26,7 milyon karakter eder

    [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    static readonly Queue<string> komutlar = new Queue<string>();
    static Stream cikis;
    static System.Windows.Forms.Timer bekletme;

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
            if (m.Msg == WM_CLIPBOARDUPDATE)
            {
                // Bazı programlar panoyu art arda birkaç kez açıp kapar (ekran alıntısı: önce DIB, sonra PNG);
                // kısa bir bekleme sonunda tek kez okunur.
                bekletme.Stop();
                bekletme.Start();
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_KOMUT) { KomutlariIsle(); return; }
            if (m.Msg == WM_CIK) { Application.ExitThread(); return; }
            base.WndProc(ref m);
        }
    }

    [STAThread]
    static int Main()
    {
        cikis = Console.OpenStandardOutput();
        bekletme = new System.Windows.Forms.Timer();
        bekletme.Interval = 150;
        bekletme.Tick += delegate { bekletme.Stop(); PanoyuBildir("change"); };
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
                    if (satir.Length > MAX_SATIR)
                    {
                        // Cevap sırası bozulmasın: sunucu her komuta bir cevap bekler.
                        lock (komutlar) komutlar.Enqueue("buyuk");
                    }
                    else lock (komutlar) komutlar.Enqueue(satir);
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
            if (satir == "get") PanoyuBildir("get");
            else if (satir.StartsWith("set ")) Ayarla(satir.Substring(4));
            else if (satir.StartsWith("setimg ")) ResimAyarla(satir.Substring(7));
            else if (satir == "buyuk") Yaz("{\"t\":\"set\",\"ok\":false,\"msg\":" + Json("Veri çok büyük.") + "}");
            else Yaz("{\"t\":\"error\",\"msg\":\"bilinmeyen komut\"}");
        }
    }

    // Panodaki metni (yoksa resmi) okuyup "tur" türüyle bildirir. change olayında başka içerik sessizce geçilir.
    static void PanoyuBildir(string tur)
    {
        string metin = null;
        bool resimVar = false;
        bool okundu = false;
        for (int i = 0; i < 5 && !okundu; i++)
        {
            try
            {
                if (Clipboard.ContainsText(TextDataFormat.UnicodeText)) metin = Clipboard.GetText(TextDataFormat.UnicodeText);
                else resimVar = Clipboard.ContainsData("PNG") || Clipboard.ContainsData("image/png") || Clipboard.ContainsImage();
                okundu = true;
            }
            catch (Exception) { Thread.Sleep(60); } // pano başka süreçte açık
        }
        if (!okundu) { if (tur == "get") Yaz("{\"t\":\"get\",\"error\":true}"); return; }
        if (metin == null && resimVar && ResmiBildir(tur)) return;
        if (metin == null)
        {
            if (tur == "get") Yaz("{\"t\":\"get\",\"text\":\"\",\"empty\":true}");
            return;
        }
        if (Encoding.UTF8.GetByteCount(metin) > MAX_BAYT) { Yaz("{\"t\":\"" + tur + "\",\"tooBig\":true}"); return; }
        Yaz("{\"t\":\"" + tur + "\",\"text\":" + Json(metin) + "}");
    }

    // Panodaki resmi PNG olarak bildirir; okunamazsa false.
    static bool ResmiBildir(string tur)
    {
        byte[] png = null;
        Image kaynak = null;
        for (int i = 0; i < 5; i++)
        {
            try
            {
                // Önce "PNG" akışı (ekran alıntısı, tarayıcılar; saydamlığı korur), yoksa DIB/BITMAP.
                IDataObject d = Clipboard.GetDataObject();
                if (d != null)
                {
                    foreach (string bicim in new[] { "PNG", "image/png" })
                    {
                        if (png != null || !d.GetDataPresent(bicim)) continue;
                        MemoryStream ms = d.GetData(bicim) as MemoryStream;
                        if (ms != null && ms.Length > 8) png = ms.ToArray();
                    }
                }
                if (png == null) kaynak = Clipboard.GetImage();
                break;
            }
            catch (Exception) { png = null; kaynak = null; Thread.Sleep(60); }
        }
        try
        {
            if (png != null)
            {
                try { kaynak = Image.FromStream(new MemoryStream(png), false, false); }
                catch (Exception) { png = null; kaynak = Clipboard.GetImage(); } // bozuk PNG akışı: DIB'e dön
            }
            if (kaynak == null) return false;
            int w = kaynak.Width, h = kaynak.Height;
            if ((long)w * h > MAX_PIKSEL)
            {
                Yaz("{\"t\":\"" + tur + "\",\"image\":true,\"tooBig\":true,\"w\":" + w + ",\"h\":" + h + ",\"hash\":\"buyuk-" + w + "x" + h + "\"}");
                return true;
            }
            string ozet;
            using (Bitmap b32 = Ciz32(kaynak))
            {
                ozet = Ozet(b32);
                if (png == null) png = PngYap(kaynak);
            }
            if (png.Length > MAX_RESIM)
            {
                Yaz("{\"t\":\"" + tur + "\",\"image\":true,\"tooBig\":true,\"w\":" + w + ",\"h\":" + h + ",\"hash\":\"" + ozet + "\",\"bytes\":" + png.Length + "}");
                return true;
            }
            Yaz("{\"t\":\"" + tur + "\",\"image\":true,\"w\":" + w + ",\"h\":" + h + ",\"hash\":\"" + ozet + "\",\"bytes\":" + png.Length
                + ",\"png\":\"" + Convert.ToBase64String(png) + "\"}");
            return true;
        }
        catch (Exception) { return false; }
        finally { if (kaynak != null) kaynak.Dispose(); }
    }

    // Resmi 32 bit ARGB bitmap'e kopyalar (DPI'dan bağımsız, piksel piksel).
    static Bitmap Ciz32(Image img)
    {
        var b = new Bitmap(img.Width, img.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(b))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(img, new Rectangle(0, 0, img.Width, img.Height));
        }
        return b;
    }

    static byte[] PngYap(Image img)
    {
        using (var ms = new MemoryStream())
        {
            img.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    // Piksellerin SHA-1 özeti (boyutla birlikte): aynı resim hangi biçimden okunursa okunsun aynı çıkar (geri yankı önleme).
    static string Ozet(Bitmap b32)
    {
        int w = b32.Width, h = b32.Height;
        var veri = b32.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            using (var sha = SHA1.Create())
            {
                byte[] bas = Encoding.ASCII.GetBytes(w + "x" + h + ";");
                sha.TransformBlock(bas, 0, bas.Length, null, 0);
                var satir = new byte[w * 4];
                for (int y = 0; y < h; y++)
                {
                    Marshal.Copy(new IntPtr(veri.Scan0.ToInt64() + (long)y * veri.Stride), satir, 0, satir.Length);
                    sha.TransformBlock(satir, 0, satir.Length, null, 0);
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                var sb = new StringBuilder(40);
                foreach (byte x in sha.Hash) sb.Append(x.ToString("x2"));
                return sb.ToString();
            }
        }
        finally { b32.UnlockBits(veri); }
    }

    // CF_DIB: BITMAPINFOHEADER + alttan üste 24 bit satırlar. Saydam yerler beyaza karışır (her program yapıştırabilsin).
    static byte[] DibYap(Bitmap b32)
    {
        int w = b32.Width, h = b32.Height;
        using (var b24 = new Bitmap(w, h, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(b24))
            {
                g.Clear(Color.White);
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(b32, new Rectangle(0, 0, w, h));
            }
            int satirBayt = (w * 3 + 3) & ~3;
            var cikti = new byte[40 + (long)satirBayt * h];
            using (var bw = new BinaryWriter(new MemoryStream(cikti)))
            {
                bw.Write(40); bw.Write(w); bw.Write(h); bw.Write((short)1); bw.Write((short)24);
                bw.Write(0); bw.Write(satirBayt * h); bw.Write(2835); bw.Write(2835); bw.Write(0); bw.Write(0);
            }
            var veri = b24.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                for (int y = 0; y < h; y++)
                    Marshal.Copy(new IntPtr(veri.Scan0.ToInt64() + (long)y * veri.Stride), cikti, 40 + (h - 1 - y) * satirBayt, w * 3);
            }
            finally { b24.UnlockBits(veri); }
            return cikti;
        }
    }

    static void SetHata(string msg) { Yaz("{\"t\":\"set\",\"ok\":false,\"msg\":" + Json(msg) + "}"); }

    static void ResimAyarla(string b64)
    {
        byte[] bayt;
        try { bayt = Convert.FromBase64String(b64); }
        catch (Exception) { SetHata("Geçersiz veri."); return; }
        if (bayt.Length > MAX_RESIM) { SetHata("Resim çok büyük (en fazla 20 MB)."); return; }
        bool kaynakPng = bayt.Length > 8 && bayt[0] == 0x89 && bayt[1] == 0x50 && bayt[2] == 0x4E && bayt[3] == 0x47;
        Bitmap b32;
        try
        {
            using (var img = Image.FromStream(new MemoryStream(bayt), false, false))
            {
                if ((long)img.Width * img.Height > MAX_PIKSEL) { SetHata("Resim çok büyük (çok fazla piksel)."); return; }
                b32 = Ciz32(img);
            }
        }
        catch (Exception) { SetHata("Resim okunamadı (PNG, JPEG, GIF ya da BMP olmalı)."); return; }
        using (b32)
        {
            byte[] png, dib;
            string ozet;
            try
            {
                png = kaynakPng ? bayt : PngYap(b32);
                dib = DibYap(b32);
                ozet = Ozet(b32);
            }
            catch (Exception) { SetHata("Resim hazırlanamadı."); return; }
            for (int i = 0; i < 3; i++)
            {
                try
                {
                    var d = new DataObject();
                    d.SetData("PNG", false, new MemoryStream(png));
                    d.SetData(DataFormats.Dib, false, new MemoryStream(dib));
                    Clipboard.SetDataObject(d, true, 5, 100);
                    Yaz("{\"t\":\"set\",\"ok\":true,\"image\":true,\"w\":" + b32.Width + ",\"h\":" + b32.Height + ",\"hash\":\"" + ozet + "\"}");
                    return;
                }
                catch (Exception) { Thread.Sleep(150); }
            }
        }
        SetHata("Pano başka bir program tarafından kilitli.");
    }

    static void Ayarla(string b64)
    {
        string metin;
        try
        {
            byte[] bayt = Convert.FromBase64String(b64);
            if (bayt.Length > MAX_BAYT) { SetHata("Metin çok büyük."); return; }
            metin = new UTF8Encoding(false, true).GetString(bayt);
        }
        catch (Exception)
        {
            SetHata("Geçersiz veri.");
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
        SetHata("Pano başka bir program tarafından kilitli.");
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
