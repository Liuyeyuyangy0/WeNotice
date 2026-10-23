# 更新日志

## v1.1.3（Token 与一键开启修复）

- **修复 Token 加密读取**：AstrWeChat 会把 `httpApiToken` 用系统加密保存成 `safe:...`（口令模式为 `lock:...`）。现在会先解密再使用；解密失败时给出可操作提示，不再把密文当 Token 用导致 401
- **同步前先校验**：自动读取 Token 时先用 `/api/v1/sessions` 验证有效才写入配置，避免覆盖掉原本可用的 Token
- **一键开启 AstrWeChat API**：设置页新增按钮，自动改写 AstrWeChat 配置（开启本地 API + 主动推送）并重启它；解决 AstrWeChat 1.5.0 没有「设置 → API 服务」页、卡在开 API 步骤的问题
- **错误原因细分**：读 Token / 测试连接失败时区分「未完成微信连接」「Token 无效」「API 未开启」「网络不可达」「加密无法解密」等，并给出对应操作
- 诊断信息新增 AstrWeChat 配置分析（Token 长度/是否加密/解密结果/最近同步状态，全部脱敏）
- 文档修正：API 开关实际在 AstrWeChat 的「Bridge」页（不在「设置」）；README 数据目录与常见问题同步更新

## v1.1.1（托盘防护）

- **托盘注册预检**：启动器在创建托盘前先调用 `Shell_NotifyIcon` 探测；如果当前目录被系统限制（AI 代理工作区、同步盘、受控企业目录等），会立刻弹窗说明原因和迁移方法，不再静默丢图标
- **单实例提示**：再次双击启动时不再静默退出，而是提示「WeNotice 已经在运行」并给出 `Ctrl+Alt+Shift+W` 找回窗口
- 启动器新增「托盘探测结果」日志行（`WeNotice-launcher.log`），便于远程排查
- docs/TRAY.md 补充：遇到「托盘图标被系统拒绝」弹窗时如何迁移；`Start-Process` 启动 GUI 会挂住，测试请用 `cmd /c start`
- 版本号 1.1.1（无功能变化）

## v1.1.0（体验补齐）

- **首次使用向导**：首次启动引导「演示体验 → 连接 AstrWeChat → 开启 API → 测试连接」，每台电脑只出现一次；设置 → 应用 → 新手引导 可再次打开
- **Token 自动读取**：连接前自动从 `%APPDATA%\weflow\WeFlow-config.json` 读取 AstrWeChat 的 API Token；AstrWeChat 重启换 Token 也能自动同步，设置里可关闭或手动覆盖（输入框旁「自动读取」按钮）
- **通知点击闭环**：点击桌面通知会打开并定位到对应消息，同时自动标记该消息为已读
- **诊断导出**：设置 → 应用 → 导出诊断信息，生成脱敏配置 + boot.log + 启动器日志
- **规则导入 / 导出**：规则弹窗底部支持 JSON 导入导出，方便备份、迁移与分享
- 启动流程改进：首次启动即使 Token 为空，也会尝试从 AstrWeChat 配置补全后再自动连接
- README 补充：首次向导、Token 自动读取、AstrWeChat 安装包为何不随 Release 分发

## v1.0.3

- 修复「最小化到托盘」不生效：最小化时按启动器模式正确隐藏窗口
- 定位托盘图标不显示的根因：**放在受限目录（如 AI 代理工作区）时 Windows 拒绝进程注册托盘图标（`Shell_NotifyIcon` ACCESS_DENIED）**；程序部署到普通用户目录（`C:\Users\<用户名>\WeNotice`）即正常
- 托盘图标改为启动器（WinForms）托管，并新增 `docs/TRAY.md` 说明；新增全局快捷键（`Ctrl+Alt+Shift+W`，备用 `Ctrl+Alt+F9`）找回窗口
- 桌面通知点击后标记已读；新增 `WeNotice-launcher.log` 便于排查启动问题
- 版本号 1.0.3；CI 增加 SignPath 可选签名流程

## v1.0.2

- 全局快捷键改为候选链（`Ctrl+Alt+Shift+W` → `Ctrl+Alt+F9` → `Ctrl+Alt+Shift+N`），避免被其它软件占用后完全失效

## v1.0.1

- 内容清洗：公众号/小程序/文件等 XML 消息自动提取标题与摘要
- 连接后回填最近消息（默认 12 小时，带「回填」标记、不弹通知、不计未读）
- 公众号普通推文默认只归档，标题命中关键词才进通知中心
- 修复 `[图片]` 等媒体消息被误归为「文件」

## v1.0.0

- 首个可分发版本：微信消息自动筛选通知类消息的桌面应用（Electron）
- 消费 AstrWeChat 本地 HTTP API + SSE 实时推送；内置 12 类识别、自定义规则、桌面通知、免打扰、托盘常驻、演示模式
- 便携版（启动器 + Electron 运行时），MIT 开源

