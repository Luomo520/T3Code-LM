package expo.modules.t3nativecontrols

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer

/** 将系统共享的画面直接写入 H.264，限制高刷新率屏幕送入编码器的帧数。 */
internal class T3ScreenVideoEncoder(file: File, width: Int, height: Int, bitRate: Int, frameRate: Int) {
  private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
  private var muxer: MediaMuxer? = null
  private var input: Surface? = null
  val surface: Surface get() = checkNotNull(input)
  private val info = MediaCodec.BufferInfo()
  private var track = -1
  private var firstUs = -1L
  private var lastUs = 0L

  init {
    try {
      val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
      format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
      format.setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
      format.setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, frameRate.toFloat())
      format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
      val caps = codec.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).encoderCapabilities
      if (caps?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) == true) {
        format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
      }
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      input = codec.createInputSurface()
      muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      codec.start()
    } catch (error: Exception) {
      release()
      throw error
    }
  }

  fun drain(finishing: Boolean = false) {
    val writer = checkNotNull(muxer)
    val deadline = SystemClock.elapsedRealtime() + if (finishing) 2000 else 10
    do {
      val index = codec.dequeueOutputBuffer(info, if (finishing) 10_000L else 0L)
      when {
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          track = writer.addTrack(codec.outputFormat)
          writer.start()
        }
        index >= 0 -> {
          val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          try {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              if (firstUs < 0) firstUs = info.presentationTimeUs
              info.presentationTimeUs -= firstUs
              lastUs = info.presentationTimeUs
              writer.writeSampleData(track, checkNotNull(codec.getOutputBuffer(index)), info)
            }
          } finally {
            codec.releaseOutputBuffer(index, false)
          }
          if (eos) return
        }
        index == MediaCodec.INFO_TRY_AGAIN_LATER && !finishing -> return
      }
    } while (SystemClock.elapsedRealtime() < deadline)
    check(!finishing) { "录屏编码器未及时结束" }
  }

  fun finish(elapsedUs: Long) {
    codec.signalEndOfInputStream()
    drain(true)
    check(firstUs >= 0)
    // 静止页面可能很久没有新帧，用空结束样本保留最后一帧的停留时间。
    info.set(0, 0, maxOf(lastUs + 1, elapsedUs), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
    checkNotNull(muxer).apply {
      writeSampleData(track, ByteBuffer.allocate(0), info)
      stop()
    }
  }

  fun release() {
    runCatching { codec.release() }
    input?.release()
    runCatching { muxer?.release() }
  }
}
