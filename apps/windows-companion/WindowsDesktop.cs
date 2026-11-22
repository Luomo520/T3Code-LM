using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal sealed class WindowsDesktop : IDisposable
{
    private Process ownedWindow;
    private readonly string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

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

    internal string Open(string action)
    {
        RequireDesktop();
        if (ownedWindow != null && !ownedWindow.HasExited)
            throw new InvalidOperationException("先关闭此前由受控端打开的窗口。");
        string path;
        if (action == "open-notepad")
            path = Path.Combine(Environment.SystemDirectory, "notepad.exe");
        else
        {
            path = FindT3();
            if (path == null) throw new InvalidOperationException("请先安装 T3Code-LM 桌面应用。");
        }
        var next = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path) });
        if (next == null) throw new InvalidOperationException("Windows 未返回新进程。");
        Dispose();
        ownedWindow = next;
        return action == "open-notepad" ? "已请求打开记事本。" : "已请求打开 T3Code-LM。";
    }

    private string FindT3()
    {
        string[] roots = { Path.Combine(local, "Programs"), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) };
        string[] directories = { "t3code", "T3Code-LM", "T3 Code", "T3 Code (Beta)" };
        string[] names = { "T3 Code (Beta).exe", "T3Code-LM.exe", "T3 Code.exe" };
        foreach (string root in roots)
        foreach (string directory in directories)
        foreach (string name in names)
        {
            string path = Path.Combine(root, directory, name);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    internal string Close()
    {
        RequireDesktop();
        if (ownedWindow == null || ownedWindow.HasExited)
            throw new InvalidOperationException("没有本受控端创建且仍在运行的进程。");
        ownedWindow.Refresh();
        if (!ownedWindow.CloseMainWindow())
            throw new InvalidOperationException("找不到本受控端新启动的窗口。已运行的应用可能复用了现有进程。");
        return "已发送正常关闭请求。请在 Windows 上处理应用的保存提示。";
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
    }
}

internal static class WindowsMcp
{
    private static readonly Uri Endpoint = new Uri("http://127.0.0.1:8000/mcp");
    private static readonly HttpClient Client = new HttpClient(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false
    }) { Timeout = TimeSpan.FromSeconds(12), MaxResponseContentBufferSize = 12 * 1024 * 1024 };

    internal static async Task<string> Screenshot(CancellationToken cancel)
    {
        WindowsDesktop.RequireDesktop();
        const string protocol = "2025-03-26";
        var init = await Request(new { jsonrpc = "2.0", id = 1, method = "initialize", @params = new
        {
            protocolVersion = protocol, capabilities = new { },
            clientInfo = new { name = "T3Code-LM Companion", version = Program.Version }
        } }, null, null, cancel).ConfigureAwait(false);
        string session = init.Item2;
        string imageData = null;
        ExceptionDispatchInfo captureError = null;
        try
        {
            var initialization = Json.Map(init.Item1, "result");
            if (Json.String(initialization, "protocolVersion") != protocol)
                throw new InvalidDataException("Windows-MCP 协议版本不兼容。");
            await Request(new { jsonrpc = "2.0", method = "notifications/initialized" }, session, protocol, cancel).ConfigureAwait(false);

            var status = await Tool(2, "ControlStatus", new { }, session, protocol, cancel).ConfigureAwait(false);
            if (Json.String(Json.Map(status, "structuredContent"), "state") != "ready")
                throw new InvalidOperationException("Windows-MCP 当前由用户接管或正在使用。");
            WindowsDesktop.RequireDesktop();
            var screenshot = await Tool(3, "Screenshot", new { display = new[] { 0 }, use_annotation = false },
                session, protocol, cancel).ConfigureAwait(false);
            WindowsDesktop.RequireDesktop();
            foreach (object item in (IEnumerable)screenshot["content"])
            {
                var image = item as Dictionary<string, object>;
                if (Json.String(image, "type") == "image")
                {
                    imageData = Json.String(image, "data");
                    break;
                }
            }
        }
        catch (Exception error) { captureError = ExceptionDispatchInfo.Capture(error); }
        if (session != null) await CloseSession(session, protocol).ConfigureAwait(false);
        if (captureError != null) captureError.Throw();
        if (String.IsNullOrEmpty(imageData)) throw new InvalidDataException("Windows-MCP 未返回截图。");
        return PrepareImage(imageData);
    }

    private static async Task CloseSession(string session, string protocol)
    {
        try
        {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1)))
            using (var delete = new HttpRequestMessage(HttpMethod.Delete, Endpoint))
            {
                delete.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
                delete.Headers.TryAddWithoutValidation("Mcp-Protocol-Version", protocol);
                using (await Client.SendAsync(delete, timeout.Token).ConfigureAwait(false)) { }
            }
        }
        catch (HttpRequestException) { }
        catch (OperationCanceledException) { }
    }

    private static string PrepareImage(string data)
    {
        if (String.IsNullOrEmpty(data)) throw new InvalidDataException("Windows-MCP 截图为空。");
        using (var raw = new MemoryStream(Convert.FromBase64String(data)))
        using (var source = Image.FromStream(raw, false, true))
        {
            // 限制图像尺寸和编码大小，舍弃 Windows-MCP 返回的窗口树和文本。
            const int maxUpload = 5 * 1024 * 1024;
            double scale = Math.Min(1, 1440.0 / Math.Max(source.Width, source.Height));
            for (int attempt = 0; attempt < 3; attempt++, scale *= 0.75)
            {
                int width = Math.Max(1, (int)(source.Width * scale));
                int height = Math.Max(1, (int)(source.Height * scale));
                using (var image = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                using (var graphics = Graphics.FromImage(image))
                using (var output = new MemoryStream())
                {
                    graphics.DrawImage(source, 0, 0, width, height);
                    image.Save(output, ImageFormat.Png);
                    if (output.Length <= maxUpload) return Convert.ToBase64String(output.ToArray());
                }
            }
            throw new InvalidDataException("截图超出上传大小限制。");
        }
    }

    private static async Task<Dictionary<string, object>> Tool(int id, string name, object args,
        string session, string protocol, CancellationToken cancel)
    {
        var response = await Request(new { jsonrpc = "2.0", id, method = "tools/call", @params = new
        {
            name, arguments = args
        } }, session, protocol, cancel).ConfigureAwait(false);
        var result = Json.Map(response.Item1, "result");
        object failed;
        if (result == null || result.TryGetValue("isError", out failed) && Equals(failed, true))
            throw new InvalidOperationException("Windows-MCP 无法完成 " + name + "。");
        return result;
    }

    private static async Task<Tuple<Dictionary<string, object>, string>> Request(object payload, string session,
        string protocol, CancellationToken cancel)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Post, Endpoint))
        {
            request.Headers.Accept.ParseAdd("application/json, text/event-stream");
            if (session != null) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
            if (protocol != null) request.Headers.TryAddWithoutValidation("Mcp-Protocol-Version", protocol);
            request.Content = new StringContent(Json.Encode(payload), Encoding.UTF8, "application/json");
            using (var response = await Client.SendAsync(request, cancel).ConfigureAwait(false))
            {
                if (!response.IsSuccessStatusCode) throw new ApiFailure(response.StatusCode);
                IEnumerable<string> values;
                string nextSession = null;
                if (response.Headers.TryGetValues("Mcp-Session-Id", out values))
                    foreach (string value in values) { nextSession = value; break; }
                string body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (body.Length == 0) return Tuple.Create<Dictionary<string, object>, string>(null, nextSession);
                if (response.Content.Headers.ContentType != null &&
                    response.Content.Headers.ContentType.MediaType == "text/event-stream")
                {
                    // FastMCP 的同步请求在一个 data 事件中返回 JSON-RPC 响应。
                    using (var lines = new StringReader(body))
                    {
                        string line;
                        while ((line = lines.ReadLine()) != null)
                            if (line.StartsWith("data: ", StringComparison.Ordinal))
                                return Tuple.Create(Json.Decode(line.Substring(6)), nextSession);
                    }
                    throw new InvalidDataException("Windows-MCP 未返回事件数据。");
                }
                return Tuple.Create(Json.Decode(body), nextSession);
            }
        }
    }
}
