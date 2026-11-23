using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class CaptureTarget
{
    private const int ImageLimit = 5 * 1024 * 1024;
    private static int capturing;
    private readonly IntPtr window;
    private readonly uint thread;
    private readonly uint process;
    private readonly string display;
    private readonly Rectangle bounds;
    private readonly uint dpi;
    private readonly IntPtr monitor;
    internal readonly string Name;
    internal readonly string ResultLabel;
    internal string Scope { get { return window == IntPtr.Zero ? "display" : "window"; } }
    internal Size Size { get { return bounds.Size; } }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
        internal Rectangle Bounds { get { return Rectangle.FromLTRB(Left, Top, Right, Bottom); } }
    }

    private delegate bool WindowCallback(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsHungAppWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr handle, out uint affinity);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetWindowAttribute(IntPtr handle, uint attribute, out int value, uint size);

    private CaptureTarget(Screen screen)
    {
        display = screen.DeviceName;
        bounds = screen.Bounds;
        string id = display.Replace(@"\\.\DISPLAY", "");
        Name = String.Format("显示器 {0} · {1} × {2}{3}", id, bounds.Width, bounds.Height,
            screen.Primary ? " · 主显示器" : "");
        ResultLabel = CleanLabel(Name, "所选显示器");
    }

    private CaptureTarget(IntPtr handle, uint threadId, uint processId, Rectangle area, string title)
    {
        window = handle;
        thread = threadId;
        process = processId;
        bounds = area;
        dpi = GetDpiForWindow(handle);
        monitor = MonitorFromWindow(handle, 2);
        Name = String.Format("窗口 · {0}（{1} × {2}，{3}, {4}）", title, area.Width, area.Height, area.X, area.Y);
        ResultLabel = CleanLabel(title, "所选窗口");
    }

    private static string CleanLabel(string value, string fallback)
    {
        var safe = new StringBuilder(120);
        foreach (char character in value)
        {
            var category = char.GetUnicodeCategory(character);
            if (char.IsControl(character) || category == UnicodeCategory.Format ||
                category == UnicodeCategory.LineSeparator || category == UnicodeCategory.ParagraphSeparator ||
                category == UnicodeCategory.Surrogate) continue;
            safe.Append(character);
            if (safe.Length == 120) break;
        }
        var label = safe.ToString().Trim();
        return label.Length == 0 ? fallback : label;
    }

    public override string ToString() { return Name; }

    internal static List<CaptureTarget> List(string kind, IntPtr owner)
    {
        WindowsDesktop.RequireDesktop();
        var targets = new List<CaptureTarget>();
        if (kind != "display")
        {
            uint ownerProcess;
            GetWindowThreadProcessId(owner, out ownerProcess);
            EnumWindows(delegate (IntPtr handle, IntPtr ignored)
            {
                uint process;
                Rect rect;
                uint thread = GetWindowThreadProcessId(handle, out process);
                if (thread == 0 || process == ownerProcess || !Usable(handle) || !GetWindowRect(handle, out rect) ||
                    !AllowedSize(rect.Bounds)) return true;
                var title = new StringBuilder(181);
                if (GetWindowText(handle, title, title.Capacity) > 0)
                    targets.Add(new CaptureTarget(handle, thread, process, rect.Bounds, title.ToString().Trim()));
                return true;
            }, IntPtr.Zero);
        }
        if (kind != "window")
            foreach (Screen screen in Screen.AllScreens)
                if (AllowedSize(screen.Bounds)) targets.Add(new CaptureTarget(screen));
        return targets;
    }

    private static bool Usable(IntPtr handle)
    {
        int cloaked;
        uint affinity;
        return IsWindowVisible(handle) && !IsIconic(handle) && !IsHungAppWindow(handle) &&
            GetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked == 0 &&
            GetWindowDisplayAffinity(handle, out affinity) && affinity == 0;
    }

    private static bool AllowedSize(Rectangle rect)
    {
        return rect.Width > 0 && rect.Height > 0 && (long)rect.Width * rect.Height <= 32L * 1024 * 1024;
    }

    internal Rectangle Verify()
    {
        WindowsDesktop.RequireDesktop();
        if (window == IntPtr.Zero)
        {
            foreach (Screen screen in Screen.AllScreens)
                if (screen.DeviceName == display && screen.Bounds == bounds) return bounds;
            throw new InvalidOperationException("所选显示器已断开或显示布局已改变。");
        }
        uint currentProcess;
        Rect rect;
        if (GetWindowThreadProcessId(window, out currentProcess) != thread || currentProcess != process ||
            !Usable(window) || !GetWindowRect(window, out rect))
            throw new InvalidOperationException("所选窗口已关闭、最小化或无法拍摄。");
        Rectangle current = rect.Bounds;
        if (current.Size != bounds.Size || GetDpiForWindow(window) != dpi || MonitorFromWindow(window, 2) != monitor)
            throw new InvalidOperationException("所选窗口的尺寸、缩放比例或所在显示器已改变。");
        return current;
    }

    private Bitmap Capture(Action<DateTime> timestamp)
    {
        Rectangle area = Verify();
        var source = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb);
        try
        {
            using (var graphics = Graphics.FromImage(source))
            {
                if (window == IntPtr.Zero)
                    graphics.CopyFromScreen(area.Location, Point.Empty, area.Size);
                else
                {
                    // 窗口拍摄使用自己的图像，失败时不能改拍窗口后面的桌面。
                    IntPtr dc = graphics.GetHdc();
                    bool printed;
                    try { printed = PrintWindow(window, dc, 2); }
                    finally { graphics.ReleaseHdc(dc); }
                    if (!printed) throw new InvalidOperationException("所选窗口无法生成图像。");
                }
            }
            DateTime capturedAt = DateTime.UtcNow;
            Verify();
            if (timestamp != null) timestamp(capturedAt);
            return source;
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    internal async Task<Bitmap> CaptureAsync(CancellationToken cancel, Action<DateTime> timestamp = null)
    {
        cancel.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref capturing, 1, 0) != 0)
            throw new InvalidOperationException("上一帧仍在结束，请稍后重试。");
        DateTime capturedAt = default(DateTime);
        Task<Bitmap> frame = Task.Run(() =>
        {
            try { return Capture(time => capturedAt = time); }
            finally { Interlocked.Exchange(ref capturing, 0); }
        });
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            var deadline = Task.Delay(TimeSpan.FromSeconds(2), timeout.Token);
            if (await Task.WhenAny(frame, deadline) == frame)
            {
                timeout.Cancel();
                Bitmap result = await frame;
                if (cancel.IsCancellationRequested) result.Dispose();
                cancel.ThrowIfCancellationRequested();
                if (timestamp != null) timestamp(capturedAt);
                return result;
            }
        }
        // PrintWindow 可能等待目标程序结束绘制。迟到的图像只释放，不展示或传送。
        ReleaseLateFrame(frame);
        cancel.ThrowIfCancellationRequested();
        throw new InvalidOperationException("所选窗口未及时返回图像。");
    }

    private static async void ReleaseLateFrame(Task<Bitmap> pending)
    {
        try { using (await pending.ConfigureAwait(false)) { } }
        catch { }
    }

    internal static string EncodePng(Bitmap source)
    {
        double scale = Math.Min(1, 1440.0 / Math.Max(source.Width, source.Height));
        for (int attempt = 0; attempt < 3; attempt++, scale *= 0.75)
        {
            int width = Math.Max(1, (int)(source.Width * scale));
            int height = Math.Max(1, (int)(source.Height * scale));
            using (var image = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (var graphics = Graphics.FromImage(image))
            using (var output = new MemoryStream())
            {
                graphics.DrawImage(source, 0, 0, width, height);
                image.Save(output, ImageFormat.Png);
                if (output.Length <= ImageLimit) return Convert.ToBase64String(output.ToArray());
            }
        }
        throw new InvalidDataException("截图超出上传大小限制。");
    }
}
