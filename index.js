// dsh-restart — 让 DSH 能自己重启：排队 → 等所有会话空闲 → 重启 → 回来继续。
//
// 为什么需要它（2026-10-17 实测结论，不是猜的）：
//   1) 改完插件/配置必须重启 DSH 才生效，而 **DSH 桌面端没有任何内部重启接口**：
//      - 主进程（Electron）只接受 host 发来的 ready / platform-session / shutdown-complete /
//        fatal / update-tasks 这几种 IPC，多发一种会被当成协议错误，直接进崩溃恢复；
//      - 主窗口的 X 只是**缩到托盘**（DesktopTray.hide），不是退出；
//      - "重启应用与 Host"那句菜单代码在 development 分支里，生产版没有；
//      - preload 暴露给 renderer 的 API（dshDesktop / dshDesktopBoot …）里也没有 restart。
//      → 所以唯一可靠的路线是**外部 helper**：由它杀掉整棵 "DeepSeek Harness.exe" 进程树、
//        等宿主端口真的释放、再用同一个 exe 重新拉起。
//   2) 重启会打断正在跑的对话，所以**不能随便动手**：先排队，轮询所有会话是否空闲
//      （status==='running' / inbox 有排队 / 有 running job），一空就重启（idleGraceMs 默认 0）。
//      ⚠️ 发起重启的那个会话自己在工具返回后仍是 running —— 这一轮没结束就不会重启，
//      这正是"必须等这一轮完全结束"的保证。
//   3) 重启完得有人叫醒发起者，否则就躺在那里不知道要继续。
//      → 重启前把 {sessionId, note} 落盘；插件下次 apply 时读到 phase='restarting'，
//        等会话被 UI 加载出来，再用 followup（不是 inject —— inject 不唤醒）投一条"重启完成"。
//   4) **谁来执行 helper**：从宿主里 spawn 出来的进程会被"连坐"杀掉（实测：脚本写出来了、
//      日志一行没有）。所以真正干活的是一个**外部看守**：一个由计划任务每分钟拉起的
//      PowerShell，它不在 DSH 的进程树里，读 state 发现该重启就跑 helper。
//      这个计划任务由插件**自己安装**（见 ensureScheduledTask），用户零配置。
//   5) 重启后窗口状态：DSH 自己不保存，helper 里用 Win32 记下来再摆回去。

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { buildHelperScript, buildTaskXml } from './helper.js'

export const name = 'restart'

// agents：判断空闲 + 重启后唤醒；tools：注册工具。
export const inject = ['agents', 'tools']

/** 包名：消息 source 里 producer-owned 的 kind 用它（v4 格式拒绝 `kind:'plugin'`）。 */
const PACKAGE = 'dsh-restart'

/** 重启状态超过这个时间就算过期（防止某次重启失败后，下次启动莫名其妙被"唤醒"）。 */
const STALE_MS = 10 * 60 * 1000
/** 日志最多留多少行。 */
const MAX_LOG_LINES = 400

export const Config = Schema.object({
  statePath: Schema.string().default('').description('状态文件路径；留空 = $DSH_HOME/dsh-restart-state.json。'),
  exePath: Schema.string().default('').description('要重启的 exe；留空 = 自动探测（桌面端是 "DeepSeek Harness.exe"）。'),
  port: Schema.number().default(19387).description('宿主 Web 端口；helper 用它判断旧进程是否真的退出、端口是否释放。'),
  pollMs: Schema.number().default(2000).description('多久检查一次"有没有空闲"。'),
  idleGraceMs: Schema.number().default(0).description('检测到空闲后还要等多久才动手（默认 0 = 立刻重启；调成正数可留一点缓冲）。'),
  resumeDelayMs: Schema.number().default(12000).description('重启后等多久再唤醒发起会话（等 host 起来 + UI 恢复会话）。'),
  resumeWaitMs: Schema.number().default(90000).description('唤醒前最多等会话被加载多久。'),
  debugTools: Schema.boolean().default(true).description('注册 dsh_restart_status（排查用）。'),
})

export function apply(ctx, config) {
  const logger = {
    info: (m) => ctx.logger?.info?.(`dsh-restart: ${m}`),
    warn: (m) => ctx.logger?.warn?.(`dsh-restart: ${m}`),
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const statePath = String(config.statePath || '').trim() || join(home, 'dsh-restart-state.json')
  const logPath = join(dirname(statePath), 'dsh-restart.log')

  // ── 基础工具 ──────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 本地时间戳：必须和 helper 写进同一份日志的格式一致（toISOString 是 UTC，混着看会晕）。 */
  function localStamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function appendLog(kind, text) {
    const line = `[${localStamp()}] ${kind}: ${text}`
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${line}\n`, 'utf8')
      // 粗粒度裁剪：文件太大就只留最后 MAX_LOG_LINES 行。
      if (existsSync(logPath)) {
        const all = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '')
        if (all.length > MAX_LOG_LINES * 2) writeFileSync(logPath, `${all.slice(-MAX_LOG_LINES).join('\n')}\n`, 'utf8')
      }
    } catch {
      // 日志写不了不能让插件挂掉
    }
    logger.info(text)
  }

  /** 空状态：phase='idle'。 */
  function emptyState() {
    return { phase: 'idle', sessionId: '', note: '', reason: '', requestedAt: 0, restartStartedAt: 0, lastRestartAt: 0 }
  }

  function readState() {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    } catch {
      return emptyState()
    }
  }

  function writeState(next) {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      logger.warn(`写状态失败：${error?.message ?? error}`)
    }
  }

  function clearState() {
    writeState(emptyState())
  }

  /** 从 agent 上尽力取会话 id（不同宿主版本的字段名不完全一样）。 */
  function sessionIdOf(agent) {
    if (!agent) return ''
    return String(agent.id ?? agent.session?.id ?? agent.session?.header?.id ?? '')
  }

  /** 这个进程是不是桌面端（Electron 宿主、且 execPath 是应用 exe 而不是 node）。 */
  function isDesktopHost() {
    if (!process.versions?.electron) return false
    return /\.exe$/i.test(String(process.execPath ?? ''))
  }

  function resolveExe() {
    const configured = String(config.exePath || '').trim()
    if (configured) return configured
    if (!isDesktopHost()) return ''
    return String(process.execPath)
  }

  // ── 空闲判断 ─────────────────────────────────────────────────────────────
  //
  // 判据照抄 DSH 桌面端自己的 hasDesktopActiveTasks（dsh-desktop-host 里的退出检查）：
  //   agent.status === 'running' 或 inbox 里还有排队的消息 → 忙；
  //   jobs 里还有 running/stopping 的后台任务 → 忙。
  // 不自己发明判据：宿主认为"退出会打断工作"的情形，重启一样会打断。

  function listBusy() {
    const busy = []
    let agents = []
    try {
      agents = ctx.agents?.list?.() ?? []
    } catch (error) {
      logger.warn(`列会话失败：${error?.message ?? error}`)
    }
    for (const agent of agents) {
      const status = String(agent?.status ?? '')
      const nextTurn = Number(agent?.inbox?.nextTurn?.length ?? 0)
      const nextStep = Number(agent?.inbox?.nextStep?.length ?? 0)
      if (status === 'running' || nextTurn > 0 || nextStep > 0) {
        busy.push({ kind: 'agent', id: sessionIdOf(agent), status, queued: nextTurn + nextStep })
      }
    }
    // ⚠️ 后台任务必须查，而且**必须带 owner 参数**（2026-10-20 实测踩坑）：
    //    `jobs.list()` 无参调用一行都拿不到 —— 宿主自己（dsh-desktop-host 的
    //    hasDesktopActiveTasks）是对 `undefined` 和**每个会话 id** 各查一遍的：
    //      [void 0, ...liveAgents].some((agent) => jobs.list(agent?.id).some(...))
    //    本喵原来写的是 jobs.list() ✗ → 后台任务在跑照样重启 ✗（主人后台跑着活被重启了）。
    const jobs = ctx.get?.('jobs')
    if (jobs && typeof jobs.list === 'function') {
      const seen = new Set()
      const owners = [undefined, ...agents.map((agent) => (agent?.id === undefined ? undefined : agent.id))]
      for (const owner of owners) {
        let list = []
        try {
          list = jobs.list(owner) ?? []
        } catch {
          continue // 某个 owner 查不了就跳过，别让一个异常把整轮检查废掉
        }
        for (const job of list) {
          const id = String(job?.id ?? '?')
          if (seen.has(id)) continue
          if (job?.status === 'running' || job?.status === 'stopping') {
            seen.add(id)
            busy.push({ kind: 'job', id, status: String(job.status), owner: owner ?? '(unowned)' })
          }
        }
      }
    }
    return busy
  }

  // ── 重启 helper ──────────────────────────────────────────────────────────
  //
  // ⚠️ 2026-10-17 实测：从这个宿主里 `spawn(detached)` 出来的 PowerShell **活不下来**
  //    （脚本写出来了、spawn 也没报错，但日志里一行 "helper start" 都没有，DSH 也没动）。
  //    换成计划任务起就活得好好的 —— 说明来源进程树本身有"连坐"的清理机制。
  //    所以改成两路并发：
  //      快路：直接 spawn（如果哪天宿主不连坐了，1.2 秒就动手）
  //      兜底：把"该重启了"写成 state + 固定路径的 helper 脚本，
  //            由外部那个每 15 秒跑一次的计划任务（dsh-restart-watch）看到就执行。
  //    两条路都调同一个 helper 脚本，谁先跑起来算谁的；state 在重启后会被清空，
  //    所以兜底任务看到 phase != 'restarting' 自然就不动了。

  const helperPath = join(dirname(statePath), 'dsh-restart-helper.ps1')
  const watchPath = join(dirname(statePath), 'dsh-restart-watch.ps1')
  /** 窗口状态落盘：DSH 自己不保存，只能重启前记、重启后摆回去（helper 里做）。 */
  const windowStatePath = join(dirname(statePath), 'dsh-restart-window.json')

  function writeHelperFile(exe, delayMs) {
    writeFileSync(
      helperPath,
      buildHelperScript({
        exe,
        port: Number(config.port) || 19387,
        delayMs,
        helperLog: logPath,
        windowStatePath,
      }),
      'utf8',
    )
    return helperPath
  }

  function spawnHelper(scriptPath) {
    appendLog('helper', `spawn ${scriptPath}`)
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: tmpdir() },
    )
    child.on('error', (error) => appendLog('helper', `spawn failed: ${error?.message ?? error}`))
    child.unref()
  }

  /**
   * 看守脚本：由计划任务每分钟直接拉起一次，跑 58 秒自己退出，下一分钟接上。
   * state 里是 restarting（且没过期）就跑 helper 重启 DSH，否则什么都不做。
   *
   * 这个文件每次 apply 都会重写：路径、端口这些跟着配置走，不会因为用户改配置而失效。
   */
  const vbsPath = join(dirname(statePath), 'dsh-restart-watch.vbs')
  /** 计划任务名（注册/查/卸载都用它）。 */
  const TASK_NAME = 'DshRestartWatch'

  /**
   * 启动器（.vbs）。计划任务的动作指向它，而不是直接指向 powershell.exe ——
   * 因为任务以"用户已登录时运行"的方式跑时，`-WindowStyle Hidden` **压不住**控制台窗口，
   * 每分钟会弹一个黑框（2026-10-17 主人截图问"这个是"）。wscript 自己没有控制台，
   * `Run(..., 0, False)` 里的 0 才是真隐藏。
   *
   * ⚠️ 必须写 UTF-16 LE + BOM：.vbs 里带着**绝对路径**（$DSH_HOME 可能含非 ASCII
   *    字符，例如中文用户名），而 wscript 默认按 ANSI 读文件，UTF-8 无 BOM 会让路径
   *    直接乱码、脚本跑不起来。
   */
  function writeWatchLauncher() {
    const content =
      "' dsh-restart watch launcher (generated; safe to delete)\r\n" +
      `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${watchPath}""", 0, False\r\n`
    const bom = Buffer.from([0xff, 0xfe])
    writeFileSync(vbsPath, Buffer.concat([bom, Buffer.from(content, 'utf16le')]))
    return vbsPath
  }

  /**
   * 装上（或刷新）那个每分钟拉一次看守的计划任务。
   *
   * 用户零配置：插件启动时自己 `schtasks /create /xml`。为什么用 schtasks 而不是
   * PowerShell 的 Register-ScheduledTask：前者是原生的、启动快；而这里是在宿主进程里
   * spawn 子进程，**可能**会被进程树连坐（实测宿主 spawn 的长命进程会被清掉），
   * 所以要挑执行时间最短的那条路，并且 5 秒后自己回查一次任务文件在不在。
   *
   * 任务已经存在就不重复创建（每次开机都跑一次 create 会写日志、没必要）。
   */
  function ensureScheduledTask() {
    if (process.platform !== 'win32') return
    const taskFile = join(dirname(statePath), 'dsh-restart-watch-task.xml')
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const registered = join(systemRoot, 'System32', 'Tasks', TASK_NAME)

    try {
      // schtasks /xml 只吃 UTF-16 LE + BOM。
      writeFileSync(taskFile, `\ufeff${buildTaskXml({ launcherPath: vbsPath })}`, 'utf16le')
    } catch (error) {
      logger.warn(`写任务 XML 失败：${error?.message ?? error}`)
      return
    }

    if (existsSync(registered)) {
      appendLog('task', 'scheduled task already registered')
      return
    }

    try {
      // schtasks 很快；即使这个子进程随后被连坐，命令本身大概率已经执行完了。
      const child = spawn('schtasks.exe', ['/create', '/tn', TASK_NAME, '/xml', taskFile, '/f'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', (error) => appendLog('task', `schtasks spawn failed: ${error?.message ?? error}`))
      child.unref()
      appendLog('task', `registering scheduled task from ${taskFile}`)
    } catch (error) {
      appendLog('task', `schtasks threw: ${error?.message ?? error}`)
      return
    }

    // 回查：没有注册成功就把补救办法写进日志，别让人对着"重启没反应"猜。
    setTimeout(() => {
      try {
        if (existsSync(registered)) {
          appendLog('task', 'scheduled task registered ok')
          spawn('schtasks.exe', ['/run', '/tn', TASK_NAME], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
        } else {
          appendLog(
            'task',
            `scheduled task NOT registered - restart execution will not work until you run: ` +
              `schtasks /create /tn ${TASK_NAME} /xml "${taskFile}" /f`,
          )
        }
      } catch {
        /* 只是回查，失败无所谓 */
      }
    }, 5000).unref?.()
  }

  function writeWatchScript() {
    // PowerShell 单引号字面量：只有 ' 要翻倍，反斜杠原样保留（用 JSON.stringify 会把
    // C:\Users\... 变成 C:\\Users\\... —— PowerShell 里那就是两个反斜杠，路径全废）。
    const lit = (value) => `'${String(value).replace(/'/g, "''")}'`
    //
    // ⚠️ 这个脚本是**由计划任务每分钟直接拉起、跑 58 秒就自己退出**的，不是无限循环，
    //    也不是"任务跑一次、脚本自己常驻"：
    //    - 计划任务的重复间隔最小 1 分钟（PT15S 会被拒），所以频率靠任务的重复；
    //    - 而"先跑一个 guard、guard 再 Start-Process 出常驻看守"这条路**走不通** ——
    //      任务上下文里拉起来的子进程会跟着父进程一起被清掉（实测：看守日志一行都没有，
    //      进程启动即死）。让任务**自己**跑看守才是最稳的形状。
    const body = `# dsh-restart watch (generated; safe to delete)
# Pulled up by the DshRestartWatch scheduled task once a minute; runs about 58 seconds
# and exits so the next trigger takes over.
$ErrorActionPreference = 'SilentlyContinue'
$State = ${lit(statePath)}
$Helper = ${lit(helperPath)}
$Log = ${lit(logPath)}
$Lock = ${lit(join(dirname(statePath), 'dsh-restart-acting.lock'))}

function Note([string]$m) {
  try { Add-Content -LiteralPath $Log -Value ("[{0}] watch: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch { }
}

Note ("watch tick start (pid " + $PID + ")")

# ⚠️ 循环体必须包 try/catch：PowerShell 的**终止性**错误（比如读到写了一半的 state、
#    ConvertFrom-Json 抛 ArgumentException）会让 while 直接结束、进程退出 ——
#    那之后就只能等下一分钟的触发来救（2026-10-17 实测：18:21 那次重启就是这么没的）。
#    catch 住就只是这一轮跳过。
$deadline = (Get-Date).AddSeconds(58)
$seq = 0
while ((Get-Date) -lt $deadline) {
  $seq = $seq + 1
  try {
    $act = $false
    $locking = Test-Path -LiteralPath $Lock
    if ($locking) {
      $lockAge = ((Get-Date) - (Get-Item -LiteralPath $Lock).LastWriteTime).TotalSeconds
      if ($lockAge -ge 120) { Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue; $locking = $false }
    }
    if (-not $locking -and (Test-Path -LiteralPath $State) -and (Test-Path -LiteralPath $Helper)) {
      # ⚠️ -Encoding UTF8 不能省：state 是 Node 按 UTF-8 写的（无 BOM），PowerShell 5.1 的
      # Get-Content 默认按系统 ANSI(GBK) 读 → note 里的中文一乱码，JSON 就解析失败 →
      # $json 是 $null → 永远认不出 restarting（2026-10-17 实测踩过：日志里一行都没有）。
      $json = Get-Content -LiteralPath $State -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $json -and $json.phase -eq 'restarting') {
        $ageSec = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$json.restartStartedAt) / 1000
        if ($ageSec -ge 0 -and $ageSec -le 300) { $act = $true; $ageText = [int]$ageSec }
      }
    }
    if ($act) {
      New-Item -ItemType File -Path $Lock -Force | Out-Null
      Note ("state is restarting (" + $ageText + "s old) - running helper")
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $Helper
      Note 'helper returned'
      # ⚠️ 执行完必须主动放 lock：否则它自己就成了"120 秒冷却"，把后面每一次检查全挡掉
      #    （2026-10-17 实测：18:16:34 排队的重启，硬生生等到 18:17:31 才被执行，就是因为
      #    18:15 那次留下的 lock 还在 120 秒窗口里）。
      #    但也不能立刻放：新 DSH 要几秒才起得来，这段时间 state 仍是 restarting，
      #    马上放 lock 会让下一轮循环再杀一次。等它起来（插件会在 boot 时把 state 清成 idle）。
      Start-Sleep -Seconds 20
      Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue
      Note 'lock released'
    }
  } catch {
    Note ("loop error: " + $_.Exception.Message)
  }
  Start-Sleep -Seconds 2
}
Note ("watch tick end (pid " + $PID + ", " + $seq + " passes)")
`
    writeFileSync(watchPath, `\ufeff${body}`, 'utf8')
    return watchPath
  }

  // ── 排队 + 轮询 ──────────────────────────────────────────────────────────

  let idleSince = 0
  let ticking = false
  // ⚠️ 这里**故意没有** restarting 标志。曾经有过一个：startRestart 里置 true，
  //    然后 tick 一开头 `if (ticking || restarting) return`。问题是它只有"重启成功"那条路
  //    才会被清掉 —— 一旦 helper 没跑起来（2026-10-17 18:21 实测就是），这个标志就永远挂着，
  //    **插件从此再也不会处理任何排队请求**，而 state 里明明还躺着 queued。
  //    防重复启动只需要看 state.phase 就行（写到 'restarting' 之后 tick 自然不再进来）。

  function startRestart(state) {
    const exe = resolveExe()
    if (!exe) {
      appendLog('restart', '无法确定要重启的 exe（exePath 留空且当前不是桌面宿主）——取消')
      clearState()
      return
    }
    // 动手前再确认一次。tick 检查到这里最多隔 2 秒，但"后台任务在这 2 秒里刚起来"是完全
    // 可能的 —— 那种情况下宁可退回排队，也不要打断别人的活。
    const busyNow = listBusy()
    if (busyNow.length > 0) {
      appendLog('restart', `动手前又忙起来了（${busyNow.map((b) => `${b.kind}:${b.id}`).join(', ')}）—— 退回排队`)
      writeState({ ...state, phase: 'queued' })
      return
    }
    writeState({ ...state, phase: 'restarting', restartStartedAt: Date.now() })
    appendLog('restart', `idle confirmed → restarting ${exe}`)

    let scriptPath = ''
    try {
      scriptPath = writeHelperFile(exe, 1200)
      appendLog('helper', `written ${scriptPath}`)
    } catch (error) {
      appendLog('helper', `写 helper 脚本失败：${error?.message ?? error}`)
    }
    if (scriptPath) {
      try {
        // 快路。活不下来也没关系 —— 兜底的计划任务会捡起来。
        spawnHelper(scriptPath)
      } catch (error) {
        appendLog('helper', `spawn threw: ${error?.message ?? error}`)
      }
    }
  }

  function tick() {
    if (ticking) return
    ticking = true
    try {
      const state = readState()
      // state 卡在 'restarting' 超过 5 分钟 = 那次重启根本没成（helper 没跑起来、exe 起不来…）。
      // 不放它自己恢复的话，插件会永远等着一个不会到来的重启，后面排队的请求也全被堵死。
      if (state.phase === 'restarting') {
        const age = Date.now() - Number(state.restartStartedAt || 0)
        if (age > 5 * 60 * 1000) {
          appendLog('watchdog', `上次重启卡了 ${Math.round(age / 1000)}s 没动静 —— 把 state 复位成 idle`)
          clearState()
          idleSince = 0
        }
        return
      }
      if (state.phase !== 'queued') {
        idleSince = 0
        return
      }
      const busy = listBusy()
      if (busy.length > 0) {
        if (idleSince !== 0) appendLog('wait', `又开始忙了：${busy.map((b) => `${b.id}=${b.status}`).join(', ')}`)
        idleSince = 0
        return
      }
      // 宽限期默认 0（主人 2026-10-17：「只要空闲了，且需要重启就立马重启」）——
      // 看到空闲就直接动手，不再等"连续空闲 N 秒"。
      // 想要一点缓冲就把 idleGraceMs 调成正数，行为退回旧版。
      const grace = Math.max(0, Number(config.idleGraceMs) || 0)
      if (grace > 0) {
        if (idleSince === 0) {
          idleSince = Date.now()
          appendLog('wait', '检测到空闲，开始计宽限期')
          return
        }
        if (Date.now() - idleSince < grace) return
      }
      startRestart(state)
    } catch (error) {
      logger.warn(`tick 失败：${error?.message ?? error}`)
    } finally {
      ticking = false
    }
  }

  const pollMs = Math.max(500, Number(config.pollMs) || 2000)
  const timer = setInterval(tick, pollMs)
  ctx.effect(() => () => clearInterval(timer))

  // ── 重启后：叫醒发起会话 ─────────────────────────────────────────────────

  function resumeText(state) {
    const when = new Date(Number(state.restartStartedAt) || Date.now())
    const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    const note = String(state.note ?? '').trim()
    const reason = String(state.reason ?? '').trim()
    return [
      `[DSH 已自动重启完成 · ${hhmm}] 重启由 dsh-restart 插件安排：所有会话都空闲之后，`,
      '它杀掉了旧的 DSH 进程树并重新拉起（插件 / 配置的改动现在应该已经生效）。',
      reason ? `重启原因：${reason}` : '',
      note ? `重启前的交代：${note}` : '',
      '请先确认刚才被打断的事情到了哪一步，然后继续 —— 该验证的验证，该往下做的往下做。',
      '如果发现某个改动其实没生效，再调用一次 dsh_restart 即可。',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  function wake(agent, text) {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      // 0.2.0 的 v4 消息格式要求 producer-owned 的 source（`kind:'plugin'` 会被拒）。
      source: { kind: `plugin:${PACKAGE}` },
    })
    // ⚠️ inject() 只进上下文、**不唤醒**（宿主自带注释就写着）。要真叫醒必须 followup。
    const send = () => (typeof agent.followup === 'function' ? agent.followup(message) : agent.inject(message))
    try {
      return ctx.agents.withInitiator(agent, send)
    } catch {
      return send()
    }
  }

  async function waitForAgent(sessionId, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    while (Date.now() < deadline) {
      const live = ctx.agents?.get?.(sessionId)
      if (live) return live
      await sleep(3000)
    }
    return undefined
  }

  /**
   * 会话没被 UI 加载出来时的兜底：显式 resume 把它拉起来。
   *
   * ⚠️ resume 必须带 agentOptions（模型），否则提示词里的 {{model}} 没值、整轮组装失败
   * （dsh-qq-bridge 踩过这个坑，这里的取法和它一样：投影 → 日志里的 request/header →
   * 部署默认模型，三层兜底）。
   */
  async function resolveAgentOptions(sessionId) {
    try {
      const q = ctx.get?.('sessionQuery')
      if (q && typeof q.observeSession === 'function') {
        const obs = await q.observeSession(sessionId, { projectionMode: 'all' })
        try {
          const proj = obs?.projections
          const pending =
            proj?.['modelSelection']?.pending ??
            (typeof proj?.get === 'function' ? proj.get('modelSelection')?.pending : undefined)
          if (pending?.provider && pending?.model) {
            return {
              provider: pending.provider,
              model: pending.model,
              ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
            }
          }
          const events = Array.isArray(obs?.events) ? obs.events : []
          for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]
            if (event?.type !== 'request/header') continue
            const cfg = event.data?.header?.config
            if (cfg?.provider && cfg?.model) {
              return {
                provider: cfg.provider,
                model: cfg.model,
                ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
              }
            }
          }
        } finally {
          if (obs && typeof obs.dispose === 'function') obs.dispose()
        }
      }
    } catch (error) {
      logger.warn(`读会话模型失败（退回部署默认）：${error?.message ?? error}`)
    }
    try {
      const fallback = ctx.get?.('agentDefaultModel')
      const sel = typeof fallback?.currentSelection === 'function' ? fallback.currentSelection() : undefined
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch {
      // 没有默认模型服务就算了
    }
    return undefined
  }

  async function tryResume(sessionId) {
    try {
      const agentOptions = await resolveAgentOptions(sessionId)
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      })
      const agent = handle?.agent ?? handle
      appendLog('recover', `resume(${sessionId}) → ${agent ? 'ok' : 'no agent'}`)
      return agent && typeof agent.followup === 'function' ? agent : undefined
    } catch (error) {
      appendLog('recover', `resume 失败：${error?.message ?? error}`)
      return undefined
    }
  }

  async function recover(state) {
    const sessionId = String(state.sessionId ?? '')
    if (!sessionId) {
      appendLog('recover', '状态里没有 sessionId，跳过唤醒')
      clearState()
      return
    }
    let agent = await waitForAgent(sessionId, Number(config.resumeWaitMs) || 90000)
    if (!agent) {
      appendLog('recover', `会话 ${sessionId} 一直没被 UI 加载，尝试 resume 拉起`)
      agent = await tryResume(sessionId)
    }
    if (!agent) {
      appendLog('recover', `会话 ${sessionId} 拉不起来 —— 放弃唤醒（状态已清空，下次重启重来）`)
      clearState()
      return
    }
    try {
      await wake(agent, resumeText(state))
      appendLog('recover', `已唤醒会话 ${sessionId}`)
    } catch (error) {
      appendLog('recover', `唤醒失败：${error?.message ?? error}`)
    }
    clearState()
  }

  // apply 时立刻检查：这次启动是不是上一次排队重启的结果。
  try {
    const boot = readState()
    if (boot.phase === 'restarting') {
      const age = Date.now() - Number(boot.restartStartedAt || 0)
      if (age >= 0 && age < STALE_MS) {
        appendLog('boot', `检测到上一次重启（${Math.round(age / 1000)}s 前），准备唤醒 ${boot.sessionId || '(无会话)'}`)
        writeState({ ...boot, phase: 'restarting', lastRestartAt: Date.now() })
        const delay = Math.max(2000, Number(config.resumeDelayMs) || 12000)
        setTimeout(() => {
          recover(readState()).catch((error) => logger.warn(`recover 失败：${error?.message ?? error}`))
        }, delay)
      } else {
        appendLog('boot', `上一次重启状态已过期（${Math.round(age / 1000)}s），忽略`)
        clearState()
      }
    }
  } catch (error) {
    logger.warn(`启动检查失败：${error?.message ?? error}`)
  }

  // 每次启动都刷新看守脚本 + 启动器：里面的路径 / 端口跟着当前配置走。
  try {
    writeWatchScript()
    writeWatchLauncher()
    appendLog('boot', `watch script + launcher refreshed: ${watchPath}`)
  } catch (error) {
    logger.warn(`写看守脚本失败：${error?.message ?? error}`)
  }

  // 装上那个每分钟拉一次看守的计划任务（已经装过就跳过）。
  try {
    ensureScheduledTask()
  } catch (error) {
    logger.warn(`注册计划任务失败：${error?.message ?? error}`)
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'dsh_restart',
      description:
        '安排一次 DSH 重启（改了插件/配置之后用）。它不会立刻动手：先排队，等**所有会话都空闲**' +
        '（没有正在生成的轮、没有排队的消息、没有跑着的后台任务）且连续空闲几秒后才重启；' +
        '重启会杀掉旧进程树再拉起同一个 exe，**当前这一轮对话会断**。' +
        '重启完成后插件会自动唤醒你并附上这里给的 note —— 所以把"重启后要干嘛"写进 note。',
      parameters: {
        note: { type: 'string', description: '重启完成后要交代给自己的话，例如「验证 xxx 插件是否生效」。' },
        reason: { type: 'string', description: '为什么重启（写进日志与唤醒消息）。' },
        now: { type: 'boolean', description: 'true = 不等空闲，检查一次后立刻重启（危险，会打断别人的会话）。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec?.agent)
        const state = readState()
        if (state.phase === 'restarting') {
          return JSON.stringify({ ok: false, why: '已经有一次重启在进行中（上次排队后已经动手）', state }, null, 2)
        }
        const next = {
          ...emptyState(),
          phase: 'queued',
          sessionId,
          note: String(args.note ?? ''),
          reason: String(args.reason ?? ''),
          requestedAt: Date.now(),
          lastRestartAt: Number(state.lastRestartAt ?? 0),
        }
        writeState(next)
        idleSince = 0
        appendLog('queue', `排队重启：session=${sessionId || '(未知)'} note=${next.note || '(空)'}`)

        if (args.now === true) {
          const busy = listBusy()
          if (busy.length > 0) appendLog('queue', `now=true 时仍有 ${busy.length} 个忙的会话，照样重启`)
          startRestart(next)
          return JSON.stringify({ ok: true, mode: 'immediate', busy }, null, 2)
        }

        const busy = listBusy()
        return JSON.stringify(
          {
            ok: true,
            mode: 'queued',
            sessionId,
            note: next.note,
            busyNow: busy,
            pollMs,
            idleGraceMs: Number(config.idleGraceMs),
            hint:
              busy.length > 0
                ? '还有会话在忙，会一直等它们做完（你这一轮结束也算）。重启完成后会收到一条"重启完成"的消息。'
                : '现在看起来空闲，但宽限期结束前你这一轮还会占着会话 —— 等你这轮说完就会重启。',
          },
          null,
          2,
        )
      },
    }),
  )

  if (config.debugTools) {
    ctx.tools.register(
      defineTool({
        name: 'dsh_restart_status',
        description: '查看 dsh-restart 状态：排队的重启请求、当前哪些会话算"忙"、状态文件与日志位置。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute() {
          let tail = []
          try {
            tail = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').slice(-12)
          } catch {
            tail = []
          }
          return JSON.stringify(
            {
              state: readState(),
              busy: listBusy(),
              idleGraceMs: Number(config.idleGraceMs),
              pollMs,
              isDesktop: isDesktopHost(),
              exe: resolveExe() || '(无法确定)',
              pid: process.pid,
              ppid: process.ppid,
              statePath,
              logPath,
              logTail: tail,
            },
            null,
            2,
          )
        },
      }),
    )
  }
}
