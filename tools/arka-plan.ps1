# Uzaktan Bağlantı: sunucuyu konsol penceresi ve tepsi simgesi OLMADAN arka planda çalıştırır.
# Yalnızca Windows'un imzalı araçlarını kullanır (powershell.exe, taskkill.exe); yeni exe derlemez, Add-Type kullanmaz
# (Akıllı Uygulama Denetimi imzasız, yeni derlenmiş dosyaları engelleyebiliyor).
#   -Islem baslat  zaten çalışıyorsa ikinci kopya açmaz (yalnızca tarayıcıyı açar); değilse gizli bekçiyi başlatır,
#                  sunucu cevap verince tarayıcıda http://localhost:<port> açar (arka-plan-baslat.bat)
#   -Islem bekci   (iç kullanım) node'u gizli çalıştırır, çıktısını günlüğe ekler, beklenmedik kapanışta artan beklemeyle
#                  (2, 5, 15, 60 sn) yeniden başlatır; 10 dakikada 5 çökmede durur ve günlüğe yazar
#   -Islem durdur  yalnızca PID dosyasındaki KENDİ bekçi + node süreçlerini ağacıyla durdurur, ADLA öldürmez
#                  (önce data\arka-plan.dur işareti: bekçi sunucuyu düzgün kapatır; olmazsa PID ile) (arka-plan-durdur.bat)
#   -Islem durum   çalışıyorsa 0, değilse 1 döner (JSON yazar)
#   -Sessiz        tarayıcı açılmaz (Windows açılınca başlatma)
#   -PortNo N / -VeriKlasoru K   PORT / REMOTE_DATA_DIR yerine (Windows açılınca başlatma komutu varsayılan dışı değerleri böyle verir)
# Ortam: PORT (varsayılan 3080), REMOTE_DATA_DIR (varsayılan <kök>\data), REMOTE_ARKA_TARAYICI=0 (tarayıcı hiç açılmaz; testler),
#        REMOTE_ARKA_BEKLEME="2,5,15,60" (çökme sonrası bekleme, sn; testler kısaltır), REMOTE_ARKA_BETIK (server.js yerine; testler)
# Veri klasöründe: arka-plan.pid (JSON: bekci, node, port), arka-plan.dur (durdurma işareti),
#                  sunucu.log (5 MB'ı aşınca sunucu.log.1'e taşınır)
# Tepsi (helper\Tepsi.exe) ya da baslat.bat ile çalışan sunucuya dokunulmaz: port zaten cevap veriyorsa yeni kopya açılmaz.
param(
  [ValidateSet('baslat', 'bekci', 'durdur', 'durum')][string]$Islem = 'baslat',
  [switch]$Sessiz,
  [int]$PortNo = 0,
  [string]$VeriKlasoru = ''
)
$ErrorActionPreference = 'Stop'
# Bekçi ve node bu değerleri ortamdan devralır.
if ($PortNo -gt 0) { $env:PORT = [string]$PortNo }
if ($VeriKlasoru) { $env:REMOTE_DATA_DIR = $VeriKlasoru }
$Kok = Split-Path -Parent $PSScriptRoot
$Port = 3080
if ($env:PORT -match '^\d{1,5}$' -and [int]$env:PORT -gt 0 -and [int]$env:PORT -lt 65536) { $Port = [int]$env:PORT }
$Veri = if ($env:REMOTE_DATA_DIR) { $env:REMOTE_DATA_DIR } else { Join-Path $Kok 'data' }
$PidDosya = Join-Path $Veri 'arka-plan.pid'
$DurDosya = Join-Path $Veri 'arka-plan.dur'
$Log = Join-Path $Veri 'sunucu.log'
$LogMax = 5MB
$Betik = if ($env:REMOTE_ARKA_BETIK) { $env:REMOTE_ARKA_BETIK } else { 'server.js' }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[void][IO.Directory]::CreateDirectory($Veri)

# ---------- Günlük ----------
$script:logBoyut = -1
function LogSatir([string]$s) {
  try {
    if ($script:logBoyut -lt 0) { $script:logBoyut = if (Test-Path -LiteralPath $Log) { (Get-Item -LiteralPath $Log).Length } else { 0 } }
    if ($script:logBoyut -gt $LogMax) {
      Move-Item -LiteralPath $Log -Destination "$Log.1" -Force
      $script:logBoyut = 0
    }
    $satir = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $s + "`r`n"
    [IO.File]::AppendAllText($Log, $satir, $Utf8)
    $script:logBoyut += $Utf8.GetByteCount($satir)
  } catch { <# günlük yazılamazsa sunucu yine çalışsın #> }
}
function Yaz([string]$s) { LogSatir "[arka-plan] $s" }

# ---------- Süreçler ----------
function PidOku {
  try { if (Test-Path -LiteralPath $PidDosya) { return (Get-Content -LiteralPath $PidDosya -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch { }
  return $null
}
function PidYaz($bekci, $node) {
  $o = [ordered]@{ bekci = $bekci; node = $node; port = $Port; kok = $Kok; zaman = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($PidDosya, ($o | ConvertTo-Json -Compress), $Utf8)
}
# PID hâlâ BİZİM sürecimiz mi (PID'ler yeniden kullanılabilir): komut satırı ve üst süreç denetlenir.
function Surec($id) {
  if (-not $id) { return $null }
  try { return Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$id)" } catch { return $null }
}
function BekciMi($id) {
  $p = Surec $id
  return [bool]($p -and $p.CommandLine -and $p.CommandLine.Contains('arka-plan.ps1') -and $p.CommandLine -match '-Islem\s+bekci')
}
function NodeMu($id, $bekci) {
  $p = Surec $id
  return [bool]($p -and $p.Name -ieq 'node.exe' -and $p.ParentProcessId -eq [int]$bekci)
}
function AgaciSonlandir($id) {
  if (-not $id) { return }
  & "$env:SystemRoot\System32\taskkill.exe" /PID ([int]$id) /T /F 2>&1 | Out-Null
}

# ---------- Sunucu yoklama ----------
function SunucuCevapVeriyor {
  try {
    $r = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/features")
    $r.Proxy = $null
    $r.Timeout = 2000
    $c = $r.GetResponse()
    $ok = [int]$c.StatusCode -eq 200
    $c.Close()
    return $ok
  } catch { return $false }
}
function PortDinleniyor {
  $t = New-Object Net.Sockets.TcpClient
  try { return $t.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $t.Connected } catch { return $false } finally { $t.Close() }
}
function TarayiciAc {
  if ($Sessiz -or $env:REMOTE_ARKA_TARAYICI -eq '0') { return }
  try { Start-Process "http://localhost:$Port/" } catch { Yaz "tarayıcı açılamadı: $($_.Exception.Message)" }
}

function NodeBul {
  $paket = Join-Path $Kok 'runtime\node.exe'
  if (Test-Path -LiteralPath $paket) { return $paket }
  $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

# ---------- baslat ----------
function Baslat {
  $k = PidOku
  if ($k -and (BekciMi $k.bekci)) {
    # Zaten çalışıyor (belki hâlâ açılıyor): yeni kopya yok.
    for ($i = 0; $i -lt 60 -and -not (SunucuCevapVeriyor); $i++) { Start-Sleep -Milliseconds 500 }
    Write-Host "Zaten arka planda çalışıyor (bekçi $($k.bekci), port $Port)."
    TarayiciAc
    return 0
  }
  if (SunucuCevapVeriyor) {
    Write-Host "Sunucu zaten çalışıyor (tepsi ya da konsol, port $Port); yeni kopya açılmadı."
    TarayiciAc
    return 0
  }
  if (PortDinleniyor) {
    Yaz "port $Port başka bir program tarafından kullanılıyor, başlatılmadı"
    Write-Host "Port $Port başka bir program tarafından kullanılıyor; sunucu başlatılmadı."
    return 2
  }
  Remove-Item -LiteralPath $DurDosya -Force -ErrorAction SilentlyContinue
  if ($k) { Remove-Item -LiteralPath $PidDosya -Force -ErrorAction SilentlyContinue } # eski (bayat) kayıt
  $ps = Join-Path $PSHOME 'powershell.exe'
  $arg = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Islem bekci"
  $b = Start-Process -FilePath $ps -ArgumentList $arg -WindowStyle Hidden -PassThru
  Yaz "bekçi başlatıldı (pid $($b.Id), port $Port)"
  for ($i = 0; $i -lt 90; $i++) {
    if (SunucuCevapVeriyor) {
      Write-Host "Arka planda başladı: http://localhost:$Port (günlük: $Log)"
      TarayiciAc
      return 0
    }
    if ($b.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Sunucu zamanında cevap vermedi; ayrıntı için günlük: $Log"
  return 1
}

# ---------- bekci ----------
# Node'un çıktısını satır satır günlüğe yazar; durdurma işareti gelirse $true döner, node kapanırsa $false.
function Izle($p) {
  $akislar = @(
    @{ r = $p.StandardOutput; t = $p.StandardOutput.ReadLineAsync(); bitti = $false },
    @{ r = $p.StandardError; t = $p.StandardError.ReadLineAsync(); bitti = $false }
  )
  $cikis = $null
  while ($true) {
    $acik = @($akislar | Where-Object { -not $_.bitti } | ForEach-Object { $_.t })
    if ($acik.Count) { [void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]$acik, 500) } else { Start-Sleep -Milliseconds 250 }
    foreach ($a in $akislar) {
      while (-not $a.bitti -and $a.t.IsCompleted) {
        $s = $null
        try { $s = $a.t.Result } catch { }
        if ($null -eq $s) { $a.bitti = $true } else { LogSatir $s; $a.t = $a.r.ReadLineAsync() }
      }
    }
    if (Test-Path -LiteralPath $DurDosya) { return $true }
    if ($p.HasExited) {
      # Alt süreçler (ffmpeg vb.) çıktıyı açık tutabilir: node kapandıktan sonra en fazla 3 sn daha okunur.
      if (-not $acik.Count) { return $false }
      if ($null -eq $cikis) { $cikis = Get-Date } elseif (((Get-Date) - $cikis).TotalSeconds -gt 3) { return $false }
    }
  }
}

function NodeDurdur($p, $belirtec) {
  if ($p.HasExited) { return }
  try {
    # Düzgün kapanış (bağlantılar kapanır, sanal ekran kaldırılır): features/tepsi.js'in belirteçli yerel ucu.
    $r = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/tepsi/kapat")
    $r.Method = 'POST'
    $r.Proxy = $null
    $r.Timeout = 3000
    $r.Headers.Add('X-Tepsi', $belirtec)
    $r.ContentType = 'application/json'
    $b = [Text.Encoding]::ASCII.GetBytes('{}')
    $r.ContentLength = $b.Length
    $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
    $r.GetResponse().Close()
  } catch { }
  if ($p.WaitForExit(8000)) { Yaz "sunucu düzgün kapandı (kod $($p.ExitCode))" }
  else {
    Yaz 'sunucu kapanmadı, sonlandırılıyor'
    AgaciSonlandir $p.Id
    [void]$p.WaitForExit(5000)
  }
}

function Bekci {
  $k = PidOku
  if ($k -and $k.bekci -ne $PID -and (BekciMi $k.bekci)) { Yaz "başka bir bekçi zaten çalışıyor (pid $($k.bekci))"; return 0 }
  PidYaz $PID $null
  $bekleme = @(2, 5, 15, 60)
  if ($env:REMOTE_ARKA_BEKLEME -match '^\d+(\.\d+)?(,\d+(\.\d+)?)*$') { $bekleme = @($env:REMOTE_ARKA_BEKLEME.Split(',') | ForEach-Object { [double]$_ }) }
  $belirtec = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $cokmeler = New-Object System.Collections.ArrayList
  Yaz "bekçi çalışıyor (pid $PID, port $Port, kök $Kok)"
  try {
    while (-not (Test-Path -LiteralPath $DurDosya)) {
      if (SunucuCevapVeriyor) { Yaz "port $Port üzerinde başka bir sunucu çalışıyor (tepsi ya da konsol); bekçi duruyor"; break }
      $node = NodeBul
      if (-not $node) { Yaz 'Node.js bulunamadı (runtime\node.exe ya da PATH)'; break }
      $psi = New-Object Diagnostics.ProcessStartInfo
      $psi.FileName = $node
      $psi.Arguments = "`"$Betik`""
      $psi.WorkingDirectory = $Kok
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.StandardOutputEncoding = $Utf8
      $psi.StandardErrorEncoding = $Utf8
      $psi.EnvironmentVariables['PORT'] = [string]$Port
      $psi.EnvironmentVariables['TRAY_TOKEN'] = $belirtec        # düzgün kapanış ucu için (yalnızca bu bilgisayar + belirteç)
      $psi.EnvironmentVariables['REMOTE_BASLATICI'] = 'arka-plan' # sunucu tepsinin olmadığını bilsin (Windows bildirimi)
      $p = $null
      try { $p = [Diagnostics.Process]::Start($psi) } catch { Yaz "sunucu başlatılamadı: $($_.Exception.Message)" }
      $durIstendi = $false
      $kod = -1
      if ($p) {
        PidYaz $PID $p.Id
        Yaz "sunucu başlatıldı (pid $($p.Id))"
        $durIstendi = Izle $p
        if ($durIstendi) { NodeDurdur $p $belirtec; break }
        $kod = $p.ExitCode
        if ($kod -eq 0) { Yaz 'sunucu kendisi kapandı (kod 0), bekçi duruyor'; break }
      }
      $simdi = Get-Date
      [void]$cokmeler.Add($simdi)
      foreach ($c in @($cokmeler)) { if (($simdi - $c).TotalMinutes -gt 10) { $cokmeler.Remove($c) } }
      if ($cokmeler.Count -ge 5) {
        Yaz "sunucu 10 dakika içinde $($cokmeler.Count) kez beklenmedik şekilde kapandı (son kod $kod); yeniden başlatılmıyor. Port $Port başka bir programca kullanılıyor olabilir."
        break
      }
      $sn = $bekleme[[Math]::Min($cokmeler.Count - 1, $bekleme.Count - 1)]
      Yaz "sunucu beklenmedik şekilde kapandı (kod $kod), $sn sn sonra yeniden başlatılıyor"
      PidYaz $PID $null
      $son = (Get-Date).AddSeconds($sn)
      while ((Get-Date) -lt $son -and -not (Test-Path -LiteralPath $DurDosya)) { Start-Sleep -Milliseconds 200 }
    }
  } finally {
    $k = PidOku
    if ($k -and $k.bekci -eq $PID) { Remove-Item -LiteralPath $PidDosya -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $DurDosya -Force -ErrorAction SilentlyContinue
    Yaz 'bekçi durdu'
  }
  return 0
}

# ---------- durdur ----------
function Durdur {
  $k = PidOku
  if (-not $k) {
    if (SunucuCevapVeriyor) {
      Write-Host "Sunucu arka-plan-baslat ile başlatılmamış (tepsi ya da konsol, port $Port); ona dokunulmadı."
      Write-Host 'Tepsi ile çalışıyorsa: tepsi simgesi → Çıkış (ya da helper\Tepsi.exe --cikis).'
      return 3
    }
    Write-Host 'Arka planda çalışan sunucu yok.'
    return 0
  }
  $bekciVar = BekciMi $k.bekci
  if ($bekciVar) {
    [IO.File]::WriteAllText($DurDosya, (Get-Date).ToString('o'), $Utf8)
    for ($i = 0; $i -lt 80 -and (Get-Process -Id ([int]$k.bekci) -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
    if (Get-Process -Id ([int]$k.bekci) -ErrorAction SilentlyContinue) {
      if (BekciMi $k.bekci) { Yaz "bekçi işarete cevap vermedi, PID ile durduruluyor ($($k.bekci))"; AgaciSonlandir $k.bekci }
    }
  }
  if ($k.node -and (NodeMu $k.node $k.bekci)) { Yaz "sunucu PID ile durduruluyor ($($k.node))"; AgaciSonlandir $k.node }
  Remove-Item -LiteralPath $PidDosya -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $DurDosya -Force -ErrorAction SilentlyContinue
  Write-Host 'Arka plandaki sunucu durduruldu.'
  return 0
}

function Durum {
  $k = PidOku
  $calisiyor = [bool]($k -and (BekciMi $k.bekci))
  Write-Host ([ordered]@{ calisiyor = $calisiyor; bekci = $k.bekci; node = $k.node; port = $Port; cevap = (SunucuCevapVeriyor) } | ConvertTo-Json -Compress)
  if ($calisiyor) { return 0 } else { return 1 }
}

$kod = 0
switch ($Islem) {
  'baslat' { $kod = Baslat }
  'bekci' { $kod = Bekci }
  'durdur' { $kod = Durdur }
  'durum' { $kod = Durum }
}
exit ([int]($kod | Select-Object -Last 1))
