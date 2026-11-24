using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class PendingInstallation
{
    private static readonly string Location = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "T3Code-LM-Companion", "installation-receipt.bin");

    public string Id { get; set; }
    public int Attempt { get; set; }
    public string Sha256 { get; set; }
    public string StageId { get; set; }
    public string ProductCode { get; set; }
    public string Version { get; set; }
    public string PackageCode { get; set; }
    public bool PreviouslyDifferent { get; set; }
    public string State { get; set; }
    public int ProcessId { get; set; }
    public long ProcessStartedUtcTicks { get; set; }

    internal static bool Exists { get { return File.Exists(Location) || File.Exists(Location + ".new"); } }

    internal static PendingInstallation Load(Pairing pairing)
    {
        string temporary = Location + ".new";
        if (!File.Exists(Location))
        {
            if (!File.Exists(temporary)) return null;
            File.Move(temporary, Location);
        }

        byte[] data;
        using (var file = new FileStream(Location, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new BinaryReader(file))
        {
            if (file.Length == 0 || file.Length > 16 * 1024) throw new InvalidDataException("本机安装回执记录无效。");
            data = ProtectedData.Unprotect(reader.ReadBytes((int)file.Length), PairingEntropy(pairing),
                DataProtectionScope.CurrentUser);
        }
        var record = new JavaScriptSerializer().Deserialize<PendingInstallation>(Encoding.UTF8.GetString(data));
        Guid id;
        if (record == null || record.Attempt <= 0 ||
            !Guid.TryParseExact(record.Id, "D", out id) ||
            !Guid.TryParseExact(record.StageId, "N", out id) ||
            !Guid.TryParseExact(record.ProductCode, "B", out id) ||
            !Guid.TryParseExact(record.PackageCode, "B", out id) ||
            !Regex.IsMatch(record.Sha256 ?? "", "\\A[0-9a-f]{64}\\z") ||
            record.Version == null || record.Version.Length > 32 ||
            !Regex.IsMatch(record.Version, "\\A[0-9]+(\\.[0-9]+){1,3}\\z") ||
            !(record.State == "prepared" || record.State == "opened" || record.State == "verified" ||
                record.State == "unverified" || record.State == "canceled"))
            throw new InvalidDataException("本机安装回执记录无效。");
        return record;
    }

    internal void Save(Pairing pairing)
    {
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Encode(this)),
            PairingEntropy(pairing), DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(Location));
        string temporary = Location + ".new";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(data, 0, data.Length);
            file.Flush(true);
        }
        if (File.Exists(Location)) File.Replace(temporary, Location, null);
        else File.Move(temporary, Location);
    }

    internal static void Clear()
    {
        File.Delete(Location + ".new");
        File.Delete(Location);
    }

    private static byte[] PairingEntropy(Pairing pairing)
    {
        using (var digest = SHA256.Create())
            return digest.ComputeHash(Encoding.UTF8.GetBytes(
                "t3-companion-installation\n" + pairing.Address + "\n" + pairing.DeviceId + "\n" + pairing.Token));
    }

    internal void MarkOpened(Process process)
    {
        State = "opened";
        ProcessId = process.Id;
        try { ProcessStartedUtcTicks = process.StartTime.ToUniversalTime().Ticks; }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
    }

    internal string Recover(out bool canClearStage)
    {
        canClearStage = false;
        if (State == "prepared") return "unverified";
        if (State != "opened") return State;
        if (ProcessId <= 0 || ProcessStartedUtcTicks <= 0) return "unverified";
        try
        {
            using (var process = Process.GetProcessById(ProcessId))
                if (!process.HasExited && process.StartTime.ToUniversalTime().Ticks == ProcessStartedUtcTicks) return null;
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { return "unverified"; }
        catch (Win32Exception) { return "unverified"; }
        canClearStage = true;
        // 仅当前登记与授权前不同，才能在缺少退出码时确认这次结果。
        return PreviouslyDifferent && CompanionInstaller.IsInstalled(ProductCode, Version, PackageCode)
            ? "verified" : "unverified";
    }

    internal object Report()
    {
        var result = new Dictionary<string, object> { { "attempt", Attempt }, { "status", State } };
        if (State == "verified")
        {
            result["productCode"] = ProductCode;
            result["version"] = Version;
        }
        return new { id = Id, status = "done", message = "", windowsInstallation = new { sha256 = Sha256, result } };
    }
}
