# PWA ikonlarını üretir (public/icons). Bir kez çalıştırıldı, çıktılar repoda; tasarım değişirse tekrar çalıştır:
#   powershell -ExecutionPolicy Bypass -File tools\ikon-uret.ps1
param([string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'public\icons'))
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# size: piksel; rounded: köşeleri saydam yuvarlak zemin; scale: simgenin zemine oranı
function Make([int]$size, [bool]$rounded, [float]$scale, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0f1115'))
  if ($rounded) { $g.FillPath($bg, (RoundRect 0 0 $size $size ($size * 0.22))) } else { $g.FillRectangle($bg, 0, 0, $size, $size) }

  $blue = [System.Drawing.ColorTranslator]::FromHtml('#3b82f6')
  $u = $size * $scale          # simge kutusu
  $ox = ($size - $u) / 2
  $oy = ($size - $u) / 2
  # Ekran (monitör)
  $mw = $u; $mh = $u * 0.64
  $my = $oy + $u * 0.06
  $screen = RoundRect $ox $my $mw $mh ($u * 0.08)
  $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new($ox, $my)), ([System.Drawing.PointF]::new($ox + $mw, $my + $mh)), ([System.Drawing.ColorTranslator]::FromHtml('#1e3a8a')), ([System.Drawing.ColorTranslator]::FromHtml('#172033'))
  $g.FillPath($fill, $screen)
  $pen = New-Object System.Drawing.Pen $blue, ($u * 0.055)
  $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $screen)
  # Ayak
  $sb = New-Object System.Drawing.SolidBrush $blue
  $g.FillPath($sb, (RoundRect ($ox + $u * 0.44) ($my + $mh) ($u * 0.12) ($u * 0.14) ($u * 0.02)))
  $g.FillPath($sb, (RoundRect ($ox + $u * 0.28) ($my + $mh + $u * 0.13) ($u * 0.44) ($u * 0.07) ($u * 0.035)))
  # İmleç oku
  $ax = $ox + $u * 0.40; $ay = $my + $mh * 0.20; $a = $u * 0.36
  $pts = @(
    [System.Drawing.PointF]::new($ax, $ay),
    [System.Drawing.PointF]::new($ax, $ay + $a * 1.0),
    [System.Drawing.PointF]::new($ax + $a * 0.26, $ay + $a * 0.76),
    [System.Drawing.PointF]::new($ax + $a * 0.44, $ay + $a * 1.12),
    [System.Drawing.PointF]::new($ax + $a * 0.58, $ay + $a * 1.05),
    [System.Drawing.PointF]::new($ax + $a * 0.40, $ay + $a * 0.70),
    [System.Drawing.PointF]::new($ax + $a * 0.74, $ay + $a * 0.70)
  )
  $arrow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $arrow.AddPolygon($pts)
  $g.FillPath([System.Drawing.Brushes]::White, $arrow)
  $ap = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#0f1115')), ($u * 0.022)
  $ap.LineJoin = 'Round'
  $g.DrawPath($ap, $arrow)

  $g.Dispose()
  $bmp.Save((Join-Path $Out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Make 192 $true 0.62 'icon-192.png'
Make 512 $true 0.62 'icon-512.png'
Make 512 $false 0.50 'maskable-512.png'
Make 180 $false 0.60 'apple-touch-icon.png'
Get-ChildItem $Out | Select-Object Name, Length
