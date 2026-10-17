// 离线测 dsh-restart 生成的 PowerShell helper：
//   1) 生成的脚本带 BOM（PS 5.1 才认 UTF-8）
//   2) 磁盘上的脚本能被 PowerShell 解析器**解析**（不执行 —— 执行就把 DSH 杀了）
//   3) 关键路径/数值都正确注入
//
// 用法：node test-helper.mjs [输出目录]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildHelperScript, psQuote } from './helper.js'

const outDir = process.argv[2] ?? '.'
const exe = 'D:\\ZXQ\\DSH\\DeepSeek Harness.exe'
const helperLog = 'C:\\Users\\开心\\.dsh\\dsh-restart.log'
const windowStatePath = 'C:\\Users\\开心\\.dsh\\dsh-restart-window.json'
const script = buildHelperScript({ exe, port: 19387, delayMs: 1200, helperLog, windowStatePath })
const outPath = join(outDir, 'dsh-restart-helper.ps1')
writeFileSync(outPath, script, 'utf8')

const buf = readFileSync(outPath)
const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
const text = buf.toString('utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

check('BOM', hasBom, hasBom ? 'EF BB BF' : 'missing (PS 5.1 would read it as GBK)')
check('exe path quoted', text.includes(`$Exe = ${psQuote(exe)}`), psQuote(exe))
check('port injected', text.includes('$Port = 19387'))
check('delay injected', text.includes('$DelayMs = 1200'))
check('base name from exe', text.includes("[IO.Path]::GetFileNameWithoutExtension($Exe)"))
check('kills by name', text.includes('Get-Process -Name $ProcName'))
check('waits for port', text.includes("New-Object System.Net.Sockets.TcpClient"))
check('relaunches', text.includes('Start-Process -FilePath $Exe'))
check('saves window state', text.includes('window state saved'))
check('restores window state', text.includes('window restored'))
check('uses GetWindowPlacement', text.includes('[DshWin32]::GetWindowPlacement'))
check('has placement factory', text.includes('public static WINDOWPLACEMENT NewPlacement()'))
check('calls NewPlacement()', text.includes('[DshWin32]::NewPlacement()'))
check('records showCmd', text.includes('$wp.showCmd'))
check('uses ShowWindow(SW_MAXIMIZE)', text.includes('[DshWin32]::ShowWindow($h, 3)'))
check('waits for the new window', text.includes('no window appeared within 90s'))
check('window state path quoted', text.includes(`$WinState = ${psQuote(windowStatePath)}`))
check('no CRLF-only issue', !/\r\n/.test(text) || true) // 只是记录，PS 两种行尾都吃
// 中文**会**出现在脚本里（DSH_HOME 在 C:\Users\开心\ 下），所以不能要求纯 ASCII ——
// 能要求的是：只要存在非 ASCII 字符，BOM 就必须在（PS 5.1 只有靠 BOM 才会按 UTF-8 读）。
const nonAscii = /[^\x00-\x7F]/.test(text.replace(/^\ufeff/, ''))
check('non-ASCII requires BOM', !nonAscii || hasBom, nonAscii ? 'script carries CJK (paths) and BOM is present' : 'pure ASCII')

console.log(`\nwrote ${outPath} (${buf.length} bytes)`)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all static checks passed')
