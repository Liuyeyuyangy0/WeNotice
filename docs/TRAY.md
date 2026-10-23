# 托盘图标的实现与排障记录

> 本文记录 WeNotice 1.0.1 起「托盘图标显示」方案的设计取舍，以及开发机上的排障过程。
> 如果你遇到托盘图标不显示，先看文末「用户自救」一节。

## 背景

WeNotice 最初用 Electron 自带的 `Tray` API 显示托盘图标。开发机上出现了一个很难解释的现象：

- `tray created` 日志证明 `new Tray(icon)` 调用成功（`imageEmpty=false`、`destroyed=false`）；
- 但 Windows 11 的托盘溢出面板（任务栏右下角 `^`）里始终没有 WeNotice；
- 换成纯色 32×32 PNG、多尺寸 `.ico`、换 Electron 44/45 都一样；
- 注册表 `HKCU\Control Panel\NotifyIconSettings` 里始终没有 `electron.exe` 的登记项；
- 用 C# 直接调用 `Shell_NotifyIcon(NIM_ADD)` 做对照测试，返回 `NIM_ADD=False ERR=5`（拒绝访问）；
- 但同一个开发环境里，其他 Electron 应用（AstrWeChat）和 WinForms 应用（如任务管理器）的托盘图标正常显示。

结论：**在部分 Windows 环境/启动方式下，Electron 进程调用的托盘注册会被系统拒绝，且不会报错到 JS 层。**
这不是图标文件、代码写法或 Electron 版本的问题（均已逐一排除），也很难在用户侧修复。

## 方案：把托盘移到启动器

Electron 进程「注册不上」，但**原生 WinForms 进程可以**。所以我们把托盘交给 `WeNotice.exe` 启动器：

1. 启动器（C# WinForms，`tools/launcher.cs`）拉起同目录的 `electron.exe`，并传入 `--launcher-tray`；
2. 应用收到该参数后不创建 Electron 托盘，而是在 `127.0.0.1` 的**随机端口**上开一个本地控制接口，把 `{ port, token }` 写入 `resources\.data\control.json`；
3. 启动器读取 `control.json`，用 WinForms `NotifyIcon` 显示托盘图标和右键菜单（打开通知中心 / 暂停提醒 / 设置 / 退出）；
4. 菜单动作、单击/双击、未读数刷新（每 4 秒轮询 `/state`）都通过这个带 Token 的本地接口完成；
5. 应用退出时删除 `control.json`，启动器发现进程退出后自动清理托盘图标。

安全约束：控制接口只监听 `127.0.0.1`，Token 每次启动随机生成；`control.json` 在用户数据目录内，不进入仓库与发行包。

## 兜底：全局快捷键

即使托盘图标由于任何原因不可见，`Ctrl+Alt+W`（Electron `globalShortcut`）也能随时把窗口找回来；
再次运行 `WeNotice.exe` 也会唤醒已有窗口（单实例锁）。

## 用户自救

1. 点任务栏右下角 `^`，把 WeNotice 图标从展开区拖到任务栏固定；
2. 找不到图标时按 `Ctrl+Alt+W`；
3. 仍不行：设置 → 应用 → 关闭「最小化到托盘」，最小化就会回到任务栏；
4. 反馈问题时可附上 `resources\.data\boot.log`（含托盘/控制接口是否创建成功）。

## 相关文件

- `tools/launcher.cs`：启动器源码（编译为 `dist\WeNotice\WeNotice.exe`）
- `app/main.js`：`--launcher-tray` 模式、控制接口、全局快捷键
- `tools/build-portable.ps1`：打包时编译启动器并复制进 dist
