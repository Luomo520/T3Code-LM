using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

internal static class DesktopActionChoice
{
    internal static T Pick<T>(Form owner, List<T> items, string title, string description,
        string operation, Stopwatch requestAge, Action<Form> setDialog) where T : class
    {
        var list = new ListBox { IntegralHeight = false, AccessibleName = title };
        foreach (T item in items) list.Items.Add(item);
        T result = null;
        Show(owner, title, description, operation, list, requestAge, setDialog, approve =>
        {
            list.SelectedIndexChanged += delegate { approve.Enabled = list.SelectedItem != null; };
            approve.Click += delegate { result = list.SelectedItem as T; };
        });
        return result;
    }

    internal static List<string> ShareControls(Form owner, List<string> items, Stopwatch requestAge,
        Action<Form> setDialog)
    {
        var list = new CheckedListBox
        {
            IntegralHeight = false, CheckOnClick = true, AccessibleName = "可回传的控件"
        };
        foreach (string item in items) list.Items.Add(item);
        var approved = new List<string>();
        Show(owner, "确认回传窗口控件", "请勾选可以发回原会话的控件名称。只发送勾选项。",
            "发送所选名称", list, requestAge, setDialog, approve =>
            {
                list.ItemCheck += delegate(object sender, ItemCheckEventArgs e)
                {
                    int delta = e.NewValue == CheckState.Checked ? 1 : -1;
                    approve.Enabled = list.CheckedItems.Count + delta > 0;
                };
                approve.Click += delegate
                {
                    foreach (string item in list.CheckedItems) approved.Add(item);
                };
            });
        return approved;
    }

    private static void Show(Form owner, string title, string description, string operation, ListBox items,
        Stopwatch requestAge, Action<Form> setDialog, Action<Button> configure)
    {
        using (var expiry = new Timer())
        using (var dialog = new Form
        {
            Text = title, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false, MaximizeBox = false, ShowInTaskbar = false,
            AutoScaleMode = AutoScaleMode.Dpi, Font = SystemFonts.MessageBoxFont, ClientSize = new Size(510, 280)
        })
        {
            var label = new Label { Text = description, AutoSize = true, MaximumSize = new Size(475, 0) };
            var approve = new Button
            {
                Text = operation, AutoSize = true, MinimumSize = new Size(105, 32),
                Enabled = false, DialogResult = DialogResult.OK
            };
            var cancel = new Button
            {
                Text = "取消", AutoSize = true, MinimumSize = new Size(80, 32), DialogResult = DialogResult.Cancel
            };
            var buttons = new FlowLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft
            };
            buttons.Controls.Add(approve);
            buttons.Controls.Add(cancel);
            var content = new TableLayoutPanel { ColumnCount = 1, RowCount = 3, Dock = DockStyle.Fill, Padding = new Padding(12) };
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            items.Dock = DockStyle.Fill;
            items.HorizontalScrollbar = true;
            content.Controls.Add(label, 0, 0);
            content.Controls.Add(items, 0, 1);
            content.Controls.Add(buttons, 0, 2);
            dialog.Controls.Add(content);
            dialog.ActiveControl = items;
            dialog.AcceptButton = approve;
            dialog.CancelButton = cancel;
            configure(approve);
            expiry.Interval = Math.Max(1, 50000 - (int)requestAge.ElapsedMilliseconds);
            expiry.Tick += delegate { dialog.Close(); };
            expiry.Start();
            setDialog(dialog);
            try
            {
                if (requestAge.Elapsed.TotalSeconds >= 50 || dialog.ShowDialog(owner) != DialogResult.OK)
                    throw new InvalidOperationException("本机已取消操作，或请求已过期。");
            }
            finally { setDialog(null); }
        }
    }
}
