# Agent 配置指南（微信源 + QQ 源）

> 这份文档写给 **AI Agent**：当你被要求在一台 Windows 电脑上「配好 WeNotice 并让它收到消息」时，按本文顺序执行。
> 人类读者也可以用它当排障手册。
>
> 一句话原则：**Token 环节（读取 → 校验 → 写入 WeNotice）全程由 Agent 自动完成，人类不复制、不粘贴；
> 只有「取微信解密密钥 / 扫码登录 / 设口令」保留给人类。**

---

## 0. 角色与边界

### Agent 允许自动做的事

- 检测软件是否安装、进程是否在跑、端口是否监听（只读）。
- 启动/重启 WeNotice、AstrWeChat、NapCat（不涉及登录态）。
- 读取 `%APPDATA%\weflow\WeFlow-config.json`、`%APPDATA%\weflow\bridge\config.json`（只读；需要把内容写进报告时对 token/密钥打码）。
- 在人工已确认 AstrWeChat 已连上微信后：**自动完成本地 API 开启、Token 读取/校验/写入**（详见 2.3 / 2.4；优先让 WeNotice 自己「自动读取」或「一键开启」，也可按 2.3-B 直接改 AstrWeChat 配置后重启）。
- 改 WeNotice 自己的配置（`<WeNotice 数据目录>\data\config.json`）、拉 QQ WebSocket 配置、跑验证清单。

### Agent 禁止做的事（必须停下来让人类操作）

1. **不要代替人类点 AstrWeChat「微信连接」页的「自动获取 / 自动检测」**，更不要往密钥输入框里打字或粘贴任何密钥。
   - 说明：AstrWeChat 的「自动获取」一旦点击，会自己扫描微信进程提取解密密钥并**自动填框 + 落盘**。这是它的设计行为，但属于敏感操作，必须由账号所有者当面确认。
2. **不要让人类复制/粘贴 Token，也不要把 Token 发到聊天/日志/回执里。** Token 的读取、校验、写入由 Agent 按 2.3/2.4 自动完成；任何地方只允许出现打码值（前 4 位 + 长度）。
3. **不要设置、猜测或改写任何口令/应用锁**（AstrWeChat 的 `authEnabled` / `authPassword`、Bridge 的口令等）。
4. **不要跨机器复制 `%APPDATA%\weflow`**。里面 `safe:` 字段是 DPAPI 加密的，换机/换用户必然解不开，只会制造「Token 解不开」的假故障。
5. **不要代替人类扫码登录**（NapCat / QQ 登录二维码）。
6. 不要向任何外部地址发送密钥、Token、二维码、聊天记录截图。

> 如果人类明确要求「你全自动搞定包括点自动获取」，先说清上面的风险并复述一次，得到确认再执行；执行后把「密钥已由 AstrWeChat 自动获取写入」写进回执。

---

## 1. 环境探测（只读）

```powershell
# WeNotice 是否安装（便携版通常在这两处之一）
$paths = @(
  "$env:LOCALAPPDATA\Programs\WeNotice\WeNotice.exe",
  "$env:USERPROFILE\WeNotice\WeNotice.exe"
)
$paths | Where-Object { Test-Path $_ }

# AstrWeChat 是否安装（注册表 / 常见路径）
Get-ChildItem 'C:\Program Files\astrwechat\AstrWeChat.exe','C:\Program Files (x86)\astrwechat\AstrWeChat.exe' -ErrorAction SilentlyContinue |
  Select-Object FullName, Length

# 进程与端口
Get-Process AstrWeChat, WeNotice, electron -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, MainWindowTitle
Get-NetTCPConnection -LocalPort 5031 -State Listen -ErrorAction SilentlyContinue

# WeNotice 版本
Get-ChildItem "$env:USERPROFILE\WeNotice\version.txt" -ErrorAction SilentlyContinue | Get-Content
```

判定：

- WeNotice 没装 → 到 https://github.com/Liuyeyuyangy0/WeNotice/releases 下载 portable zip，解压到 **`C:\Users\<用户名>\WeNotice`**（不要放在 `Documents` 之类可能受控的目录，见第 7 节托盘限制）。
- AstrWeChat 没装 → 到 https://github.com/CMKH1337/Astrwechat/releases 下载安装（需管理员）。
- 微信本体没开 → 提示人类先登录微信（WeNotice 设置里也能配「自动启动微信客户端」，但这解决不了首次登录）。

---

## 2. 微信数据源（AstrWeChat）

### 2.1 人工步骤（Agent 引导，人类操作）

1. 打开 AstrWeChat → 左侧「**微信连接**」。
2. 点「**自动检测**」找到微信数据目录/微信 ID。
3. 点「**自动获取**」→ 按提示**退出微信登录**再重新登录（不同版本提示不同，以界面为准）→ 密钥会自动填入。
4. 检查「数据目录 / 密钥 / 微信 ID」三项都有值 → 点「**连接数据库**」→ 能看到会话列表即成功。

> 这一步必须在 AstrWeChat 界面里由人类确认；Agent 不要代点、不要代填。

### 2.2 Agent 校验（只读，证明 2.1 真的成功）

```powershell
$cfg = Get-Content "$env:APPDATA\weflow\WeFlow-config.json" -Raw | ConvertFrom-Json
[pscustomobject]@{
  dbPath        = $cfg.dbPath
  myWxid        = $cfg.myWxid
  decryptKeyIsEncrypted = ($cfg.decryptKey -like 'safe:*')
  decryptKeyLength      = ($cfg.decryptKey | Measure-Object -Character).Characters
  apiEnabled    = $cfg.httpApiEnabled
  pushEnabled   = $cfg.messagePushEnabled
  tokenPresent  = [bool]$cfg.httpApiToken
} | Format-List

# 数据库是否真的能打开（看最后一行 open succeeded）
Get-Content "$env:APPDATA\weflow\logs\wcdb.log" -Tail 30 | Select-String 'open succeeded|open failed|error'
```

判定：

| 现象 | 结论 | 下一步 |
| --- | --- | --- |
| `dbPath`/`myWxid` 空 | 2.1 没做完 | 请人类回去完成「微信连接」 |
| `decryptKey` 为 `lock:` 开头 | 口令模式，WeNotice/Agent 无法解码 **Token**（解密密钥本身也必须由人类处理） | Token 按 2.3-B 重写明文后重启；解密密钥请人类在 AstrWeChat 里重走 2.1 |
| 日志没有 `open succeeded` | 密钥/版本不匹配 | 确认微信版本，重走 2.1；不要自己填 key |
| 全部正常 | 继续 2.3 | — |

### 2.3 开启本地 API（Agent 全自动，Token 不落地到聊天）

按 A → B → C 顺序尝试，任一条成功后即可：

**A. 用 WeNotice「一键开启 AstrWeChat API」（最省事）**
WeNotice → 设置 → 数据源 → 「**一键开启 AstrWeChat API**」。这个按钮会自动完成：
备份 AstrWeChat 配置 → 停止 AstrWeChat → 写入 `httpApiEnabled=true`、`messagePushEnabled=true`、`httpApiToken`（32 位 hex 明文）→ 重启 AstrWeChat → 等 `/health` → 自动读取并校验 Token。
Agent 可用界面自动化点它；点完后 WeNotice 会自动重连。

**B. 直接改 AstrWeChat 配置并重启（纯命令行，最适合 Agent）**

```powershell
$wf  = "$env:APPDATA\weflow\WeFlow-config.json"
$cfg = Get-Content $wf -Raw | ConvertFrom-Json
$cfg.httpApiEnabled   = $true
$cfg.messagePushEnabled = $true
$cfg.httpApiPort = 5031
$cfg.httpApiHost = '127.0.0.1'
if (-not $cfg.httpApiToken) {
  $cfg.httpApiToken = -join (1..32 | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
}
Copy-Item $wf "$wf.wenotice-bak" -Force
$cfg | ConvertTo-Json -Depth 8 | Set-Content $wf -Encoding UTF8

# AstrWeChat 运行时会缓存配置：必须先退出再改、再启动
Stop-Process -Name AstrWeChat -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process 'C:\Program Files\astrwechat\AstrWeChat.exe'

# 最多等 45 秒 health
$ok = $false
1..45 | ForEach-Object {
  Start-Sleep -Seconds 1
  try { if ((Invoke-RestMethod 'http://127.0.0.1:5031/health').status -eq 'ok') { $ok = $true; return } } catch { }
}
if (-not $ok) { throw 'AstrWeChat API 未在 45s 内就绪' }
```

> 改前必须备份；AstrWeChat 退出时会把内存配置写盘，所以顺序一定是「先退出 → 改文件 → 再启动」。

**C. AstrWeChat Bridge 页**（需要 UI）：左侧「Bridge」→ 点「启动 AstrWeChat / 保存并启动」，会顺带开启 API 与主动推送并生成 Token。
（AstrWeChat 1.5.0 **没有**「设置 → API 服务」页，不用找。）

验证（不打印 Token）：

```powershell
Invoke-RestMethod 'http://127.0.0.1:5031/health'            # status=ok 即服务活着
$cfg = Get-Content "$env:APPDATA\weflow\WeFlow-config.json" -Raw | ConvertFrom-Json
if ($cfg.httpApiToken -notlike 'safe:*' -and $cfg.httpApiToken) {
  Invoke-RestMethod -Headers @{ Authorization = "Bearer $($cfg.httpApiToken)" } `
    'http://127.0.0.1:5031/api/v1/sessions?limit=1'          # 200 = Token 有效且数据库已连
}
# safe: 加密存储时不要自己解；交给 WeNotice 自动读取（2.4）
```

- `/health` 非 ok = API 没起来 → 重做 2.3-A/B。
- `/api/v1/sessions` 200 = Token 有效且数据库已连。
- 401 = Token 不一致 → 重做 2.3-B。
- 500 `请先在设置页面配置微信ID` = 2.1 还没完成。

### 2.4 Token 自动处理（人类不参与；Agent 按此执行）

> 结论：**Token 不需要人类复制粘贴**。WeNotice 会自己从 AstrWeChat 配置里读、解密、校验、落盘；Agent 只负责确保两件事：AstrWeChat 已开启 API（2.3）+ WeNotice 的自动读取开关是开的。

1. 检查 WeNotice 数据目录的配置（便携版）：`C:\Users\<用户名>\WeNotice\resources\.data\data\config.json`
   ```json
   "source": {
     "baseUrl": "http://127.0.0.1:5031",
     "token": "",
     "autoConnect": true,
     "autoTokenSync": true
   }
   ```
   `token` 可以先留空；`autoTokenSync: true`（默认）表示每次连接前自动从 AstrWeChat 配置读取 Token。

2. 启动 WeNotice：`cmd /c start "" "C:\Users\<用户名>\WeNotice\WeNotice.exe"`。
   WeNotice 启动/重连时会自动选择读取路径：
   - AstrWeChat 配置里是**明文 Token** → 直接使用；
   - 是 **`safe:` 加密 Token** → 用本机 DPAPI（Electron `safeStorage`）自动解密；
   - 读取后先用 `/api/v1/sessions` **校验有效性**，通过才写入 WeNotice 配置；失败则不覆盖旧值并给出中文提示。
   （对应错误提示：`Token 加密保存了但解不开` = `lock:` 口令模式或跨机复制；`Token 无效` = 两边不一致。）

3. 校验（Agent 不接触明文 Token）：

   ```powershell
   # WeNotice 启动日志里应有 token 同步结果
   Get-Content "$env:USERPROFILE\WeNotice\resources\.data\boot.log" -Tail 30 | Select-String 'token|source'
   # 或者导出诊断信息：设置 → 应用 → 导出诊断信息；里面有 sourceTokenMasked 与 lastTokenSync
   ```

   最终以界面状态为准：状态栏显示 `数据源: AstrWeChat · 已连接`、顶部胶囊为「已连接」。

4. **读不出 Token 时的唯一正解**：重做 **2.3-B**（把 `httpApiToken` 重写成明文）→ 重启 AstrWeChat → 重启 WeNotice。
   不要让人工复制 Token，也不要把 Token 写到聊天/日志里。

5. （可选）本机校验 `safe:` Token 的 DPAPI 片段——只在内存里用，禁止输出：

   ```powershell
   Add-Type -AssemblyName System.Security
   $cfg = Get-Content "$env:APPDATA\weflow\WeFlow-config.json" -Raw | ConvertFrom-Json
   if ($cfg.httpApiToken -like 'safe:*') {
     $bytes = [Convert]::FromBase64String($cfg.httpApiToken.Substring(5))
     $plain = [Text.Encoding]::UTF8.GetString(
       [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))
     # $plain 即明文 Token（与 Electron safeStorage 等价）；仅本机校验用，禁止打印
   }
   ```

> 安全边界：Token 只在本机 `127.0.0.1` 使用；Agent 报告/回执里一律用 `weno…(32)` 这类打码值。

### 2.5 WeNotice 侧其余配置

WeNotice 设置 → 数据源：

- 打开「启动时自动连接」「自动启动 AstrWeChat」（可选）
- 「连接后回填最近消息」：首次配置建议开（12 小时），让界面马上有内容

保存后应看到顶部胶囊为「已连接」、状态栏显示 `数据源: AstrWeChat · 已连接`。

---

## 3. QQ 数据源（可选：NapCat + OneBot 11）

### 3.1 安装（Agent 可自动执行安装脚本，扫码必须人类）

```powershell
# 仓库里的专用脚本：整理便携 QQ + NapCat + 注入器 + 桌面快捷方式
pwsh tools\setup-napcat.ps1 -InstallDir "$env:USERPROFILE\NapCat"

# 常用附加参数
#  -NapCatZip/-QQInstaller/-SevenZip：用本地压缩包离线安装
#  -Repair：已有目录损坏时原地修复（保留虚拟数据）
#  -NoDownload：完全离线
```

装完后让人类**双击桌面 `NapCat (QQ)` 快捷方式**（会自动请求管理员），扫码登录 QQ。

> 注意：NapCat 是协议端登录，**同账号登录会顶掉电脑上已登录的 QQ**。建议用小号；Agent 不要把 QQ 更新/登录凭据写进任何配置。

### 3.2 开启 WebSocket 服务

NapCat WebUI（`http://127.0.0.1:6099`，token 在 `napcat\config\webui.json`）
→ 网络配置 → 新建「WebSocket 服务器」→ 监听 `127.0.0.1:3001`（其余默认）→ 保存。

### 3.3 WeNotice 侧配置

设置 → 「QQ 数据源 · OneBot 11」→ 启用 → 地址 `ws://127.0.0.1:3001` → 保存。
侧栏出现「QQ 数据源 · OneBot / 已连接 · <QQ号>」即成功。

---

## 4. 验证清单（Agent 收尾必做）

```powershell
# 1) 5031 本地 API
Invoke-RestMethod http://127.0.0.1:5031/health

# 2) WeNotice 运行 + 控制接口（launcher 日志里有 control port/token）
Get-Content "$env:USERPROFILE\WeNotice\WeNotice-launcher.log" -Tail 20

# 3) 托盘是否正常注册
Get-Content "$env:USERPROFILE\WeNotice\resources\.data\boot.log" -Tail 20
```

人工确认项：

- [ ] 通知中心能看到真实消息（微信/QQ）
- [ ] 来一条「群公告/验证码/快递」类消息时能弹 Windows 通知
- [ ] 最小化后托盘有 WeNotice 图标（`^` 里）
- [ ] 设置 → 应用 → 导出诊断信息 能正常生成文件

---

## 5. 数据与隐私（Agent 报告里不要泄露）

- AstrWeChat 配置：`%APPDATA%\weflow\WeFlow-config.json`（含加密的 `decryptKey`、`httpApiToken`）
- WeNotice 配置：`<WeNotice 目录>\resources\.data\data\config.json`（含明文 API Token）
- 聊天历史：`<WeNotice 目录>\resources\.data\data\history.json`
- 日志：`<WeNotice 目录>\resources\.data\boot.log`、`WeNotice-launcher.log`

Agent 输出报告时：Token/密钥一律打码（保留前 4 位 + 长度），聊天内容只引用必要的标题级文本。

---

## 6. 常见故障速查

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| WeNotice 显示「连接异常：AstrWeChat 尚未完成微信连接」 | 2.1 未完成 | 请人类走「微信连接」 |
| 「AstrWeChat 把 Token 加密保存了，但本机解不开」 | `lock:` 口令模式 / 跨机复制配置 | 按 **2.3-B** 把 Token 重写为明文后重启；不要跨机复制 `%APPDATA%\weflow` |
| Token 要在 AstrWeChat 与 WeNotice 之间「传递」 | 人类复制粘贴易出错（漏字符、截断、贴错配置） | **不要人工传递**：按 2.4 让 WeNotice 自动读取+校验；读不出就按 2.3-B 重写 |
| Bridge 启动失败 `Python was not found ... 退出码 9009` | PATH 上的 python 是 Microsoft Store 存根 | Bridge 与 WeNotice 无关，可忽略；要修 Bridge 用 `tools/fix-astr-bridge.ps1`（仅本机修复路径已验证） |
| `Python 3.15.1` 报缺 `requests` | Bridge 用系统 Python 且没装依赖 | 同上；或装 3.12 并 `pip install -r resources\bridge\requirements.txt` |
| 「无法连接 AstrBot」 | Bridge 的 AstrBot 地址/服务没起 | Bridge 可选功能，不影响 WeNotice 通知 |
| AstrWeChat 弹「无法连接 AstrBot，请确认服务已启动、地址及端口正确；5 秒后重试」 | AstrWeChat → Bridge 页当前后端是「AstrBot」，正尝试连 `ws://127.0.0.1:11229/ws`，但本机没有运行 AstrBot | **与 WeNotice 无关**，按 6.1 处理 |
| 托盘图标不出现 | 程序放在受限目录（如 `Documents\...` 工作区、网盘同步目录） | 整个 WeNotice 文件夹移到 `C:\Users\<用户名>\WeNotice` 重开 |
| 5031 被占用 | 上次 AstrWeChat 没退干净 / 别的程序占用 | `Get-NetTCPConnection -LocalPort 5031` 找 PID 处理后重启 AstrWeChat |
| QQ 已连接但没消息 | 群里没人说话 / NapCat 掉线 / 同名会话被忽略 | 让群里发一条消息验证；看 WeNotice 设置里 QQ 测试连接结果 |

### 6.1 「无法连接 AstrBot，请确认服务已启动、地址及端口正确；5 秒后重试」

这条提示来自 **AstrWeChat 的 Bridge**（不是 WeNotice）。Bridge 页当前后端是「AstrBot」，会去连
`ws://127.0.0.1:11229/ws`；本机没有跑 AstrBot 就会一直重试。

**对 WeNotice 没有影响**：WeNotice 只读 AstrWeChat 的本地 HTTP API（`127.0.0.1:5031`），不经过 Bridge。
处理方式按需求选一种：

- **A. 不用 Bridge（只收通知，最常见）**
  AstrWeChat → Bridge 页 → 不要点「启动 AstrWeChat」；已经启动的点「停止」。
  需要 API 时用 WeNotice 的「一键开启 AstrWeChat API」就够了（只启 API 服务 + 主动推送，不启 Bridge）。
- **B. 确实要用 AstrBot 机器人**
  1. 安装并启动 AstrBot；
  2. 在 AstrBot 里配置 OneBot v11 的 WebSocket 服务端（默认端口 `11229`、路径 `/ws`，若不同以 AstrBot 配置为准）；
  3. AstrWeChat → Bridge → 地址填 `ws://127.0.0.1:11229/ws`，Token 与 AstrBot 侧保持一致；
  4. 点「保存并启动」，出现已连接即可。Bridge 的 Python 依赖问题见上面 9009 / `requests` 两行。
- **C. 用内置模型（不想装 AstrBot）**
  Bridge 页把后端切换成「内置模型」，填 OpenAI 兼容的 Base URL / API Key / 模型名，保存后启动。
- **D. 用 KouriChat**
  Bridge 页后端选「KouriChat」，填它的 OneBot 地址与 Token。

> Agent 只需要判断「WeNotice 的微信数据源是否已连接、`/health` 与 `/api/v1/sessions` 是否正常」；
> AstrBot 连接失败不用修，也不要为了消除提示去改 Bridge 后端配置（属于用户偏好）。

---

## 7. 回执模板（Agent 完成任务后发给人类）

```text
【WeNotice 配置回执】
- 机器/用户：<计算机名>\<用户名>
- WeNotice：<版本>，位置 <路径>，运行中：是/否
- 微信数据源：已连接/未配置；AstrWeChat <版本>；DB 校验 open succeeded=是/否
- 本地 API：http://127.0.0.1:5031 health=ok；sessions=200（Token 有效）
- Token 处理：Agent 自动读取 + /api/v1/sessions 校验通过；写入 WeNotice 配置成功（值：weno…(32)，不回显）
- QQ 数据源：未启用 / 已连接（QQ<号>）
- 托盘：正常 / 受限目录提示
- 剩余人工步骤：<无 / 仅首次微信登录与 AstrWeChat 取密钥这类必须人工的步骤>
- 未改动项：AstrWeChat 解密密钥（由软件自动获取）、口令、QQ 登录态
```

---

## 8. 参考

- 仓库根 `README.md`：功能、安装、签名、FAQ
- `docs/TRAY.md`：托盘受限目录的完整根因与排查
- 上游项目：AstrWeChat（CMKH1337/Astrwechat）、WeFlow（hicccc77/WeFlow）、NapCatQQ（NapNeko/NapCatQQ）
