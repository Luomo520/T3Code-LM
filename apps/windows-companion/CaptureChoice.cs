using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class CaptureChoice
{
    internal readonly CaptureTarget Target;
    internal readonly int Seconds;

    private CaptureChoice(CaptureTarget target, int seconds)
    {
        Target = target;
        Seconds = seconds;
    }

    internal static CaptureChoice Ask(Form owner, string kind, bool record, bool send, int seconds, int maximum, Action<Form> setDialog)
    {
        var targets = CaptureTarget.List(kind, owner.Handle);
        if (targets.Count == 0) throw new InvalidOperationException("找不到可用的拍摄目标。");
        using (var dialog = new Form())
        {
            dialog.Text = record ? "选择录制目标" : "选择截图目标";
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.MaximizeBox = false;
            dialog.MinimizeBox = false;
            dialog.ShowInTaskbar = false;
            dialog.AutoScaleMode = AutoScaleMode.Dpi;
            dialog.Font = SystemFonts.MessageBoxFont;
            dialog.ClientSize = new Size(465, 180);
            var caption = new Label
            {
                Text = send ? "选择本次发回原会话的窗口或显示器。" : "选择本次保存在此电脑的窗口或显示器。",
                Dock = DockStyle.Top, AutoSize = true, Margin = new Padding(0, 0, 0, 6)
            };
            var target = new ComboBox
            {
                AccessibleName = "拍摄目标", Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList,
                IntegralHeight = false, MaxDropDownItems = 12, Margin = new Padding(0, 0, 0, 10)
            };
            target.Items.AddRange(targets.ToArray());
            var duration = new NumericUpDown
            {
                AccessibleName = "录制时长（秒）", Minimum = 1, Maximum = maximum, Value = seconds, Width = 80
            };
            var durationGroup = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, Visible = record };
            durationGroup.Controls.Add(new Label { Text = "最多录制（秒）", AutoSize = true, Margin = new Padding(0, 5, 7, 0) });
            durationGroup.Controls.Add(duration);

            var approve = new Button
            {
                Text = record ? "继续录制" : send ? "截图并发送" : "继续截图",
                AutoSize = true, Enabled = false, DialogResult = DialogResult.OK
            };
            var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
            target.SelectedIndexChanged += delegate { approve.Enabled = target.SelectedItem is CaptureTarget; };
            var buttons = new FlowLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft
            };
            buttons.Controls.Add(approve);
            buttons.Controls.Add(cancel);
            var content = new TableLayoutPanel
            {
                ColumnCount = 1, Dock = DockStyle.Fill, Padding = new Padding(12), AutoScroll = true
            };
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.Controls.Add(caption, 0, 0);
            content.Controls.Add(target, 0, 1);
            content.Controls.Add(durationGroup, 0, 2);
            content.Controls.Add(buttons, 0, 3);
            dialog.Controls.Add(content);
            dialog.AcceptButton = approve;
            dialog.CancelButton = cancel;
            dialog.ActiveControl = target;
            setDialog(dialog);
            try
            {
                return dialog.ShowDialog(owner) == DialogResult.OK && target.SelectedItem is CaptureTarget
                    ? new CaptureChoice((CaptureTarget)target.SelectedItem, (int)duration.Value)
                    : null;
            }
            finally { setDialog(null); }
        }
    }
}
