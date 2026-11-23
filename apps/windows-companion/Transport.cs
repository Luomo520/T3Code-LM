using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class Json
{
    // 截图编码和 MCP 的事件流需要高于系统默认的大小上限。
    private static JavaScriptSerializer Serializer()
    {
        return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    }

    internal static string Encode(object value) { return Serializer().Serialize(value); }
    internal static Dictionary<string, object> Decode(string text) { return Serializer().Deserialize<Dictionary<string, object>>(text); }
    internal static Dictionary<string, object> Map(Dictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
    }

    internal static string String(Dictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) ? value as string : null;
    }
}

internal sealed class ApiFailure : Exception
{
    internal readonly HttpStatusCode Status;
    internal ApiFailure(HttpStatusCode status) : base("服务器响应 HTTP " + (int)status) { Status = status; }
}

internal sealed class Pairing
{
    public string Address { get; set; }
    public string DeviceId { get; set; }
    public string Name { get; set; }
    public string Token { get; set; }

    private static readonly string Location = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "T3Code-LM-Companion", "pairing.bin");

    internal static Uri ValidateAddress(string input)
    {
        Uri address;
        if (!Uri.TryCreate(input, UriKind.Absolute, out address) ||
            !String.IsNullOrEmpty(address.UserInfo) || !String.IsNullOrEmpty(address.Query) ||
            !String.IsNullOrEmpty(address.Fragment) || address.AbsolutePath != "/" ||
            !(address.Scheme == "https" || address.Scheme == "http" && IsPrivate(address)))
            throw new ArgumentException("请输入 HTTPS 服务地址，或本机／局域网的 HTTP IP 地址。");
        return address;
    }

    private static bool IsPrivate(Uri address)
    {
        if (address.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
        IPAddress ip;
        if (!IPAddress.TryParse(address.Host.Trim('[', ']'), out ip)) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        byte[] octets = ip.GetAddressBytes();
        return octets.Length == 4
            ? octets[0] == 10 || octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31 ||
                octets[0] == 192 && octets[1] == 168
            : (octets[0] & 0xfe) == 0xfc;
    }

    internal static Pairing Load()
    {
        if (!File.Exists(Location)) return null;
        byte[] data = ProtectedData.Unprotect(File.ReadAllBytes(Location), null, DataProtectionScope.CurrentUser);
        var stored = new JavaScriptSerializer().Deserialize<Pairing>(Encoding.UTF8.GetString(data));
        ValidateAddress(stored.Address);
        if (String.IsNullOrWhiteSpace(stored.Token) || String.IsNullOrWhiteSpace(stored.DeviceId))
            throw new InvalidDataException("配对信息不完整。");
        return stored;
    }

    internal void Save()
    {
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Encode(this)), null, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(Location));
        string temp = Location + ".new";
        File.WriteAllBytes(temp, data);
        if (File.Exists(Location)) File.Replace(temp, Location, null);
        else File.Move(temp, Location);
    }

    internal static void Clear() { File.Delete(Location); }
}

internal static class CompanionApi
{
    private static readonly HttpClient Client = new HttpClient(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseDefaultCredentials = false,
        UseCookies = false,
        UseProxy = false,
        MaxConnectionsPerServer = 2
    })
    {
        Timeout = TimeSpan.FromSeconds(15),
        MaxResponseContentBufferSize = 8 * 1024 * 1024
    };

    internal static async Task<Dictionary<string, object>> Post(Uri origin, string method, object payload, string token, CancellationToken cancel)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "api/companions/" + method)))
        {
            request.Content = new StringContent(Json.Encode(payload), Encoding.UTF8, "application/json");
            if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using (var response = await Client.SendAsync(request, cancel).ConfigureAwait(false))
            {
                if (!response.IsSuccessStatusCode) throw new ApiFailure(response.StatusCode);
                return Json.Decode(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            }
        }
    }
}
