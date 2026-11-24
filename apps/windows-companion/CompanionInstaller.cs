using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class CompanionInstaller
{
    private const uint Canceled = 1602;
    private const int RebootInitiated = 1641, RebootRequired = 3010;
    private const uint Success = 0;
    private const int Installed = 5;
    private const int Unknown = -1, Advertised = 1, Absent = 2;
    private const uint RevisionNumberSummary = 9;

    internal static string StageDirectory(string id)
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "T3Code-LM-Companion", "installer-" + id);
    }

    internal static void ClearStage(string id)
    {
        string directory = StageDirectory(id);
        try
        {
            File.Delete(Path.Combine(directory, "package.msi"));
            if (Directory.Exists(directory)) Directory.Delete(directory);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    internal static bool IsPackage(string path)
    {
        return String.Equals(Path.GetExtension(path), ".msi", StringComparison.OrdinalIgnoreCase);
    }

    internal static async Task<string> Install(string source, string sha256,
        Action<string, string, string, string, bool> prepare, Action<Process> opened)
    {
        if (!IsPackage(source)) throw new InvalidOperationException("请选择本机已收到的 MSI 安装包。");
        string stageId = Guid.NewGuid().ToString("N");
        string directory = StageDirectory(stageId);
        string path = Path.Combine(directory, "package.msi");
        Directory.CreateDirectory(directory);
        bool canClearStage = true;
        try
        {
            await Task.Run(() =>
            {
                using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    if (input.Length == 0 || input.Length > 5 * 1024 * 1024)
                        throw new InvalidDataException("本机安装包大小已变化。");
                    input.CopyTo(output);
                    output.Flush(true);
                }
            });
            // 在 Windows Installer 读包期间保持只读句柄，防止暂存副本被覆盖。
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                using (var digest = SHA256.Create())
                {
                    var actual = BitConverter.ToString(digest.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                    if (actual != sha256)
                        throw new InvalidDataException("本机安装包已变化，SHA-256 与原会话回执不符。");
                }
                var product = ReadProduct(path);
                prepare(stageId, product.Item1, product.Item2, product.Item3,
                    PreviouslyDifferent(product.Item1, product.Item2, product.Item3));
                var command = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"),
                    "/i \"" + path + "\" /qf")
                {
                    UseShellExecute = false,
                    WorkingDirectory = directory
                };
                using (var process = Process.Start(command))
                {
                    if (process == null) throw new InvalidOperationException("Windows 未能启动安装器。");
                    canClearStage = false;
                    opened(process);
                    int code = await Task.Run(() => { process.WaitForExit(); return process.ExitCode; });
                    canClearStage = true;
                    return Outcome(code, () => IsInstalled(product.Item1, product.Item2, product.Item3));
                }
            }
        }
        finally { if (canClearStage) ClearStage(stageId); }
    }

    internal static string Outcome(int code, Func<bool> isInstalled)
    {
        if (code == Canceled || code == 1223) return "canceled";
        return (code == Success || code == RebootInitiated || code == RebootRequired) && isInstalled()
            ? "verified" : "unverified";
    }

    internal static Tuple<string, string, string> ReadProduct(string path)
    {
        uint database;
        if (MsiOpenDatabase(path, IntPtr.Zero, out database) != Success)
            throw new InvalidDataException("无法读取 MSI 安装包的属性。");
        try
        {
            string product = ReadProperty(database, "ProductCode");
            string version = ReadProperty(database, "ProductVersion");
            string package = ReadPackageCode(database);
            Guid code;
            Version number;
            if (!Guid.TryParseExact(product, "B", out code) || String.IsNullOrEmpty(version) ||
                version.Length > 32 || !Version.TryParse(version, out number) ||
                !Regex.IsMatch(version, "\\A[0-9]+(\\.[0-9]+){1,3}\\z") || package == null)
                throw new InvalidDataException("MSI 安装包缺少可核对的产品标识或版本。");
            return Tuple.Create(code.ToString("B").ToUpperInvariant(), version, package);
        }
        finally { MsiCloseHandle(database); }
    }

    private static string ReadProperty(uint database, string name)
    {
        uint view;
        string query = "SELECT `Value` FROM `Property` WHERE `Property` = '" + name + "'";
        if (MsiDatabaseOpenView(database, query, out view) != Success) return null;
        try
        {
            uint record;
            if (MsiViewExecute(view, 0) != Success || MsiViewFetch(view, out record) != Success) return null;
            try
            {
                uint size = 128;
                var value = new StringBuilder((int)size);
                return MsiRecordGetString(record, 1, value, ref size) == Success ? value.ToString() : null;
            }
            finally { MsiCloseHandle(record); }
        }
        finally { MsiCloseHandle(view); }
    }

    private static string ReadPackageCode(uint database)
    {
        uint summary;
        if (MsiGetSummaryInformation(database, null, 0, out summary) != Success) return null;
        try
        {
            uint size = 128, type;
            int integer;
            System.Runtime.InteropServices.ComTypes.FILETIME time;
            var value = new StringBuilder((int)size);
            return MsiSummaryInfoGetProperty(summary, RevisionNumberSummary, out type, out integer, out time, value, ref size) ==
                Success ? NormalizeCode(value.ToString()) : null;
        }
        finally { MsiCloseHandle(summary); }
    }

    private static string NormalizeCode(string value)
    {
        Guid code;
        return Guid.TryParseExact(value, "B", out code) ? code.ToString("B").ToUpperInvariant() : null;
    }

    private static string InstalledProperty(string product, string property)
    {
        uint size = 128;
        var value = new StringBuilder((int)size);
        return MsiGetProductInfo(product, property, value, ref size) == Success ? value.ToString() : null;
    }

    internal static bool IsInstalled(string product, string version, string package)
    {
        return MsiQueryProductState(product) == Installed &&
            InstalledProperty(product, "VersionString") == version &&
            NormalizeCode(InstalledProperty(product, "PackageCode")) == package;
    }

    private static bool PreviouslyDifferent(string product, string version, string package)
    {
        int state = MsiQueryProductState(product);
        if (state == Unknown || state == Advertised || state == Absent) return true;
        if (state != Installed) return false;
        string installedVersion = InstalledProperty(product, "VersionString");
        string installedPackage = NormalizeCode(InstalledProperty(product, "PackageCode"));
        return (installedVersion != null && installedVersion != version) ||
            (installedPackage != null && installedPackage != package);
    }

    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiOpenDatabase(string path, IntPtr mode, out uint database);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiDatabaseOpenView(uint database, string query, out uint view);
    [DllImport("msi.dll")]
    private static extern uint MsiViewExecute(uint view, uint parameters);
    [DllImport("msi.dll")]
    private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint size);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern int MsiQueryProductState(string product);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiGetProductInfo(string product, string property, StringBuilder value, ref uint size);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiGetSummaryInformation(uint database, string path, uint updates, out uint summary);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiSummaryInfoGetProperty(uint summary, uint property, out uint type, out int integer,
        out System.Runtime.InteropServices.ComTypes.FILETIME time, StringBuilder value, ref uint size);
    [DllImport("msi.dll")]
    private static extern uint MsiCloseHandle(uint handle);
}
