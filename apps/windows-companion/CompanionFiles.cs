using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class CompanionFiles
{
    private const int MaxBytes = 5 * 1024 * 1024;

    internal static async Task<Dictionary<string, string>> ChooseUpload(Form owner, CancellationToken cancel)
    {
        string path;
        using (var dialog = new OpenFileDialog
        {
            Title = "选择要发回原会话的文件（最多 5 MiB）",
            CheckFileExists = true,
            RestoreDirectory = true
        })
        {
            if (dialog.ShowDialog(owner) != DialogResult.OK)
                throw new InvalidOperationException("未选择要发送的文件。");
            path = dialog.FileName;
        }
        return await Task.Run(() =>
        {
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new BinaryReader(input))
            {
                if (input.Length > MaxBytes)
                    throw new InvalidOperationException("文件超过受控端单次传输的 5 MiB 上限。");
                byte[] bytes = reader.ReadBytes((int)input.Length);
                cancel.ThrowIfCancellationRequested();
                return new Dictionary<string, string>
                {
                    { "name", Path.GetFileName(path) },
                    { "sha256", Digest(bytes) },
                    { "data", Convert.ToBase64String(bytes) }
                };
            }
        }, cancel);
    }

    internal static async Task<Dictionary<string, string>> SaveDownload(
        Form owner, Uri origin, string token, string jobId, string fileName, CancellationToken cancel)
    {
        if (String.IsNullOrWhiteSpace(fileName))
            throw new InvalidDataException("服务器未提供文件名。");
        string path;
        using (var dialog = new SaveFileDialog
        {
            Title = "选择文件保存位置",
            FileName = Path.GetFileName(fileName),
            RestoreDirectory = true,
            OverwritePrompt = true
        })
        {
            if (dialog.ShowDialog(owner) != DialogResult.OK)
                throw new InvalidOperationException("未选择文件保存位置。");
            path = dialog.FileName;
        }
        var existing = new FileInfo(path);
        bool canReplace = existing.Exists;
        long originalLength = canReplace ? existing.Length : 0;
        DateTime originalModified = canReplace ? existing.LastWriteTimeUtc : DateTime.MinValue;
        var file = await CompanionApi.Post(origin, "read-transfer", new { id = jobId }, token, cancel);
        string payload = Json.String(file, "data");
        string expected = Json.String(file, "sha256");
        if (payload == null || payload.Length > 4 * ((MaxBytes + 2) / 3))
            throw new InvalidDataException("服务器未返回有效的文件。");
        await Task.Run(() =>
        {
            byte[] bytes = Convert.FromBase64String(payload);
            if (bytes.Length > MaxBytes || Digest(bytes) != expected)
                throw new InvalidDataException("下载的文件与 SHA-256 校验不符。");
            cancel.ThrowIfCancellationRequested();
            string temp = Path.Combine(Path.GetDirectoryName(path), ".t3-transfer-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    output.Write(bytes, 0, bytes.Length);
                    output.Flush(true);
                }
                cancel.ThrowIfCancellationRequested();
                if (canReplace)
                {
                    existing.Refresh();
                    if (!existing.Exists || existing.Length != originalLength ||
                        existing.LastWriteTimeUtc != originalModified)
                        throw new InvalidOperationException("目标文件在下载期间已变化，请重新选择保存位置。");
                    File.Replace(temp, path, null);
                }
                else File.Move(temp, path);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }, cancel);
        return new Dictionary<string, string> { { "path", path }, { "sha256", expected } };
    }

    private static string Digest(byte[] bytes)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
}
