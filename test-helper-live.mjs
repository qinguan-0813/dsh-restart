// 影子测试：**真的跑一遍** helper 的"杀进程 → 等端口 → 重新拉起"流程，但把
// 「DeepSeek Harness.exe」换成一个无害的目标（ping.exe），所以不会碰到 DSH。
//
// 这是唯一能验证 helper 逻辑的办法 —— 直接对着 DSH 跑一次就等于自杀。
// 验证点：旧 ping 被杀掉、新 ping 被拉起（不同 pid）、日志里有对应记录。
//
// 用法：node test-helper-live.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHelperScript } from './helper.js'

const target = 'C:\\Windows\\System32\\CHARMAP.EXE' // 无参数也会常驻（弹个小窗口）—— 用它当假 DSH
const PORT = 19999 // 没人监听：helper 应该立刻判定"端口已释放"
const procName = 'CHARMAP'
const work = mkdtempSync(join(tmpdir(), 'dsh-restart-live-'))
const logPath = join(work, 'helper.log')
const scriptPath = join(work, 'helper.ps1')

const ps = (command) =>
  String(
    spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).stdout ?? '',
  ).trim()

function pidsOf(name) {
  return ps(`@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue).Id -join ','`)
    .split(',')
    .filter((s) => s.trim() !== '')
    .map((s) => s.trim())
}

const killAll = (name) => ps(`Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Stop-Process -Force`)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

killAll(procName)

// 1) 起一个"假的 DSH"：charmap 无参数会常驻（弹个字符映射表窗口），跑完测试再杀掉
spawn(target, [], { stdio: 'ignore', windowsHide: true }).unref()
await new Promise((r) => setTimeout(r, 1500))
const before = pidsOf(procName)
check('victim started', before.length > 0, `pids=${before.join(',')}`)

// 2) 用插件里**同一个** buildHelperScript 生成脚本，认真实跑一遍
writeFileSync(scriptPath, buildHelperScript({ exe: target, port: PORT, delayMs: 200, helperLog: logPath }), 'utf8')
const run = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  stdio: 'ignore',
  windowsHide: true,
})
const exitCode = await new Promise((resolve) => run.on('exit', (code) => resolve(code)))
check('helper exited cleanly', exitCode === 0, `exit=${exitCode}`)

// 3) 等新进程起来再核对
await new Promise((r) => setTimeout(r, 2500))
const after = pidsOf(procName)
check('old process killed', before.every((pid) => !after.includes(pid)), `before=${before.join(',')} after=${after.join(',')}`)
check('new process launched', after.length > 0, `pids=${after.join(',')}`)
check('replacement has a new pid', after.length > 0 && after.every((pid) => !before.includes(pid)))

// 4) 日志
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
const killedLine = log.split('\n').find((l) => l.includes('killed')) ?? '(no killed line)'
check('log records the kill', /killed 1 of 1 process/.test(log), killedLine.trim())
check('log records the relaunch', /relaunched pid=\d+/.test(log), log.split('\n').find((l) => l.includes('relaunched')) ?? '(no line)')

// 收尾
killAll(procName)
try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n${failures === 0 ? 'all live checks passed' : `${failures} live check(s) failed`}`)
if (failures > 0) process.exit(1)
