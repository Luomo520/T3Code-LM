using System;
using System.Collections.Generic;
using System.ComponentModel;
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
    private Window openedWindow;
    private static readonly string SystemNotepad = Path.Combine(Environment.SystemDirectory, "notepad.exe");

    private delegate bool WindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint size, StringBuilder family);

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

    internal sealed class Window
    {
        internal readonly IntPtr Handle;
        internal readonly uint ProcessId;
        private readonly uint threadId;
        private readonly DateTime startedAt;
        private readonly string title;
        private readonly int number;

        internal Window(IntPtr handle, uint id, uint thread, DateTime start, string name, int index)
        {
            Handle = handle;
            ProcessId = id;
            threadId = thread;
            startedAt = start;
            title = name;
            number = index;
        }

        public override string ToString() { return number + ". " + title; }

        internal void Verify(bool checkTitle)
        {
            RequireDesktop();
            uint currentProcess;
            if (GetWindowThreadProcessId(Handle, out currentProcess) != threadId || currentProcess != ProcessId ||
                !IsUsable(Handle) || !InspectProcess(currentProcess, process => process.StartTime == startedAt) ||
                (checkTitle && ReadTitle(Handle) != title))
                throw new InvalidOperationException("所选窗口已关闭、隐藏或更换，请重新选择。");
        }
    }

    internal static List<Window> ListWindows(bool notepad)
    {
        RequireDesktop();
        var windows = new List<Window>();
        var paths = notepad ? null : new HashSet<string>(T3Paths(), StringComparer.OrdinalIgnoreCase);
        EnumWindows(delegate(IntPtr handle, IntPtr ignored)
        {
            uint id;
            uint thread = GetWindowThreadProcessId(handle, out id);
            if (thread == 0 || !IsUsable(handle)) return true;
            string title = ReadTitle(handle);
            if (title.Length == 0) return true;
            var candidate = InspectProcess(id, process =>
                (notepad ? IsNotepad(process) : paths.Contains(process.MainModule.FileName))
                    ? new Window(handle, id, thread, process.StartTime, title, windows.Count + 1)
                    : null);
            if (candidate != null) windows.Add(candidate);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static T InspectProcess<T>(uint id, Func<Process, T> inspect)
    {
        try
        {
            using (var process = Process.GetProcessById((int)id)) return inspect(process);
        }
        catch (ArgumentException) { return default(T); }
        catch (InvalidOperationException) { return default(T); }
        catch (Win32Exception) { return default(T); }
    }

    private static bool IsUsable(IntPtr window)
    {
        int cloaked;
        return IsWindowVisible(window) && !IsIconic(window) && !IsHungAppWindow(window) &&
            GetWindow(window, 4) == IntPtr.Zero &&
            DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked == 0;
    }

    private static string ReadTitle(IntPtr window)
    {
        var title = new StringBuilder(241);
        GetWindowText(window, title, title.Capacity);
        return title.ToString().Trim();
    }

    private static bool IsNotepad(Process process)
    {
        string path = process.MainModule.FileName;
        if (String.Equals(path, SystemNotepad, StringComparison.OrdinalIgnoreCase) ||
            String.Equals(path, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "notepad.exe"),
                StringComparison.OrdinalIgnoreCase))
            return true;
        if (!String.Equals(Path.GetFileName(path), "notepad.exe", StringComparison.OrdinalIgnoreCase)) return false;
        var family = new StringBuilder(128);
        uint size = (uint)family.Capacity;
        return GetPackageFamilyName(process.Handle, ref size, family) == 0 &&
            family.ToString() == "Microsoft.WindowsNotepad_8wekyb3d8bbwe";
    }

    private static IEnumerable<string> T3Paths()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] roots = { Path.Combine(local, "Programs"), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) };
        string[] directories = { "t3code", "T3Code-LM", "T3 Code", "T3 Code (Beta)" };
        string[] names = { "T3 Code (Beta).exe", "T3Code-LM.exe", "T3 Code.exe" };
        foreach (string root in roots)
        foreach (string directory in directories)
        foreach (string name in names)
            yield return Path.Combine(root, directory, name);
    }

    internal async Task<string> Open(bool notepad, Window selected, IntPtr approvingWindow,
        Action verifyRequest, Func<Task> verifyJob, CancellationToken cancel)
    {
        await CheckBeforeWindowAction(selected, approvingWindow, verifyRequest, verifyJob, cancel);
        string name = notepad ? "记事本" : "T3Code-LM";
        if (selected != null)
        {
            await Activate(selected, approvingWindow, verifyRequest, cancel);
            return "已激活所选" + name + "窗口。";
        }
        if (ownedWindow != null && !ownedWindow.HasExited)
            throw new InvalidOperationException("先关闭此前由受控端打开的窗口，或选择现有窗口。");
        string path = notepad ? SystemNotepad : null;
        if (!notepad)
            foreach (string candidate in T3Paths())
                if (File.Exists(candidate)) { path = candidate; break; }
        if (path == null) throw new InvalidOperationException("请先安装 T3Code-LM 桌面应用。");
        var existing = new HashSet<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr ignored) { existing.Add(handle); return true; }, IntPtr.Zero);
        VerifyBeforeWindowAction(null, approvingWindow, verifyRequest, cancel);
        var next = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path) });
        if (next == null) throw new InvalidOperationException("Windows 未返回新进程。");
        try
        {
            var elapsed = Stopwatch.StartNew();
            while (elapsed.Elapsed < TimeSpan.FromSeconds(12))
            {
                cancel.ThrowIfCancellationRequested();
                verifyRequest();
                next.Refresh();
                var foreground = GetForegroundWindow();
                // 单实例应用可能把启动转交给已有进程。只把新进程的精确窗口标记为可关闭。
                foreach (var candidate in ListWindows(notepad))
                {
                    if (existing.Contains(candidate.Handle)) continue;
                    if (!next.HasExited && candidate.ProcessId == (uint)next.Id && candidate.Handle == next.MainWindowHandle)
                    {
                        Dispose();
                        ownedWindow = next;
                        openedWindow = candidate;
                        return "已打开" + name + "窗口。";
                    }
                    if (candidate.Handle == foreground && next.HasExited)
                        return "已打开" + name + "窗口。";
                }
                await Task.Delay(150, cancel);
            }
            throw new InvalidOperationException("已请求启动" + name + "，尚未确认出现新窗口。");
        }
        finally { if (ownedWindow != next) next.Dispose(); }
    }

    private static async Task CheckBeforeWindowAction(Window selected, IntPtr approvingWindow, Action verifyRequest,
        Func<Task> verifyJob, CancellationToken cancel)
    {
        await WindowsMcp.RequireIdleAsync(() => VerifyBeforeWindowAction(selected, approvingWindow, verifyRequest, cancel), cancel);
        await verifyJob();
        VerifyBeforeWindowAction(selected, approvingWindow, verifyRequest, cancel);
    }

    private static void VerifyBeforeWindowAction(Window selected, IntPtr approvingWindow, Action verifyRequest,
        CancellationToken cancel)
    {
        cancel.ThrowIfCancellationRequested();
        verifyRequest();
        RequireDesktop();
        if (selected != null) selected.Verify(true);
        IntPtr foreground = GetForegroundWindow();
        if (foreground != approvingWindow && (selected == null || foreground != selected.Handle))
            throw new InvalidOperationException("前台已切换到其他窗口，本次操作已停止。");
    }

    private static async Task Activate(Window window, IntPtr approvingWindow, Action verifyRequest, CancellationToken cancel)
    {
        if (GetForegroundWindow() != window.Handle && SetForegroundWindow(window.Handle))
        {
            var elapsed = Stopwatch.StartNew();
            while (GetForegroundWindow() != window.Handle && elapsed.ElapsedMilliseconds < 300)
            {
                VerifyBeforeWindowAction(window, approvingWindow, verifyRequest, cancel);
                await Task.Delay(30, cancel);
            }
        }
        VerifyBeforeWindowAction(window, approvingWindow, verifyRequest, cancel);
        RequireForegroundWindow(window, true);
    }

    internal async Task<string> NotepadText(Window window, string replacement, IntPtr approvingWindow,
        Action verifyRequest, Func<Task> verifyJob, CancellationToken cancel)
    {
        await CheckBeforeWindowAction(window, approvingWindow, verifyRequest, verifyJob, cancel);
        await Activate(window, approvingWindow, verifyRequest, cancel);
        var root = AutomationElement.FromHandle(window.Handle);
        var fields = root.FindAll(TreeScope.Descendants, new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
        AutomationElement editor = null;
        foreach (AutomationElement field in fields)
        {
            if (field.Current.ProcessId != (int)window.ProcessId || field.Current.IsOffscreen ||
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
            verifyRequest();
            RequireForegroundWindow(window, true);
            ((ValuePattern)pattern).SetValue(replacement);
        }
        verifyRequest();
        RequireForegroundWindow(window, replacement == null);
        object readable;
        string text;
        if (editor.TryGetCurrentPattern(TextPattern.Pattern, out readable))
            text = ((TextPattern)readable).DocumentRange.GetText(3890);
        else if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out readable))
            text = ((ValuePattern)readable).Current.Value;
        else throw new InvalidOperationException("无法读回记事本文字。");
        RequireForegroundWindow(window, replacement == null);
        if (text.Length > 3889)
            throw new InvalidOperationException("记事本文字超过可返回的长度。");
        return replacement == null ? "读回的记事本文字：" + Environment.NewLine + text :
            "已填写并读回记事本文字：" + Environment.NewLine + text;
    }

    private static void RequireForegroundWindow(Window expected, bool checkTitle)
    {
        expected.Verify(checkTitle);
        if (GetForegroundWindow() != expected.Handle)
            throw new InvalidOperationException("未能确认所选窗口在前台，本次操作已停止。");
    }

    internal async Task<Process> RequestClose(IntPtr approvingWindow, Action verifyRequest, Func<Task> verifyJob,
        CancellationToken cancel)
    {
        RequireDesktop();
        var process = ownedWindow;
        var window = openedWindow;
        if (process == null || process.HasExited || window == null)
            throw new InvalidOperationException("没有本受控端创建且仍在运行的窗口。");
        await CheckBeforeWindowAction(null, approvingWindow, verifyRequest, verifyJob, cancel);
        window.Verify(false);
        process.Refresh();
        if (process.MainWindowHandle != window.Handle)
            throw new InvalidOperationException("受控端打开的原窗口已更换。");
        if (!process.CloseMainWindow() && !process.HasExited)
            throw new InvalidOperationException("找不到可关闭的窗口。如果应用已有保存提示，请在 Windows 上处理。");
        return process;
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
        openedWindow = null;
    }
}
