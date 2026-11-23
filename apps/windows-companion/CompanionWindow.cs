using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
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
    private readonly Button checkButton = ButtonFor("设备自检");
    private readonly Button renameButton = ButtonFor("修改名称");
    private readonly Button allowButton = ButtonFor("允许这次");
    private readonly Button refuseButton = ButtonFor("拒绝");
    private readonly Button recordButton = ButtonFor("开始录制");
    private readonly Button screenshotButton = ButtonFor("截取画面");
    private readonly Button pickButton = ButtonFor("选择文件");
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem pauseMenu;
    private readonly ToolStripMenuItem recordMenu;
    private readonly Timer pollTimer = new Timer { Interval = 3000 };
    private readonly Timer recordTimer = new Timer { Interval = ScreenRecording.Interval };
    private readonly Timer recordingStopTimer = new Timer { Interval = 500 };
    private readonly WindowsDesktop desktop = new WindowsDesktop();
    private Dictionary<string, string> info;
    private bool editingName;
    private int networkInfoChanged;
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
    private const int RemoteRecordingSeconds = 10;
    private const int RemoteRecordingMaxBytes = 5 * 1024 * 1024;
    private TaskCompletionSource<bool> remoteRecording;
    private Stopwatch recordingElapsed;
    private CaptureChoice recordingChoice;
    private CancellationTokenSource frameCancel;
    private bool framePending;
    private Form captureDialog;
    private bool pickingLocalCapture;
    private const int RemoteRecordingMaximum = 30;
    private string watchedRecordingId;
    private bool checkingRecordingStop, recordingStopRequested;

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
        info = new Dictionary<string, string>();
        LoadPairing();
        pairButton.Click += async delegate { await Enroll(); };
        pauseButton.Click += delegate { TogglePause(); };
        forgetButton.Click += async delegate { await Forget(); };
        checkButton.Click += async delegate { await CheckDevice(null); };
        renameButton.Click += async delegate
        {
            if (editing || working || paired == null) return;
            if (editingName)
            {
                await CheckDevice(name.Text.Trim());
            }
            else
            {
                editingName = true;
                UpdateView();
                name.Focus();
                name.SelectAll();
            }
        };
        name.KeyDown += delegate(object sender, KeyEventArgs args)
        {
            if (!editingName || editing || args.KeyCode != Keys.Escape) return;
            args.SuppressKeyPress = true;
            editingName = false;
            if (paired != null) name.Text = paired.Name;
            UpdateView();
        };
        allowButton.Click += delegate { SetApproval(true); };
        refuseButton.Click += delegate { SetApproval(false); };
        recordButton.Click += delegate { ToggleRecording(); };
        screenshotButton.Click += async delegate { await TakeLocalScreenshot(); };
        pickButton.Click += delegate { SelectFile(); };
        pollTimer.Tick += async delegate { await Poll(); };
        recordTimer.Tick += async delegate { await RecordFrame(); };
        Resize += delegate
        {
            if (recording != null && WindowState == FormWindowState.Minimized) FinishRecording();
        };
        recordingStopTimer.Tick += async delegate { await CheckRecordingStop(); };
        recordingStatus.Text = "本机录制和文件选择";
        SystemEvents.SessionSwitch += SessionSwitch;
        NetworkChange.NetworkAddressChanged += NetworkAddressChanged;
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
        AddAcross(content, Commands(pairButton, pauseButton, forgetButton), 8);
        AddAcross(content, Commands(checkButton, renameButton), 13);
        AddAcross(content, activity, 3);
        AddAcross(content, Commands(allowButton, refuseButton), 13);
        AddAcross(content, recordingStatus, 3);
        AddAcross(content, Commands(screenshotButton, recordButton, pickButton), 0);
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
        address.ReadOnly = isPaired || editing;
        name.ReadOnly = editing || (isPaired && !editingName);
        code.Enabled = !isPaired && !editing;
        pairButton.Visible = !isPaired;
        pairButton.Enabled = !editing;
        pauseButton.Visible = forgetButton.Visible = isPaired;
        pauseButton.Enabled = pauseMenu.Enabled = isPaired && !editing;
        forgetButton.Enabled = !editing;
        checkButton.Visible = renameButton.Visible = isPaired;
        checkButton.Enabled = !editing && !editingName;
        renameButton.Enabled = !editing;
        renameButton.Text = editingName ? "保存名称" : "修改名称";
        pauseButton.Text = accepting ? "暂停接收" : "恢复接收";
        pauseMenu.Text = pauseButton.Text;
        allowButton.Enabled = refuseButton.Enabled = approval != null && accepting;
        allowButton.Visible = refuseButton.Visible = approval != null;
        screenshotButton.Enabled = recording == null && !working && !pickingLocalCapture;
        recordButton.Enabled = recording != null || (!working && !pickingLocalCapture);
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
            info = await Task.Run(() => DeviceInfo.Read(), lifetime.Token);
            var response = await CompanionApi.Post(server, "enroll", new { code = enteredCode, name = enteredName, info = DeviceInfo.WithDesktopState(info) },
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
        editingName = false;
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
        if (captureDialog != null) captureDialog.Close();
        if (inProgress != null) inProgress.Cancel();
        if (remoteRecording != null) FinishRecording("接收已暂停，录像仅保存在本机。");
        lastStatus = text;
        UpdateView();
    }

    private bool ApplyServerName(Pairing current, string serverName)
    {
        if (String.IsNullOrWhiteSpace(serverName) || serverName == current.Name) return true;
        current.Name = serverName;
        if (!editingName) name.Text = serverName;
        try { current.Save(); return true; }
        catch (Exception)
        {
            activityText = "已同步设备名称，保存本地记录失败。";
            return false;
        }
    }

    private async Task CheckDevice(string renamedTo)
    {
        var current = paired;
        if (current == null || editing || working) return;
        if (renamedTo != null && renamedTo.Length == 0)
        {
            activityText = "请输入设备名称。按 Esc 可取消修改。";
            UpdateView();
            return;
        }
        if (renamedTo == current.Name)
        {
            editingName = false;
            UpdateView();
            return;
        }

        editing = true;
        activityText = renamedTo == null ? "正在读取本机资料并检查配对连接…" : "正在同步设备名称…";
        UpdateView();
        try
        {
            info = await Task.Run(() => DeviceInfo.Read(), lifetime.Token);
            var payload = new Dictionary<string, object> { { "info", DeviceInfo.WithDesktopState(info) } };
            if (renamedTo != null) payload["name"] = renamedTo;
            var response = await CompanionApi.Post(origin, "check", payload, current.Token, lifetime.Token);
            if (paired != current || quitting) return;
            editingName = false;
            string serverName = Json.String(response, "name");
            bool saved = ApplyServerName(current, serverName);
            name.Text = current.Name;
            if (renamedTo != null)
            {
                if (saved) activityText = "设备名称已同步。";
            }
            else
            {
                if (saved) activityText = "配对连接正常，设备资料已更新。";
                MessageBox.Show(this, FormatCheckResults(response), "设备自检", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
        catch (ApiFailure ex)
        {
            if (paired == current && (ex.Status == HttpStatusCode.Unauthorized || ex.Status == HttpStatusCode.Forbidden))
                ClearPairing("服务器已撤销配对");
            else activityText = "无法同步设备资料 · " + FriendlyError(ex);
        }
        catch (Exception ex) { activityText = "无法同步设备资料 · " + FriendlyError(ex); }
        finally { editing = false; UpdateView(); }
    }

    private string FormatCheckResults(Dictionary<string, object> response)
    {
        var lines = new List<string> { "配对连接正常", "设备名称 · " + paired.Name };
        DateTimeOffset updated;
        if (DateTimeOffset.TryParse(Json.String(response, "detailsUpdatedAt"), out updated))
            lines.Add("资料更新时间 · " + updated.ToLocalTime().ToString("g"));
        foreach (var item in new[] {
            new KeyValuePair<string, string>("os", "系统"),
            new KeyValuePair<string, string>("cpu", "处理器"),
            new KeyValuePair<string, string>("gpu", "显卡"),
            new KeyValuePair<string, string>("memory", "内存")
        })
        {
            string value;
            if (info.TryGetValue(item.Key, out value)) lines.Add(item.Value + " · " + value);
        }
        foreach (var field in info)
            if (field.Key.StartsWith("network", StringComparison.Ordinal)) lines.Add("网卡 · " + field.Value);
        return String.Join(Environment.NewLine, lines);
    }

    private void NetworkAddressChanged(object sender, EventArgs args)
    {
        Interlocked.Exchange(ref networkInfoChanged, 1);
    }

    private async Task CheckRecordingStop()
    {
        string id = watchedRecordingId;
        var current = paired;
        if (id == null || current == null || !accepting || checkingRecordingStop || recordingStopRequested)
            return;
        checkingRecordingStop = true;
        try
        {
            using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                cancel.CancelAfter(TimeSpan.FromSeconds(2));
                var state = await CompanionApi.Post(origin, "poll",
                    new { name = current.Name, info = DeviceInfo.WithDesktopState(info), watchRecordingId = id }, current.Token, cancel.Token);
                object requested;
                if (watchedRecordingId == id && paired == current && accepting &&
                    state != null && state.TryGetValue("stopRequested", out requested) && Equals(requested, true))
                {
                    recordingStopRequested = true;
                    SetApproval(false);
                    if (captureDialog != null) captureDialog.Close();
                    if (remoteRecording != null) FinishRecording();
                }
            }
        }
        catch (ApiFailure ex)
        {
            if (watchedRecordingId == id && paired == current &&
                (ex.Status == HttpStatusCode.Unauthorized || ex.Status == HttpStatusCode.Forbidden))
                ClearPairing("服务器已撤销配对");
        }
        catch (OperationCanceledException) { }
        catch (HttpRequestException) { }
        catch (InvalidOperationException) { }
        catch (ArgumentException) { }
        finally { checkingRecordingStop = false; }
    }

    private async Task Poll()
    {
        var current = paired;
        var target = origin;
        if (!accepting || editing || working || pickingLocalCapture || current == null) return;
        working = true;
        int started = acceptanceVersion;
        try
        {
            if (info.Count == 0) info = await Task.Run(() => DeviceInfo.Read(), lifetime.Token);
            else if (Interlocked.Exchange(ref networkInfoChanged, 0) == 1)
            {
                var previous = info;
                info = await Task.Run(() => DeviceInfo.WithCurrentNetworks(previous), lifetime.Token);
            }
            if (!accepting || paired != current || started != acceptanceVersion) return;
            var response = await CompanionApi.Post(target, "poll", new { name = current.Name, info = DeviceInfo.WithDesktopState(info) }, current.Token, lifetime.Token);
            if (paired != current) return;

            ApplyServerName(current, Json.String(response, "name"));
            if (accepting) lastStatus = "在线 · 等待操作请求";
            var job = Json.Map(response, "job");
            if (job != null)
            {
                if (Json.String(job, "action") == "record-screen")
                {
                    watchedRecordingId = Json.String(job, "id");
                    recordingStopRequested = false;
                    recordingStopTimer.Start();
                }
                try
                {
                    var outcome = await RunJob(job, started);
                    if (paired == current && !quitting)
                        await SendOutcome(target, current.Token, outcome, started);
                }
                finally
                {
                    recordingStopTimer.Stop();
                    watchedRecordingId = null;
                    recordingStopRequested = false;
                }
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

    private async Task SendOutcome(Uri target, string token, Dictionary<string, object> outcome, int started)
    {
        bool hasRecording = outcome.ContainsKey("recordingBase64");
        bool hasFile = outcome.ContainsKey("file");
        if (!hasRecording && !hasFile && !outcome.ContainsKey("imageBase64"))
        {
            await CompanionApi.Post(target, "result", outcome, token, lifetime.Token);
            return;
        }
        if (started != acceptanceVersion)
        {
            outcome.Remove("imageBase64");
            outcome.Remove("recordingBase64");
            outcome.Remove("file");
            outcome.Remove("captureScope");
            outcome["status"] = "failed";
            outcome["message"] = hasRecording ? "本机已暂停，录像保存在本机。" : "本机已暂停，结果未上传。";
            await CompanionApi.Post(target, "result", outcome, token, lifetime.Token);
            return;
        }
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try
            {
                if (hasFile) outcome["message"] = "文件已发送至原会话，服务已确认 SHA-256。";
                await CompanionApi.Post(target, "result", outcome, token, cancel.Token);
                if (hasFile) activityText = (string)outcome["message"];
            }
            finally { inProgress = null; }
        }
    }

    private async Task<Dictionary<string, object>> RunJob(Dictionary<string, object> job, int started)
    {
        string action = Json.String(job, "action");
        var arguments = Json.Map(job, "params");
        var outcome = new Dictionary<string, object> { { "id", Json.String(job, "id") }, { "status", "failed" } };
        string label;
        switch (action)
        {
            case "screenshot": label = "选择目标截图并发回原会话"; break;
            case "record-screen": label = "选择目标录制并发回原会话"; break;
            case "open-t3": label = "打开 T3Code-LM"; break;
            case "open-notepad": label = "打开记事本"; break;
            case "close-window": label = "关闭受控端打开的窗口"; break;
            case "send-file": label = "选择一个本机文件并发送至原会话"; break;
            case "receive-file": label = "保存会话文件 «" + Json.String(arguments, "fileName") + "»"; break;
            case "write-notepad": label = "替换本受控端打开的记事本中的文字"; break;
            case "read-notepad": label = "读取本受控端打开的记事本文字并发回会话"; break;
            default:
                outcome["message"] = "受控端不支持此操作。";
                return outcome;
        }
        try
        {
            if (!accepting || started != acceptanceVersion) throw new InvalidOperationException("Windows 已暂停接收请求。");
            WindowsDesktop.RequireDesktop();
            if (action == "record-screen" && recording != null)
                throw new InvalidOperationException("本机正在录制，无法开始另一段录制。");
            var requestAge = Stopwatch.StartNew();
            if (action == "write-notepad")
            {
                var text = Json.String(arguments, "text");
                if (text == null || text.Length > 512)
                    throw new InvalidDataException("写入的记事本文字无效。");
                label += "（将显示待写入文字）";
            }
            activityText = "请求 · " + label;
            approval = new TaskCompletionSource<bool>();
            Reveal();
            tray.ShowBalloonTip(4000, Title, activityText, ToolTipIcon.Info);
            UpdateView();
            Task finished = await Task.WhenAny(approval.Task, Task.Delay(TimeSpan.FromSeconds(45), lifetime.Token));
            bool allowed = finished == approval.Task && await approval.Task;
            approval = null;
            UpdateView();
            if (action == "record-screen" && recordingStopRequested)
                throw new InvalidOperationException("原会话已停止录屏请求，录制尚未开始。");
            if (!allowed || !accepting || started != acceptanceVersion)
                throw new InvalidOperationException("Windows 用户拒绝了请求，或请求等待超时。");
            if (action == "write-notepad" &&
                MessageBox.Show(this, "替换记事本内容为以下文字？" + Environment.NewLine + Environment.NewLine +
                    Json.String(arguments, "text"), "确认写入记事本", MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
                throw new InvalidOperationException("Windows 用户取消了填写。");
            if (!accepting || started != acceptanceVersion || requestAge.Elapsed.TotalSeconds >= 50)
                throw new InvalidOperationException("接收已暂停或请求已过期。");
            activityText = "正在执行 · " + label;
            UpdateView();
            if (action == "screenshot")
            {
                var choice = ChooseCapture(Json.String(arguments, "captureKind"), false, true, 1, 1);
                CheckCaptureApproval(choice, started, requestAge, false);
                using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    inProgress = cancel;
                    try
                    {
                        using (var frame = await choice.Target.CaptureAsync(cancel.Token))
                        {
                            string image = await Task.Run(() => CaptureTarget.EncodePng(frame), cancel.Token);
                            cancel.Token.ThrowIfCancellationRequested();
                            WindowsDesktop.RequireDesktop();
                            outcome["imageBase64"] = image;
                            outcome["captureScope"] = choice.Target.Scope;
                            outcome["message"] = "所选目标的截图已生成。";
                        }
                    }
                    finally { inProgress = null; }
                }
            }
            else if (action == "record-screen")
            {
                int requested = ReadRecordingDuration(Json.String(arguments, "durationSeconds"));
                var choice = ChooseCapture(Json.String(arguments, "captureKind"), true, true, requested, requested);
                CheckCaptureApproval(choice, started, requestAge, true);
                outcome["recordingBase64"] = await RecordForThread(choice, started, requestAge);
                outcome["captureScope"] = choice.Target.Scope;
                outcome["message"] = recordingStopRequested
                    ? "已按原会话请求结束录制，副本保存在本机。"
                    : "所选目标的录像已生成，副本保存在本机。";
            }
            else if (action == "send-file" || action == "receive-file")
            {
                using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    inProgress = cancel;
                    try
                    {
                        if (action == "send-file")
                        {
                            outcome["file"] = await CompanionFiles.ChooseUpload(this, cancel.Token);
                            outcome["message"] = "文件已选择，正在发送。";
                        }
                        else
                        {
                            var saved = await CompanionFiles.SaveDownload(this, origin, paired.Token,
                                Json.String(job, "id"), Json.String(arguments, "fileName"), cancel.Token);
                            outcome["savedFile"] = saved;
                            outcome["message"] = "已保存文件并核对 SHA-256。";
                        }
                    }
                    finally { inProgress = null; }
                }
            }
            else if (action == "write-notepad" || action == "read-notepad")
            {
                outcome["message"] = desktop.NotepadText(
                    action == "write-notepad" ? Json.String(arguments, "text") : null);
            }
            else outcome["message"] = action == "close-window" ? desktop.Close() : desktop.Open(action);
            outcome["status"] = "done";
        }
        catch (Exception ex) { outcome["message"] = FriendlyError(ex); }
        activityText = label + " · " + outcome["message"];
        UpdateView();
        return outcome;
    }

    private static int ReadRecordingDuration(string value)
    {
        int seconds;
        if (value == null) return RemoteRecordingSeconds;
        if (!Int32.TryParse(value, out seconds) || seconds < 1 || seconds > RemoteRecordingMaximum)
            throw new InvalidDataException("录制时长应为 1 到 30 秒的整数。");
        return seconds;
    }

    private CaptureChoice ChooseCapture(string kind, bool record, bool send, int seconds, int maximum)
    {
        if (kind != null && kind != "window" && kind != "display")
            throw new InvalidDataException("拍摄目标类型无效。");
        return CaptureChoice.Ask(this, kind, record, send, seconds, maximum,
            dialog => captureDialog = dialog);
    }

    private void CheckCaptureApproval(CaptureChoice choice, int started, Stopwatch requestAge, bool record)
    {
        if (record && recordingStopRequested)
            throw new InvalidOperationException("原会话已停止录屏请求，录制尚未开始。");
        if (choice == null || !accepting || started != acceptanceVersion || requestAge.Elapsed.TotalSeconds >= 50)
            throw new InvalidOperationException("已取消选择、暂停接收或请求已过期。");
        WindowsDesktop.RequireDesktop();
    }

    private async Task<string> RecordForThread(CaptureChoice choice, int started, Stopwatch requestAge)
    {
        if (recording != null) throw new InvalidOperationException("本机已经在录制。");
        string file = ChooseRecordingPath();
        CheckCaptureApproval(file == null ? null : choice, started, requestAge, true);
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        StartRecording(choice, file, finished);

        bool saved = await finished.Task;
        if (!saved || !accepting || started != acceptanceVersion)
            throw new InvalidOperationException("录屏已结束。已写入的内容保存在本机，未上传。");
        WindowsDesktop.RequireDesktop();
        return await Task.Run(() =>
        {
            using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new BinaryReader(input))
            {
                if (input.Length == 0 || input.Length > RemoteRecordingMaxBytes)
                    throw new InvalidOperationException("录像文件大小已变化。文件保存在本机，未上传。");
                return Convert.ToBase64String(reader.ReadBytes((int)input.Length));
            }
        }, lifetime.Token);
    }

    private void SetApproval(bool allowed)
    {
        if (approval != null) approval.TrySetResult(allowed);
    }

    private static string FriendlyError(Exception ex)
    {
        if (ex is OperationCanceledException) return "操作已取消或连接超时。";
        if (ex is HttpRequestException) return "无法建立连接。请核对服务地址和证书。";
        if (ex is IOException || ex is UnauthorizedAccessException) return "无法读取或写入本机文件，请检查路径和访问权限。";
        if (ex is ArgumentException || ex is ApiFailure || ex is InvalidOperationException)
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

    private async Task TakeLocalScreenshot()
    {
        if (working || pickingLocalCapture || recording != null) return;
        pickingLocalCapture = true;
        UpdateView();
        try
        {
            var choice = ChooseCapture(null, false, false, 1, 1);
            if (choice == null) return;
            using (var dialog = new SaveFileDialog
            {
                Title = "保存截图",
                Filter = "PNG 图像 (*.png)|*.png",
                FileName = "T3Code-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png",
                AddExtension = true,
                RestoreDirectory = true
            })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    inProgress = cancel;
                    try
                    {
                        using (var frame = await choice.Target.CaptureAsync(cancel.Token))
                        {
                            string image = await Task.Run(() => CaptureTarget.EncodePng(frame), cancel.Token);
                            cancel.Token.ThrowIfCancellationRequested();
                            WindowsDesktop.RequireDesktop();
                            byte[] bytes = Convert.FromBase64String(image);
                            using (var file = new FileStream(dialog.FileName, FileMode.CreateNew, FileAccess.Write))
                                file.Write(bytes, 0, bytes.Length);
                        }
                    }
                    finally { inProgress = null; }
                }
                recordingStatus.Text = "截图已保存 · " + Path.GetFileName(dialog.FileName);
            }
        }
        catch (Exception ex) { recordingStatus.Text = "截图失败 · " + FriendlyError(ex); }
        finally { pickingLocalCapture = false; UpdateView(); }
    }

    private string ChooseRecordingPath()
    {
        using (var dialog = new SaveFileDialog
        {
            Title = "保存录像",
            Filter = "AVI 视频 (*.avi)|*.avi",
            FileName = "T3Code-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".avi",
            AddExtension = true,
            RestoreDirectory = true
        })
        {
            return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
        }
    }

    private void ToggleRecording()
    {
        if (recording != null) { FinishRecording(); return; }
        if (working || pickingLocalCapture) return;
        pickingLocalCapture = true;
        UpdateView();
        try
        {
            var choice = ChooseCapture(null, true, false, 30, 600);
            if (choice == null) return;
            string file = ChooseRecordingPath();
            if (file == null) return;
            StartRecording(choice, file, null);
        }
        catch (Exception ex)
        {
            recordingStatus.Text = "录制启动失败 · " + FriendlyError(ex);
        }
        finally { pickingLocalCapture = false; UpdateView(); }
    }

    private void StartRecording(CaptureChoice choice, string file, TaskCompletionSource<bool> remote)
    {
        choice.Target.Verify();
        recording = remote == null
            ? new ScreenRecording(file, choice.Target.Size)
            : new ScreenRecording(file, choice.Target.Size, 640, RemoteRecordingMaxBytes);
        recordingPath = file;
        recordingChoice = choice;
        remoteRecording = remote;
        recordingElapsed = Stopwatch.StartNew();
        frameCancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        string description = choice.Target.Name;
        if (description.Length > 75) description = description.Substring(0, 74) + "…";
        recordingStatus.Text = "正在录制 · " + description + " · 最多 " + choice.Seconds + " 秒 · " +
            (remote == null ? "保存在此电脑" : "录像将发回原会话");
        Reveal();
        UpdateView();
        recordTimer.Start();
    }

    private async Task RecordFrame()
    {
        var current = recording;
        if (current == null) return;
        if (recordingElapsed.Elapsed.TotalSeconds >= recordingChoice.Seconds ||
            current.Count >= ScreenRecording.FrameLimit)
        {
            FinishRecording();
            return;
        }
        if (framePending) return;
        framePending = true;
        var token = frameCancel.Token;
        try
        {
            using (var frame = await recordingChoice.Target.CaptureAsync(token))
            {
                if (recording == current && recordingElapsed.Elapsed.TotalSeconds < recordingChoice.Seconds)
                    current.AddFrame(frame);
            }
        }
        catch (Exception ex)
        {
            if (recording == current) FinishRecording(FriendlyError(ex));
        }
        finally { framePending = false; }
    }

    private void FinishRecording(string reason = null)
    {
        if (recording == null) return;
        recordTimer.Stop();
        frameCancel.Cancel();
        frameCancel.Dispose();
        var remote = remoteRecording;
        bool hasFrames = recording.Count > 0;
        bool saved = false;
        try
        {
            recording.Dispose();
            saved = hasFrames && reason == null;
            recordingStatus.Text = hasFrames
                ? "录制已保存 · " + Path.GetFileName(recordingPath)
                : "没有收到可保存的录像帧。";
            if (!hasFrames) File.Delete(recordingPath);
            if (reason != null) recordingStatus.Text += " · " + reason;
        }
        catch (Exception ex) { recordingStatus.Text = "录制保存失败 · " + FriendlyError(ex); }
        finally
        {
            recording = null;
            remoteRecording = null;
            recordingElapsed = null;
            recordingChoice = null;
            frameCancel = null;
            if (remote != null) remote.TrySetResult(saved);
            UpdateView();
        }
    }

    private void SessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        bool locked = e.Reason == SessionSwitchReason.SessionLock ||
            e.Reason == SessionSwitchReason.RemoteDisconnect || e.Reason == SessionSwitchReason.ConsoleDisconnect;
        if (!locked && e.Reason != SessionSwitchReason.SessionUnlock &&
            e.Reason != SessionSwitchReason.RemoteConnect && e.Reason != SessionSwitchReason.ConsoleConnect) return;
        if (!IsHandleCreated || quitting) return;
        BeginInvoke(new Action(async delegate
        {
            if (locked)
            {
                StopAccepting("Windows 已锁定或断开，接收已暂停");
                FinishRecording();
            }
            var current = paired;
            var target = origin;
            if (current == null || quitting) return;
            try
            {
                // check 刷新桌面状态，锁屏时不会调用领取任务的 poll。
                var available = DeviceInfo.WithDesktopState(info);
                if (locked) available["desktopState"] = "locked";
                await CompanionApi.Post(target, "check", new { info = available }, current.Token, lifetime.Token);
            }
            catch (OperationCanceledException) { }
            catch (HttpRequestException) { }
            catch (ApiFailure) { }
        }));
    }

    private void ClosingWindow(object sender, FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            if (approval != null) SetApproval(false);
            if (pickingLocalCapture && inProgress != null) inProgress.Cancel();
            FinishRecording();
            Hide();
            return;
        }
        quitting = true;
        StopAccepting("受控端已退出");
        FinishRecording();
        lifetime.Cancel();
        SystemEvents.SessionSwitch -= SessionSwitch;
        NetworkChange.NetworkAddressChanged -= NetworkAddressChanged;
        tray.Visible = false;
        var menu = tray.ContextMenuStrip;
        tray.Dispose();
        menu.Dispose();
        pollTimer.Dispose();
        recordTimer.Dispose();
        recordingStopTimer.Dispose();
        desktop.Dispose();
        lifetime.Dispose();
    }
}
