// Ses.exe — bilgisayarın varsayılan ses çıkışını (hoparlör/kulaklık) WASAPI loopback ile yakalar
// ve stdout'a ham PCM yazar: s16le, 48000 Hz, 2 kanal (karışım biçimi ne olursa olsun çevrilir).
// Ses çalmıyorken loopback paket vermez; zaman çizelgesi aksamasın diye gerçek zamana göre sessizlik doldurulur.
// Varsayılan aygıt değişirse ya da aygıt geçersizleşirse yeniden başlar. stdout kapanınca çıkar.
// Sunucu (features/ses.js) bunu ffmpeg'e (Opus kodlayıcı) bağlar.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

// ---------- COM arayüzleri (mmdeviceapi.h / audioclient.h sırasıyla) ----------

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
  [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint frames);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

static class Ses
{
  const int OUT_RATE = 48000;
  const int eRender = 0, eConsole = 0;
  const int CLSCTX_ALL = 0x17;
  const int AUDCLNT_SHAREMODE_SHARED = 0;
  const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
  const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
  const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
  const int AUDCLNT_S_BUFFER_EMPTY = 0x08890001;
  const long BUFFER_HNS = 2000000; // 200 ms paylaşılan tampon (100 ns birimi)

  static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
  static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
  static readonly Guid SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
  static readonly Guid SUBTYPE_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");

  static IntPtr stdout;
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static double lastWriteMs; // en son ne zamana kadar çıktı yazıldı (gerçek zaman, ms)

  // Yeniden örnekleme durumu (parçalar arasında sürer)
  static double rsPos;
  static float rsPrevL, rsPrevR;

  // Kaynak biçim
  static int srcRate, srcChannels, srcBits, srcBlockAlign;
  static bool srcFloat;

  class StdoutClosed : Exception { }

  const int STD_OUTPUT_HANDLE = -11;
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int nStdHandle);

  // stderr UTF-8 (konsol kod sayfasını değiştirmeden — sunucuyla aynı konsolu paylaşıyoruz)
  static readonly TextWriter stderr = new StreamWriter(Console.OpenStandardError(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };

  [MTAThread]
  static int Main(string[] args)
  {
    // Console/FileStream akışları kırık boru hatasını (ERROR_NO_DATA) sessizce yutar, okuyan kapanınca
    // çıkamazdık; bu yüzden ham tanıtıcıya doğrudan WriteFile ile yazılır.
    stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    // Test kipi: "Ses.exe sentetik <hız> <kanal>" — ses aygıtı kullanmadan 1 sn'lik 1 kHz sinüsü
    // (float32, verilen hız/kanal) dönüştürme yolundan geçirip yazar. Hoparlörden ses çıkmaz.
    if (args.Length == 3 && args[0] == "sentetik")
    {
      try { Synthetic(int.Parse(args[1]), int.Parse(args[2])); } catch (StdoutClosed) { }
      return 0;
    }
    try
    {
      for (;;)
      {
        try { Capture(); }
        catch (StdoutClosed) { return 0; }
        catch (Exception e) { Log("hata: " + e.Message); }
        // Aygıt yok / geçersizleşti: kısa süre sessizlik yazıp yeniden dene.
        WaitWithSilence(1000);
      }
    }
    catch (StdoutClosed) { return 0; }
  }

  static void Log(string s)
  {
    try { stderr.WriteLine("Ses: " + s); } catch { }
  }

  static void Synthetic(int rate, int channels)
  {
    if (rate < 8000 || rate > 384000 || channels < 1 || channels > 8) throw new ArgumentException("geçersiz test biçimi");
    srcRate = rate; srcChannels = channels; srcBits = 32; srcFloat = true; srcBlockAlign = 4 * channels;
    ResetResampler();
    const int chunk = 441; // gerçek paketler gibi parça parça
    IntPtr mem = Marshal.AllocHGlobal(chunk * srcBlockAlign);
    try
    {
      float[] frame = new float[chunk * channels];
      for (int start = 0; start < rate; start += chunk)
      {
        int n = Math.Min(chunk, rate - start);
        for (int i = 0; i < n; i++)
        {
          // sol: 1 kHz sinüs, sağ: ters işaretli (kanal eşlemesi denetlenebilsin), diğer kanallar 0
          float v = (float)(0.5 * Math.Sin(2 * Math.PI * 1000 * (start + i) / rate));
          for (int c = 0; c < channels; c++) frame[i * channels + c] = c == 0 ? v : c == 1 ? -v : 0f;
        }
        Marshal.Copy(frame, 0, mem, n * channels);
        WriteConverted(mem, n, false);
      }
    }
    finally { Marshal.FreeHGlobal(mem); }
  }

  static void Check(int hr, string what)
  {
    if (hr < 0) throw new COMException(what + " başarısız (0x" + hr.ToString("X8") + ")", hr);
  }

  // Bir aygıt açılıp kapanana kadar yakalar. Aygıt değişirse/geçersizleşirse döner.
  static void Capture()
  {
    IMMDeviceEnumerator enumerator = null;
    IMMDevice device = null;
    IAudioClient client = null;
    IAudioCaptureClient capture = null;
    IntPtr mix = IntPtr.Zero;
    try
    {
      enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator));
      int hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
      if (hr < 0 || device == null) { Log("varsayılan ses çıkışı yok (0x" + hr.ToString("X8") + ")"); return; }
      string deviceId;
      Check(device.GetId(out deviceId), "GetId");

      Guid iid = IID_IAudioClient;
      object o;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "IMMDevice.Activate");
      client = (IAudioClient)o;
      Check(client.GetMixFormat(out mix), "GetMixFormat");
      ReadFormat(mix);
      Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER_HNS, 0, mix, IntPtr.Zero), "Initialize");
      Guid iidCap = IID_IAudioCaptureClient;
      Check(client.GetService(ref iidCap, out o), "GetService");
      capture = (IAudioCaptureClient)o;
      Check(client.Start(), "Start");
      Log(string.Format("yakalanıyor: {0} Hz, {1} kanal, {2} bit {3}", srcRate, srcChannels, srcBits, srcFloat ? "float" : "tamsayı"));
      ResetResampler();

      double lastDeviceCheck = clock.Elapsed.TotalMilliseconds;
      for (;;)
      {
        bool got = false;
        uint packet;
        hr = capture.GetNextPacketSize(out packet);
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { Log("aygıt geçersizleşti, yeniden başlatılıyor"); return; }
        Check(hr, "GetNextPacketSize");
        while (packet > 0)
        {
          IntPtr data; uint frames, flags; ulong devPos, qpcPos;
          hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
          if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { Log("aygıt geçersizleşti, yeniden başlatılıyor"); return; }
          if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
          Check(hr, "GetBuffer");
          if (frames > 0)
          {
            // Sessiz işaretli paketlerde veri anlamsızdır: sıfır olarak yazılır.
            WriteConverted(data, (int)frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
            got = true;
          }
          Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
          hr = capture.GetNextPacketSize(out packet);
          if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { Log("aygıt geçersizleşti, yeniden başlatılıyor"); return; }
          Check(hr, "GetNextPacketSize");
        }

        double now = clock.Elapsed.TotalMilliseconds;
        if (got) lastWriteMs = now;
        else FillSilence(now);

        // Varsayılan aygıt değişti mi? (bildirim arayüzü yerine 1 sn'de bir yokla)
        if (now - lastDeviceCheck > 1000)
        {
          lastDeviceCheck = now;
          IMMDevice cur = null;
          try
          {
            string curId = null;
            if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out cur) >= 0 && cur != null) cur.GetId(out curId);
            if (curId != deviceId) { Log("varsayılan ses çıkışı değişti, yeniden başlatılıyor"); return; }
          }
          finally { if (cur != null) Marshal.ReleaseComObject(cur); }
        }
        Thread.Sleep(5);
      }
    }
    finally
    {
      if (client != null) { try { client.Stop(); } catch { } }
      if (mix != IntPtr.Zero) Marshal.FreeCoTaskMem(mix);
      if (capture != null) Marshal.ReleaseComObject(capture);
      if (client != null) Marshal.ReleaseComObject(client);
      if (device != null) Marshal.ReleaseComObject(device);
      if (enumerator != null) Marshal.ReleaseComObject(enumerator);
    }
  }

  // WAVEFORMATEX / WAVEFORMATEXTENSIBLE okuma
  static void ReadFormat(IntPtr f)
  {
    int tag = (ushort)Marshal.ReadInt16(f, 0);
    srcChannels = (ushort)Marshal.ReadInt16(f, 2);
    srcRate = Marshal.ReadInt32(f, 4);
    srcBlockAlign = (ushort)Marshal.ReadInt16(f, 12);
    srcBits = (ushort)Marshal.ReadInt16(f, 14);
    if (tag == 0xFFFE)
    {
      // WAVEFORMATEXTENSIBLE: cbSize(2) @16, Samples(2) @18, dwChannelMask(4) @20, SubFormat(16) @24
      byte[] g = new byte[16];
      Marshal.Copy(new IntPtr(f.ToInt64() + 24), g, 0, 16);
      Guid sub = new Guid(g);
      if (sub == SUBTYPE_FLOAT) srcFloat = true;
      else if (sub == SUBTYPE_PCM) srcFloat = false;
      else throw new Exception("desteklenmeyen karışım biçimi " + sub);
    }
    else if (tag == 3) srcFloat = true;      // WAVE_FORMAT_IEEE_FLOAT
    else if (tag == 1) srcFloat = false;     // WAVE_FORMAT_PCM
    else throw new Exception("desteklenmeyen karışım biçimi etiketi " + tag);
    if (srcChannels < 1 || srcRate < 8000 || srcRate > 384000) throw new Exception("geçersiz karışım biçimi");
    if (srcFloat ? srcBits != 32 : (srcBits != 16 && srcBits != 24 && srcBits != 32))
      throw new Exception("desteklenmeyen örnek boyutu " + srcBits);
  }

  static float Sample(byte[] b, int off)
  {
    if (srcFloat) return BitConverter.ToSingle(b, off);
    switch (srcBits)
    {
      case 16: return BitConverter.ToInt16(b, off) / 32768f;
      case 24: return ((b[off] << 8 | b[off + 1] << 16 | b[off + 2] << 24) >> 8) / 8388608f;
      default: return BitConverter.ToInt32(b, off) / 2147483648f;
    }
  }

  static byte[] inBuf = new byte[0];
  static float[] tmpL = new float[0], tmpR = new float[0];

  // Paketi stereo float'a çevirir, gerekirse 48 kHz'e yeniden örnekler ve s16le olarak yazar.
  static void WriteConverted(IntPtr data, int frames, bool silent)
  {
    if (tmpL.Length < frames) { tmpL = new float[frames]; tmpR = new float[frames]; }
    if (silent)
    {
      Array.Clear(tmpL, 0, frames);
      Array.Clear(tmpR, 0, frames);
    }
    else
    {
      int bytes = frames * srcBlockAlign;
      if (inBuf.Length < bytes) inBuf = new byte[bytes];
      Marshal.Copy(data, inBuf, 0, bytes);
      int bps = srcBits / 8;
      for (int i = 0; i < frames; i++)
      {
        int off = i * srcBlockAlign;
        float l = Sample(inBuf, off);
        // Tek kanalsa iki kulağa çoğalt; çok kanallıysa ön sol/sağ (ilk iki kanal) alınır.
        float r = srcChannels > 1 ? Sample(inBuf, off + bps) : l;
        tmpL[i] = l; tmpR[i] = r;
      }
    }
    if (srcRate == OUT_RATE) WriteStereo(tmpL, tmpR, frames);
    else Resample(frames);
  }

  static void ResetResampler() { rsPos = 0; rsPrevL = 0; rsPrevR = 0; }

  static float[] rsL = new float[0], rsR = new float[0];

  // Basit doğrusal yeniden örnekleme. Konum 0 = önceki parçanın son karesi, 1..n = bu parçanın kareleri.
  static void Resample(int n)
  {
    double step = (double)srcRate / OUT_RATE;
    int maxOut = (int)(n / step) + 4;
    if (rsL.Length < maxOut) { rsL = new float[maxOut]; rsR = new float[maxOut]; }
    int outN = 0;
    while (rsPos + 1 <= n && outN < maxOut)
    {
      int i = (int)rsPos;
      float f = (float)(rsPos - i);
      float aL = i == 0 ? rsPrevL : tmpL[i - 1], aR = i == 0 ? rsPrevR : tmpR[i - 1];
      float bL = tmpL[i], bR = tmpR[i];
      rsL[outN] = aL + (bL - aL) * f;
      rsR[outN] = aR + (bR - aR) * f;
      outN++;
      rsPos += step;
    }
    rsPos -= n;
    rsPrevL = tmpL[n - 1]; rsPrevR = tmpR[n - 1];
    WriteStereo(rsL, rsR, outN);
  }

  static byte[] outBuf = new byte[0];

  static void WriteStereo(float[] l, float[] r, int frames)
  {
    int bytes = frames * 4;
    if (outBuf.Length < bytes) outBuf = new byte[bytes];
    for (int i = 0; i < frames; i++)
    {
      short a = ToS16(l[i]), b = ToS16(r[i]);
      int o = i * 4;
      outBuf[o] = (byte)a; outBuf[o + 1] = (byte)(a >> 8);
      outBuf[o + 2] = (byte)b; outBuf[o + 3] = (byte)(b >> 8);
    }
    Write(outBuf, bytes);
  }

  static short ToS16(float v)
  {
    if (float.IsNaN(v)) return 0;
    int s = (int)Math.Round(v * 32767f);
    return (short)(s > 32767 ? 32767 : s < -32768 ? -32768 : s);
  }

  static void Write(byte[] b, int n)
  {
    int off = 0;
    while (off < n)
    {
      uint written;
      // Okuyan taraf kapandıysa WriteFile başarısız olur (ERROR_NO_DATA / ERROR_BROKEN_PIPE): çık.
      if (!WriteFile(stdout, b, off, (uint)(n - off), out written, IntPtr.Zero) || written == 0) throw new StdoutClosed();
      off += (int)written;
    }
  }

  // byte[] içinde ofsetten yazmak için işaretçi aritmetiği yerine sabitlenmiş tampon kullanılır.
  static bool WriteFile(IntPtr h, byte[] b, int off, uint count, out uint written, IntPtr overlapped)
  {
    GCHandle pin = GCHandle.Alloc(b, GCHandleType.Pinned);
    try { return WriteFileNative(h, new IntPtr(pin.AddrOfPinnedObject().ToInt64() + off), count, out written, overlapped); }
    finally { pin.Free(); }
  }

  [DllImport("kernel32.dll", EntryPoint = "WriteFile", SetLastError = true)]
  static extern bool WriteFileNative(IntPtr hFile, IntPtr buffer, uint count, out uint written, IntPtr overlapped);

  const int SLICE_MS = 10;              // sessizlik 10 ms'lik dilimlerle yazılır
  const int SILENCE_AFTER_MS = 30;      // bu kadar süre paket gelmezse sessizlik doldurulmaya başlanır
  static readonly byte[] silenceSlice = new byte[OUT_RATE / 1000 * SLICE_MS * 4];

  // Loopback ses çalmıyorken paket vermez: gerçek zamana göre eksik kalan süre kadar sıfır yaz.
  static void FillSilence(double now)
  {
    double gap = now - lastWriteMs;
    if (gap < SILENCE_AFTER_MS) return;
    if (gap > 1000) { lastWriteMs = now - SILENCE_AFTER_MS; gap = SILENCE_AFTER_MS; } // uzun takılmada geçmişi doldurma
    int slices = (int)(gap / SLICE_MS);
    for (int i = 0; i < slices; i++) Write(silenceSlice, silenceSlice.Length);
    lastWriteMs += slices * SLICE_MS;
    ResetResampler();
  }

  static void WaitWithSilence(int ms)
  {
    double end = clock.Elapsed.TotalMilliseconds + ms;
    for (;;)
    {
      double now = clock.Elapsed.TotalMilliseconds;
      FillSilence(now);
      if (now >= end) return;
      Thread.Sleep(10);
    }
  }
}
