// WeNotice 启动器（启动 electron.exe 原名的打包应用）。
//
// 为什么不是直接把 electron.exe 改名：在本机 Windows 环境下重命名后的 electron.exe 会在 Chromium
// 启动早期以 0xC0000005 崩溃；保持 electron.exe 原名 + 本启动器用同名 WeNotice.exe 拉起应用更稳。
//
// 兜底逻辑：部分受限环境（远程会话、受管终端等）里 Chromium 沙箱不可用，electron 会立刻以非 0 退出。
// 此时自动追加 --no-sandbox 重试一次，保证应用仍能打开；正常桌面环境不会走到重试分支。
//
// 编译（在 wenotice 目录下）：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /win32icon:app\assets\icon.ico /out:tools\WeNoticeLauncher.exe tools\launcher.cs

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string target = Path.Combine(dir, "electron.exe");
        if (!File.Exists(target))
        {
            Fail(dir, "未找到 electron.exe，请确认 WeNotice 目录完整（electron.exe 与 resources 目录需在同一文件夹）。");
            return;
        }

        string baseArgs = BuildArgs(args);

        // 第一次尝试：正常（带 Chromium 沙箱）启动。
        Process first = Start(dir, baseArgs);
        if (first == null) return;

        // 4 秒内正常退出说明应用把参数问题/沙箱问题暴露出来了；0 退出通常是“已有实例在运行”，不再重试。
        bool exited = first.WaitForExit(4000);
        if (!exited || first.ExitCode == 0) return;

        // 第二次尝试：加 --no-sandbox 兜底。
        Process second = Start(dir, baseArgs + " --no-sandbox");
        if (second == null) return;
        if (second.WaitForExit(4000) && second.ExitCode != 0)
        {
            Fail(dir, "应用启动失败（electron 退出码 " + second.ExitCode + "）。可尝试在命令行运行 electron.exe 查看详细报错。");
        }
    }

    private static Process Start(string dir, string arguments)
    {
        var psi = new ProcessStartInfo(Path.Combine(dir, "electron.exe"), arguments);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = dir;
        // 某些开发环境会把 ELECTRON_RUN_AS_NODE 注入到环境中，导致 electron.exe 以 Node 模式运行而报
        // "bad option"；正常双击用户环境没有该变量，这里显式移除，保证任何情况下都按 GUI 应用启动。
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        try
        {
            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            Fail(dir, "启动 electron.exe 失败：" + ex.Message);
            return null;
        }
    }

    private static void Fail(string dir, string message)
    {
        try
        {
            File.WriteAllText(Path.Combine(dir, "WeNotice-launch-error.txt"), message);
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
