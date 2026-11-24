using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;

internal static class WindowControlSummary
{
    private const int MaxNodes = 180;
    private const int MaxResults = 24;
    private static int scanning;

    internal static async Task<List<string>> Read(WindowsDesktop.Window window, CancellationToken cancel)
    {
        if (Interlocked.CompareExchange(ref scanning, 1, 0) != 0)
            throw new InvalidOperationException("上一项控件检查尚未结束。");
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            CancellationToken probe = timeout.Token;
            // UI Automation 请求本身不一定可中断。超时后退出等待，禁止重叠扫描。
            var scan = Task.Run(() =>
            {
                try { return ReadTree(window, probe); }
                finally { Interlocked.Exchange(ref scanning, 0); }
            });
            var limit = Task.Delay(4000, probe);
            if (await Task.WhenAny(scan, limit) != scan)
            {
                timeout.Cancel();
                scan.ContinueWith(task => { var error = task.Exception; },
                    CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
                cancel.ThrowIfCancellationRequested();
                throw new InvalidOperationException("此窗口的控件检查超时。");
            }
            timeout.Cancel();
            return await scan;
        }
    }

    private static List<string> ReadTree(WindowsDesktop.Window window, CancellationToken cancel)
    {
        window.Verify(true);
        var walker = TreeWalker.ControlViewWalker;
        var root = AutomationElement.FromHandle(window.Handle);
        var results = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int visited = 0;
        Visit(walker, root, 0, (int)window.ProcessId, cancel, seen, results, ref visited);
        return results;
    }

    private static void Visit(TreeWalker walker, AutomationElement parent, int depth, int processId,
        CancellationToken cancel, HashSet<string> seen, List<string> results, ref int visited)
    {
        if (depth >= 9 || visited >= MaxNodes || results.Count >= MaxResults) return;
        cancel.ThrowIfCancellationRequested();
        for (var child = walker.GetFirstChild(parent); child != null; child = walker.GetNextSibling(child))
        {
            if (visited++ >= MaxNodes || results.Count >= MaxResults) return;
            cancel.ThrowIfCancellationRequested();
            var control = child.Current;
            if (control.ProcessId != processId || control.IsOffscreen || control.IsPassword) continue;
            var type = control.ControlType;
            if (type == ControlType.Document || type == ControlType.Edit || type == ControlType.ComboBox ||
                type == ControlType.Text || type == ControlType.DataGrid ||
                type == ControlType.List || type == ControlType.Tree) continue;
            string kind = Kind(type);
            if (kind != null)
            {
                string name = SafeName(control.Name);
                if (name != null)
                {
                    string row = kind + " · " + name;
                    if (seen.Add(row)) results.Add(row);
                }
            }
            // 列表项、文件名、文档正文和编辑区不进入候选结果。
            if (type == ControlType.Group || type == ControlType.Pane || type == ControlType.ToolBar ||
                type == ControlType.MenuBar || type == ControlType.Tab)
                Visit(walker, child, depth + 1, processId, cancel, seen, results, ref visited);
        }
    }

    internal static string Kind(ControlType type)
    {
        if (type == ControlType.Button) return "按钮";
        if (type == ControlType.CheckBox) return "复选框";
        if (type == ControlType.RadioButton) return "单选按钮";
        if (type == ControlType.MenuItem) return "菜单项";
        return null;
    }

    internal static string SafeName(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length > 96) return null;
        foreach (char ch in value)
            if (Char.IsControl(ch) || Char.GetUnicodeCategory(ch) == System.Globalization.UnicodeCategory.Format)
                return null;
        return value.Trim();
    }
}
