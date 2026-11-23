using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// 本机 Windows-MCP 仅补充用户接管状态。窗口身份和内容由 WindowsDesktop 核验。
internal static class WindowsMcp
{
    private static readonly Uri LocalEndpoint = new Uri("http://127.0.0.1:8000/mcp");
    private const string Protocol = "2025-03-26";
    private static readonly HttpClient Client = new HttpClient(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        UseDefaultCredentials = false,
        UseProxy = false
    })
    {
        MaxResponseContentBufferSize = 16 * 1024
    };

    internal static Task RequireIdleAsync(Action verifyWindow, CancellationToken cancel)
    {
        return RequireIdleAsync(Client, verifyWindow, cancel);
    }

    internal static async Task RequireIdleAsync(HttpClient client, Action verifyWindow, CancellationToken cancel)
    {
        var elapsed = Stopwatch.StartNew();
        bool waitingForUser = false;
        do
        {
            cancel.ThrowIfCancellationRequested();
            verifyWindow();
            string state = await ReadControlStateAsync(client, cancel);
            cancel.ThrowIfCancellationRequested();
            verifyWindow();
            if (state == "ready") return;
            // 没有可用的控制状态时，继续依赖本机确认和窗口校验。已观察到接手则等待明确恢复。
            if (!waitingForUser && (state == null || state == "disabled" || state == "unavailable")) return;
            if (state != "user") break;
            waitingForUser = true;
            await Task.Delay(650, cancel);
        }
        while (elapsed.Elapsed < TimeSpan.FromSeconds(12));
        throw new InvalidOperationException("Windows-MCP 仍报告桌面被占用，请在本机结束接手后重试。");
    }

    internal static async Task<string> ReadControlStateAsync(HttpClient client, CancellationToken cancel)
    {
        string session = null;
        string state = null;
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                bool supported;
                using (var request = Post(new { jsonrpc = "2.0", id = 1, method = "initialize",
                    @params = new { protocolVersion = Protocol, capabilities = new Dictionary<string, object>(),
                        clientInfo = new { name = "t3code-lm-windows-companion", version = "1.0" } } }, null, false))
                using (var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false))
                {
                    IEnumerable<string> ids;
                    if (response.Headers.TryGetValues("Mcp-Session-Id", out ids)) session = ids.FirstOrDefault();
                    var initialized = await ReadResult(response, 1).ConfigureAwait(false);
                    supported = Json.String(initialized, "protocolVersion") == Protocol &&
                        Json.String(Json.Map(initialized, "serverInfo"), "name") == "windows-mcp";
                }

                if (supported)
                {
                    using (var request = Post(new { jsonrpc = "2.0", method = "notifications/initialized" }, session, true))
                    using (var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false))
                        response.EnsureSuccessStatusCode();

                    using (var request = Post(new { jsonrpc = "2.0", id = 2, method = "tools/call",
                        @params = new { name = "ControlStatus", arguments = new Dictionary<string, object>() } }, session, true))
                    using (var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false))
                    {
                        var result = await ReadResult(response, 2).ConfigureAwait(false);
                        object error;
                        if (result != null && (!result.TryGetValue("isError", out error) || Equals(error, false)))
                            state = Json.String(Json.Map(result, "structuredContent"), "state") ?? ReadTextState(result);
                    }
                }
            }
            catch (HttpRequestException) { }
            catch (InvalidOperationException) { }
            catch (ArgumentException) { }
            catch (OperationCanceledException) { }
        }
        if (!String.IsNullOrEmpty(session)) await CloseSession(client, session).ConfigureAwait(false);
        cancel.ThrowIfCancellationRequested();
        return state;
    }

    private static HttpRequestMessage Post(object payload, string session, bool initialized)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, LocalEndpoint);
        AddHeaders(request, session, initialized);
        request.Content = new StringContent(Json.Encode(payload), Encoding.UTF8, "application/json");
        return request;
    }

    private static void AddHeaders(HttpRequestMessage request, string session, bool initialized)
    {
        request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
        if (!String.IsNullOrEmpty(session)) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
        if (initialized) request.Headers.TryAddWithoutValidation("MCP-Protocol-Version", Protocol);
    }

    private static async Task CloseSession(HttpClient client, string session)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Delete, LocalEndpoint))
        using (var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(500)))
        {
            AddHeaders(request, session, true);
            try { using (await client.SendAsync(request, timeout.Token).ConfigureAwait(false)) { } }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) { }
        }
    }

    private static async Task<Dictionary<string, object>> ReadResult(HttpResponseMessage response, int id)
    {
        response.EnsureSuccessStatusCode();
        if (response.Content == null || response.Content.Headers.ContentType == null) return null;
        string type = response.Content.Headers.ContentType.MediaType;
        var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (type == "application/json") return MatchResult(body, id);
        if (type != "text/event-stream") return null;
        foreach (string entry in body.Replace("\r\n", "\n").Split(new[] { "\n\n" }, StringSplitOptions.None))
        {
            var data = entry.Split('\n').Where(line => line.StartsWith("data:", StringComparison.Ordinal))
                .Select(line => line.Substring(5).TrimStart());
            string payload = String.Join("\n", data);
            if (payload.Length == 0) continue;
            var result = MatchResult(payload, id);
            if (result != null) return result;
        }
        return null;
    }

    private static Dictionary<string, object> MatchResult(string text, int id)
    {
        var message = Json.Decode(text);
        object replyId;
        return Json.String(message, "jsonrpc") == "2.0" &&
            message.TryGetValue("id", out replyId) && Equals(replyId, id) && !message.ContainsKey("error")
            ? Json.Map(message, "result")
            : null;
    }

    private static string ReadTextState(Dictionary<string, object> result)
    {
        object content;
        if (!result.TryGetValue("content", out content)) return null;
        var blocks = content as System.Collections.IList;
        if (blocks == null || blocks.Count != 1) return null;
        var block = blocks[0] as Dictionary<string, object>;
        string text = Json.String(block, "text");
        return Json.String(block, "type") == "text" && text != null ? Json.String(Json.Decode(text), "state") : null;
    }
}
