// WeNotice 启动器（WinForms 托盘宿主 + 拉起 electron.exe 原名的打包应用）。
//
// 职责：
// 1. 托盘图标由本启动器显示（WinForms NotifyIcon）。部分 Windows 环境下 Electron 的 Tray API
//    创建后系统不显示图标，而原生 WinForms 托盘正常，所以把托盘放在启动器里更可靠。
// 2. 启动 electron.exe，并把 --launcher-tray 传给应用；应用会在 <userData>/control.json 写入
//    随机端口 + token 的本地控制接口，启动器通过它显示窗口、暂停提醒、退出。
// 3. 兜底：受限环境里 Chromium 沙箱不可用，electron 会以非 0 退出，此时自动追加 --no-sandbox 重试。
//
// 为什么不是直接把 electron.exe 改名：在本机 Windows 环境下重命名后的 electron.exe 会在 Chromium
// 启动早期以 0xC0000005 崩溃；保持 electron.exe 原名 + 本启动器用同名 WeNotice.exe 拉起应用更稳。
//
// 编译（在 wenotice 目录下）：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /win32icon:app\assets\icon.ico /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:tools\WeNoticeLauncher.exe tools\launcher.cs

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private static string appDir;
    private static string controlFile;
    private static NotifyIcon tray;
    private static Process appProc;
    private static System.Windows.Forms.Timer stateTimer;
    private static string apiBase;
    private static string apiToken;
    private static bool quitting;

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        appDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string target = Path.Combine(appDir, "electron.exe");
        if (!File.Exists(target))
        {
            Fail("未找到 electron.exe，请确认 WeNotice 目录完整（electron.exe 与 resources 目录需在同一文件夹）。");
            return;
        }

        controlFile = Path.Combine(appDir, "resources", ".data", "control.json");
        string baseArgs = BuildArgs(args) + " --launcher-tray";

        // 第一次：正常（Chromium 沙箱）启动。
        Process first = Start(baseArgs);
        if (first == null) return;

        bool exited = first.WaitForExit(4000);
        if (exited)
        {
            if (first.ExitCode == 0)
            {
                // 已有实例在运行（单实例锁）：不再创建托盘，直接退出。
                return;
            }
            // 受限环境沙箱不可用：加 --no-sandbox 重试。
            Process second = Start(baseArgs + " --no-sandbox");
            if (second == null) return;
            if (second.WaitForExit(4000) && second.ExitCode != 0)
            {
                Fail("应用启动失败（electron 退出码 " + second.ExitCode + "）。可尝试直接运行 electron.exe 查看详细报错。");
                return;
            }
            appProc = second;
        }
        else
        {
            appProc = first;
        }

        appProc.EnableRaisingEvents = true;
        appProc.Exited += delegate { Shutdown(); };

        // 等待应用把控制接口写好（冷启动可能 1-5 秒），再显示托盘。
        if (!WaitForControl(30000)) { Fail("应用已启动，但在 30 秒内没有就绪（缺少 control.json）。请查看 resources\\.data\\boot.log。"); }
        CreateTray();
        StartStateTimer();
        Application.Run();
    }

    // ---------------- 控制接口 ----------------

    private static bool WaitForControl(int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (File.Exists(controlFile))
                {
                    string text = File.ReadAllText(controlFile, Encoding.UTF8);
                    Match m = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                    Match t = Regex.Match(text, "\"token\"\\s*:\\s*\"([0-9a-fA-F]+)\"");
                    if (m.Success && t.Success)
                    {
                        apiBase = "http://127.0.0.1:" + m.Groups[1].Value + "/";
                        apiToken = t.Groups[1].Value;
                        return true;
                    }
                }
            }
            catch (Exception) { /* 正在写入，重试 */ }
            Thread.Sleep(300);
            if (appProc != null && appProc.HasExited) return false;
        }
        return false;
    }

    private static string Request(string action)
    {
        try
        {
            string url = apiBase + action + (action.IndexOf('?') >= 0 ? "&" : "?") + "token=" + apiToken;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 2000;
            req.ReadWriteTimeout = 2000;
            req.Proxy = null;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
            {
                return reader.ReadToEnd();
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void LaunchAction(string action)
    {
        Request(action);
    }

    // ---------------- 托盘 ----------------

    private static void CreateTray()
    {
        Icon icon;
        try
        {
            icon = new Icon(Path.Combine(appDir, "resources", "app", "assets", "icon.ico"));
        }
        catch (Exception)
        {
            icon = SystemIcons.Application;
        }

        tray = new NotifyIcon();
        tray.Icon = icon;
        tray.Text = "WeNotice · 微信通知过滤器";
        tray.Visible = true;
        tray.DoubleClick += delegate { LaunchAction("show"); };

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开通知中心", null, delegate { LaunchAction("show"); });
        var pauseItem = new ToolStripMenuItem("暂停提醒", null, delegate
        {
            string state = Request("state");
            string toggle = state != null && state.IndexOf("\"paused\":true") >= 0 ? "pause?value=0" : "pause?value=1";
            Request(toggle);
        });
        pauseItem.Name = "pause";
        menu.Items.Add(pauseItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("设置…", null, delegate { LaunchAction("settings"); });
        menu.Items.Add("退出 WeNotice", null, delegate
        {
            quitting = true;
            Request("quit");
            DateTime deadline = DateTime.UtcNow.AddSeconds(3);
            while (DateTime.UtcNow < deadline && appProc != null && !appProc.HasExited) Thread.Sleep(100);
            if (appProc != null && !appProc.HasExited) { try { appProc.Kill(); } catch (Exception) { } }
            Shutdown();
        });
        menu.Opening += delegate
        {
            string state = Request("state");
            pauseItem.Text = state != null && state.IndexOf("\"paused\":true") >= 0 ? "恢复提醒" : "暂停提醒";
        };
        tray.ContextMenuStrip = menu;
    }

    private static void StartStateTimer()
    {
        stateTimer = new System.Windows.Forms.Timer();
        stateTimer.Interval = 4000;
        stateTimer.Tick += delegate { RefreshState(); };
        stateTimer.Start();
        RefreshState();
    }

    private static void RefreshState()
    {
        if (quitting) return;
        if (appProc != null && appProc.HasExited)
        {
            Shutdown();
            return;
        }
        string state = Request("state");
        if (state == null)
        {
            if (tray != null) tray.Text = "WeNotice · 连接中断";
            return;
        }
        Match m = Regex.Match(state, "\"unread\"\\s*:\\s*(\\d+)");
        int unread = m.Success ? int.Parse(m.Groups[1].Value) : 0;
        if (tray != null) tray.Text = unread > 0 ? "WeNotice · " + unread + " 条未读" : "WeNotice · 微信通知过滤器";
    }

    private static void Shutdown()
    {
        quitting = true;
        try { if (stateTimer != null) stateTimer.Stop(); } catch (Exception) { }
        try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch (Exception) { }
        try { Application.ExitThread(); } catch (Exception) { }
        Environment.Exit(0);
    }

    // ---------------- 进程 ----------------

    private static Process Start(string arguments)
    {
        var psi = new ProcessStartInfo(Path.Combine(appDir, "electron.exe"), arguments);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = appDir;
        // 某些开发环境会把 ELECTRON_RUN_AS_NODE 注入到环境中，导致 electron.exe 以 Node 模式运行而报
        // "bad option"；正常双击用户环境没有该变量，这里显式移除，保证任何情况下都按 GUI 应用启动。
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        try
        {
            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            Fail("启动 electron.exe 失败：" + ex.Message);
            return null;
        }
    }

    private static void Fail(string message)
    {
        try
        {
            File.WriteAllText(Path.Combine(appDir, "WeNotice-launch-error.txt"), message);
        }
        catch (Exception)
        {
            // 写日志失败时无需再处理
        }
    }

    private static string BuildArgs(string[] args)
    {
        var sb = new StringBuilder();
        foreach (string arg in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Quote(arg));
        }
        return sb.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
