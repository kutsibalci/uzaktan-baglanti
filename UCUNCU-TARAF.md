# Üçüncü taraf bileşenler

Uzaktan Bağlantı'nın kendi kodu **GPL-3.0-or-later** ile lisanslıdır (bkz. [LICENSE](LICENSE)).
Aşağıdaki bileşenler kendi lisanslarıyla gelir.

## Pakete dahil olanlar

| Bileşen | Sürüm | Lisans | Kaynak |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org) (gyan.dev "essentials" Windows yapısı, `ffmpeg-static` ile) | 6.1.1 | GPL-3.0 (libx264 dahil olduğu için GPL yapı) | https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 — yapı bilgisi: `node_modules/ffmpeg-static/ffmpeg.exe.README` |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | 5.3.0 | GPL-3.0-or-later | npm |
| [ws](https://github.com/websockets/ws) | 8.22 | MIT | npm |
| [Node.js](https://nodejs.org) (taşınabilir pakette `runtime/`) | 24 LTS | MIT (+ içerdiği bileşenlerin lisansları: https://github.com/nodejs/node/blob/main/LICENSE) | https://github.com/nodejs/node |

FFmpeg ayrı bir süreç olarak çalıştırılır; uygulamanın koduna bağlanmaz. GPL gereği FFmpeg'in kaynak koduna yukarıdaki bağlantıdan ulaşılabilir.

## Pakete dahil olmayan, isteğe bağlı kurulanlar

| Bileşen | Lisans | Not |
|---|---|---|
| [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) | kendi lisansı (depoya bakın) | `surucu-kur.bat` ile winget üzerinden kurulur |
| [Tailscale](https://tailscale.com) | istemci BSD-3-Clause; hizmet Tailscale şartlarına tabi | `tailscale-kur.bat` ile winget üzerinden kurulur |

## Windows bileşenleri
Yardımcı programlar (`helper/*.cs`) Windows'un kendi .NET Framework C# derleyicisiyle (`csc.exe`) bu bilgisayarda derlenir; .NET Framework Windows'un parçasıdır.
