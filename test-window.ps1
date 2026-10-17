# 验证 dsh-restart helper 用的窗口状态读取方式。
# 只读不写：拿 DSH 自己的主窗口试 GetWindowPlacement，确认工厂方法 + API 调用都对
# （GetWindowRect 在窗口最小化时会给 -25600 之类的垃圾坐标，所以改用 placement）。
$failures = 0
function Check($name, $ok, $detail) {
  if ($ok) { Write-Output ("PASS  " + $name + " - " + $detail) } else { Write-Output ("FAIL  " + $name + " - " + $detail); $script:failures++ }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  public static WINDOWPLACEMENT NewPlacement() {
    WINDOWPLACEMENT p = new WINDOWPLACEMENT();
    p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    return p;
  }
}
"@

$p = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
Check 'DSH main window found' ($null -ne $p) ($(if ($p) { 'pid=' + $p.Id } else { 'none' }))
if (-not $p) { exit 1 }
$h = $p.MainWindowHandle

$wp = [WinProbe]::NewPlacement()
Check 'factory produced struct' ($null -ne $wp) ('type=' + $wp.GetType().Name)
$ok = [WinProbe]::GetWindowPlacement($h, [ref]$wp)
Check 'GetWindowPlacement ok' $ok ('ok=' + $ok)

$w = $wp.rcNormalPosition.Right - $wp.rcNormalPosition.Left
$ht = $wp.rcNormalPosition.Bottom - $wp.rcNormalPosition.Top
Write-Output ("      showCmd=" + $wp.showCmd + "  normal=" + $wp.rcNormalPosition.Left + ',' + $wp.rcNormalPosition.Top + ' ' + $w + 'x' + $ht)
Write-Output ("      IsZoomed=" + [WinProbe]::IsZoomed($h) + "  IsIconic=" + [WinProbe]::IsIconic($h))

$r = New-Object WinProbe+RECT
$null = [WinProbe]::GetWindowRect($h, [ref]$r)
Write-Output ("      GetWindowRect=" + $r.Left + ',' + $r.Top + ' ' + ($r.Right - $r.Left) + 'x' + ($r.Bottom - $r.Top))

Check 'placement reports maximized (3)' ($wp.showCmd -eq 3) ('showCmd=' + $wp.showCmd)
Check 'normal geometry is usable' ($w -gt 200 -and $ht -gt 200) ($w.ToString() + 'x' + $ht)

if ($failures -gt 0) { Write-Output ($failures.ToString() + ' check(s) failed'); exit 1 }
Write-Output 'window probe ok'
