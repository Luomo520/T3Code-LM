using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal sealed class LocalSshProfiles
{
    private static readonly string SystemSsh = Path.Combine(Environment.SystemDirectory, "OpenSSH", "ssh.exe");
    private const uint CreateNewConsole = 0x00000010;
    private static readonly Regex AliasPattern = new Regex(@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z", RegexOptions.CultureInvariant);
    private static readonly Regex LinePattern = new Regex(@"\A[ \t]*([A-Za-z][A-Za-z0-9]*)[ \t]*=?[ \t]*(.*)\z",
        RegexOptions.CultureInvariant);
    private static readonly HashSet<string> CommandDirectives = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "include", "match", "proxycommand", "proxyjump", "knownhostscommand", "localcommand",
        "pkcs11provider", "securitykeyprovider", "ignoreunknown", "remotecommand", "enableSSHKeysign",
        "sessiontype", "forkafterauthentication"
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal ushort ShowWindow, ReservedSize;
        internal IntPtr ReservedData, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory,
        ref StartupInfo startup, out ProcessInfo process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class ProcessExit : WaitHandle
    {
        internal ProcessExit(IntPtr process) { SafeWaitHandle = new SafeWaitHandle(process, true); }
    }

    private readonly string path;
    private readonly string digest;
    private readonly List<string> aliases;

    private LocalSshProfiles(string path, string digest, List<string> aliases)
    {
        this.path = path;
        this.digest = digest;
        this.aliases = aliases;
    }

    internal List<string> Aliases { get { return new List<string>(aliases); } }

    internal static LocalSshProfiles Load()
    {
        if (!File.Exists(SystemSsh)) throw new InvalidOperationException("请先在 Windows 安装 OpenSSH 客户端。");
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "config");
        if (!File.Exists(path)) throw new InvalidOperationException("本机 .ssh 配置中没有可用的主机别名。");
        using (var file = OpenConfig(path))
        {
            string digest = Digest(file);
            file.Position = 0;
            using (var reader = new StreamReader(file, new UTF8Encoding(false, true)))
                return new LocalSshProfiles(path, digest, ReadAliases(reader));
        }
    }

    internal static List<string> ReadAliases(TextReader reader)
    {
        var aliases = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            string clean = line.Trim(' ', '\t');
            if (clean.Length == 0 || clean.StartsWith("#", StringComparison.Ordinal)) continue;
            // 遇到子配置、匹配规则或本地命令时拒绝直接调用 OpenSSH。
            var match = LinePattern.Match(clean);
            if (!match.Success || CommandDirectives.Contains(match.Groups[1].Value))
                throw new InvalidDataException("此 SSH 配置含有需要从本机终端直接处理的指令。");
            if (!String.Equals(match.Groups[1].Value, "host", StringComparison.OrdinalIgnoreCase)) continue;
            string hosts = match.Groups[2].Value;
            foreach (string entry in hosts.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (entry.StartsWith("#", StringComparison.Ordinal)) break;
                string alias = entry;
                if (alias.Length >= 2 && alias[0] == '"' && alias[alias.Length - 1] == '"')
                    alias = alias.Substring(1, alias.Length - 2);
                if (AliasPattern.IsMatch(alias) && seen.Add(alias)) aliases.Add(alias);
                if (aliases.Count > 128) throw new InvalidDataException("本机 SSH 别名数量超出上限。");
            }
        }
        aliases.Sort(StringComparer.CurrentCultureIgnoreCase);
        return aliases;
    }

    internal void Open(string alias, Action verifyRequest, CancellationToken cancel)
    {
        if (alias == null || !AliasPattern.IsMatch(alias) || !aliases.Contains(alias))
            throw new InvalidOperationException("应从本机配置中选择一个 SSH 别名。");
        FileStream locked = OpenConfig(path);
        try
        {
            if (Digest(locked) != digest) throw new InvalidOperationException("本机 SSH 配置已变化，请重新选择。");
            // 固定系统程序和交互式参数。用户凭据输入直接交给 OpenSSH。
            var commandLine = new StringBuilder("\"" + SystemSsh + "\" -F \"" + path + "\" " +
                "-o RemoteCommand=none -o PermitLocalCommand=no -o ProxyCommand=none " +
                "-o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no " +
                "-o ControlMaster=no -o ControlPath=none -o RequestTTY=force " +
                "-o StrictHostKeyChecking=ask -o VerifyHostKeyDNS=no -o BatchMode=no -- " + alias);
            verifyRequest();
            cancel.ThrowIfCancellationRequested();
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)) };
            ProcessInfo process;
            if (!CreateProcessW(SystemSsh, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateNewConsole,
                IntPtr.Zero, Environment.SystemDirectory, ref startup, out process))
                throw new InvalidOperationException("Windows 未能打开 OpenSSH 终端。");
            CloseHandle(process.Thread);
            var exited = new ProcessExit(process.Process);
            var config = locked;
            try
            {
                // 保持已校验的配置以只读共享方式打开，直到 OpenSSH 退出。
                ThreadPool.RegisterWaitForSingleObject(exited, delegate
                {
                    config.Dispose();
                    exited.Dispose();
                }, null, Timeout.Infinite, true);
                locked = null;
            }
            catch
            {
                exited.Dispose();
                throw;
            }
        }
        finally { if (locked != null) locked.Dispose(); }
    }

    private static FileStream OpenConfig(string path)
    {
        var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length <= 128 * 1024) return file;
        file.Dispose();
        throw new InvalidDataException("本机 SSH 配置过大。");
    }

    private static string Digest(Stream stream)
    {
        using (var sha = SHA256.Create())
            return Convert.ToBase64String(sha.ComputeHash(stream));
    }
}
