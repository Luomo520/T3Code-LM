using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;

internal sealed class WindowsDesktop : IDisposable
{
    private Process ownedWindow;
    private IntPtr openedWindowHandle;
    private bool ownsNotepad;
    private readonly string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint length, out uint required);

    internal static bool DesktopAvailable()
    {
        IntPtr handle = OpenInputDesktop(0, false, 1);
        if (handle == IntPtr.Zero) return false;
        try
        {
            uint needed;
            var name = new StringBuilder(64);
            return GetUserObjectInformation(handle, 2, name, (uint)name.Capacity * 2, out needed) &&
                name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseDesktop(handle); }
    }

    internal async Task<string> Open(string action, CancellationToken cancel)
    {
        RequireDesktop();
        if (ownedWindow != null && !ownedWindow.HasExited)
            throw new InvalidOperationException("先关闭此前由受控端打开的窗口。");
        string path;
        if (action == "open-notepad")
            path = Path.Combine(Environment.SystemDirectory, "notepad.exe");
        else
        {
            path = FindT3();
            if (path == null) throw new InvalidOperationException("请先安装 T3Code-LM 桌面应用。");
        }
        var next = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path) });
        if (next == null) throw new InvalidOperationException("Windows 未返回新进程。");
        Dispose();
        ownedWindow = next;
        ownsNotepad = action == "open-notepad";
        string name = ownsNotepad ? "记事本" : "T3Code-LM";
        // 启动器可能转交给已运行的桌面实例。仅持有新进程，避免后续关闭用户原有窗口。
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(12))
        {
            cancel.ThrowIfCancellationRequested();
            RequireDesktop();
            next.Refresh();
            if (!next.HasExited)
            {
                IntPtr window = next.MainWindowHandle;
                if (IsProcessWindow(window, next))
                {
                    openedWindowHandle = window;
                    return "已打开" + name + "窗口。";
                }
            }
            if (next.HasExited && IsForegroundApplication(path))
                return name + "的现有窗口已显示。";
            await Task.Delay(150, cancel);
        }
        throw new InvalidOperationException("已请求启动" + name + "，尚未确认窗口已显示。");
    }

    private static bool IsForegroundApplication(string expectedPath)
    {
        uint id;
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out id) == 0) return false;
        try
        {
            using (var foreground = Process.GetProcessById((int)id))
            {
                var module = foreground.MainModule;
                return module != null && String.Equals(module.FileName, expectedPath, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    private string FindT3()
    {
        string[] roots = { Path.Combine(local, "Programs"), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) };
        string[] directories = { "t3code", "T3Code-LM", "T3 Code", "T3 Code (Beta)" };
        string[] names = { "T3 Code (Beta).exe", "T3Code-LM.exe", "T3 Code.exe" };
        foreach (string root in roots)
        foreach (string directory in directories)
        foreach (string name in names)
        {
            string path = Path.Combine(root, directory, name);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    internal async Task<string> NotepadText(string replacement, IntPtr approvingWindow, Action verifyRequest,
        CancellationToken cancel)
    {
        RequireDesktop();
        Process process = ownedWindow;
        if (!ownsNotepad || process == null || process.HasExited)
            throw new InvalidOperationException("请先通过受控端新开记事本。");
        IntPtr window = openedWindowHandle;
        if (!IsProcessWindow(window, process))
            throw new InvalidOperationException("找不到受控端新打开的记事本。");
        await WindowsMcp.RequireIdleAsync(() =>
        {
            verifyRequest();
            RequireDesktop();
            if (ownedWindow != process || process.HasExited || !IsProcessWindow(window, process))
                throw new InvalidOperationException("本次批准的记事本窗口已关闭或更换。");
            IntPtr foreground = GetForegroundWindow();
            if (foreground != approvingWindow && foreground != window)
                throw new InvalidOperationException("前台已切换到其他窗口，本次操作已停止。");
        }, cancel);
        if (GetForegroundWindow() != window)
        {
            SetForegroundWindow(window);
            RequireForegroundWindow(window, process);
        }
        var root = AutomationElement.FromHandle(window);
        var fields = root.FindAll(TreeScope.Descendants, new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
        AutomationElement editor = null;
        foreach (AutomationElement field in fields)
        {
            if (field.Current.ProcessId != process.Id || field.Current.IsOffscreen ||
                !field.Current.IsEnabled) continue;
            object candidate;
            if (!field.TryGetCurrentPattern(TextPattern.Pattern, out candidate) &&
                !field.TryGetCurrentPattern(ValuePattern.Pattern, out candidate)) continue;
            if (editor != null) throw new InvalidOperationException("记事本中有多个可编辑控件。");
            editor = field;
        }
        if (editor == null) throw new InvalidOperationException("找不到记事本编辑区。");
        if (replacement != null)
        {
            object pattern;
            if (!editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
                throw new InvalidOperationException("当前记事本编辑区不支持写入。");
            RequireForegroundWindow(window, process);
            ((ValuePattern)pattern).SetValue(replacement);
        }
        RequireForegroundWindow(window, process);
        object readable;
        string text;
        if (editor.TryGetCurrentPattern(TextPattern.Pattern, out readable))
            text = ((TextPattern)readable).DocumentRange.GetText(3890);
        else if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out readable))
            text = ((ValuePattern)readable).Current.Value;
        else throw new InvalidOperationException("无法读回记事本文字。");
        RequireForegroundWindow(window, process);
        if (text.Length > 3889)
            throw new InvalidOperationException("记事本文字超过可返回的长度。");
        return replacement == null ? "读回的记事本文字：" + Environment.NewLine + text :
            "已填写并读回记事本文字：" + Environment.NewLine + text;
    }

    private static bool IsProcessWindow(IntPtr window, Process process)
    {
        uint owner;
        return window != IntPtr.Zero && GetWindowThreadProcessId(window, out owner) != 0 &&
            owner == (uint)process.Id;
    }

    private static void RequireForegroundWindow(IntPtr expected, Process process)
    {
        RequireDesktop();
        if (!IsProcessWindow(expected, process) || GetForegroundWindow() != expected)
            throw new InvalidOperationException("记事本已失去前台焦点，本次操作已停止。");
    }

    internal Process RequestClose()
    {
        RequireDesktop();
        if (ownedWindow == null || ownedWindow.HasExited)
            throw new InvalidOperationException("没有本受控端创建且仍在运行的进程。");
        ownedWindow.Refresh();
        if (!ownedWindow.CloseMainWindow() && !ownedWindow.HasExited)
            throw new InvalidOperationException("找不到可关闭的窗口。如果应用已有保存提示，请在 Windows 上处理。");
        return ownedWindow;
    }

    internal static void RequireDesktop()
    {
        if (!DesktopAvailable()) throw new InvalidOperationException("Windows 桌面处于锁定或受保护状态。");
    }

    public void Dispose()
    {
        if (ownedWindow == null) return;
        ownedWindow.Dispose();
        ownedWindow = null;
        openedWindowHandle = IntPtr.Zero;
        ownsNotepad = false;
    }
}
