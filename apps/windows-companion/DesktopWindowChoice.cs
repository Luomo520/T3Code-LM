using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

internal static class DesktopWindowChoice
{
    internal static WindowsDesktop.Window Ask(Form owner, List<WindowsDesktop.Window> windows, string title,
        string operation, bool allowLaunch, string replacement, Stopwatch requestAge, Action<Form> setDialog)
    {
        if (windows.Count == 0 && !allowLaunch)
            throw new InvalidOperationException("找不到可操作的可见记事本窗口。");

        using (var expiry = new Timer())
        using (var dialog = new Form
        {
            Text = title,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            AutoScaleMode = AutoScaleMode.Dpi,
            Font = SystemFonts.MessageBoxFont,
            ClientSize = new Size(490, replacement == null ? 148 : 276)
        })
        {
            var target = new ComboBox
            {
                AccessibleName = "窗口", Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList,
                IntegralHeight = false, MaxDropDownItems = 12
            };
            target.Items.AddRange(windows.ToArray());
            if (allowLaunch) target.Items.Add("启动新窗口");
            var approve = new Button { Text = operation, AutoSize = true, Enabled = false, DialogResult = DialogResult.OK };
            var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
            target.SelectedIndexChanged += delegate { approve.Enabled = target.SelectedIndex >= 0; };

            var buttons = new FlowLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft
            };
            buttons.Controls.Add(approve);
            buttons.Controls.Add(cancel);
            var content = new TableLayoutPanel { ColumnCount = 1, Dock = DockStyle.Fill, Padding = new Padding(12) };
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.Controls.Add(new Label
            {
                Text = replacement == null ? "选择本次操作的窗口。" : "下方文字将替换所选记事本编辑区中的全部内容。",
                AutoSize = true
            }, 0, 0);
            content.Controls.Add(target, 0, 1);
            if (replacement != null)
            {
                var preview = new TextBox
                {
                    AccessibleName = "将替换为以下文字", Text = replacement, Multiline = true,
                    ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill
                };
                content.Controls.Add(preview, 0, 2);
            }
            content.Controls.Add(buttons, 0, 3);
            dialog.Controls.Add(content);
            dialog.AcceptButton = approve;
            dialog.CancelButton = cancel;
            dialog.ActiveControl = target;
            expiry.Interval = Math.Max(1, 50000 - (int)requestAge.ElapsedMilliseconds);
            expiry.Tick += delegate { dialog.Close(); };
            expiry.Start();
            setDialog(dialog);
            try
            {
                if (requestAge.Elapsed.TotalSeconds >= 50)
                    throw new InvalidOperationException("请求已过期。");
                if (dialog.ShowDialog(owner) != DialogResult.OK)
                    throw new InvalidOperationException("已取消窗口选择，或请求已过期。");
                return target.SelectedItem as WindowsDesktop.Window;
            }
            finally { setDialog(null); }
        }
    }
}
