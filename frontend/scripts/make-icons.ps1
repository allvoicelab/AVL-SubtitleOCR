# Generate gradient-tinted icons from src/icons/logo-source.png (transparent line art)
# Output: src/icons/icon-<palette>.png + icon-<palette>.ico + logo-mask.png (sidebar mask)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $projectRoot "src\icons\logo-source.png"
$outDir = Join-Path $projectRoot "src\icons"
New-Item -ItemType Directory -Force $outDir | Out-Null

# per palette: bright end -> deep end (diagonal gradient)
$palettes = [ordered]@{
  neon     = @("2ce9ff", "157cff")
  sage     = @("a8d0b4", "46705c")
  graphite = @("ff8a50", "d9480f")
}

function Save-Ico([System.Drawing.Bitmap]$bmp, [string]$path) {
  # multi-size DIB (BMP) entries: 16..256, the most compatible ICO layout
  $images = @()
  foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
    $resized = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($resized)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($bmp, 0, 0, $s, $s)
    $g.Dispose()

    $rect2 = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $data = $resized.LockBits($rect2, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $px = New-Object byte[] ($s * $s * 4)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
    $resized.UnlockBits($data)
    $resized.Dispose()

    # XOR mask: 32bpp BGRA, rows bottom-up
    $xor = New-Object byte[] ($s * $s * 4)
    for ($y = 0; $y -lt $s; $y++) {
      [Array]::Copy($px, $y * $s * 4, $xor, ($s - 1 - $y) * $s * 4, $s * 4)
    }
    # AND mask: 1bpp, rows bottom-up, 4-byte aligned; zeros (alpha channel rules)
    $andStride = [int]([Math]::Ceiling([Math]::Ceiling($s / 8.0) / 4.0) * 4)
    $and = New-Object byte[] ($andStride * $s)

    # BITMAPINFOHEADER with doubled height (XOR + AND)
    $hdr = New-Object byte[] 40
    $hdr[0] = 40
    [BitConverter]::GetBytes([int32]$s).CopyTo($hdr, 4)
    [BitConverter]::GetBytes([int32](2 * $s)).CopyTo($hdr, 8)
    [BitConverter]::GetBytes([uint16]1).CopyTo($hdr, 12)
    [BitConverter]::GetBytes([uint16]32).CopyTo($hdr, 14)
    [BitConverter]::GetBytes([int32]($xor.Length + $and.Length)).CopyTo($hdr, 20)

    $ms = New-Object System.IO.MemoryStream
    $mw = New-Object System.IO.BinaryWriter($ms)
    $mw.Write($hdr); $mw.Write($xor); $mw.Write($and); $mw.Flush()
    $images += ,@($s, $ms.ToArray())
    $mw.Dispose()
  }

  $offset = 6 + 16 * $images.Count
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
  foreach ($img in $images) {
    $s = $img[0]
    $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$img[1].Length); $bw.Write([uint32]$offset)
    $offset += $img[1].Length
  }
  foreach ($img in $images) { $bw.Write($img[1]) }
  $bw.Flush(); $bw.Close()
}

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$rect = New-Object System.Drawing.Rectangle(0, 0, $src.Width, $src.Height)
$srcData = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$srcBytes = New-Object byte[] ($srcData.Stride * $src.Height)
[System.Runtime.InteropServices.Marshal]::Copy($srcData.Scan0, $srcBytes, 0, $srcBytes.Length)
$src.UnlockBits($srcData)
$max = ($src.Width + $src.Height - 2) * 1.0

foreach ($entry in $palettes.GetEnumerator()) {
  $bright = [System.Drawing.ColorTranslator]::FromHtml("#" + $entry.Value[0])
  $deep = [System.Drawing.ColorTranslator]::FromHtml("#" + $entry.Value[1])

  $out = New-Object System.Drawing.Bitmap($src.Width, $src.Height)
  $outData = $out.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $outBytes = New-Object byte[] ($outData.Stride * $out.Height)
  [Array]::Copy($srcBytes, $outBytes, $srcBytes.Length)

  for ($y = 0; $y -lt $src.Height; $y++) {
    $row = $y * $outData.Stride
    for ($x = 0; $x -lt $src.Width; $x++) {
      $i = $row + $x * 4
      if ($outBytes[$i + 3] -eq 0) { continue }
      $t = [Math]::Pow((($x + $y) / $max), 0.9)
      $outBytes[$i]     = [byte]($bright.B + ($deep.B - $bright.B) * $t)
      $outBytes[$i + 1] = [byte]($bright.G + ($deep.G - $bright.G) * $t)
      $outBytes[$i + 2] = [byte]($bright.R + ($deep.R - $bright.R) * $t)
    }
  }
  [System.Runtime.InteropServices.Marshal]::Copy($outBytes, 0, $outData.Scan0, $outBytes.Length)
  $out.UnlockBits($outData)

  $pngPath = Join-Path $outDir ("icon-" + $entry.Key + ".png")
  $out.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Save-Ico $out (Join-Path $outDir ("icon-" + $entry.Key + ".ico"))
  $out.Dispose()
  "generated icon-$($entry.Key).png/.ico"
}
$src.Dispose()
Copy-Item $srcPath (Join-Path $outDir "logo-mask.png") -Force
"mask copied"
