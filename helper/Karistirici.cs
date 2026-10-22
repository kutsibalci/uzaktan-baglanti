// Karistirici.exe — ses karıştırıcı yardımcısı (Windows Ses Karıştırıcısı gibi). features/karisim.js istek gelince başlatır,
// 30 sn boşta kalınca stdin'i kapatır (o zaman çıkar). Windows Core Audio COM arayüzleri; ek DLL yok, yönetici izni gerekmez:
//   cihazlar     IMMDeviceEnumerator (etkin çıkış cihazları) + IPropertyStore (PKEY_Device_FriendlyName) + IAudioEndpointVolume
//   uygulamalar  IAudioSessionManager2 -> IAudioSessionEnumerator -> IAudioSessionControl2 (GetProcessId, IsSystemSoundsSession)
//                -> ISimpleAudioVolume. Süresi dolmuş oturumlar ve kapanmış süreçler atlanır; bir cihazda aynı süreç tek satır.
//   varsayılan   IPolicyConfig::SetDefaultEndpoint — belgelenmemiş ama Ses denetim masasının da kullandığı arayüz (Windows 7–11);
//                konsol + multimedya + iletişim rollerinin üçü birden.
// stdin: satır komutları; stdout: her komuta TEK satır JSON (yalnızca ASCII; Türkçe harfler \uXXXX — konsol kod sayfası bozmasın).
//   liste                   -> {"t":"liste","cihazlar":[{id,ad,varsayilan,multimedya,iletisim,ses,sessiz}],
//                               "uygulamalar":[{pid,ad,ses,sessiz,cihazId,sistem?}]}       ses: 0-100
//   cihaz-ses <id> <0-100>  -> {"t":"cihaz-ses","ok":true}         (hata: "ok":false,"msg":"..")
//   cihaz-sessiz <id> <0|1>
//   varsayilan <id>
//   uyg-ses <pid> <0-100>   (sürecin tüm çıkış cihazlarındaki oturumları)
//   uyg-sessiz <pid> <0|1>
//   bilinmeyen komut        -> {"t":"error","msg":".."}
// İstenen yüzde şimdiki değerin yuvarlanmışına eşitse seviye şimdiki değerin KENDİSİYLE yazılır: hiçbir şey değişmez (sürüklerken aynı
// yüzde tekrar gelirse ya da test ayar yolunu değişiklik yapmadan sınarsa).
// "Karistirici.exe kuru" (testler, sunucuda REMOTE_KARISIM_KURU=1): ayar komutları hiçbir şeyi değiştirmez, {"ok":true,"kuru":true} döner.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// ---------- COM arayüzleri (mmdeviceapi.h, endpointvolume.h, audiopolicy.h sırasıyla; kullanılmayan sondaki yöntemler yazılmadı) ----------

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[StructLayout(LayoutKind.Sequential)]
struct PropertyKey { public Guid fmtid; public int pid; }

// PROPVARIANT: vt + 3 ayrılmış WORD + 2 işaretçilik birlik (x64'te 24, x86'da 16 bayt)
[StructLayout(LayoutKind.Sequential)]
struct PropVariant { public ushort vt, r1, r2, r3; public IntPtr p, p2; }

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore
{
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PropertyKey key);
  [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume
{
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDB, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDB);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDB, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDB);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
  [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
  // IAudioSessionControl
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
  [PreserveSig] int GetGroupingParam(out Guid group);
  [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  // IAudioSessionControl2
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession(); // S_OK (0) = sistem sesleri, S_FALSE (1) = değil
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume
{
  [PreserveSig] int SetMasterVolume(float level, ref Guid context);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// Belgelenmemiş IPolicyConfig (Windows 7+): SetDefaultEndpoint'ten önceki 10 yöntem kullanılmaz, yalnızca sıra için yazıldı.
[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig
{
  [PreserveSig] int GetMixFormat();
  [PreserveSig] int GetDeviceFormat();
  [PreserveSig] int ResetDeviceFormat();
  [PreserveSig] int SetDeviceFormat();
  [PreserveSig] int GetProcessingPeriod();
  [PreserveSig] int SetProcessingPeriod();
  [PreserveSig] int GetShareMode();
  [PreserveSig] int SetShareMode();
  [PreserveSig] int GetPropertyValue();
  [PreserveSig] int SetPropertyValue();
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
}

static class Karistirici
{
  const int eRender = 0, eConsole = 0, eMultimedia = 1, eCommunications = 2;
  const int DEVICE_STATE_ACTIVE = 1;
  const int CLSCTX_ALL = 0x17;
  const int AudioSessionStateExpired = 2;

  static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  static readonly Guid CLSID_PolicyConfigClient = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
  static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
  static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
  static PropertyKey PKEY_Device_FriendlyName = new PropertyKey { fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid = 14 };
  static Guid baglam = Guid.Empty; // ayarların olay bağlamı (diğer programlar değişikliği bu kimlikle görür)

  static bool kuru;
  static Stream cikis;
  static IMMDeviceEnumerator numaralayici;

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
  const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint STILL_ACTIVE = 259;

  [MTAThread]
  static int Main(string[] args)
  {
    kuru = args.Length > 0 && args[0] == "kuru";
    cikis = Console.OpenStandardOutput();
    var giris = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    try
    {
      string satir;
      while ((satir = giris.ReadLine()) != null)
      {
        satir = satir.Trim();
        if (satir.Length == 0) continue;
        string t = satir.Split(' ')[0];
        string cevap;
        try { cevap = Komut(satir); }
        catch (Exception e) { cevap = "{\"t\":" + Json(t) + ",\"ok\":false,\"msg\":" + Json(e.Message) + "}"; }
        Yaz(cevap);
      }
    }
    catch (IOException) { /* sunucu kapandı */ }
    return 0;
  }

  static string Komut(string satir)
  {
    var p = satir.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
    string t = p[0];
    if (t == "liste" && p.Length == 1) return Liste();
    if (t == "varsayilan" && p.Length == 2) return Ayar(t, () => Varsayilan(p[1]));
    if (p.Length == 3)
    {
      int deger;
      if (!int.TryParse(p[2], NumberStyles.None, CultureInfo.InvariantCulture, out deger)) return Hata(t, "geçersiz değer");
      bool sessiz = t.EndsWith("-sessiz");
      if (sessiz ? deger > 1 : deger > 100) return Hata(t, "değer aralık dışında");
      uint pid = 0;
      bool uyg = t.StartsWith("uyg-");
      if (uyg && !uint.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid)) return Hata(t, "geçersiz süreç kimliği");
      if (t == "cihaz-ses") return Ayar(t, () => CihazSes(p[1], deger));
      if (t == "cihaz-sessiz") return Ayar(t, () => CihazSessiz(p[1], deger == 1));
      if (t == "uyg-ses") return Ayar(t, () => UygAyar(pid, deger, null));
      if (t == "uyg-sessiz") return Ayar(t, () => UygAyar(pid, -1, deger == 1));
    }
    return "{\"t\":\"error\",\"msg\":" + Json("bilinmeyen komut") + "}";
  }

  // Ayar komutu: kuru kipte hiçbir şeye dokunmaz. İş, hata metni döner (null = tamam).
  static string Ayar(string t, Func<string> is_)
  {
    if (kuru) return "{\"t\":" + Json(t) + ",\"ok\":true,\"kuru\":true}";
    string hata = is_();
    return hata == null ? "{\"t\":" + Json(t) + ",\"ok\":true}" : Hata(t, hata);
  }

  static string Hata(string t, string msg) { return "{\"t\":" + Json(t) + ",\"ok\":false,\"msg\":" + Json(msg) + "}"; }

  static void Kontrol(int hr, string ne)
  {
    if (hr < 0) throw new COMException(ne + " başarısız (0x" + hr.ToString("X8") + ")", hr);
  }

  static void Birak(object o) { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); }

  static IMMDeviceEnumerator Numaralayici()
  {
    if (numaralayici == null) numaralayici = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator));
    return numaralayici;
  }

  static int Yuzde(float v)
  {
    int y = (int)Math.Round(v * 100, MidpointRounding.AwayFromZero);
    return y < 0 ? 0 : y > 100 ? 100 : y;
  }

  // İstenen yüzde şimdikinin yuvarlanmışıysa şimdiki değerin kendisi (değişiklik olmasın), değilse yüzde / 100.
  static float Hedef(float simdi, int yuzde) { return Yuzde(simdi) == yuzde ? simdi : yuzde / 100f; }

  static string VarsayilanId(int rol)
  {
    IMMDevice d = null;
    try
    {
      string id;
      if (Numaralayici().GetDefaultAudioEndpoint(eRender, rol, out d) < 0 || d == null || d.GetId(out id) < 0) return null;
      return id;
    }
    finally { Birak(d); }
  }

  // Etkin çıkış cihazı (yoksa hata metniyle null).
  static IMMDevice Cihaz(string id, out string hata)
  {
    IMMDevice d;
    int durum;
    hata = null;
    if (Numaralayici().GetDevice(id, out d) < 0 || d == null) { hata = "ses cihazı bulunamadı"; return null; }
    if (d.GetState(out durum) < 0 || durum != DEVICE_STATE_ACTIVE) { Birak(d); hata = "ses cihazı etkin değil"; return null; }
    return d;
  }

  static IAudioEndpointVolume Hacim(IMMDevice d)
  {
    Guid iid = IID_IAudioEndpointVolume;
    object o;
    Kontrol(d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "IAudioEndpointVolume");
    return (IAudioEndpointVolume)o;
  }

  static string CihazAdi(IMMDevice d)
  {
    IPropertyStore ps = null;
    try
    {
      if (d.OpenPropertyStore(0 /* STGM_READ */, out ps) < 0 || ps == null) return null;
      PropVariant v;
      if (ps.GetValue(ref PKEY_Device_FriendlyName, out v) < 0) return null;
      try { return v.vt == 31 /* VT_LPWSTR */ && v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : null; }
      finally { PropVariantClear(ref v); }
    }
    finally { Birak(ps); }
  }

  // ---------- liste ----------
  class Uyg { public uint pid; public string ad, cihazId; public float ses; public bool sessiz, sistem; }

  static string Liste()
  {
    string vKonsol = VarsayilanId(eConsole), vMulti = VarsayilanId(eMultimedia), vIletisim = VarsayilanId(eCommunications);
    IMMDeviceCollection liste;
    Kontrol(Numaralayici().EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out liste), "EnumAudioEndpoints");
    var sb = new StringBuilder("{\"t\":\"liste\",\"cihazlar\":[");
    var uygulamalar = new List<Uyg>();
    try
    {
      uint n;
      Kontrol(liste.GetCount(out n), "IMMDeviceCollection.GetCount");
      int yazilan = 0;
      for (uint i = 0; i < n; i++)
      {
        IMMDevice d = null;
        IAudioEndpointVolume ev = null;
        try
        {
          string id;
          if (liste.Item(i, out d) < 0 || d == null || d.GetId(out id) < 0 || id == null) continue;
          float ses = 0;
          bool sessiz = false;
          try { ev = Hacim(d); ev.GetMasterVolumeLevelScalar(out ses); ev.GetMute(out sessiz); } catch { /* ses denetimi yok */ }
          if (yazilan++ > 0) sb.Append(',');
          sb.Append("{\"id\":").Append(Json(id)).Append(",\"ad\":").Append(Json(CihazAdi(d) ?? id))
            .Append(",\"varsayilan\":").Append(B(id == vKonsol)).Append(",\"multimedya\":").Append(B(id == vMulti))
            .Append(",\"iletisim\":").Append(B(id == vIletisim)).Append(",\"ses\":").Append(Yuzde(ses)).Append(",\"sessiz\":").Append(B(sessiz)).Append('}');
          try { Oturumlar(d, id, uygulamalar); } catch { /* oturum listesi alınamadı: cihaz yine görünür */ }
        }
        finally { Birak(ev); Birak(d); }
      }
    }
    finally { Birak(liste); }
    sb.Append("],\"uygulamalar\":[");
    for (int i = 0; i < uygulamalar.Count; i++)
    {
      var u = uygulamalar[i];
      if (i > 0) sb.Append(',');
      sb.Append("{\"pid\":").Append(u.pid).Append(",\"ad\":").Append(Json(u.ad)).Append(",\"ses\":").Append(Yuzde(u.ses))
        .Append(",\"sessiz\":").Append(B(u.sessiz)).Append(",\"cihazId\":").Append(Json(u.cihazId));
      if (u.sistem) sb.Append(",\"sistem\":true");
      sb.Append('}');
    }
    return sb.Append("]}").ToString();
  }

  // Cihazın ses oturumları. Aynı süreç bir cihazda tek satır: seviye en yükseği, sessiz yalnızca hepsi sessizse.
  static void Oturumlar(IMMDevice d, string cihazId, List<Uyg> cikti)
  {
    var bu = new Dictionary<uint, Uyg>();
    OturumlariGez(d, (ctl, vol, pid, sistem) =>
    {
      float ses; bool sessiz;
      if (vol.GetMasterVolume(out ses) < 0 || vol.GetMute(out sessiz) < 0) return;
      Uyg u;
      if (bu.TryGetValue(pid, out u)) { u.ses = Math.Max(u.ses, ses); u.sessiz = u.sessiz && sessiz; return; }
      string gorunen = null;
      try { ctl.GetDisplayName(out gorunen); } catch { }
      u = new Uyg { pid = pid, cihazId = cihazId, ses = ses, sessiz = sessiz, sistem = sistem, ad = sistem ? "Sistem sesleri" : UygAdi(pid, gorunen) };
      bu[pid] = u;
      cikti.Add(u);
    });
  }

  // Süresi dolmamış, süreci yaşayan her oturum için fn(denetim, seviye, pid, sistem sesleri mi).
  static void OturumlariGez(IMMDevice d, Action<IAudioSessionControl2, ISimpleAudioVolume, uint, bool> fn)
  {
    Guid iid = IID_IAudioSessionManager2;
    object o;
    Kontrol(d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "IAudioSessionManager2");
    var yonetici = (IAudioSessionManager2)o;
    IAudioSessionEnumerator oturumlar = null;
    try
    {
      Kontrol(yonetici.GetSessionEnumerator(out oturumlar), "GetSessionEnumerator");
      int n;
      Kontrol(oturumlar.GetCount(out n), "IAudioSessionEnumerator.GetCount");
      for (int i = 0; i < n; i++)
      {
        IAudioSessionControl2 ctl = null;
        try
        {
          int durum;
          uint pid;
          if (oturumlar.GetSession(i, out ctl) < 0 || ctl == null) continue;
          if (ctl.GetState(out durum) < 0 || durum == AudioSessionStateExpired) continue;
          if (ctl.GetProcessId(out pid) < 0) continue;
          bool sistem = ctl.IsSystemSoundsSession() == 0;
          if (!sistem && !Yasiyor(pid)) continue;
          var vol = ctl as ISimpleAudioVolume;
          if (vol != null) fn(ctl, vol, pid, sistem);
        }
        finally { Birak(ctl); }
      }
    }
    finally { Birak(oturumlar); Birak(yonetici); }
  }

  static bool Yasiyor(uint pid)
  {
    if (pid == 0) return false;
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() != 87; // ERROR_INVALID_PARAMETER: böyle süreç yok; erişim reddi = yaşıyor
    try { uint kod; return !GetExitCodeProcess(h, out kod) || kod == STILL_ACTIVE; }
    finally { CloseHandle(h); }
  }

  static readonly Dictionary<string, string> aciklamalar = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

  // Uygulama adı: oturumun kendi adı (varsa; "@dll,-id" kaynak dizgesi değilse), yoksa exe'nin dosya açıklaması
  // (Görev Yöneticisi gibi: "Google Chrome"), yoksa exe adı.
  static string UygAdi(uint pid, string gorunen)
  {
    if (!string.IsNullOrEmpty(gorunen) && gorunen.Trim().Length > 0 && !gorunen.StartsWith("@")) return gorunen.Trim();
    string yol = null;
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h != IntPtr.Zero)
    {
      try
      {
        var sb = new StringBuilder(1024);
        int boy = sb.Capacity;
        if (QueryFullProcessImageName(h, 0, sb, ref boy)) yol = sb.ToString();
      }
      finally { CloseHandle(h); }
    }
    if (yol != null)
    {
      string a;
      if (!aciklamalar.TryGetValue(yol, out a))
      {
        try { a = FileVersionInfo.GetVersionInfo(yol).FileDescription; } catch { a = null; }
        a = a == null || a.Trim().Length == 0 ? null : a.Trim();
        aciklamalar[yol] = a;
      }
      return a ?? Path.GetFileNameWithoutExtension(yol);
    }
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "Süreç " + pid; }
  }

  // ---------- ayarlar ----------
  static string CihazSes(string id, int yuzde)
  {
    string hata;
    IMMDevice d = Cihaz(id, out hata);
    if (d == null) return hata;
    IAudioEndpointVolume ev = null;
    try
    {
      ev = Hacim(d);
      float simdi;
      Kontrol(ev.GetMasterVolumeLevelScalar(out simdi), "GetMasterVolumeLevelScalar");
      Kontrol(ev.SetMasterVolumeLevelScalar(Hedef(simdi, yuzde), ref baglam), "SetMasterVolumeLevelScalar");
      return null;
    }
    finally { Birak(ev); Birak(d); }
  }

  static string CihazSessiz(string id, bool sessiz)
  {
    string hata;
    IMMDevice d = Cihaz(id, out hata);
    if (d == null) return hata;
    IAudioEndpointVolume ev = null;
    try
    {
      ev = Hacim(d);
      Kontrol(ev.SetMute(sessiz, ref baglam), "SetMute");
      return null;
    }
    finally { Birak(ev); Birak(d); }
  }

  static string Varsayilan(string id)
  {
    string hata;
    IMMDevice d = Cihaz(id, out hata);
    if (d == null) return hata;
    Birak(d);
    object o = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_PolicyConfigClient));
    try
    {
      var pc = o as IPolicyConfig;
      if (pc == null) return "Windows varsayılan cihaz arayüzünü (IPolicyConfig) vermedi";
      foreach (int rol in new[] { eConsole, eMultimedia, eCommunications }) Kontrol(pc.SetDefaultEndpoint(id, rol), "SetDefaultEndpoint");
      return null;
    }
    finally { Birak(o); }
  }

  // Sürecin bütün etkin çıkış cihazlarındaki oturumları: yuzde >= 0 ise seviye, sessiz verilmişse sessiz.
  static string UygAyar(uint pid, int yuzde, bool? sessiz)
  {
    IMMDeviceCollection liste;
    Kontrol(Numaralayici().EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out liste), "EnumAudioEndpoints");
    int adet = 0;
    string hata = null;
    try
    {
      uint n;
      Kontrol(liste.GetCount(out n), "IMMDeviceCollection.GetCount");
      for (uint i = 0; i < n; i++)
      {
        IMMDevice d = null;
        try
        {
          if (liste.Item(i, out d) < 0 || d == null) continue;
          OturumlariGez(d, (ctl, vol, p, sistem) =>
          {
            if (p != pid) return;
            int hr;
            if (yuzde >= 0)
            {
              float simdi;
              hr = vol.GetMasterVolume(out simdi);
              if (hr >= 0) hr = vol.SetMasterVolume(Hedef(simdi, yuzde), ref baglam);
            }
            else hr = vol.SetMute(sessiz.Value, ref baglam);
            if (hr >= 0) adet++; else hata = "ayar uygulanamadı (0x" + hr.ToString("X8") + ")";
          });
        }
        catch { /* bu cihazın oturumları alınamadı */ }
        finally { Birak(d); }
      }
    }
    finally { Birak(liste); }
    return adet > 0 ? null : hata ?? "uygulamanın ses oturumu yok (kapanmış olabilir)";
  }

  // ---------- çıktı ----------
  static string B(bool b) { return b ? "true" : "false"; }

  static void Yaz(string json)
  {
    var b = Encoding.ASCII.GetBytes(json + "\n");
    cikis.Write(b, 0, b.Length);
    cikis.Flush();
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
