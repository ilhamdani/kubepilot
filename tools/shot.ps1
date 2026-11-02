Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$proc = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_ELECTRON_WINDOW"; exit 1 }
$h = $proc.MainWindowHandle
[WinCap]::ShowWindow($h, 9) | Out-Null
[WinCap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1200
$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Output "RECT $($r.Left),$($r.Top) ${w}x${ht}"
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$out = "D:\WorkBuddy AI\Infrastructure\lens-desktop\shot.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED $out"
