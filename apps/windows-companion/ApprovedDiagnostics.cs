using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal sealed class ApprovedDiagnostics
{
    private readonly string label;
    private readonly string script;

    private ApprovedDiagnostics(string label, string script)
    {
        this.label = label;
        this.script = script;
    }

    public override string ToString() { return label; }

    internal static List<ApprovedDiagnostics> Presets()
    {
        return new List<ApprovedDiagnostics>
        {
            new ApprovedDiagnostics("检查本机 OpenSSH 客户端是否存在",
                "if ([System.IO.File]::Exists([System.IO.Path]::Combine([System.Environment]::SystemDirectory, 'OpenSSH', 'ssh.exe'))) { exit 0 } else { exit 1 }"),
            new ApprovedDiagnostics("检查当前用户的临时目录是否可找到",
                "if ([System.IO.Directory]::Exists([System.IO.Path]::GetTempPath())) { exit 0 } else { exit 1 }")
        };
    }

    internal async Task<string> Run(Action verifyStart, Action verifyRequest, CancellationToken cancel)
    {
        string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) throw new InvalidOperationException("本机 Windows PowerShell 不可用。");
        var arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " +
            Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        verifyStart();
        cancel.ThrowIfCancellationRequested();
        using (var process = Process.Start(new ProcessStartInfo(powershell, arguments)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory
        }))
        {
            if (process == null) throw new InvalidOperationException("Windows 未能启动本机诊断。");
            var elapsed = Stopwatch.StartNew();
            try
            {
                while (!process.HasExited)
                {
                    verifyRequest();
                    cancel.ThrowIfCancellationRequested();
                    WindowsDesktop.RequireDesktop();
                    if (elapsed.Elapsed.TotalSeconds >= 10)
                        throw new InvalidOperationException("本机诊断未在规定时间完成。");
                    await Task.Delay(100, cancel);
                }
                verifyRequest();
                cancel.ThrowIfCancellationRequested();
                WindowsDesktop.RequireDesktop();
                if (process.ExitCode == 0) return label + "：已通过。";
                if (process.ExitCode == 1) return label + "：未找到。";
                throw new InvalidOperationException("本机诊断未正常结束。");
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
