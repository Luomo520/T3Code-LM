using System;
using System.Drawing;
using System.Windows.Forms;

internal static class ApprovedScriptManager
{
    internal static void Show(Form owner, Func<Exception, string> describeError)
    {
        using (var dialog = new Form
        {
            Text = "本机脚本", StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(580, 310),
            FormBorderStyle = FormBorderStyle.FixedDialog, MinimizeBox = false, MaximizeBox = false,
            ShowInTaskbar = false, AutoScaleMode = AutoScaleMode.Dpi, Font = SystemFonts.MessageBoxFont
        })
        {
            var instructions = new Label
            {
                Text = "请先审阅脚本内容。每次会话请求仍需在这台电脑上选择脚本并确认运行。",
                AutoSize = true, MaximumSize = new Size(545, 0)
            };
            var list = new ListBox
            {
                Dock = DockStyle.Fill, IntegralHeight = false, HorizontalScrollbar = true,
                AccessibleName = "已批准的本机脚本"
            };
            var add = new Button { Text = "批准脚本…", AutoSize = true, MinimumSize = new Size(95, 32) };
            var revoke = new Button { Text = "撤销批准", AutoSize = true, MinimumSize = new Size(95, 32), Enabled = false };
            var close = new Button
            {
                Text = "关闭", AutoSize = true, MinimumSize = new Size(80, 32), DialogResult = DialogResult.Cancel
            };
            var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
            buttons.Controls.Add(add);
            buttons.Controls.Add(revoke);
            buttons.Controls.Add(close);
            var content = new TableLayoutPanel
            {
                ColumnCount = 1, RowCount = 3, Dock = DockStyle.Fill, Padding = new Padding(12)
            };
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.Controls.Add(instructions, 0, 0);
            content.Controls.Add(list, 0, 1);
            content.Controls.Add(buttons, 0, 2);
            dialog.Controls.Add(content);
            dialog.CancelButton = close;
            Action refresh = delegate
            {
                var scripts = ApprovedScripts.Load();
                list.Items.Clear();
                foreach (var script in scripts) list.Items.Add(script);
                revoke.Enabled = false;
            };
            Action<Action> apply = change =>
            {
                try { change(); refresh(); }
                catch (Exception ex)
                {
                    MessageBox.Show(dialog, describeError(ex), "无法更新脚本批准",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };
            list.SelectedIndexChanged += delegate { revoke.Enabled = list.SelectedItem != null; };
            add.Click += delegate
            {
                using (var chooser = new OpenFileDialog
                {
                    Title = "选择已审阅的 PowerShell 脚本", CheckFileExists = true, RestoreDirectory = true,
                    Filter = "PowerShell 脚本 (*.ps1)|*.ps1"
                })
                {
                    if (chooser.ShowDialog(dialog) != DialogResult.OK) return;
                    apply(delegate
                    {
                        WindowsDesktop.RequireDesktop();
                        var script = ApprovedScripts.Inspect(chooser.FileName);
                        if (MessageBox.Show(dialog,
                            "批准以下路径的当前脚本版本？" + Environment.NewLine + script.Path +
                            Environment.NewLine + Environment.NewLine + "SHA-256  " + script.Sha256,
                            "确认本机脚本", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                            MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                        WindowsDesktop.RequireDesktop();
                        ApprovedScripts.Approve(script);
                    });
                }
            };
            revoke.Click += delegate
            {
                var script = list.SelectedItem as ApprovedScripts.Entry;
                if (script != null) apply(() => ApprovedScripts.Revoke(script));
            };
            refresh();
            dialog.ActiveControl = list.Items.Count == 0 ? (Control)add : list;
            dialog.ShowDialog(owner);
        }
    }
}
