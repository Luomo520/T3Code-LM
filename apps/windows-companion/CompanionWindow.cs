using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

internal sealed class CompanionWindow : Form
{
    private const string Title = "T3Code-LM Windows 受控端";
    private readonly TextBox address = new TextBox();
    private readonly TextBox name = new TextBox { MaxLength = 128 };
    private readonly TextBox code = new TextBox { MaxLength = 64, UseSystemPasswordChar = true };
    private readonly Label status = new Label();
    private readonly Label activity = new Label();
    private readonly Label recordingStatus = new Label();
    private readonly Label configHelp = new Label();
    private readonly Button pairButton = ButtonFor("配对");
    private readonly Button pauseButton = ButtonFor("恢复");
    private readonly Button forgetButton = ButtonFor("解除配对");
    private readonly Button allowButton = ButtonFor("允许这次");
    private readonly Button refuseButton = ButtonFor("拒绝");
    private readonly Button recordButton = ButtonFor("开始录制");
    private readonly Button pickButton = ButtonFor("选择文件");
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem pauseMenu;
    private readonly ToolStripMenuItem recordMenu;
    private readonly Timer pollTimer = new Timer { Interval = 3000 };
    private readonly Timer recordTimer = new Timer { Interval = ScreenRecording.Interval };
    private readonly WindowsDesktop desktop = new WindowsDesktop();
    private readonly Dictionary<string, string> info;
    private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
    private TaskCompletionSource<bool> approval;
    private Pairing paired;
    private Uri origin;
    private bool accepting, working, editing, quitting;
    private int acceptanceVersion;
    private CancellationTokenSource inProgress;
    private string lastStatus = "等待配对";
    private string activityText = "当前没有操作请求。";
    private ScreenRecording recording;
    private string recordingPath;

    internal CompanionWindow()
    {
        Text = Title;
        Icon = SystemIcons.Application;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = SystemFonts.MessageBoxFont;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(520, 475);
        ClientSize = new Size(575, 463);

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开受控端", null, delegate { Reveal(); });
        pauseMenu = (ToolStripMenuItem)menu.Items.Add("恢复接收", null, delegate { TogglePause(); });
        recordMenu = (ToolStripMenuItem)menu.Items.Add("停止录制", null, delegate { FinishRecording(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出受控端", null, delegate { quitting = true; Close(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = Title, Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += delegate { Reveal(); };

        BuildLayout();
        info = ReadInfo();
        LoadPairing();
        pairButton.Click += async delegate { await Enroll(); };
        pauseButton.Click += delegate { TogglePause(); };
        forgetButton.Click += async delegate { await Forget(); };
        allowButton.Click += delegate { SetApproval(true); };
        refuseButton.Click += delegate { SetApproval(false); };
        recordButton.Click += delegate { ToggleRecording(); };
        pickButton.Click += delegate { SelectFile(); };
        pollTimer.Tick += async delegate { await Poll(); };
        recordTimer.Tick += delegate { RecordFrame(); };
        recordingStatus.Text = "本机录制和文件选择";
        SystemEvents.SessionSwitch += SessionSwitch;
        FormClosing += ClosingWindow;
        UpdateView();
    }

    private static Button ButtonFor(string text) { return new Button { Text = text, AutoSize = true, MinimumSize = new Size(83, 30) }; }

    private void BuildLayout()
    {
        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(20), ColumnCount = 2
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 98));
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(content);

        status.Font = new Font(Font.FontFamily, 13, FontStyle.Bold);
        AddAcross(content, status, 13);
        AddField(content, "服务地址", address);
        AddField(content, "设备名称", name);
        AddField(content, "配对码", code);
        AddAcross(content, configHelp, 8);
        AddAcross(content, Commands(pairButton, pauseButton, forgetButton), 13);
        AddAcross(content, activity, 3);
        AddAcross(content, Commands(allowButton, refuseButton), 13);
        AddAcross(content, recordingStatus, 3);
        AddAcross(content, Commands(recordButton, pickButton), 0);
    }

    private static void AddAcross(TableLayoutPanel parent, Control control, int bottom)
    {
        control.AutoSize = true;
        control.Dock = DockStyle.Top;
        control.Margin = new Padding(0, 0, 0, bottom);
        var label = control as Label;
        if (label != null) label.MaximumSize = new Size(445, 0);
        int row = parent.RowCount++;
        parent.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        parent.Controls.Add(control, 0, row);
        parent.SetColumnSpan(control, 2);
    }

    private static void AddField(TableLayoutPanel parent, string caption, TextBox field)
    {
        var label = new Label { Text = caption, AutoSize = true, Anchor = AnchorStyles.Left };
        field.Dock = DockStyle.Fill;
        field.AccessibleName = caption;
        field.Margin = new Padding(0, 0, 0, 7);
        int row = parent.RowCount++;
        parent.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        parent.Controls.Add(label, 0, row);
        parent.Controls.Add(field, 1, row);
    }

    private static FlowLayoutPanel Commands(params Button[] buttons)
    {
        var group = new FlowLayoutPanel { AutoSize = true, WrapContents = true };
        foreach (Button button in buttons)
        {
            button.Margin = new Padding(0, 0, 8, 4);
            group.Controls.Add(button);
        }
        return group;
    }

    private static Dictionary<string, string> ReadInfo()
    {
        var values = new Dictionary<string, string> {
            { "hostname", Environment.MachineName },
            { "os", Environment.OSVersion.VersionString },
            { "platform", "windows" },
            { "version", Program.Version },
            { "processorCount", Environment.ProcessorCount.ToString() }
        };
        var cpu = Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", "") as string;
        if (!String.IsNullOrWhiteSpace(cpu)) values["cpu"] = cpu.Trim();
        return values;
    }

    private void LoadPairing()
    {
        name.Text = Environment.MachineName;
        try
        {
            paired = Pairing.Load();
            if (paired == null) return;
            origin = Pairing.ValidateAddress(paired.Address);
            address.Text = paired.Address;
            name.Text = paired.Name;
            lastStatus = "接收已暂停";
        }
        catch (Exception)
        {
            lastStatus = "无法读取保存的配对。可重新配对。";
        }
    }

    private void UpdateView()
    {
        if (quitting) return;
        status.Text = lastStatus;
        activity.Text = activityText;
        bool isPaired = paired != null;
        configHelp.Text = isPaired
            ? "通过此服务接收请求。截图、打开和关闭窗口均需在本机确认。"
            : "在 T3Code-LM 的设备控制页创建 Windows 配对码。";
        address.ReadOnly = name.ReadOnly = isPaired || editing;
        code.Enabled = !isPaired && !editing;
        pairButton.Visible = !isPaired;
        pairButton.Enabled = !editing;
        pauseButton.Visible = forgetButton.Visible = isPaired;
        pauseButton.Enabled = pauseMenu.Enabled = isPaired && !editing;
        forgetButton.Enabled = !editing;
        pauseButton.Text = accepting ? "暂停接收" : "恢复接收";
        pauseMenu.Text = pauseButton.Text;
        allowButton.Enabled = refuseButton.Enabled = approval != null && accepting;
        allowButton.Visible = refuseButton.Visible = approval != null;
        recordButton.Text = recording == null ? "开始录制" : "停止录制";
        recordMenu.Enabled = recording != null;
        tray.Icon = recording != null ? SystemIcons.Warning : SystemIcons.Application;
        tray.Text = recording != null ? "T3Code-LM 正在录制" : Title + (accepting ? " · 接收请求" : " · 已暂停");
        TopMost = recording != null || approval != null;
    }

    private async Task Enroll()
    {
        try
        {
            var server = Pairing.ValidateAddress(address.Text.Trim());
            string enteredName = name.Text.Trim();
            string enteredCode = code.Text.Trim();
            if (enteredName.Length == 0 || enteredCode.Length == 0)
                throw new ArgumentException("请输入设备名称和配对码。");
            if (server.Scheme == Uri.UriSchemeHttp &&
                MessageBox.Show(this, "此 HTTP 连接会以明文传输配对和截图。继续连接 " + server.AbsoluteUri + "？",
                    "确认服务器地址", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
                return;
            editing = true;
            lastStatus = "正在配对…";
            UpdateView();
            var response = await CompanionApi.Post(server, "enroll", new { code = enteredCode, name = enteredName, info },
                null, lifetime.Token);
            var next = new Pairing { Address = server.AbsoluteUri, Name = enteredName, Token = Json.String(response, "token"),
                DeviceId = Json.String(response, "deviceId") };
            if (String.IsNullOrEmpty(next.Token) || String.IsNullOrEmpty(next.DeviceId))
                throw new InvalidDataException("服务器没有返回完整的设备授权。");
            ExceptionDispatchInfo saveError = null;
            try { next.Save(); }
            catch (Exception error) { saveError = ExceptionDispatchInfo.Capture(error); }
            if (saveError != null)
            {
                try { await CompanionApi.Post(server, "revoke", new { }, next.Token, lifetime.Token); }
                catch (Exception) { }
                saveError.Throw();
            }
            paired = next;
            origin = server;
            address.Text = next.Address;
            code.Clear();
            lastStatus = "已配对，接收已暂停";
        }
        catch (Exception ex) { lastStatus = "配对失败 · " + FriendlyError(ex); }
        finally { editing = false; UpdateView(); }
    }

    private async Task Forget()
    {
        var previous = paired;
        if (previous == null || editing) return;
        StopAccepting("正在解除配对…");
        editing = true;
        UpdateView();
        try
        {
            await CompanionApi.Post(origin, "revoke", new { }, previous.Token, lifetime.Token);
            ClearPairing("已解除配对");
        }
        catch (ApiFailure ex)
        {
            if (ex.Status == HttpStatusCode.Unauthorized || ex.Status == HttpStatusCode.Forbidden)
                ClearPairing("已解除配对");
            else lastStatus = "解除配对失败 · " + FriendlyError(ex);
        }
        catch (Exception ex) { lastStatus = "解除配对失败 · " + FriendlyError(ex); }
        finally { editing = false; UpdateView(); }
    }

    private void ClearPairing(string text)
    {
        StopAccepting(text);
        paired = null;
        origin = null;
        try { Pairing.Clear(); }
        catch (IOException) { lastStatus += " · 本地配对记录删除失败"; }
        catch (UnauthorizedAccessException) { lastStatus += " · 本地配对记录删除失败"; }
    }

    private async void TogglePause()
    {
        if (paired == null || editing) return;
        if (accepting) StopAccepting("接收已暂停");
        else
        {
            accepting = true;
            lastStatus = "正在连接服务器…";
            pollTimer.Start();
            UpdateView();
            await Poll();
        }
    }

    private void StopAccepting(string text)
    {
        accepting = false;
        acceptanceVersion++;
        pollTimer.Stop();
        SetApproval(false);
        if (inProgress != null) inProgress.Cancel();
        lastStatus = text;
        UpdateView();
    }

    private async Task Poll()
    {
        var current = paired;
        var target = origin;
        if (!accepting || editing || working || current == null) return;
        working = true;
        int started = acceptanceVersion;
        try
        {
            var response = await CompanionApi.Post(target, "poll", new { name = current.Name, info }, current.Token, lifetime.Token);
            if (paired != current) return;

            string serverName = Json.String(response, "name");
            if (!String.IsNullOrWhiteSpace(serverName) && serverName != current.Name)
            {
                current.Name = serverName;
                name.Text = serverName;
                try { current.Save(); }
                catch (Exception) { activityText = "已更新设备名称，保存本地记录失败。"; }
            }
            if (accepting) lastStatus = "在线 · 等待操作请求";
            var job = Json.Map(response, "job");
            if (job != null)
            {
                var outcome = await RunJob(job, started);
                if (paired == current && !quitting)
                    await SendOutcome(target, current.Token, outcome, started);
            }
        }
        catch (ApiFailure ex)
        {
            if (paired == current && (ex.Status == HttpStatusCode.Unauthorized || ex.Status == HttpStatusCode.Forbidden))
                ClearPairing("服务器已撤销配对");
            else if (accepting) lastStatus = "连接失败 · " + FriendlyError(ex);
        }
        catch (Exception ex)
        {
            if (accepting) lastStatus = "连接失败 · " + FriendlyError(ex);
        }
        finally { working = false; UpdateView(); }
    }

    private async Task SendOutcome(Uri target, string token, Dictionary<string, string> outcome, int started)
    {
        if (!outcome.ContainsKey("imageBase64"))
        {
            await CompanionApi.Post(target, "result", outcome, token, lifetime.Token);
            return;
        }
        if (started != acceptanceVersion)
        {
            outcome.Remove("imageBase64");
            outcome["status"] = "failed";
            outcome["message"] = "本机已暂停，截图未上传。";
            await CompanionApi.Post(target, "result", outcome, token, lifetime.Token);
            return;
        }
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try { await CompanionApi.Post(target, "result", outcome, token, cancel.Token); }
            finally { inProgress = null; }
        }
    }

    private async Task<Dictionary<string, string>> RunJob(Dictionary<string, object> job, int started)
    {
        string action = Json.String(job, "action");
        var outcome = new Dictionary<string, string> { { "id", Json.String(job, "id") }, { "status", "failed" } };
        string label;
        switch (action)
        {
            case "screenshot": label = "截取主屏幕并发送至已配对服务器"; break;
            case "open-t3": label = "打开 T3Code-LM"; break;
            case "open-notepad": label = "打开记事本"; break;
            case "close-window": label = "关闭受控端打开的窗口"; break;
            default:
                outcome["message"] = "受控端不支持此操作。";
                return outcome;
        }
        try
        {
            if (!accepting || started != acceptanceVersion) throw new InvalidOperationException("Windows 已暂停接收请求。");
            WindowsDesktop.RequireDesktop();
            activityText = "请求 · " + label;
            approval = new TaskCompletionSource<bool>();
            Reveal();
            tray.ShowBalloonTip(4000, Title, activityText, ToolTipIcon.Info);
            UpdateView();
            Task finished = await Task.WhenAny(approval.Task, Task.Delay(TimeSpan.FromSeconds(45), lifetime.Token));
            bool allowed = finished == approval.Task && await approval.Task;
            approval = null;
            UpdateView();
            if (!allowed || !accepting || started != acceptanceVersion)
                throw new InvalidOperationException("Windows 用户拒绝了请求，或请求等待超时。");
            activityText = "正在执行 · " + label;
            UpdateView();
            if (action == "screenshot")
            {
                using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    inProgress = cancel;
                    try
                    {
                        string image = await WindowsMcp.Screenshot(cancel.Token);
                        cancel.Token.ThrowIfCancellationRequested();
                        outcome["imageBase64"] = image;
                        outcome["message"] = "主屏幕截图已生成。";
                    }
                    finally { inProgress = null; }
                }
            }
            else outcome["message"] = action == "close-window" ? desktop.Close() : desktop.Open(action);
            outcome["status"] = "done";
        }
        catch (Exception ex) { outcome["message"] = FriendlyError(ex); }
        activityText = label + " · " + outcome["message"];
        UpdateView();
        return outcome;
    }

    private void SetApproval(bool allowed)
    {
        if (approval != null) approval.TrySetResult(allowed);
    }

    private static string FriendlyError(Exception ex)
    {
        if (ex is OperationCanceledException) return "操作已取消或连接超时。";
        if (ex is HttpRequestException) return "无法建立连接。请核对服务地址、证书或 Windows-MCP 状态。";
        if (ex is ArgumentException || ex is ApiFailure || ex is InvalidDataException || ex is InvalidOperationException)
            return ex.Message;
        return "操作失败（" + ex.GetType().Name + "）。";
    }

    private void Reveal()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void SelectFile()
    {
        using (var dialog = new OpenFileDialog { Title = "选择本机文件", CheckFileExists = true, RestoreDirectory = true })
        {
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                activityText = "已选择本机文件 · " + Path.GetFileName(dialog.FileName);
                UpdateView();
            }
        }
    }

    private void ToggleRecording()
    {
        if (recording != null) { FinishRecording(); return; }
        using (var dialog = new SaveFileDialog
        {
            Title = "保存主屏幕录制",
            Filter = "AVI 视频 (*.avi)|*.avi",
            FileName = "T3Code-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".avi",
            AddExtension = true,
            RestoreDirectory = true
        })
        {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            try
            {
                recording = new ScreenRecording(dialog.FileName);
                recordingPath = dialog.FileName;
                recordingStatus.Text = "正在录制主屏幕 · 保存在此电脑";
                UpdateView();
                recordTimer.Start();
            }
            catch (Exception ex)
            {
                recordingStatus.Text = "录制启动失败 · " + FriendlyError(ex);
            }
        }
    }

    private void RecordFrame()
    {
        try
        {
            recording.Capture();
            if (recording.Count >= ScreenRecording.FrameLimit) FinishRecording();
        }
        catch (Exception ex) { FinishRecording(FriendlyError(ex)); }
    }

    private void FinishRecording(string reason = null)
    {
        if (recording == null) return;
        recordTimer.Stop();
        try
        {
            recording.Dispose();
            recordingStatus.Text = "录制已保存 · " + Path.GetFileName(recordingPath);
            if (reason != null) recordingStatus.Text += " · " + reason;
        }
        catch (Exception ex) { recordingStatus.Text = "录制保存失败 · " + FriendlyError(ex); }
        finally { recording = null; UpdateView(); }
    }

    private void SessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason != SessionSwitchReason.SessionLock && e.Reason != SessionSwitchReason.RemoteDisconnect &&
            e.Reason != SessionSwitchReason.ConsoleDisconnect) return;
        if (!IsHandleCreated || quitting) return;
        BeginInvoke(new Action(delegate
        {
            StopAccepting("Windows 已锁定或断开，接收已暂停");
            FinishRecording();
        }));
    }

    private void ClosingWindow(object sender, FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            if (approval != null) SetApproval(false);
            Hide();
            return;
        }
        quitting = true;
        StopAccepting("受控端已退出");
        FinishRecording();
        lifetime.Cancel();
        SystemEvents.SessionSwitch -= SessionSwitch;
        tray.Visible = false;
        var menu = tray.ContextMenuStrip;
        tray.Dispose();
        menu.Dispose();
        pollTimer.Dispose();
        recordTimer.Dispose();
        desktop.Dispose();
        lifetime.Dispose();
    }
}
