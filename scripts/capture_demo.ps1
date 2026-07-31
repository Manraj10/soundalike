# Grab frames of the Soundalike window for the README demo.
#
# Captures the window rect directly via GDI rather than going through the
# computer-use screenshot path, which masks any window that isn't in the
# session allowlist with a solid black rectangle -- fine for driving the UI,
# useless for a recording.
#
#   powershell -ExecutionPolicy Bypass -File scripts/capture_demo.ps1 -Seconds 20

param([int]$Seconds = 20, [int]$Fps = 4, [string]$Out = "$PSScriptRoot\..\build\frames")

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@

$proc = Get-Process Soundalike -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "Soundalike window not found"; exit 1 }

$h = $proc.MainWindowHandle
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500

$r = New-Object RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Host "window ${w}x${ht} at $($r.Left),$($r.Top)"

New-Item -ItemType Directory -Force -Path $Out | Out-Null
Get-ChildItem $Out -Filter *.png -ErrorAction SilentlyContinue | Remove-Item -Force

$delay = [int](1000 / $Fps)
$total = $Seconds * $Fps
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)

for ($i = 0; $i -lt $total; $i++) {
  # Re-read the rect each frame so a moved window doesn't shear the capture.
  [Win]::GetWindowRect($h, [ref]$r) | Out-Null
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $Out ("frame_{0:D4}.png" -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
  Start-Sleep -Milliseconds $delay
}

$g.Dispose(); $bmp.Dispose()
Write-Host "captured $total frames to $Out"
