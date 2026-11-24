package expo.modules.t3nativecontrols

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer

/** 部分设备在静止画面上不再输出新帧。写入结束时间，让播放器保留最后一帧至停录时刻。 */
internal fun preserveRecordingDuration(file: File, elapsedUs: Long) {
  val reader = MediaExtractor()
  try {
    reader.setDataSource(file.path)
    if (reader.trackCount != 1) return
    val format = reader.getTrackFormat(0)
    if (format.containsKey(MediaFormat.KEY_DURATION) &&
      format.getLong(MediaFormat.KEY_DURATION) >= elapsedUs - 200_000) return
    reader.selectTrack(0)
    val tmp = File.createTempFile("录屏封装-", ".mp4", file.parentFile)
    try {
      val writer = MediaMuxer(tmp.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      try {
        val track = writer.addTrack(format)
        writer.start()
        val info = MediaCodec.BufferInfo()
        var buf = ByteBuffer.allocateDirect(128 * 1024)
        val first = reader.sampleTime
        check(first >= 0)
        var last = 0L
        while (reader.sampleTime >= 0) {
          val size = reader.sampleSize.toInt()
          if (buf.capacity() < size) buf = ByteBuffer.allocateDirect(size)
          buf.clear()
          val count = reader.readSampleData(buf, 0)
          check(count == size)
          val time = reader.sampleTime - first
          val flags = if (reader.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
          info.set(0, count, time, flags)
          writer.writeSampleData(track, buf, info)
          last = maxOf(last, time)
          reader.advance()
        }
        info.set(0, 0, maxOf(elapsedUs, last + 1), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        writer.writeSampleData(track, buf, info)
        writer.stop()
      } finally {
        writer.release()
      }
      check(tmp.renameTo(file))
    } finally {
      tmp.delete()
    }
  } finally {
    reader.release()
  }
}
