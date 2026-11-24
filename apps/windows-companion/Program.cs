using System;
using System.Reflection;
using System.Net;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("T3Code-LM Windows 受控端")]
[assembly: AssemblyProduct("T3Code-LM Windows 受控端")]
[assembly: AssemblyVersion("0.2.5.2")]
[assembly: AssemblyFileVersion("0.2.5.2")]
[assembly: AssemblyInformationalVersion("0.2.5-2-localtest.1")]

internal static class Program
{
    public const string Version = "0.2.5-2-localtest.1";

    [STAThread]
    private static void Main()
    {
        bool first;
        using (var instance = new Mutex(true, @"Local\T3Code-LM-Windows-Companion", out first))
        {
            if (!first)
            {
                MessageBox.Show("受控端已运行。请从 Windows 通知区域打开。", "T3Code-LM Windows 受控端");
                return;
            }
            ServicePointManager.SecurityProtocol = SecurityProtocolType.SystemDefault;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new CompanionWindow()) Application.Run(window);
        }
    }
}
