# dsh-restart

让 DSH 能**自己重启**：改完插件/配置不用手动关开，它会在所有会话都空闲时重启，
把窗口恢复成原样，再把发起重启的那个会话叫回来继续干活。

> Windows 专用（计划任务 + Win32 窗口操作）。DSH 桌面端 ≥ 0.2.0-rc.1。

## ⚠️ 装之前先知道三件事

1. **它会杀掉整个 `DeepSeek Harness.exe` 进程树**（主进程 + host + 渲染进程），
   然后重新拉起。所有会话都会被打断一轮。
2. **它会给你装一个计划任务** `DshRestartWatch`（每分钟跑一次看守脚本）。
   不装这个任务，重启请求会一直排队但永远不执行 —— 原因见「为什么需要一个外部看守」。
3. 它会写几个文件到 `$DSH_HOME`（默认 `~/.dsh`）：

   | 文件 | 作用 |
   |---|---|
   | `dsh-restart-state.json` | 排队中的重启请求 |
   | `dsh-restart-window.json` | 重启前的窗口状态（是否最大化 / 位置 / 尺寸）|
   | `dsh-restart-helper.ps1` | 真正执行"杀 + 等端口 + 拉起 + 摆窗口"的脚本 |
   | `dsh-restart-watch.ps1` | 看守：每 2 秒看一眼 state，该重启就跑 helper |
   | `dsh-restart-watch.vbs` | 启动器（用 wscript 拉起看守，避免弹控制台窗口）|
   | `dsh-restart-watch-task.xml` | 计划任务的描述文件 |
   | `dsh-restart.log` | 三方共用的日志 |

## 安装

```bash
dsh plugin add dsh-restart
# 或者本地开发：
# dsh plugin add file:/path/to/dsh-restart
```

装完**手动重启一次 DSH**（这是唯一需要你动手的一次）——之后它就能自己重启了。

## 用法

模型侧有两个工具：

```
dsh_restart({ note: "重启完成后验证 xxx 是否生效", reason: "改了 xxx 插件" })
dsh_restart_status()          # 排队状态 / 谁还在忙 / 日志尾巴
```

`dsh_restart` **不会立刻重启**：

1. 落盘一个排队请求；
2. 每 `pollMs`（默认 2 秒）检查一次所有会话 —— 判据照抄宿主自己的
   `hasDesktopActiveTasks`：`status === 'running'`、inbox 里有排队消息、
   有 running/stopping 的后台任务，都算忙；
3. **一旦所有会话都空了就立刻动手**（`idleGraceMs` 默认 0）；
4. 重启完成后，插件在下次启动时读到 `restarting` 状态，等会话被 UI 加载出来，
   用 `followup()`（不是 `inject()` —— 那个只进上下文、不唤醒）投一条
   "重启完成"的消息，附上你给的 `note`。

调用之后这一轮照常说完，插件会等在**这一轮结束之后**的空档重启，然后把你叫回来。

实际延迟：`pollMs`(≤2s) + 看守轮询(≤2s) + helper 延迟(1.2s) + 杀进程/等端口(≈2s)
≈ **5~7 秒**（前提是没有别的会话在忙）。

### 强制立即重启

`{ now: true }` 会跳过"等空闲"直接动手 —— **会打断别人的会话**，慎用。

## 它是怎么工作的

```
dsh_restart 工具
  └─ state.json：{ phase: 'queued', sessionId, note, reason }
       └─ 插件每 2 秒轮询：所有会话都空闲？
            └─ phase 改 'restarting'，写 helper 脚本，试着 spawn 它（快路，通常无效）
                 └─ 兜底：外部看守每 2 秒读 state，看到 'restarting' 就跑 helper
                      └─ helper：记窗口状态 → 杀进程树 → 等端口释放 → 拉起 exe → 摆回窗口
                           └─ 新进程启动时插件读到 'restarting' → 唤醒发起会话 → 清空 state
```

### 为什么需要一个外部看守

在宿主进程里 `spawn()` 出来的子进程**活不下来**：脚本能写出来、`spawn` 也不报错，
但子进程一行日志都没来得及写就没了（宿主那条进程树会被整体清理，`detached` 也逃不掉）。
而由**计划任务**拉起的进程活得好好的。

所以真正干活的永远是外部那个看守进程 —— 插件自己 spawn 那一下只是"万一哪天能用"的快路。

### 为什么计划任务是"每分钟一次、每次跑 58 秒"

- 计划任务的重复间隔**最小 1 分钟**（`PT15S` 会被系统直接拒绝），所以频率只能靠触发器；
- 而"任务只触发一次、脚本自己常驻"不行：常驻进程一死就再没有人把它拉起来；
- 而"任务跑一个 guard、guard 再 `Start-Process` 出常驻看守"也不行：任务上下文里拉起来的
  子进程会跟着父进程一起被清掉。

→ 让任务**自己**承载周期性，脚本跑 58 秒退出，下一分钟的触发无缝接上。

### 为什么动作是 `wscript.exe` 而不是 `powershell.exe`

任务以"用户已登录时运行"的方式跑时，`-WindowStyle Hidden` **压不住**控制台窗口，
每分钟会弹一个黑框。`wscript` 自己没有控制台，VBS 里 `Run(..., 0, False)` 的 0 才是真隐藏。

## 窗口状态

DSH 桌面端**自己不保存**窗口状态（userData 里没有任何 window-state 文件），所以重启后
窗口总是回到默认尺寸。改不了宿主，就自己记：

- helper 在**杀进程之前**用 Win32 `GetWindowPlacement` 记下 `showCmd`（3=最大化 / 2=最小化 /
  1=正常）和 `rcNormalPosition`（还原后的矩形）；
- 新进程起来后，等主窗口出现（最多 90 秒），再用 `ShowWindow(SW_MAXIMIZE)` 或
  `SetWindowPos` 摆回原位。

⚠️ **不能用 `GetWindowRect` 取几何**：窗口最小化时它返回 `-25600,-25600` 那一类垃圾坐标
（实测踩过：记成 `159x27`，恢复时被判「无效」直接跳过）。`GetWindowPlacement` 的
`rcNormalPosition` 才是"还原后该在哪"，最小化 / 最大化都稳。

只能走 Win32 —— 插件跑在 host 进程里，拿不到 Electron 的 `BrowserWindow`。

## 配置

都在 profile 的插件配置页里改（`cordis.patch.yml` 里有完整注释）：

| 键 | 默认 | 说明 |
|---|---|---|
| `statePath` | `$DSH_HOME/dsh-restart-state.json` | 状态文件 |
| `exePath` | 自动探测 | 要重启的 exe；桌面端取 `process.execPath` |
| `port` | `19387` | 宿主 Web 端口，helper 用它判断旧进程是否真退出 |
| `pollMs` | `2000` | 检查间隔 |
| `idleGraceMs` | `0` | 检测到空闲后还等多久（0 = 立刻）|
| `resumeDelayMs` | `12000` | 重启后等多久再唤醒 |
| `resumeWaitMs` | `90000` | 唤醒前最多等会话加载多久 |
| `debugTools` | `true` | 注册 `dsh_restart_status` |

## 卸载

1. 卸插件：`dsh plugin remove dsh-restart`
2. 删掉那个计划任务（否则它会每分钟跑一次已经不存在的脚本）：

```bat
schtasks /delete /tn DshRestartWatch /f
```

3. 可选：删掉 `$DSH_HOME` 下的 `dsh-restart*` 文件。

## 出问题了怎么看

先看日志：

```powershell
Get-Content $HOME\.dsh\dsh-restart.log -Tail 20
```

- `watch tick start` / `watch tick end` **每分钟各一行** = 看守在正常工作。
  这两行停了就说明计划任务没跑 → `schtasks /run /tn DshRestartWatch` 拽一把，
  或者 `schtasks /query /tn DshRestartWatch` 看任务还在不在。
- 有 `queue:` 但迟迟没有 `restart:` = 还有会话在忙。`dsh_restart_status` 的 `busy` 会点名是谁。
- 有 `restart:` 但没有 `helper start` = 看守没接上（任务挂了 / 被删了）。
- `kill failed ... 拒绝访问` 是正常的：普通权限只能杀掉自己能杀的，
  主进程一死剩下的会跟着退出，端口照样释放。

## 已知限制

- **Windows 专用**。计划任务、`wscript`、Win32 窗口 API 都是 Windows 的。
- **无法优雅退出**：helper 是强杀（`Process.Kill()`）。所以"重启前落盘"这类事只能靠
  插件把 state 提前写好，宿主自己的退出钩子不会跑。
- **窗口状态恢复是尽力而为**：如果新进程 90 秒内没出主窗口（比如启动失败），就不恢复，
  日志里会写 `no window appeared within 90s`。
- 如果一个会话**卡在 `running` 状态**很久（不是真在干活），重启会一直被它挡住。
  用 `dsh_restart_status` 确认是谁，必要时 `{ now: true }` 强推。

## 开发

```bash
node test-helper.mjs        # 静态检查生成的 helper（BOM / 注入值 / 关键调用）
node test-task.mjs          # 用临时任务名验证计划任务 XML 能被 schtasks 接受
node test-helper-live.mjs   # 影子测试：真跑一遍 helper 的"杀→等→拉起"，目标是 charmap.exe
powershell -File test-parse.ps1 -Path dsh-restart-helper.ps1   # PS 5.1 语法解析
powershell -File test-window.ps1                               # 只读验证窗口状态读取方式
```

`test-helper-live.mjs` 是唯一能验证 helper 逻辑的办法 —— 直接对着 DSH 跑一次就等于自杀。

### 踩过的坑（改代码前先读）

1. **编码**：state 是 Node 按 UTF-8 写的（无 BOM），而 PowerShell 5.1 的 `Get-Content`
   默认按系统 ANSI(GBK) 读。中文一乱码 JSON 就解析失败 → 看守永远认不出 `restarting`。
   **脚本里读 state 必须带 `-Encoding UTF8`**。
2. **helper 脚本必须带 BOM**：路径可能含非 ASCII 字符，PS 5.1 没有 BOM 就按 GBK 读，
   直接语法错误、脚本不执行。
3. **lock 不能留着**：执行完 helper 必须删 lock 文件，否则它自己就变成 120 秒冷却，
   把后面每一次检查全挡掉；但也不能立刻删 —— 新 DSH 起来之前 state 还是 `restarting`，
   立刻删会让下一轮再杀一次。等 20 秒再删。
4. **循环体必须包 `try/catch`**：PowerShell 的终止性错误（读到写了一半的 state 等）
   会让脚本整个退出，那之后就只能等下一分钟的触发来救。
5. **不要用状态标志防重复**：曾经有个 `restarting` 布尔，只有"重启成功"那条路会清它，
   一旦某次 helper 没跑起来就永久卡死，**后续所有排队请求都不再执行**。
   防重复看 `state.phase` 就够了。
6. **任务 XML 必须是 UTF-16 LE + BOM**：`schtasks /xml` 只吃这种编码。

## License

MIT
