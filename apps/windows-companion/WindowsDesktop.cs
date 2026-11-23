using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal sealed class WindowsDesktop : IDisposable
{
    private Process ownedWindow;
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

    internal string Open(string action)
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
        return action == "open-notepad" ? "已请求打开记事本。" : "已请求打开 T3Code-LM。";
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

    internal string NotepadText(string replacement)
    {
        RequireDesktop();
        if (!ownsNotepad || ownedWindow == null || ownedWindow.HasExited)
            throw new InvalidOperationException("请先通过受控端新开记事本。");
        ownedWindow.Refresh();
        IntPtr window = ownedWindow.MainWindowHandle;
        uint process;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out process) == 0 ||
            process != (uint)ownedWindow.Id)
            throw new InvalidOperationException("找不到受控端新打开的记事本。");
        if (GetForegroundWindow() != window)
        {
            SetForegroundWindow(window);
            RequireForegroundWindow(window);
        }
        var root = AutomationElement.FromHandle(window);
        var fields = root.FindAll(TreeScope.Descendants, new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
        AutomationElement editor = null;
        foreach (AutomationElement field in fields)
        {
            if (field.Current.ProcessId != ownedWindow.Id || field.Current.IsOffscreen ||
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
            RequireForegroundWindow(window);
            ((ValuePattern)pattern).SetValue(replacement);
        }
        RequireForegroundWindow(window);
        object readable;
        string text;
        if (editor.TryGetCurrentPattern(TextPattern.Pattern, out readable))
            text = ((TextPattern)readable).DocumentRange.GetText(3890);
        else if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out readable))
            text = ((ValuePattern)readable).Current.Value;
        else throw new InvalidOperationException("无法读回记事本文字。");
        RequireForegroundWindow(window);
        if (text.Length > 3889)
            throw new InvalidOperationException("记事本文字超过可返回的长度。");
        return replacement == null ? "读回的记事本文字：" + Environment.NewLine + text :
            "已填写并读回记事本文字：" + Environment.NewLine + text;
    }

    private static void RequireForegroundWindow(IntPtr expected)
    {
        RequireDesktop();
        if (GetForegroundWindow() != expected)
            throw new InvalidOperationException("记事本已失去前台焦点，本次操作已停止。");
    }

    internal string Close()
    {
        RequireDesktop();
        if (ownedWindow == null || ownedWindow.HasExited)
            throw new InvalidOperationException("没有本受控端创建且仍在运行的进程。");
        ownedWindow.Refresh();
        if (!ownedWindow.CloseMainWindow())
            throw new InvalidOperationException("找不到本受控端新启动的窗口。已运行的应用可能复用了现有进程。");
        return "已发送正常关闭请求。请在 Windows 上处理应用的保存提示。";
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
        ownsNotepad = false;
    }
}
