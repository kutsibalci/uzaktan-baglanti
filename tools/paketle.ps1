# Taşınabilir Windows paketi oluşturur: dist\UzaktanBaglanti-v<sürüm>-win64.zip
# İçinde Node.js (runtime\node.exe), bağımlılıklar (ffmpeg dahil) ve derlenmiş yardımcı program bulunur;
# hedef bilgisayara hiçbir şey kurmak gerekmez.
#   Kullanım:  powershell -ExecutionPolicy Bypass -File tools\paketle.ps1
param(
  [string]$NodeMajor = '24',
  [string]$OutDir = 'dist'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$name = "UzaktanBaglanti-v$version-win64"
$out = Join-Path $root $OutDir
$stage = Join-Path $out $name
$cache = Join-Path $out 'cache'
$zip = Join-Path $out "$name.zip"

Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage, $cache, "$stage\runtime", "$stage\helper" | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------- 1. Node.js (en güncel v$NodeMajor LTS, SHA256 doğrulamalı) ----------
Write-Host "[1/5] Node.js indiriliyor..."
# Parantez şart: Windows PowerShell 5.1 JSON dizisini boru hattına tek nesne olarak verir.
$rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') |
  Where-Object { $_.version -like "v$NodeMajor.*" -and $_.lts } | Select-Object -First 1
if (-not $rel) { throw "Node.js v$NodeMajor LTS bulunamadı." }
$nodeVer = $rel.version
$nodeZipName = "node-$nodeVer-win-x64.zip"
$nodeZip = Join-Path $cache $nodeZipName
if (-not (Test-Path $nodeZip)) {
  Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/$nodeZipName" -OutFile $nodeZip -UseBasicParsing
}
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt" -UseBasicParsing).Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
$line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($nodeZipName))\s*$" } | Select-Object -First 1
$expected = ($line -split '\s+')[0]
$actual = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $actual -ne $expected) {
  Remove-Item $nodeZip -Force
  throw "Node.js zip doğrulanamadı (SHA256 uyuşmuyor)."
}
$z = [IO.Compression.ZipFile]::OpenRead($nodeZip)
try {
  foreach ($e in $z.Entries) {
    if ($e.FullName -match '^node-[^/]+/node\.exe$') { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$stage\runtime\node.exe", $true) }
    if ($e.FullName -match '^node-[^/]+/LICENSE$') { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$stage\runtime\LICENSE.txt", $true) }
  }
} finally { $z.Dispose() }
if (-not (Test-Path "$stage\runtime\node.exe")) { throw "node.exe çıkarılamadı." }
Write-Host "      Node.js $nodeVer (SHA256 doğrulandı)"

# ---------- 2. Uygulama dosyaları ----------
Write-Host "[2/5] Uygulama dosyaları kopyalanıyor..."
foreach ($f in 'server.js', 'package.json', 'package-lock.json', 'README.md', 'baslat.bat', 'surucu-kur.bat', 'tailscale-kur.bat') {
  Copy-Item "$root\$f" $stage
}
Copy-Item "$root\lib", "$root\public" $stage -Recurse
Copy-Item "$root\helper\RemoteHelper.cs" "$stage\helper\"

# ---------- 3. Bağımlılıklar (ffmpeg dahil) ----------
Write-Host "[3/5] Bağımlılıklar kuruluyor..."
Push-Location $stage
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci başarısız." }
  # Yeni npm sürümleri kurulum betiklerini onaysız çalıştırmıyor; ffmpeg'i gerekirse elle indir.
  if (-not (Test-Path 'node_modules\ffmpeg-static\ffmpeg.exe')) {
    & "$stage\runtime\node.exe" 'node_modules\ffmpeg-static\install.js'
  }
  if (-not (Test-Path 'node_modules\ffmpeg-static\ffmpeg.exe')) { throw "ffmpeg indirilemedi." }
} finally { Pop-Location }

# ---------- 4. Yardımcı program ----------
Write-Host "[4/5] Yardımcı program derleniyor..."
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /optimize /target:exe "/out:$stage\helper\RemoteHelper.exe" /r:System.Drawing.dll /r:System.Windows.Forms.dll "$stage\helper\RemoteHelper.cs"
if ($LASTEXITCODE -ne 0) { throw "Yardımcı program derlenemedi." }

$commit = (git -C $root rev-parse --short HEAD 2>$null)
@"
Uzaktan Bağlantı v$version
Node.js $nodeVer
Commit $commit
Oluşturulma $(Get-Date -Format 'yyyy-MM-dd HH:mm')
"@ | Set-Content "$stage\SURUM.txt" -Encoding UTF8

# ---------- 5. Zip ----------
Write-Host "[5/5] Zip oluşturuluyor..."
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Hazır: $zip ($mb MB)"
