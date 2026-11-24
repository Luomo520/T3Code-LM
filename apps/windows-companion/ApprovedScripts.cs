using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class ApprovedScripts
{
    private static readonly string Location = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "T3Code-LM-Companion", "approved-scripts.bin");
    private const int MaxScripts = 32;

    internal sealed class Entry
    {
        public Entry() { }
        public string Path { get; set; }
        public string Sha256 { get; set; }

        public override string ToString() { return Path; }
    }

    internal static List<Entry> Load()
    {
        if (!File.Exists(Location)) return new List<Entry>();
        byte[] data = ProtectedData.Unprotect(File.ReadAllBytes(Location), null, DataProtectionScope.CurrentUser);
        var entries = new JavaScriptSerializer().Deserialize<List<Entry>>(Encoding.UTF8.GetString(data));
        if (entries == null || entries.Count > MaxScripts)
            throw new InvalidDataException("本机脚本批准记录无效。");
        foreach (var entry in entries)
            if (entry == null || String.IsNullOrWhiteSpace(entry.Path) ||
                entry.Sha256 == null || entry.Sha256.Length != 64)
                throw new InvalidDataException("本机脚本批准记录无效。");
        return entries;
    }

    internal static Entry Inspect(string path)
    {
        path = Path.GetFullPath(path);
        using (var script = OpenLocalScript(path))
            return new Entry { Path = path, Sha256 = Digest(script) };
    }

    internal static void Approve(Entry entry)
    {
        var entries = Load();
        int existing = entries.FindIndex(item => String.Equals(item.Path, entry.Path, StringComparison.OrdinalIgnoreCase));
        if (existing >= 0) entries[existing] = entry;
        else if (entries.Count < MaxScripts) entries.Add(entry);
        else throw new InvalidOperationException("脚本批准已达 32 项，请先撤销一项。");
        Save(entries);
    }

    internal static void Revoke(Entry entry)
    {
        var entries = Load();
        entries.RemoveAll(item => String.Equals(item.Path, entry.Path, StringComparison.OrdinalIgnoreCase) &&
            item.Sha256 == entry.Sha256);
        Save(entries);
    }

    private static void Save(List<Entry> entries)
    {
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Encode(entries)), null, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(Location));
        string temp = Location + ".new";
        File.WriteAllBytes(temp, data);
        if (File.Exists(Location)) File.Replace(temp, Location, null);
        else File.Move(temp, Location);
    }

    internal static async Task<string> Run(Entry entry, Action verifyStart, Action verifyRequest, CancellationToken cancel)
    {
        using (var identity = WindowsIdentity.GetCurrent())
            if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("请用普通权限重新打开受控端，再运行本机脚本。");
        string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) throw new InvalidOperationException("本机 Windows PowerShell 不可用。");
        var entries = Load();
        if (!entries.Exists(item => item.Path == entry.Path && item.Sha256 == entry.Sha256))
            throw new InvalidOperationException("本机已撤销或更新此脚本的批准。");
        // 以只读共享方式持有原脚本，防止核对后通过同一路径修改或替换文件。
        using (var script = OpenLocalScript(entry.Path))
        {
            if (Digest(script) != entry.Sha256)
                throw new InvalidOperationException("脚本内容已改变，请在 Windows 重新批准。");
            var start = new ProcessStartInfo(powershell, "-NoLogo -NoProfile -NonInteractive -File \"" + entry.Path + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory
            };
            verifyStart();
            cancel.ThrowIfCancellationRequested();
            using (var process = Process.Start(start))
            {
                if (process == null) throw new InvalidOperationException("Windows 未能启动本机脚本。");
                try
                {
                    while (!process.HasExited)
                    {
                        cancel.ThrowIfCancellationRequested();
                        verifyRequest();
                        WindowsDesktop.RequireDesktop();
                        await Task.Delay(100, cancel);
                    }
                    cancel.ThrowIfCancellationRequested();
                    verifyRequest();
                    WindowsDesktop.RequireDesktop();
                    if (process.ExitCode != 0) throw new InvalidOperationException("本机脚本退出失败。");
                    return "本机脚本已运行成功。";
                }
                finally
                {
                    if (!process.HasExited)
                        try { process.Kill(); }
                        catch (InvalidOperationException) { }
                        catch (System.ComponentModel.Win32Exception) { }
                }
            }
        }
    }

    private static FileStream OpenLocalScript(string path)
    {
        if (!String.Equals(Path.GetExtension(path), ".ps1", StringComparison.OrdinalIgnoreCase) ||
            path.Length < 4 || path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0 ||
            path.IndexOfAny(new[] { '[', ']' }) >= 0 || new DriveInfo(Path.GetPathRoot(path)).DriveType != DriveType.Fixed)
            throw new InvalidOperationException("请选择本机固定磁盘上的 .ps1 文件。");
        for (string item = path; item != null; item = Path.GetDirectoryName(item))
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("请选择不经过符号链接或目录联接的脚本路径。");
        var script = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (script.Length <= 1024 * 1024) return script;
        script.Dispose();
        throw new InvalidOperationException("本机脚本大小不能超过 1 MiB。");
    }

    private static string Digest(Stream script)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(script)).Replace("-", "");
    }
}
