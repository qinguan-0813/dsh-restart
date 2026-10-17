// dsh-restart 的 PowerShell helper 生成器。
//
// 单独成文件的原因：它**不依赖**任何 DSH 包，所以可以脱离宿主单独 import、
// 把生成的脚本丢给 PowerShell 自己的解析器做语法检查 —— 重启这件事没法"跑一遍
// 试试看"（跑一遍就把当前进程杀了），能测的只有脚本本身是不是合法的 PowerShell。

/** PowerShell 单引号字符串：只有 ' 需要转义（doubled）。 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 生成"记窗口状态 → 杀掉旧 DSH → 等端口释放 → 拉起新 DSH → 把窗口摆回原样"的脚本。
 *
 * 为什么要自己记窗口状态：DSH 桌面端**不保存**窗口状态（userData 里没有 window-state
 * 之类的东西），所以重启后窗口永远是默认尺寸。改不了宿主，就自己记住再摆回去。
 *
 * 为什么只能在 helper 里做：插件跑在 host 进程里，拿不到 Electron 的 BrowserWindow，
 * 只能用 Win32 的 ShowWindow / SetWindowPos 直接操作主窗口句柄。
 *
 * @param options.exe - 要启动的 exe（也是要杀掉的进程名来源）。
 * @param options.port - 宿主 Web 端口，用来判断旧进程是否真的退出。
 * @param options.delayMs - 启动前等一下（让发起重启的那一轮先把结果写回去）。
 * @param options.helperLog - 追加日志的文件路径。
 * @param options.windowStatePath - 窗口状态的落盘路径（可选；不给就跳过记录/恢复）。
 * @returns 带 BOM 的脚本文本。
 */
export function buildHelperScript({ exe, port, delayMs, helperLog, windowStatePath }) {
  // ⚠️ PowerShell 5.1 按 GBK 读无 BOM 的文件 → 脚本里的非 ASCII 字符会乱码 →
  // 语法错误 → 脚本直接不执行（那就是"点了重启没反应"）。这里全英文 + BOM 双保险。
  const win = windowStatePath
    ? `
# ---- window state: DSH itself does not persist it, so remember it here and put it back ----
$WinState = ${psQuote(windowStatePath)}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DshWin32 {
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  // ⚠️ 这个工厂方法是必须的：在 PowerShell 里写 $wp.length = ... 会撞上数组的 .length
  //    属性（"The property 'length' cannot be found on this object"），结构体初始化不了。
  public static WINDOWPLACEMENT NewPlacement() {
    WINDOWPLACEMENT p = new WINDOWPLACEMENT();
    p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    return p;
  }
}
"@

function Get-MainWindow { @(Get-Process -Name $ProcName) | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }

$saved = $null
$win = Get-MainWindow
if ($win) {
  $h = $win.MainWindowHandle
  # ⚠️ 不能用 GetWindowRect 直接记：窗口最小化时它返回的是 -25600,-25600 之类的垃圾坐标
  #    （实测踩过：记成 159x27，恢复时被判定"几何不可用"直接跳过）。
  #    GetWindowPlacement 的 rcNormalPosition 才是"还原后该在哪"，最小化/最大化都稳。
  $wp = [DshWin32]::NewPlacement()
  $got = [DshWin32]::GetWindowPlacement($h, [ref]$wp)
  $r = New-Object DshWin32+RECT
  $gotRect = [DshWin32]::GetWindowRect($h, [ref]$r)
  if ($got) {
    $left = $wp.rcNormalPosition.Left
    $top = $wp.rcNormalPosition.Top
    $width = $wp.rcNormalPosition.Right - $wp.rcNormalPosition.Left
    $height = $wp.rcNormalPosition.Bottom - $wp.rcNormalPosition.Top
    # showCmd: 1 = normal, 2 = minimized, 3 = maximized
    $showCmd = $wp.showCmd
  } else {
    $left = if ($gotRect) { $r.Left } else { 0 }
    $top = if ($gotRect) { $r.Top } else { 0 }
    $width = if ($gotRect) { $r.Right - $r.Left } else { 0 }
    $height = if ($gotRect) { $r.Bottom - $r.Top } else { 0 }
    $showCmd = if ([DshWin32]::IsZoomed($h)) { 3 } else { 1 }
  }
  $saved = [ordered]@{
    showCmd   = $showCmd
    maximized = [bool]($showCmd -eq 3)
    minimized = [bool]([DshWin32]::IsIconic($h))
    left      = $left
    top       = $top
    width     = $width
    height    = $height
  }
  try { $saved | ConvertTo-Json -Compress | Set-Content -LiteralPath $WinState -Encoding UTF8 } catch { }
  Note ("window state saved: showCmd=" + $showCmd + " maximized=" + $saved.maximized + " minimized=" + $saved.minimized + " " + $saved.width + "x" + $saved.height)
} else {
  Note 'no main window found - window state not saved'
}
`
    : ''

  const restore = windowStatePath
    ? `
# ---- put the window back the way it was ----
try {
  if (Test-Path -LiteralPath $WinState) {
    $want = Get-Content -LiteralPath $WinState -Raw -Encoding UTF8 | ConvertFrom-Json
    $h = [IntPtr]::Zero
    $until = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $until) {
      $w = Get-MainWindow
      if ($w) { $h = $w.MainWindowHandle; break }
      Start-Sleep -Milliseconds 500
    }
    if ($h -ne [IntPtr]::Zero) {
      # Electron needs a moment to finish drawing before its window accepts geometry.
      Start-Sleep -Milliseconds 1500
      # showCmd 3 = 之前是最大化；没有这个字段的旧记录退回看 maximized。
      $wasMax = $false
      if ($null -ne $want.showCmd) { $wasMax = ([int]$want.showCmd -eq 3) }
      elseif ($null -ne $want.maximized) { $wasMax = [bool]$want.maximized }
      if ($wasMax) {
        [void][DshWin32]::ShowWindow($h, 3)   # SW_MAXIMIZE
        Note 'window restored: maximized'
      } elseif ([int]$want.width -gt 200 -and [int]$want.height -gt 200) {
        [void][DshWin32]::SetWindowPos($h, [IntPtr]::Zero, [int]$want.left, [int]$want.top, [int]$want.width, [int]$want.height, 0x0040)
        Note ("window restored: " + $want.width + "x" + $want.height)
      } else {
        Note ('window state had no usable geometry - left as is (' + $want.width + 'x' + $want.height + ')')
      }
    } else {
      Note 'no window appeared within 90s - window state not restored'
    }
  }
} catch { Note ("window restore failed: " + $_.Exception.Message) }
`
    : ''

  const body = `# dsh-restart helper (generated by the dsh-restart plugin; safe to delete)
$ErrorActionPreference = 'SilentlyContinue'
$Log = ${psQuote(helperLog)}
$Exe = ${psQuote(exe)}
$Port = ${port}
$DelayMs = ${delayMs}
$ProcName = [IO.Path]::GetFileNameWithoutExtension($Exe)

function Note([string]$m) {
  try { Add-Content -LiteralPath $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch { }
}

Note ("helper start (pid " + $PID + ") exe=" + $Exe + " port=" + $Port)
Start-Sleep -Milliseconds $DelayMs
${win}
# 1) Kill the whole DSH process tree: main process, host and renderers all share the exe name.
$procs = @(Get-Process -Name $ProcName)
$killed = 0
foreach ($p in $procs) {
  try { $p.Kill(); $killed = $killed + 1 } catch { Note ("kill failed for pid " + $p.Id + ": " + $_.Exception.Message) }
}
Note ("killed " + $killed + " of " + $procs.Count + " process(es) named " + $ProcName)

# 2) Wait until the port is really released. A dead process can still hold the socket for a
#    moment on Windows; starting too early makes the new host die with EADDRINUSE.
$deadline = (Get-Date).AddSeconds(40)
$stillBusy = $true
while ((Get-Date) -lt $deadline) {
  $busy = $false
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $client.Connected) { $busy = $true }
    $client.Close()
  } catch { $busy = $false }
  if (-not $busy) { $stillBusy = $false; break }
  Start-Sleep -Milliseconds 300
}
Note ("port " + $Port + " free=" + (-not $stillBusy))

# 3) Relaunch. The desktop main process takes no arguments, so plain Start-Process is exact.
#    -PassThru gives us the new pid for the log: "did it actually start" is the one fact
#    a failed restart cannot be diagnosed without (the old process is already gone).
Start-Sleep -Milliseconds 500
$started = Start-Process -FilePath $Exe -PassThru
if ($started) { Note ("relaunched pid=" + $started.Id) } else { Note 'relaunch returned no process object' }
${restore}`
  // BOM：让 PowerShell 5.1 无论如何按 UTF-8 读。
  return `\ufeff${body}`
}

/** XML 文本转义（任务 XML 里路径带 & 之类的字符会直接损坏整份文件）。 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 生成计划任务的 XML —— 插件装好就自己注册，用户不用手动配置。
 *
 * 为什么是"每分钟重复触发 + 每次只跑 58 秒"这个形状：
 *   - 计划任务的重复间隔**最小 1 分钟**（PT15S 会被系统直接拒绝），所以频率靠触发器；
 *   - 而"任务只触发一次、脚本自己常驻"不行：常驻进程一死就再没有人拉起（实测过）；
 *   - "任务跑 guard、guard 再 Start-Process 出常驻看守"也不行：任务上下文里拉起的子进程
 *     会跟着父进程一起被清掉（实测：看守日志一行都没有）。
 *   → 让任务**自己**承载周期性，脚本跑 58 秒退出，下一分钟的触发无缝接上。
 *
 * 为什么只有 CalendarTrigger 没有 LogonTrigger：带登录触发器的任务在普通权限下注册会
 * `Access is denied`；CalendarTrigger + 长期 Repetition 覆盖面一样，而且不需要管理员。
 *
 * 动作走 wscript.exe 而不是直接 powershell.exe：任务以"用户已登录时运行"的方式跑时，
 * `-WindowStyle Hidden` 压不住控制台窗口，会每分钟弹一个黑框（实测被用户抓包）。
 * wscript 自己没有控制台，VBS 里 `Run(..., 0, False)` 的 0 才是真隐藏。
 *
 * @param options.launcherPath - 启动器 .vbs 的绝对路径。
 * @param options.startBoundary - 可选的起始时间（ISO 无时区）；默认用当前年份的 1 月 1 日。
 * @returns XML 文本（写入时要存成 UTF-16 LE + BOM，schtasks 只吃这种）。
 */
export function buildTaskXml({ launcherPath, startBoundary }) {
  const boundary = startBoundary ?? `${new Date().getFullYear()}-01-01T00:00:00`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dsh-restart watchdog: one tick per minute, keeps the restart executor alive.</Description>
    <URI>\\DshRestartWatch</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${xmlEscape(boundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo "${xmlEscape(launcherPath)}"</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT3M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
</Task>
`
}
