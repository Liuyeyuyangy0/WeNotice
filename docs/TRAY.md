# 托盘图标的实现与排障记录

> 本文记录 WeNotice 1.0.x 起「托盘图标显示」方案的设计取舍与根因。
> 如果你遇到托盘图标不显示，先看文末「用户自救」一节。

## 最终结论（根因）

**可执行文件放在「受限目录 / 代理工作区」里运行时，Windows 会拒绝对该进程的托盘注册**，
`Shell_NotifyIcon(NIM_ADD)` 直接返回 `FALSE`、`GetLastError()=5 (ERROR_ACCESS_DENIED)`，
Electron 的 `new Tray()` 也不会报错到 JS 层，所以表现为「代码明明成功、系统里就是没有图标」。

本机实测证据：

| 运行位置 | 结果 |
| --- | --- |
| `…\deepseek-harness\default-workspace\wenotice\dist\WeNotice\`（代理工作区内） | `NIM_ADD=False err=5`，托盘无图标 |
| 同一个 `TrayProbe5.exe`，复制到 `%LOCALAPPDATA%\TrayProbePathTest\` | `NIM_ADD=True err=0`，托盘正常 |
| 整个 `WeNotice` 目录复制到 `C:\Users\<用户名>\WeNotice\` | 托盘图标正常显示（`WeNotice · N 条未读`） |

其它已排除的因素：图标文件（PNG/多尺寸 ICO 都试过）、Electron 版本（44/45 一样）、
`app.setAppUserModelId`、`--no-sandbox`、DPI、会话（始终 Session 2 / 交互式）、
第三方安全软件（本机只有 Defender）、注册表缓存。

> 因此：**请把 WeNotice 放在普通用户目录运行**，例如
> `%LOCALAPPDATA%\Programs\WeNotice` 或 `C:\Users\<用户名>\WeNotice`，
> 不要放在 AI 代理工作区、同步盘、受控企业目录等受限位置。

## 方案：托盘由启动器托管

即使目录没问题，Electron 的 `Tray` 在个别环境也有兼容问题，所以托盘交给 `WeNotice.exe` 启动器：

1. 启动器（C# WinForms，`tools/launcher.cs`）拉起同目录的 `electron.exe`，并传入 `--launcher-tray`；
2. 应用收到该参数后不创建 Electron 托盘，而是在 `127.0.0.1` 的**随机端口**上开一个本地控制接口，把 `{ port, token }` 写入 `resources\.data\control.json`；
3. 启动器读取 `control.json`，用 WinForms `NotifyIcon` 显示托盘图标和右键菜单（打开通知中心 / 暂停提醒 / 设置 / 退出）；
4. 菜单动作、单击/双击、未读数刷新（每 4 秒轮询 `/state`）都通过这个带 Token 的本地接口完成；
5. 应用退出时删除 `control.json`，启动器发现进程退出后自动清理托盘图标。

安全约束：控制接口只监听 `127.0.0.1`，Token 每次启动随机生成；`control.json` 在用户数据目录内，不进入仓库与发行包。

## 最小化行为

- 点标题栏「—」：窗口隐藏到托盘（默认，可在 设置 → 应用 关闭）；
- 点「×」：同样按设置隐藏到托盘；
- 恢复窗口：托盘图标单击/双击、`Ctrl+Alt+Shift+W`（备用 `Ctrl+Alt+F9`）、或再次运行 `WeNotice.exe`（单实例锁会唤醒已有窗口）。

## 用户自救

1. 确认 WeNotice 不在受限/同步/代理工作区目录（见上表），建议整个文件夹移到 `C:\Users\<用户名>\WeNotice`；
2. 点任务栏右下角 `^`，把 WeNotice 图标从展开区拖到任务栏固定；
3. 找不到图标时按 `Ctrl+Alt+Shift+W`（备用 `Ctrl+Alt+F9`）；
4. 仍不行：设置 → 应用 → 关闭「最小化到托盘」，最小化就会回到任务栏；
5. 反馈问题时可附上安装目录下的 `WeNotice-launcher.log`（启动器托盘日志）与 `resources\.data\boot.log`。

## 相关文件

- `tools/launcher.cs`：启动器源码（编译为 `dist\WeNotice\WeNotice.exe`）
- `app/main.js`：`--launcher-tray` 模式、控制接口、全局快捷键、最小化处理
- `tools/build-portable.ps1`：打包时编译启动器并复制进 dist
