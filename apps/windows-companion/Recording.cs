using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal sealed class ScreenRecording : IDisposable
{
    internal const int Interval = 200;
    internal const int FrameLimit = 3000;
    private readonly BinaryWriter writer;
    private readonly Rectangle screen = Screen.PrimaryScreen.Bounds;
    private readonly List<Tuple<uint, uint>> frames = new List<Tuple<uint, uint>>();
    private readonly int width;
    private readonly int height;
    private readonly long totalFrames, streamLength, movieList, movieStart;
    private bool disposed;

    internal int Count { get { return frames.Count; } }

    internal ScreenRecording(string file)
    {
        WindowsDesktop.RequireDesktop();
        width = Math.Min(1280, screen.Width);
        height = Math.Max(1, (int)(screen.Height * (width / (double)screen.Width)));
        writer = new BinaryWriter(new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read));
        try
        {
            // 写入单流 MJPEG AVI，最终保存时补齐帧数、索引和 RIFF 长度。
            Four("RIFF"); writer.Write(0u); Four("AVI ");
            Four("LIST"); writer.Write(192u); Four("hdrl");
            Four("avih"); writer.Write(56u);
            writer.Write(Interval * 1000); writer.Write(0u); writer.Write(0u); writer.Write(16u);
            totalFrames = Position; writer.Write(0u); writer.Write(0u); writer.Write(1u);
            writer.Write(0u); writer.Write(width); writer.Write(height);
            for (int i = 0; i < 4; i++) writer.Write(0u);
            Four("LIST"); writer.Write(116u); Four("strl");
            Four("strh"); writer.Write(56u); Four("vids"); Four("MJPG");
            writer.Write(0u); writer.Write(0u); writer.Write(0u); writer.Write(1u); writer.Write(1000 / Interval);
            writer.Write(0u); streamLength = Position; writer.Write(0u);
            writer.Write(0u); writer.Write(uint.MaxValue); writer.Write(0u);
            writer.Write((short)0); writer.Write((short)0); writer.Write((short)width); writer.Write((short)height);
            Four("strf"); writer.Write(40u); writer.Write(40u); writer.Write(width); writer.Write(height);
            writer.Write((short)1); writer.Write((short)24); Four("MJPG"); writer.Write(width * height * 3);
            for (int i = 0; i < 4; i++) writer.Write(0u);
            Four("LIST"); movieList = Position; writer.Write(0u); movieStart = Position; Four("movi");
        }
        catch
        {
            writer.Dispose();
            throw;
        }
    }

    private long Position { get { return writer.BaseStream.Position; } }
    private void Four(string value) { writer.Write(Encoding.ASCII.GetBytes(value)); }

    internal void Capture()
    {
        WindowsDesktop.RequireDesktop();
        if (Screen.PrimaryScreen.Bounds != screen) throw new InvalidOperationException("主显示器尺寸已改变，录制已结束。");
        using (var source = new Bitmap(screen.Width, screen.Height, PixelFormat.Format24bppRgb))
        using (var frame = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        using (var display = Graphics.FromImage(source))
        using (var resize = Graphics.FromImage(frame))
        using (var jpeg = new MemoryStream())
        {
            display.CopyFromScreen(screen.Location, Point.Empty, screen.Size);
            resize.DrawImage(source, 0, 0, width, height);
            frame.Save(jpeg, ImageFormat.Jpeg);
            if (Position + jpeg.Length > 500000000) throw new InvalidOperationException("录像已达到 500 MB。");
            frames.Add(Tuple.Create((uint)(Position - movieStart), (uint)jpeg.Length));
            Four("00dc"); writer.Write((uint)jpeg.Length);
            writer.Write(jpeg.GetBuffer(), 0, (int)jpeg.Length);
            if (jpeg.Length % 2 != 0) writer.Write((byte)0);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try
        {
            long movieEnd = Position;
            Four("idx1"); writer.Write(frames.Count * 16);
            foreach (var frame in frames)
            {
                Four("00dc"); writer.Write(16u); writer.Write(frame.Item1); writer.Write(frame.Item2);
            }
            Update(movieList, (uint)(movieEnd - movieStart));
            Update(4, (uint)(Position - 8));
            Update(totalFrames, (uint)frames.Count);
            Update(streamLength, (uint)frames.Count);
        }
        finally { writer.Dispose(); }
    }

    private void Update(long position, uint value)
    {
        long end = Position;
        writer.BaseStream.Position = position;
        writer.Write(value);
        writer.BaseStream.Position = end;
    }
}
