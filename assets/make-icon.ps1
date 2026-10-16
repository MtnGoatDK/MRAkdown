# Renders web/logo.svg into assets/MRAkdown.ico at all standard sizes.
# Uses headless Microsoft Edge to rasterise the SVG, then System.Drawing to scale and pack.
# Usage: powershell -File assets\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found' }

$web = Join-Path $PSScriptRoot '..\web' | Resolve-Path
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "mrakdown-icon-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null

# Rasterise an SVG at 512x512 with a transparent background.
function Rasterise([string]$svg) {
    $html = Join-Path $tmp "$svg.html"
    $png = Join-Path $tmp "$svg.png"
    $src = ([Uri](Join-Path $web $svg)).AbsoluteUri
    Set-Content $html "<html><body style='margin:0;background:transparent'><img src='$src' width='512' height='512'></body></html>"
    # Not "& $edge": Edge's helper processes keep the output pipe open and the call never returns.
    $edgeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--default-background-color=00000000', '--window-size=512,512',
        "--user-data-dir=`"$tmp\profile`"", "--screenshot=`"$png`"", ([Uri]$html).AbsoluteUri)
    $proc = Start-Process $edge -ArgumentList $edgeArgs -WindowStyle Hidden -PassThru
    $proc.WaitForExit(20000) | Out-Null
    for ($i = 0; -not (Test-Path $png) -and $i -lt 50; $i++) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $png)) { throw "Edge did not render $svg" }
    # Load via a copy so the temp file isn't locked when we clean up.
    $bytes = [System.IO.File]::ReadAllBytes($png)
    return [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream (, $bytes)))
}

function Scale([System.Drawing.Image]$img, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.SmoothingMode = 'AntiAlias'
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$logo = Rasterise 'logo.svg'
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$images = foreach ($s in $sizes) { ,(Scale $logo $s) }
$logo.Dispose()

# ICO container with PNG-compressed entries
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $images[$i].Length
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'MRAkdown.ico'), $out.ToArray())

if ($env:MRAKDOWN_ICON_PREVIEW) {
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        [System.IO.File]::WriteAllBytes((Join-Path $env:MRAKDOWN_ICON_PREVIEW "icon-$($sizes[$i]).png"), $images[$i])
    }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
"wrote MRAkdown.ico"
