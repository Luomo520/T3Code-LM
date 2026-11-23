using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class WindowsMcpProbe
{
    private sealed class Fixture : HttpMessageHandler
    {
        private readonly Queue<string> states;
        internal readonly List<string> Requests = new List<string>();
        internal bool Offline;
        internal bool TextResult;
        internal bool UnexpectedId;

        internal Fixture(params string[] states)
        {
            this.states = new Queue<string>(states);
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            Check(request.RequestUri.AbsoluteUri == "http://127.0.0.1:8000/mcp", "unexpected endpoint");
            if (request.Method == HttpMethod.Delete)
            {
                CheckHeaders(request);
                Requests.Add("DELETE");
                return new HttpResponseMessage(HttpStatusCode.OK);
            }
            Check(request.Method == HttpMethod.Post, "unexpected HTTP method");
            var body = Json.Decode(await request.Content.ReadAsStringAsync());
            string method = Json.String(body, "method");
            Requests.Add(method);
            if (Offline) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            if (method == "initialize")
            {
                var response = Reply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-03-26\",\"serverInfo\":{\"name\":\"windows-mcp\"}}}");
                response.Headers.Add("Mcp-Session-Id", "fixture");
                return response;
            }
            CheckHeaders(request);
            if (method == "notifications/initialized")
            {
                Check(!body.ContainsKey("id"), "notification has ID");
                return new HttpResponseMessage(HttpStatusCode.Accepted);
            }
            Check(method == "tools/call", "unexpected RPC method");
            var parameters = Json.Map(body, "params");
            Check(Json.String(parameters, "name") == "ControlStatus" &&
                Json.Map(parameters, "arguments").Count == 0, "unexpected tool or control arguments");
            string state = states.Dequeue();
            var status = new { state };
            var result = new Dictionary<string, object> { { "isError", false } };
            if (TextResult) result["content"] = new[] { new { type = "text", text = Json.Encode(status) } };
            else result["structuredContent"] = status;
            string reply = Json.Encode(new { jsonrpc = "2.0", id = UnexpectedId ? 4 : 2, result });
            return Reply(": hello\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\ndata: " +
                reply + "\r\n\r\n", "text/event-stream");
        }

        private static void CheckHeaders(HttpRequestMessage request)
        {
            Check(request.Headers.GetValues("Mcp-Session-Id").Single() == "fixture", "session missing");
            Check(request.Headers.GetValues("MCP-Protocol-Version").Single() == "2025-03-26", "protocol missing");
        }

        private static HttpResponseMessage Reply(string data, string media = "application/json")
        {
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(data, Encoding.UTF8, media) };
        }
    }

    private static void Check(bool valid, string message)
    {
        if (!valid) throw new InvalidOperationException(message);
    }

    private static async Task Reject(Task operation, string expected)
    {
        try { await operation; }
        catch (InvalidOperationException error)
        {
            Check(error.Message.Contains(expected), "wrong rejection");
            return;
        }
        throw new InvalidOperationException("expected rejection");
    }

    private static async Task Run()
    {
        var ownership = new Fixture("user", "ready");
        using (var client = new HttpClient(ownership))
        {
            int checks = 0;
            await WindowsMcp.RequireIdleAsync(client, () => checks++, CancellationToken.None);
            var exchange = new[] { "initialize", "notifications/initialized", "tools/call", "DELETE" };
            Check(ownership.Requests.SequenceEqual(exchange.Concat(exchange)) && checks == 4,
                "expected two complete exchanges with local checks");
        }
        using (var client = new HttpClient(new Fixture("takeover_pending")))
            await Reject(WindowsMcp.RequireIdleAsync(client, () => { }, CancellationToken.None), "桌面被占用");
        using (var client = new HttpClient(new Fixture("ai")))
            await Reject(WindowsMcp.RequireIdleAsync(client, () => { }, CancellationToken.None), "桌面被占用");
        using (var client = new HttpClient(new Fixture("user", "unavailable")))
            await Reject(WindowsMcp.RequireIdleAsync(client, () => { }, CancellationToken.None), "桌面被占用");

        using (var client = new HttpClient(new Fixture("ready")))
        {
            int checks = 0;
            await Reject(WindowsMcp.RequireIdleAsync(client, () =>
            {
                if (++checks == 2) throw new InvalidOperationException("焦点已变");
            }, CancellationToken.None), "焦点已变");
        }
        using (var client = new HttpClient(new Fixture { Offline = true }))
            await WindowsMcp.RequireIdleAsync(client, () => { }, CancellationToken.None);
        using (var client = new HttpClient(new Fixture("ready") { UnexpectedId = true }))
            Check(await WindowsMcp.ReadControlStateAsync(client, CancellationToken.None) == null, "accepted wrong response id");
        using (var client = new HttpClient(new Fixture("ready") { TextResult = true }))
            Check(await WindowsMcp.ReadControlStateAsync(client, CancellationToken.None) == "ready", "text back-compat failed");
    }

    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--live")
        {
            using (var client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }))
            {
                var state = WindowsMcp.ReadControlStateAsync(client, CancellationToken.None).GetAwaiter().GetResult();
                Check(state != null, "local Windows-MCP state unavailable");
                Console.WriteLine("Live 4.1.7 endpoint reported {0}.", state);
            }
            return;
        }
        Run().GetAwaiter().GetResult();
        Console.WriteLine("8 isolated Windows-MCP cases passed.");
    }
}
