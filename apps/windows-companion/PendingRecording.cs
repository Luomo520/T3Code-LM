using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed class PendingRecording
{
    internal const int MaxBytes = 5 * 1024 * 1024;
    internal const string FileChanged = "无法读取或核验已保存的原录像。本机文件已保留，录像未上传。";
    internal const string LocalOnly = "录像已保存在 Windows，本次未能回传。";
    private static readonly string Location = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "T3Code-LM-Companion", "recording-receipt.bin");

    public string Id { get; set; }
    public string FilePath { get; set; }
    public string FileIdentity { get; set; }
    public string Sha256 { get; set; }
    public long Bytes { get; set; }
    public long ExpiresUtcTicks { get; set; }
    public string Scope { get; set; }
    public string Label { get; set; }
    public string CapturedAt { get; set; }
    public string Message { get; set; }
    public bool Failed { get; set; }

    internal static PendingRecording Create(string id, FileStream file, string scope, string label, DateTime capturedAt, string message)
    {
        if (file.Length == 0 || file.Length > MaxBytes)
            throw new InvalidDataException("录像文件大小不符合会话上传限制。");
        using (var digest = SHA256.Create())
        {
            file.Position = 0;
            return new PendingRecording
            {
                Id = id,
                FilePath = file.Name,
                FileIdentity = Identify(file),
                Sha256 = Convert.ToBase64String(digest.ComputeHash(file)),
                Bytes = file.Length,
                ExpiresUtcTicks = DateTime.UtcNow.AddHours(24).Ticks,
                Scope = scope,
                Label = label,
                CapturedAt = capturedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                Message = message
            };
        }
    }

    // 将本机路径和摘要绑定到当前 Windows 用户及同一后端配对。
    private static byte[] PairingEntropy(Pairing pairing)
    {
        using (var digest = SHA256.Create())
            return digest.ComputeHash(Encoding.UTF8.GetBytes(
                "t3-companion-recording\n" + pairing.Address + "\n" + pairing.DeviceId + "\n" + pairing.Token));
    }

    internal static PendingRecording Load(Pairing pairing, string location = null)
    {
        location = location ?? Location;
        string temporary = location + ".new";
        if (File.Exists(location)) File.Delete(temporary);
        else if (File.Exists(temporary)) File.Move(temporary, location);
        else return null;
        byte[] data;
        using (var file = new FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new BinaryReader(file))
        {
            if (file.Length > 16 * 1024) throw new InvalidDataException("录像回执记录大小无效。");
            data = ProtectedData.Unprotect(
                reader.ReadBytes((int)file.Length), PairingEntropy(pairing), DataProtectionScope.CurrentUser);
        }
        var stored = new JavaScriptSerializer().Deserialize<PendingRecording>(Encoding.UTF8.GetString(data));
        Guid taskId;
        if (stored == null || !Guid.TryParseExact(stored.Id, "D", out taskId))
            throw new InvalidDataException("录像回执记录无效。");
        return stored;
    }

    internal bool Expired { get { return DateTime.UtcNow.Ticks >= ExpiresUtcTicks; } }

    internal void Save(Pairing pairing, string location = null)
    {
        location = location ?? Location;
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Encode(this)),
            PairingEntropy(pairing), DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(location));
        string temporary = location + ".new";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(data, 0, data.Length);
            file.Flush(true);
        }
        if (File.Exists(location)) File.Replace(temporary, location, null);
        else File.Move(temporary, location);
    }

    internal static void Clear(string location = null)
    {
        location = location ?? Location;
        File.Delete(location);
        File.Delete(location + ".new");
    }

    internal string ReadOriginal()
    {
        if (Failed) return null;
        try
        {
            using (var file = new FileStream(FilePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new BinaryReader(file))
            using (var digest = SHA256.Create())
            {
                // 先确认是最初的文件，再从同一个句柄读取并校验实际将上传的字节。
                if (file.Length != Bytes || Bytes <= 0 || Bytes > MaxBytes || Identify(file) != FileIdentity)
                    return null;
                var bytes = reader.ReadBytes((int)Bytes);
                if (bytes.LongLength != Bytes || Convert.ToBase64String(digest.ComputeHash(bytes)) != Sha256)
                    return null;
                return Convert.ToBase64String(bytes);
            }
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    internal Dictionary<string, object> Outcome(string original)
    {
        var result = new Dictionary<string, object> { { "id", Id }, { "status", "failed" }, { "message", Message } };
        if (Failed || original == null) return result;
        result["status"] = "done";
        result["recordingBase64"] = original;
        result["captureScope"] = Scope;
        result["capture"] = new { label = Label, capturedAt = CapturedAt };
        return result;
    }

    internal void MarkChanged()
    {
        Failed = true;
        Message = FileChanged;
        FilePath = FileIdentity = Sha256 = Scope = Label = CapturedAt = null;
        Bytes = 0;
    }

    private static string Identify(FileStream stream)
    {
        NativeFileInformation info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle, out info))
            throw new IOException("无法确认本机录像的文件身份。");
        return String.Format(CultureInfo.InvariantCulture, "{0:x8}:{1:x8}{2:x8}:{3:x8}{4:x8}",
            info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow, info.CreationTimeHigh, info.CreationTimeLow);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileInformation
    {
        public uint Attributes, CreationTimeLow, CreationTimeHigh, LastAccessLow, LastAccessHigh,
            LastWriteLow, LastWriteHigh, VolumeSerialNumber, FileSizeHigh, FileSizeLow, Links,
            FileIndexHigh, FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out NativeFileInformation information);
}
