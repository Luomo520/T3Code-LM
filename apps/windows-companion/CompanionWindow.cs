using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
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
    private readonly Button installButton = ButtonFor("打开安装器");
    private readonly Button scriptsButton = ButtonFor("本机脚本…");
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem pauseMenu;
    private readonly ToolStripMenuItem inputPauseMenu;
    private readonly ToolStripMenuItem currentJobMenu;
    private readonly ToolStripMenuItem recordMenu;
    private readonly Timer pollTimer = new Timer { Interval = 3000 };
    private readonly Timer recordTimer = new Timer { Interval = ScreenRecording.Interval };
    private readonly Timer recordingStopTimer = new Timer { Interval = 500 };
    private readonly WindowsDesktop desktop = new WindowsDesktop();
    private Dictionary<string, string> info;
    private bool editingName;
    private bool serverNameNeedsSave;
    private int networkInfoChanged;
    private bool refreshInfoOnNextPoll, refreshInfoAfterReconnect;
    private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
    private TaskCompletionSource<bool> approval;
    private Pairing paired;
    private Uri origin;
    private bool accepting, working, editing, quitting;
    private int acceptanceVersion;
    private bool remoteInputPaused, desktopRequestActive;
    private int remoteInputVersion;
    private string currentJob;
    private InstallerOffer installerOffer;
    private bool installerBusy;
    private readonly Queue<object> installerReports = new Queue<object>();

    private sealed class InstallerOffer
    {
        internal string Id, ThreadId, FileName, Path, Sha256;
        internal int Attempt;
    }
    private CancellationTokenSource inProgress;
    private string lastStatus = "等待配对";
    private string activityText = "当前没有操作请求。";
    private ScreenRecording recording;
    private string recordingPath;
    private const int RemoteRecordingSeconds = 10;
    private TaskCompletionSource<bool> remoteRecording;
    private Action<FileStream> saveRecordingReceipt;
    private DateTime? firstRecordedAt;
    private Stopwatch recordingElapsed;
    private CaptureChoice recordingChoice;
    private CancellationTokenSource frameCancel;
    private bool framePending;
    private Form captureDialog;
    private Form desktopChoiceDialog;
    private bool pickingLocalCapture;
    private const int RemoteRecordingMaximum = 30;
    private static readonly TimeSpan CloseWait = TimeSpan.FromSeconds(45);
    private const string CloseWaitingMessage = "已请求正常关闭，正在等待应用退出。如有保存提示，请在 Windows 上处理。";
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
        inputPauseMenu = (ToolStripMenuItem)menu.Items.Add("暂停远程输入", null, delegate { ToggleRemoteInput(); });
        recordMenu = (ToolStripMenuItem)menu.Items.Add("停止录制", null, delegate { FinishRecording(); });
        currentJobMenu = (ToolStripMenuItem)menu.Items.Add("");
        currentJobMenu.Enabled = false;
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
        installButton.Click += async delegate { await InstallReceivedPackage(); };
        scriptsButton.Click += delegate { ManageApprovedScripts(); };
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
        AddAcross(content, Commands(allowButton, refuseButton, installButton), 13);
        AddAcross(content, recordingStatus, 3);
        AddAcross(content, Commands(screenshotButton, recordButton, pickButton), 0);
        AddAcross(content, Commands(scriptsButton), 0);
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
        status.Text = lastStatus + (accepting && remoteInputPaused ? " · 远程输入已暂停" : "");
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
        inputPauseMenu.Enabled = isPaired && accepting && !editing;
        inputPauseMenu.Text = remoteInputPaused ? "恢复远程输入" : "暂停远程输入";
        currentJobMenu.Visible = currentJob != null;
        currentJobMenu.Text = currentJob ?? "";
        allowButton.Enabled = refuseButton.Enabled = approval != null && accepting;
        allowButton.Visible = refuseButton.Visible = approval != null;
        installButton.Visible = installerOffer != null;
        installButton.Enabled = installerOffer != null && accepting && !working &&
            !editing && !installerBusy && installerReports.Count == 0 && !PendingInstallation.Exists && recording == null;
        screenshotButton.Enabled = recording == null && !working && !pickingLocalCapture;
        scriptsButton.Enabled = recording == null && !working && !editing && !installerBusy && !pickingLocalCapture;
        recordButton.Enabled = recording != null || (!working && !pickingLocalCapture);
        recordButton.Text = recording == null ? "开始录制" : "停止录制";
        recordMenu.Enabled = recording != null;
        tray.Icon = recording != null ? SystemIcons.Warning : SystemIcons.Application;
        tray.Text = recording != null ? "T3Code-LM 正在录制" :
            Title + (accepting ? (remoteInputPaused ? " · 远程输入已暂停" : " · 接收请求") : " · 已暂停");
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
            var response = await CompanionApi.Post(server, "enroll", new { code = enteredCode, name = enteredName, info = DeviceInfo.WithDesktopState(info, false) },
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
            serverNameNeedsSave = false;
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
        installerOffer = null;
        installerReports.Clear();
        editingName = false;
        try { PendingRecording.Clear(); }
        catch (IOException) { lastStatus += " · 本地录像回执清理失败"; }
        catch (UnauthorizedAccessException) { lastStatus += " · 本地录像回执清理失败"; }
        try { PendingInstallation.Clear(); }
        catch (IOException) { lastStatus += " · 本地安装回执清理失败"; }
        catch (UnauthorizedAccessException) { lastStatus += " · 本地安装回执清理失败"; }
        try { Pairing.Clear(); }
        catch (IOException) { lastStatus += " · 本地配对记录删除失败"; }
        catch (UnauthorizedAccessException) { lastStatus += " · 本地配对记录删除失败"; }
    }

    private async void TogglePause()
    {
        if (paired == null || editing) return;
        if (accepting)
        {
            StopAccepting("接收已暂停");
            await ReportDesktopState(false);
        }
        else
        {
            accepting = true;
            refreshInfoOnNextPoll = true;
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
        if (desktopChoiceDialog != null) desktopChoiceDialog.Close();
        if (inProgress != null) inProgress.Cancel();
        if (remoteRecording != null) FinishRecording("接收已暂停，录像仅保存在本机。");
        lastStatus = text;
        UpdateView();
    }

    private async void ToggleRemoteInput()
    {
        if (paired == null || !accepting || editing) return;
        remoteInputPaused = !remoteInputPaused;
        remoteInputVersion++;
        if (remoteInputPaused && desktopRequestActive)
        {
            SetApproval(false);
            if (desktopChoiceDialog != null) desktopChoiceDialog.Close();
            if (inProgress != null) inProgress.Cancel();
        }
        UpdateView();
        await ReportDesktopState(false);
    }

    private bool ApplyServerName(Pairing current, string serverName)
    {
        if (!String.IsNullOrWhiteSpace(serverName) && serverName != current.Name)
        {
            current.Name = serverName;
            if (!editingName) name.Text = serverName;
            serverNameNeedsSave = true;
        }
        if (!serverNameNeedsSave) return true;
        try
        {
            current.Save();
            serverNameNeedsSave = false;
            return true;
        }
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
            var payload = new Dictionary<string, object> { { "info", DeviceInfo.WithDesktopState(info, accepting, remoteInputPaused) } };
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
                var state = await ReadJobState(id, current, cancel.Token);
                object requested;
                if (watchedRecordingId == id && paired == current && accepting &&
                    state != null && ((state.TryGetValue("stopRequested", out requested) && Equals(requested, true)) ||
                    (state.TryGetValue("jobActive", out requested) && Equals(requested, false))))
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

    private Task<Dictionary<string, object>> ReadJobState(string id, Pairing current, CancellationToken cancel)
    {
        // 同时传入旧版字段，让旧服务端也只查询状态，不会误领队列里的下一项。
        return CompanionApi.Post(origin, "poll",
            new { name = current.Name, info = DeviceInfo.WithDesktopState(info, accepting, remoteInputPaused), watchTaskId = id, watchRecordingId = id },
            current.Token, cancel);
    }

    private async Task CheckJobBeforeAction(string id, int started, Stopwatch requestAge)
    {
        var current = paired;
        if (current == null || !accepting || started != acceptanceVersion)
            throw new InvalidOperationException("Windows 已暂停接收请求。");
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            cancel.CancelAfter(TimeSpan.FromSeconds(3));
            var state = await ReadJobState(id, current, cancel.Token);
            object value;
            bool valid = state != null && (state.TryGetValue("jobActive", out value) ? Equals(value, true) :
                state.TryGetValue("stopRequested", out value) && value is bool);
            if (paired != current || !accepting || started != acceptanceVersion || requestAge.Elapsed.TotalSeconds >= 50 ||
                !valid)
                throw new InvalidOperationException("服务端无法确认此请求仍有效。请检查连接后重新请求。");
            if ((watchedRecordingId == id && recordingStopRequested) ||
                (state.TryGetValue("stopRequested", out value) && Equals(value, true)))
                throw new InvalidOperationException("原会话已停止录屏请求，录制尚未开始。");
            WindowsDesktop.RequireDesktop();
        }
    }

    private async Task Poll()
    {
        var current = paired;
        var target = origin;
        if (!accepting || editing || working || pickingLocalCapture || current == null) return;
        working = true;
        int started = acceptanceVersion;
        bool polled = false;
        try
        {
            bool networksChanged = Interlocked.Exchange(ref networkInfoChanged, 0) == 1;
            if (info.Count == 0 || refreshInfoOnNextPoll)
            {
                refreshInfoOnNextPoll = false;
                info = await Task.Run(() => DeviceInfo.Read(), lifetime.Token);
            }
            else if (networksChanged)
            {
                var previous = info;
                info = await Task.Run(() => DeviceInfo.WithCurrentNetworks(previous), lifetime.Token);
            }
            if (!accepting || paired != current || started != acceptanceVersion) return;
            await SendPendingRecording(target, current, started);
            if (!accepting || paired != current || started != acceptanceVersion) return;
            while (installerReports.Count > 0)
            {
                try { await CompanionApi.Post(target, "result", installerReports.Peek(), current.Token, lifetime.Token); }
                catch (ApiFailure ex)
                {
                    if (!IsTerminalInstallationReply(ex)) throw;
                    activityText = "服务端无法接收这次安装回执，原文件保存在本机。";
                }
                if (paired != current) return;
                installerReports.Dequeue();
                if (!accepting || started != acceptanceVersion) return;
            }
            if (installerBusy) return;
            await SendPendingInstallation(target, current);
            if (!accepting || paired != current || started != acceptanceVersion) return;
            var response = await CompanionApi.Post(target, "poll", new { name = current.Name, info = DeviceInfo.WithDesktopState(info, accepting, remoteInputPaused), recordingReceiptV1 = true }, current.Token, lifetime.Token);
            polled = true;
            if (paired != current) return;
            if (refreshInfoAfterReconnect)
            {
                // 先恢复连接，再在下一次轮询刷新完整资料，避免断网时反复读取 WMI。
                refreshInfoAfterReconnect = false;
                refreshInfoOnNextPoll = true;
            }
            if (!accepting && started != acceptanceVersion) await ReportDesktopState(false);

            ApplyServerName(current, Json.String(response, "name"));
            if (accepting) lastStatus = "在线 · 等待操作请求";
            var job = Json.Map(response, "job");
            if (job != null)
            {
                string action = Json.String(job, "action");
                int startedInput = remoteInputVersion;
                desktopRequestActive = IsDesktopAction(action);
                if (action == "record-screen")
                {
                    watchedRecordingId = Json.String(job, "id");
                    recordingStopRequested = false;
                    recordingStopTimer.Start();
                }
                try
                {
                    var outcome = await RunJob(job, started, startedInput);
                    if (paired == current && !quitting)
                    {
                        if (outcome == null) await SendPendingRecording(target, current, started);
                        else
                        {
                            await SendOutcome(target, current.Token, outcome, action, started, startedInput);
                            RememberInstaller(job, outcome, current);
                        }
                    }
                }
                finally
                {
                    desktopRequestActive = false;
                    recordingStopTimer.Stop();
                    watchedRecordingId = null;
                    recordingStopRequested = false;
                    currentJob = null;
                }
            }
        }
        catch (ApiFailure ex)
        {
            if (!polled) refreshInfoAfterReconnect = true;
            if (paired == current && (ex.Status == HttpStatusCode.Unauthorized || ex.Status == HttpStatusCode.Forbidden))
                ClearPairing("服务器已撤销配对");
            else if (accepting) lastStatus = "连接失败 · " + FriendlyError(ex);
        }
        catch (Exception ex)
        {
            if (!polled) refreshInfoAfterReconnect = true;
            if (accepting) lastStatus = "连接失败 · " + FriendlyError(ex);
        }
        finally { working = false; UpdateView(); }
    }

    private void RememberInstaller(Dictionary<string, object> job, Dictionary<string, object> outcome, Pairing current)
    {
        object value;
        if (paired != current || !outcome.TryGetValue("savedFile", out value)) return;
        var saved = value as Dictionary<string, string>;
        string name = Json.String(Json.Map(job, "params"), "fileName");
        if (saved == null || !CompanionInstaller.IsPackage(saved["path"]) || !CompanionInstaller.IsPackage(name)) return;
        installerOffer = new InstallerOffer
        {
            Id = Json.String(job, "id"),
            ThreadId = Json.String(job, "threadId"),
            FileName = name,
            Path = saved["path"],
            Sha256 = saved["sha256"]
        };
    }

    private async Task InstallReceivedPackage()
    {
        var offer = installerOffer;
        var current = paired;
        int started = acceptanceVersion;
        if (offer == null || current == null || !accepting || working || editing || installerBusy ||
            installerReports.Count != 0 || PendingInstallation.Exists || recording != null) return;
        installerBusy = true;
        UpdateView();
        int attempt = ++offer.Attempt;
        PendingInstallation pending = null;
        try
        {
            WindowsDesktop.RequireDesktop();
            var prompt = "文件：" + offer.Path + Environment.NewLine +
                "SHA-256：" + offer.Sha256 + Environment.NewLine + Environment.NewLine +
                "会话来源：" + origin.AbsoluteUri + Environment.NewLine +
                "原会话：" + offer.ThreadId + Environment.NewLine +
                "原文件：" + offer.FileName + Environment.NewLine + Environment.NewLine +
                "打开 Windows 安装器？请在 Windows 界面确认后续操作。";
            if (MessageBox.Show(this, prompt, "打开安装器", MessageBoxButtons.YesNo,
                MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                ReportInstallation(offer, current, attempt, "canceled");
                return;
            }

            string result = await CompanionInstaller.Install(offer.Path, offer.Sha256,
                (stageId, product, version, package, previouslyDifferent) =>
            {
                if (paired != current || !accepting || started != acceptanceVersion || quitting)
                    throw new InvalidOperationException("连接已暂停或配对已变化。");
                WindowsDesktop.RequireDesktop();
                var record = new PendingInstallation
                {
                    Id = offer.Id, Attempt = attempt, Sha256 = offer.Sha256, StageId = stageId,
                    ProductCode = product, Version = version, PackageCode = package,
                    PreviouslyDifferent = previouslyDifferent, State = "prepared"
                };
                record.Save(current);
                pending = record;
            }, process =>
            {
                pending.MarkOpened(process);
                bool recorded = TrySaveInstallation(pending, current);
                ReportInstallation(offer, current, attempt, "opened");
                activityText = recorded ? "Windows 安装器已启动，请在本机继续。" :
                    "Windows 安装器已启动，但未能保存最新安装状态。";
                UpdateView();
            });
            activityText = result == "verified" ? "已核实安装版本 " + pending.Version :
                result == "canceled" ? "Windows 已取消安装，文件仍保存在本机。" : "尚未核实安装结果，文件仍保存在本机。";
            FinishInstallation(offer, current, attempt, pending, result);
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            activityText = ex.NativeErrorCode == 1223 ? "Windows 已取消安装，文件仍保存在本机。" : "Windows 无法启动安装器。";
            FinishInstallation(offer, current, attempt, pending, ex.NativeErrorCode == 1223 ? "canceled" : "unverified");
        }
        catch (Exception ex)
        {
            activityText = "尚未核实安装结果 · " + FriendlyError(ex);
            FinishInstallation(offer, current, attempt, pending, "unverified");
        }
        finally
        {
            installerBusy = false;
            UpdateView();
        }
        await Poll();
    }

    private void FinishInstallation(InstallerOffer offer, Pairing current, int attempt, PendingInstallation pending, string state)
    {
        if (pending == null)
        {
            ReportInstallation(offer, current, attempt, state);
            return;
        }
        pending.State = state;
        if (!TrySaveInstallation(pending, current) && paired == current && !quitting)
            activityText += " · 本机未能保存最新安装状态";
    }

    private bool TrySaveInstallation(PendingInstallation pending, Pairing current)
    {
        if (paired != current || quitting) return false;
        try { pending.Save(current); return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (CryptographicException) { return false; }
    }

    private void ReportInstallation(InstallerOffer offer, Pairing current, int attempt, string state)
    {
        if (paired != current || quitting) return;
        var result = new Dictionary<string, object> { { "attempt", attempt }, { "status", state } };
        installerReports.Enqueue(new
        {
            id = offer.Id,
            status = "done",
            message = "",
            windowsInstallation = new { sha256 = offer.Sha256, result }
        });
    }

    private static bool IsTerminalInstallationReply(ApiFailure error)
    {
        return error.Status == HttpStatusCode.BadRequest || error.Status == HttpStatusCode.NotFound ||
            error.Status == HttpStatusCode.Conflict;
    }

    private async Task SendPendingInstallation(Uri target, Pairing current)
    {
        PendingInstallation pending;
        try { pending = PendingInstallation.Load(current); }
        catch (CryptographicException)
        {
            PendingInstallation.Clear();
            activityText = "无法核对本机安装记录，原文件保存在本机。";
            return;
        }
        catch (InvalidDataException)
        {
            PendingInstallation.Clear();
            activityText = "无法核对本机安装记录，原文件保存在本机。";
            return;
        }
        if (pending == null) return;
        bool canClearStage;
        string state = pending.Recover(out canClearStage);
        if (state == null) return;
        if (pending.State != state)
        {
            // 进程已结束时可先删除暂存副本，避免保存回执后中断而留下副本。
            if (canClearStage) CompanionInstaller.ClearStage(pending.StageId);
            pending.State = state;
            pending.Save(current);
        }
        try { await CompanionApi.Post(target, "result", pending.Report(), current.Token, lifetime.Token); }
        catch (ApiFailure ex)
        {
            if (!IsTerminalInstallationReply(ex)) throw;
            if (paired == current) activityText = "服务端无法接收这次安装回执，原文件保存在本机。";
        }
        if (paired == current) PendingInstallation.Clear();
    }

    private async Task SendPendingRecording(Uri target, Pairing current, int started)
    {
        if (!accepting || paired != current || started != acceptanceVersion || !WindowsDesktop.DesktopAvailable()) return;
        PendingRecording pending;
        try { pending = PendingRecording.Load(current); }
        catch (CryptographicException)
        {
            PendingRecording.Clear();
            activityText = PendingRecording.LocalOnly;
            return;
        }
        catch (InvalidDataException)
        {
            PendingRecording.Clear();
            activityText = PendingRecording.LocalOnly;
            return;
        }
        if (pending == null) return;
        if (pending.Expired)
        {
            PendingRecording.Clear();
            activityText = "录像回传期限已过，录像文件仍保存在本机。";
            return;
        }

        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try
            {
                var state = await CompanionApi.Post(target, "poll",
                    new { name = current.Name, info = DeviceInfo.WithDesktopState(info, accepting, remoteInputPaused),
                        watchTaskId = pending.Id, watchRecordingId = pending.Id, recordingReceiptV1 = true },
                    current.Token, cancel.Token);
                if (paired != current) return;
                string receiptState = Json.String(state, "recordingReceiptState");
                object active;
                bool closed = receiptState == "closed" || receiptState == null &&
                    state.TryGetValue("jobActive", out active) && Equals(active, false);
                if (closed || receiptState == "reported")
                {
                    PendingRecording.Clear();
                    activityText = closed ? PendingRecording.LocalOnly : "已在原会话查到本次录屏回执。";
                    return;
                }
                string original;
                try { original = await Task.Run(() => pending.ReadOriginal(), cancel.Token); }
                catch (IOException) { original = null; }
                catch (UnauthorizedAccessException) { original = null; }
                cancel.Token.ThrowIfCancellationRequested();
                if (!accepting || paired != current || started != acceptanceVersion || !WindowsDesktop.DesktopAvailable()) return;
                if (original == null && !pending.Failed)
                {
                    pending.MarkChanged();
                    pending.Save(current);
                }
                await CompanionApi.Post(target, "result", pending.Outcome(original), current.Token, cancel.Token);
                if (paired != current) return;
                PendingRecording.Clear();
                activityText = pending.Failed ? pending.Message : "已将原录像回传至原会话。";
            }
            catch (ApiFailure ex)
            {
                if (ex.Status != HttpStatusCode.BadRequest && ex.Status != HttpStatusCode.Conflict && ex.Status != HttpStatusCode.RequestEntityTooLarge &&
                    ex.Status != HttpStatusCode.UnsupportedMediaType && (int)ex.Status != 422) throw;
                if (paired != current) return;
                PendingRecording.Clear();
                activityText = pending.Failed ? pending.Message : "该任务无法接收回执，录像文件仍保存在本机。";
            }
            finally { inProgress = null; }
        }
    }

    private async Task SendOutcome(Uri target, string token, Dictionary<string, object> outcome, string action,
        int started, int startedInput)
    {
        bool hasFile = outcome.ContainsKey("file");
        bool hasDesktopText = (action == "read-notepad" || action == "write-notepad" ||
            action == "inspect-window-controls") &&
            Json.String(outcome, "status") == "done";
        if (!hasFile && !outcome.ContainsKey("imageBase64") && !hasDesktopText)
        {
            await CompanionApi.Post(target, "result", outcome, token, lifetime.Token);
            return;
        }
        if (started != acceptanceVersion || (hasDesktopText &&
            (startedInput != remoteInputVersion || remoteInputPaused || !WindowsDesktop.DesktopAvailable())))
        {
            outcome.Remove("imageBase64");
            outcome.Remove("file");
            outcome.Remove("captureScope");
            outcome.Remove("capture");
            outcome["status"] = "failed";
            outcome["message"] = "本机已暂停，结果未上传。";
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

    private static bool IsDesktopAction(string action)
    {
        return action == "open-t3" || action == "open-notepad" || action == "close-window" ||
            action == "write-notepad" || action == "read-notepad" || IsLocalToolAction(action);
    }

    private static bool IsLocalToolAction(string action)
    {
        return action == "inspect-window-controls" || action == "run-approved-script" || action == "open-ssh-profile";
    }

    private async Task<Dictionary<string, object>> RunJob(Dictionary<string, object> job, int started, int startedInput)
    {
        string id = Json.String(job, "id");
        string action = Json.String(job, "action");
        bool remoteInput = IsDesktopAction(action);
        var arguments = Json.Map(job, "params");
        var outcome = new Dictionary<string, object> { { "id", id }, { "status", "failed" } };
        string label;
        switch (action)
        {
            case "screenshot": label = "选择目标截图并发回原会话"; break;
            case "record-screen": label = "选择目标录制并发回原会话"; break;
            case "open-t3": label = "打开或激活 T3Code-LM"; break;
            case "open-notepad": label = "打开或激活记事本"; break;
            case "close-window": label = "关闭受控端打开的窗口"; break;
            case "send-file": label = "选择一个本机文件并发送至原会话"; break;
            case "receive-file": label = "保存会话文件 «" + Json.String(arguments, "fileName") + "»"; break;
            case "write-notepad": label = "选择记事本窗口并替换编辑区文字"; break;
            case "read-notepad": label = "选择记事本窗口并将编辑区文字发回会话"; break;
            case "inspect-window-controls": label = "选择窗口并确认回传控件名称"; break;
            case "run-approved-script": label = "选择并运行已批准的本机脚本"; break;
            case "open-ssh-profile": label = "选择本机 SSH 配置并打开终端"; break;
            default:
                outcome["message"] = "受控端不支持此操作。";
                return outcome;
        }
        try
        {
            object rawArguments;
            if (IsLocalToolAction(action) && job.TryGetValue("params", out rawArguments) &&
                (arguments == null || arguments.Count != 0))
                throw new InvalidOperationException("此操作不接受来自会话的参数。");
            if (!accepting || started != acceptanceVersion) throw new InvalidOperationException("Windows 已暂停接收请求。");
            if (remoteInput && remoteInputPaused) throw new InvalidOperationException("本机已暂停远程输入。");
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
            currentJob = "会话 " + Json.String(job, "threadId") + " · " + label;
            approval = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            Reveal();
            tray.ShowBalloonTip(4000, Title, activityText, ToolTipIcon.Info);
            UpdateView();
            Task finished = await Task.WhenAny(approval.Task, Task.Delay(TimeSpan.FromSeconds(45), lifetime.Token));
            bool allowed = finished == approval.Task && await approval.Task;
            approval = null;
            UpdateView();
            if (action == "record-screen" && recordingStopRequested)
                throw new InvalidOperationException("原会话已停止录屏请求，录制尚未开始。");
            if (remoteInput && (remoteInputPaused || startedInput != remoteInputVersion))
                throw new InvalidOperationException("本机已接手，本次远程输入已取消。");
            if (!allowed || !accepting || started != acceptanceVersion)
                throw new InvalidOperationException("Windows 用户拒绝了请求，或请求等待超时。");
            if (!accepting || started != acceptanceVersion || requestAge.Elapsed.TotalSeconds >= 50)
                throw new InvalidOperationException("接收已暂停或请求已过期。");
            if (!remoteInput && action != "screenshot" && action != "record-screen")
                await CheckJobBeforeAction(id, started, requestAge);
            if (remoteInput && (remoteInputPaused || startedInput != remoteInputVersion))
                throw new InvalidOperationException("本机已接手，本次远程输入已取消。");
            activityText = "正在执行 · " + label;
            UpdateView();
            if (action == "screenshot")
            {
                var choice = ChooseCapture(Json.String(arguments, "captureKind"), false, true, 1, 1);
                CheckCaptureApproval(choice, started, requestAge, false);
                await CheckJobBeforeAction(id, started, requestAge);
                using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    inProgress = cancel;
                    try
                    {
                        DateTime capturedAt = default(DateTime);
                        using (var frame = await choice.Target.CaptureAsync(cancel.Token, time => capturedAt = time))
                        {
                            string image = await Task.Run(() => CaptureTarget.EncodePng(frame), cancel.Token);
                            cancel.Token.ThrowIfCancellationRequested();
                            WindowsDesktop.RequireDesktop();
                            outcome["imageBase64"] = image;
                            outcome["captureScope"] = choice.Target.Scope;
                            outcome["capture"] = CaptureMetadata(choice.Target, capturedAt);
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
                await RecordForThread(id, choice, started, requestAge);
                activityText = "录像已保存至本机，等待向原会话回报。";
                UpdateView();
                return null;
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
                                id, Json.String(arguments, "fileName"), cancel.Token);
                            outcome["savedFile"] = saved;
                            outcome["message"] = "已保存文件并核对 SHA-256。";
                        }
                    }
                    finally { inProgress = null; }
                }
            }
            else if (remoteInput)
            {
                Action verifyRequest = () =>
                {
                    if (remoteInputPaused || startedInput != remoteInputVersion)
                        throw new InvalidOperationException("本机已接手，本次远程输入已取消。");
                    if (!accepting || started != acceptanceVersion || requestAge.Elapsed.TotalSeconds >= 50)
                        throw new InvalidOperationException("接收已暂停或请求已过期。");
                };
                await RunDesktopAction(action, arguments, outcome, verifyRequest,
                    () => CheckJobBeforeAction(id, started, requestAge), requestAge);
            }
            outcome["status"] = "done";
        }
        catch (Exception ex)
        {
            var apiFailure = ex as ApiFailure;
            if (apiFailure != null && (apiFailure.Status == HttpStatusCode.Unauthorized ||
                apiFailure.Status == HttpStatusCode.Forbidden)) throw;
            outcome["message"] = FriendlyError(ex);
        }
        activityText = label + " · " + outcome["message"];
        UpdateView();
        return outcome;
    }

    private async Task RunDesktopAction(string action, Dictionary<string, object> arguments,
        Dictionary<string, object> outcome, Action verifyRequest, Func<Task> verifyJob, Stopwatch requestAge)
    {
        verifyRequest();
        if (IsLocalToolAction(action))
        {
            outcome["message"] = await RunLocalTool(action, verifyRequest, verifyJob, requestAge);
            return;
        }
        var close = action == "close-window";
        var launch = action == "open-t3" || action == "open-notepad";
        var notepad = action != "open-t3";
        var replacement = action == "write-notepad" ? Json.String(arguments, "text") : null;
        WindowsDesktop.Window selected = null;
        if (!close)
        {
            var windows = WindowsDesktop.ListWindows(notepad);
            if (windows.Count != 0 || !launch)
                selected = DesktopWindowChoice.Ask(this, windows,
                    launch ? (notepad ? "打开或激活记事本" : "打开或激活 T3Code-LM") : "选择记事本窗口",
                    launch ? "继续" : replacement == null ? "读取并发送" : "确认替换文字",
                    launch, replacement, requestAge, dialog => desktopChoiceDialog = dialog);
        }

        Process closingProcess = null;
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try
            {
                if (close)
                    closingProcess = await desktop.RequestClose(Handle, verifyRequest, verifyJob, cancel.Token);
                else if (launch)
                    outcome["message"] = await desktop.Open(notepad, selected, Handle, verifyRequest, verifyJob, cancel.Token);
                else
                    outcome["message"] = await desktop.NotepadText(selected, replacement, Handle, verifyRequest, verifyJob, cancel.Token);
            }
            finally { inProgress = null; }
        }
        if (closingProcess != null)
        {
            bool reportProgress = Json.String(arguments, "closeProgressV1") == "true";
            await WaitForWindowClose(closingProcess, (string)outcome["id"], reportProgress);
            outcome["message"] = "已确认本受控端打开的应用进程退出。";
            if (reportProgress) outcome["closeState"] = "exited";
        }
    }

    private async Task<string> RunLocalTool(string action, Action verifyRequest, Func<Task> verifyJob, Stopwatch requestAge)
    {
        Action<Form> setDialog = dialog => desktopChoiceDialog = dialog;
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try
            {
                if (action == "inspect-window-controls")
                {
                    var candidates = WindowsDesktop.ListInspectableWindows();
                    if (candidates.Count == 0)
                        throw new InvalidOperationException("未找到可检查的可见记事本、计算器或画图窗口。");
                    var window = DesktopActionChoice.Pick(this, candidates, "检查窗口控件",
                        "请选择本次查看的窗口。下一步可勾选允许回传的控件名称。", "查看控件",
                        requestAge, setDialog);
                    await WindowsDesktop.CheckBeforeWindowAction(window, Handle, verifyRequest, verifyJob, cancel.Token);
                    var items = await WindowControlSummary.Read(window, cancel.Token);
                    WindowsDesktop.VerifyBeforeWindowAction(window, Handle, verifyRequest, cancel.Token);
                    if (items.Count == 0) return "所选窗口没有可回传的控件名称。";
                    var approved = DesktopActionChoice.ShareControls(this, items, requestAge, setDialog);
                    await WindowsDesktop.CheckBeforeWindowAction(window, Handle, verifyRequest, verifyJob, cancel.Token);
                    if (approved.Count == 0) throw new InvalidOperationException("未勾选可回传的控件。");
                    return "已确认的控件：" + Environment.NewLine + String.Join(Environment.NewLine, approved);
                }

                if (action == "run-approved-script")
                {
                    var choices = new List<object>();
                    choices.AddRange(ApprovedScripts.Load());
                    choices.AddRange(ApprovedDiagnostics.Presets());
                    var choice = DesktopActionChoice.Pick(this, choices, "运行本机脚本",
                        "请选择一项已批准脚本或预设检查。脚本以当前用户权限运行，原会话只收到状态。",
                        "确认运行", requestAge, setDialog);
                    await WindowsDesktop.CheckBeforeWindowAction(null, Handle, verifyRequest, verifyJob, cancel.Token);
                    Action verifyStart = () => WindowsDesktop.VerifyBeforeWindowAction(null, Handle, verifyRequest, cancel.Token);
                    var script = choice as ApprovedScripts.Entry;
                    if (script != null) return await ApprovedScripts.Run(script, verifyStart, verifyRequest, cancel.Token);
                    return await ((ApprovedDiagnostics)choice).Run(verifyStart, verifyRequest, cancel.Token);
                }

                var profiles = LocalSshProfiles.Load();
                var aliases = profiles.Aliases;
                if (aliases.Count == 0) throw new InvalidOperationException("本机 .ssh 配置中没有可用的主机别名。");
                var alias = DesktopActionChoice.Pick(this, aliases, "打开 SSH 终端",
                    "选一个本机主机别名。随后在新终端中核对主机并登录。", "打开 SSH 终端", requestAge, setDialog);
                await WindowsDesktop.CheckBeforeWindowAction(null, Handle, verifyRequest, verifyJob, cancel.Token);
                var handle = Handle;
                profiles.Open(alias, () => WindowsDesktop.VerifyBeforeWindowAction(null, handle, verifyRequest, cancel.Token),
                    cancel.Token);
                return "已在 Windows 打开 SSH 终端，请在本机完成主机核对和登录。";
            }
            finally { inProgress = null; }
        }
    }

    private async Task WaitForWindowClose(Process process, string id, bool reportProgress)
    {
        var elapsed = Stopwatch.StartNew();
        var current = paired;
        var target = origin;
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            inProgress = cancel;
            try
            {
                activityText = CloseWaitingMessage;
                UpdateView();
                while (elapsed.Elapsed < CloseWait)
                {
                    cancel.Token.ThrowIfCancellationRequested();
                    if (process.HasExited) return;
                    if (reportProgress)
                    {
                        reportProgress = !await ReportCloseProgress(target, current.Token, id, cancel.Token);
                    }
                    await Task.Delay(500, cancel.Token);
                }
                cancel.Token.ThrowIfCancellationRequested();
                if (process.HasExited) return;
                throw new InvalidOperationException("等待应用退出超时，尚未确认退出。请在 Windows 上查看应用及其保存提示。");
            }
            catch (OperationCanceledException)
            {
                throw new InvalidOperationException("已停止等待，尚未确认应用退出。请在 Windows 上查看应用。");
            }
            finally { inProgress = null; }
        }
    }

    private static async Task<bool> ReportCloseProgress(Uri target, string token, string id, CancellationToken cancel)
    {
        using (var request = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            // 短暂断线时重试进度回报，关闭请求只发送一次。
            request.CancelAfter(TimeSpan.FromSeconds(3));
            try
            {
                await CompanionApi.Post(target, "result",
                    new { id, status = "running", closeState = "waiting-for-exit", message = CloseWaitingMessage },
                    token, request.Token);
                return true;
            }
            catch (ApiFailure ex)
            {
                if (ex.Status == HttpStatusCode.Conflict || ex.Status == HttpStatusCode.NotFound)
                    throw new InvalidOperationException("会话已停止等待，尚未确认应用退出。请在 Windows 上查看应用。");
                if ((int)ex.Status < 500) throw;
            }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) { cancel.ThrowIfCancellationRequested(); }
            return false;
        }
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

    private static object CaptureMetadata(CaptureTarget target, DateTime capturedAt)
    {
        return new
        {
            label = target.ResultLabel,
            capturedAt = capturedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
        };
    }

    private async Task RecordForThread(string id, CaptureChoice choice, int started, Stopwatch requestAge)
    {
        if (recording != null) throw new InvalidOperationException("本机已经在录制。");
        string file = ChooseRecordingPath();
        CheckCaptureApproval(file == null ? null : choice, started, requestAge, true);
        await CheckJobBeforeAction(id, started, requestAge);
        var current = paired;
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        StartRecording(choice, file, finished);
        saveRecordingReceipt = stream =>
        {
            if (paired != current || !accepting || started != acceptanceVersion || !WindowsDesktop.DesktopAvailable())
                throw new InvalidOperationException(PendingRecording.LocalOnly);
            string message = recordingStopRequested
                ? "已按原会话请求结束录制，副本保存在本机。"
                : "所选目标的录像已生成，副本保存在本机。";
            PendingRecording.Create(id, stream, choice.Target.Scope, choice.Target.ResultLabel, firstRecordedAt.Value, message)
                .Save(current);
        };

        if (!await finished.Task)
            throw new InvalidOperationException(PendingRecording.LocalOnly);
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

    private void ManageApprovedScripts()
    {
        if (working || editing || installerBusy || recording != null || pickingLocalCapture) return;
        editing = true;
        UpdateView();
        try
        {
            WindowsDesktop.RequireDesktop();
            ApprovedScriptManager.Show(this, FriendlyError);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, FriendlyError(ex), "无法打开本机脚本",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            editing = false;
            UpdateView();
        }
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
            : new ScreenRecording(file, choice.Target.Size, 640, PendingRecording.MaxBytes);
        recordingPath = file;
        recordingChoice = choice;
        remoteRecording = remote;
        firstRecordedAt = null;
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
            DateTime capturedAt = default(DateTime);
            using (var frame = await recordingChoice.Target.CaptureAsync(token, time => capturedAt = time))
            {
                if (recording == current && recordingElapsed.Elapsed.TotalSeconds < recordingChoice.Seconds)
                {
                    current.AddFrame(frame);
                    if (!firstRecordedAt.HasValue) firstRecordedAt = capturedAt;
                }
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
            saved = hasFrames && reason == null && firstRecordedAt.HasValue;
            recording.Finish(saved ? saveRecordingReceipt : null);
            recordingStatus.Text = hasFrames
                ? "录制已保存 · " + Path.GetFileName(recordingPath)
                : "没有收到可保存的录像帧。";
            if (!hasFrames) File.Delete(recordingPath);
            if (reason != null) recordingStatus.Text += " · " + reason;
        }
        catch (Exception ex)
        {
            saved = false;
            recordingStatus.Text = "录像未能回传 · " + FriendlyError(ex);
        }
        finally
        {
            recording = null;
            remoteRecording = null;
            recordingElapsed = null;
            recordingChoice = null;
            frameCancel = null;
            if (remote != null) remote.TrySetResult(saved);
            saveRecordingReceipt = null;
            firstRecordedAt = null;
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
            await ReportDesktopState(locked);
        }));
    }

    private async Task ReportDesktopState(bool locked)
    {
        var current = paired;
        var target = origin;
        if (current == null || quitting) return;
        try
        {
            // 暂停或锁屏时更新资料，无需轮询领取任务。
            if (info.Count == 0) info = await Task.Run(() => DeviceInfo.Read(), lifetime.Token);
            if (paired != current || quitting) return;
            var available = DeviceInfo.WithDesktopState(info, accepting, remoteInputPaused);
            if (locked) available["desktopState"] = "locked";
            await CompanionApi.Post(target, "check", new { info = available }, current.Token, lifetime.Token);
        }
        catch (OperationCanceledException) { }
        catch (HttpRequestException) { }
        catch (ApiFailure) { }
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
