using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;

internal sealed class WindowFormControl
{
    private readonly AutomationElement element;
    private readonly bool fill;
    private readonly string label;

    private WindowFormControl(AutomationElement element, bool fill, string label)
    {
        this.element = element;
        this.fill = fill;
        this.label = label;
    }

    public override string ToString() { return label; }

    internal static bool Supports(string action)
    {
        return action == "press-window-button" || action == "fill-window-field";
    }

    internal static async Task<List<WindowFormControl>> Find(WindowsDesktop.Window window, bool fill,
        string requestedName, CancellationToken cancel)
    {
        using (var scan = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            var token = scan.Token;
            var work = Task.Run(() =>
            {
                var results = new List<WindowFormControl>();
                var nodes = new Queue<AutomationElement>();
                var walker = TreeWalker.ControlViewWalker;
                nodes.Enqueue(AutomationElement.FromHandle(window.Handle));
                int seen = 1;
                while (nodes.Count > 0 && results.Count < 32)
                {
                    token.ThrowIfCancellationRequested();
                    var node = nodes.Dequeue();
                    if (!Allowed(node, window)) continue;
                    var state = node.Current;
                    bool target = state.ControlType == (fill ? ControlType.Edit : ControlType.Button);
                    if (target && state.IsEnabled)
                    {
                        var name = Label(node);
                        object pattern;
                        if (name != null && (String.IsNullOrEmpty(requestedName) || String.Equals(requestedName, name, StringComparison.OrdinalIgnoreCase)) &&
                            node.TryGetCurrentPattern(fill ? ValuePattern.Pattern : InvokePattern.Pattern, out pattern) &&
                            (!fill || !((ValuePattern)pattern).Current.IsReadOnly))
                            results.Add(new WindowFormControl(node, fill, name));
                    }
                    if (target || state.ControlType == ControlType.Document || state.ControlType == ControlType.Edit) continue;
                    for (var child = walker.GetFirstChild(node); child != null && seen < 256; child = walker.GetNextSibling(child))
                    {
                        nodes.Enqueue(child);
                        seen++;
                    }
                }
                return results;
            }, token);
            if (await Task.WhenAny(work, Task.Delay(4000, token)) == work) return await work;
            scan.Cancel();
            cancel.ThrowIfCancellationRequested();
            throw new InvalidOperationException("读取窗口控件超时。");
        }
    }

    private static bool Allowed(AutomationElement element, WindowsDesktop.Window window)
    {
        var state = element.Current;
        return state.ProcessId == (int)window.ProcessId && !state.IsPassword && !state.IsOffscreen;
    }

    private static string Label(AutomationElement element)
    {
        return WindowControlSummary.SafeName(element.Current.Name) ?? WindowControlSummary.SafeName(element.Current.AutomationId);
    }

    internal void Apply(WindowsDesktop.Window window, string text, Action verify)
    {
        verify();
        var root = AutomationElement.FromHandle(window.Handle);
        var walker = TreeWalker.ControlViewWalker;
        var node = element;
        for (int i = 0; node != null && i < 64; i++, node = walker.GetParent(node))
        {
            if (!Allowed(node, window)) break;
            if (!Automation.Compare(node, root)) continue;
            if (!element.Current.IsEnabled || element.Current.ControlType != (fill ? ControlType.Edit : ControlType.Button) ||
                Label(element) != label) break;
            object pattern;
            if (!element.TryGetCurrentPattern(fill ? ValuePattern.Pattern : InvokePattern.Pattern, out pattern)) break;
            verify();
            if (fill && !((ValuePattern)pattern).Current.IsReadOnly) ((ValuePattern)pattern).SetValue(text);
            else if (!fill) ((InvokePattern)pattern).Invoke();
            else break;
            return;
        }
        throw new InvalidOperationException("目标窗口或控件已变化，请重新选择。");
    }
}
