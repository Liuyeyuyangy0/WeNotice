# Agent 配置指南（微信源 + QQ 源）

> 这份文档写给 **AI Agent**：当你被要求在一台 Windows 电脑上「配好 WeNotice 并让它收到消息」时，按本文顺序执行。
> 人类读者也可以用它当排障手册。
>
> 一句话原则：**只读检查可以全自动；「取密钥 / 扫码登录 / 设口令」必须由人类完成，Agent 只做引导和校验。**

---

## 0. 角色与边界

### Agent 允许自动做的事

- 检测软件是否安装、进程是否在跑、端口是否监听（只读）。
- 启动/重启 WeNotice、AstrWeChat、NapCat（不涉及登录态）。
- 读取 `%APPDATA%\weflow\WeFlow-config.json`、`%APPDATA%\weflow\bridge\config.json`（只读；需要把内容写进报告时对 token/密钥打码）。
- 在人工已确认 AstrWeChat 已连上微信后：通过 WeNotice 设置页或「一键开启 AstrWeChat API」开启本地 API / 主动推送 / 自动读取 Token。
- 改 WeNotice 自己的配置（`<WeNotice 数据目录>\data\config.json`）、拉 QQ WebSocket 配置、跑验证清单。

### Agent 禁止做的事（必须停下来让人类操作）

1. **不要代替人类点 AstrWeChat「微信连接」页的「自动获取 / 自动检测」**，更不要往密钥输入框里打字或粘贴任何密钥。
   - 说明：AstrWeChat 的「自动获取」一旦点击，会自己扫描微信进程提取解密密钥并**自动填框 + 落盘**。这是它的设计行为，但属于敏感操作，必须由账号所有者当面确认。
2. **不要设置、猜测或改写任何口令/应用锁**（AstrWeChat 的 `authEnabled` / `authPassword`、Bridge 的口令等）。
3. **不要跨机器复制 `%APPDATA%\weflow`**。里面 `safe:` 字段是 DPAPI 加密的，换机/换用户必然解不开，只会制造「Token 解不开」的假故障。
4. **不要代替人类扫码登录**（NapCat / QQ 登录二维码）。
5. 不要向任何外部地址发送密钥、Token、二维码、聊天记录截图。

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
| `decryptKey` 为 `lock:` 开头 | 口令模式，Agent/WeNotice 无法解码 | 请人类在 AstrWeChat 里重设/清除口令，或重新走 2.1 |
| 日志没有 `open succeeded` | 密钥/版本不匹配 | 确认微信版本，重走 2.1；不要自己填 key |
| 全部正常 | 继续 2.3 | — |

### 2.3 开启本地 API（Agent 可自动）

两条路，优先 A：

**A. 用 WeNotice 一键开启（推荐）**
WeNotice → 设置 → 数据源 → 「**一键开启 AstrWeChat API**」。
它会把 `httpApiEnabled=true`、`messagePushEnabled=true`、`httpApiToken`（32 位 hex）写进 AstrWeChat 配置并重启 AstrWeChat，然后自动读取 Token。

**B. 走 AstrWeChat Bridge 页**
AstrWeChat → 左侧「**Bridge**」→ 点「**启动 AstrWeChat / 保存并启动**」。这个动作会顺带开启 API 服务与主动推送并生成 Token。
（AstrWeChat 1.5.0 **没有**「设置 → API 服务」这一页，不要找它。）

验证：

```powershell
$cfg = Get-Content "$env:APPDATA\weflow\WeFlow-config.json" -Raw | ConvertFrom-Json
$token = $cfg.httpApiToken
if ($token -like 'safe:*') {
  # 加密存储时无法直接取明文；让 WeNotice 自己读（它会用 safeStorage 解密）
  $token = $null
}
Invoke-RestMethod http://127.0.0.1:5031/health
if ($token) {
  Invoke-RestMethod -Headers @{ Authorization = "Bearer $token" } `
    'http://127.0.0.1:5031/api/v1/sessions?limit=1'
}
```

- `/health` 返回 `{"status":"ok"}` = HTTP 服务活着。
- `/api/v1/sessions` 200 = Token 有效且数据库已连。
- 401 = Token 不对（让 WeNotice「自动读取 Token」或「一键开启」重来）。
- 500 `请先在设置页面配置微信ID` = 还没完成 2.1。

### 2.4 WeNotice 侧配置

WeNotice 设置 → 数据源：

- API 地址：`http://127.0.0.1:5031`（默认）
- Access Token：点「**自动读取**」（从 AstrWeChat 配置解密读取，会先校验有效性再落盘）
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
| 「AstrWeChat 把 Token 加密保存了，但本机解不开」 | `lock:` 口令模式 / 跨机复制配置 | 清除口令重走 Bridge 页；不要跨机复制 `%APPDATA%\weflow` |
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
- WeNotice 读取 Token：成功（safe: 解密）；最近回填 N 条
- QQ 数据源：未启用 / 已连接（QQ<号>）
- 托盘：正常 / 受限目录提示
- 剩余人工步骤：<无 / 列出>
- 未改动项：AstrWeChat 密钥（由软件自动获取）、口令、QQ 登录态
```

---

## 8. 参考

- 仓库根 `README.md`：功能、安装、签名、FAQ
- `docs/TRAY.md`：托盘受限目录的完整根因与排查
- 上游项目：AstrWeChat（CMKH1337/Astrwechat）、WeFlow（hicccc77/WeFlow）、NapCatQQ（NapNeko/NapCatQQ）
