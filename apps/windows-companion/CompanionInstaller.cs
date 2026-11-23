using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

internal static class CompanionInstaller
{
    private const uint Canceled = 1602;
    private const uint Success = 0;
    private const int Installed = 5;

    internal static bool IsPackage(string path)
    {
        return String.Equals(Path.GetExtension(path), ".msi", StringComparison.OrdinalIgnoreCase);
    }

    internal static async Task<Tuple<string, string, string>> Install(
        string source, string sha256, Action authorizeStart, Action opened)
    {
        if (!IsPackage(source)) throw new InvalidOperationException("请选择本机已收到的 MSI 安装包。");
        string directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "T3Code-LM-Companion", "installer-" + Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "package.msi");
        Directory.CreateDirectory(directory);
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
                authorizeStart();
                var command = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"),
                    "/i \"" + path + "\" /qf")
                {
                    UseShellExecute = false,
                    WorkingDirectory = directory
                };
                using (var process = Process.Start(command))
                {
                    if (process == null) throw new InvalidOperationException("Windows 未能启动安装器。");
                    opened();
                    int code = await Task.Run(() => { process.WaitForExit(); return process.ExitCode; });
                    return Outcome(code, product.Item1, product.Item2, () => InstalledVersion(product.Item1));
                }
            }
        }
        finally
        {
            try { File.Delete(path); Directory.Delete(directory); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    internal static Tuple<string, string, string> Outcome(int code, string productCode, string version, Func<string> installedVersion)
    {
        if (code == Canceled || code == 1223) return Tuple.Create("canceled", (string)null, (string)null);
        if (code == Success && String.Equals(installedVersion(), version, StringComparison.Ordinal))
            return Tuple.Create("verified", productCode, version);
        return Tuple.Create("unverified", (string)null, (string)null);
    }

    internal static Tuple<string, string> ReadProduct(string path)
    {
        uint database;
        if (MsiOpenDatabase(path, IntPtr.Zero, out database) != Success)
            throw new InvalidDataException("无法读取 MSI 安装包的属性。");
        try
        {
            string product = ReadProperty(database, "ProductCode");
            string version = ReadProperty(database, "ProductVersion");
            Guid code;
            Version number;
            if (!Guid.TryParseExact(product, "B", out code) || String.IsNullOrEmpty(version) ||
                version.Length > 32 || !Version.TryParse(version, out number))
                throw new InvalidDataException("MSI 安装包缺少可核对的产品标识或版本。");
            return Tuple.Create(code.ToString("B").ToUpperInvariant(), version);
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

    private static string InstalledVersion(string product)
    {
        if (MsiQueryProductState(product) != Installed) return null;
        uint size = 128;
        var value = new StringBuilder((int)size);
        return MsiGetProductInfo(product, "VersionString", value, ref size) == Success ? value.ToString() : null;
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
    [DllImport("msi.dll")]
    private static extern uint MsiCloseHandle(uint handle);
}
