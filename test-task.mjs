// 验证生成的计划任务 XML 能被 schtasks 接受（用临时任务名试创建 / 再删掉，不碰真任务）。
// 用法：node test-task.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTaskXml } from './helper.js'

const TEST_TASK = 'DshRestartWatchXmlProbe'
const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-xml-'))
const xmlPath = join(dir, 'task.xml')
// schtasks /xml 只吃 UTF-16 LE + BOM
writeFileSync(xmlPath, `\ufeff${buildTaskXml({ launcherPath: 'C:\\Users\\开心\\.dsh\\dsh-restart-watch.vbs' })}`, 'utf16le')

const buf = readFileSync(xmlPath)
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

check('utf16 BOM', buf[0] === 0xff && buf[1] === 0xfe, buf.subarray(0, 2).toString('hex'))
const text = buf.toString('utf16le')
check('has CalendarTrigger', text.includes('<CalendarTrigger>'))
check('repeats every minute', text.includes('<Interval>PT1M</Interval>'))
check('runs 58s per tick via wscript', text.includes('<Command>wscript.exe</Command>'))
check('launcher path embedded', text.includes('dsh-restart-watch.vbs'))

try {
  execFileSync('schtasks.exe', ['/create', '/tn', TEST_TASK, '/xml', xmlPath, '/f'], { encoding: 'utf8', windowsHide: true })
  check('schtasks accepted the XML', true)
} catch (error) {
  check('schtasks accepted the XML', false, String(error?.stderr ?? error?.message ?? error).trim())
}

try {
  execFileSync('schtasks.exe', ['/delete', '/tn', TEST_TASK, '/f'], { encoding: 'utf8', windowsHide: true })
  check('probe task removed', true)
} catch {
  check('probe task removed', false, 'left behind - remove manually')
}

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n${failures === 0 ? 'task XML ok' : `${failures} check(s) failed`}`)
if (failures > 0) process.exit(1)
