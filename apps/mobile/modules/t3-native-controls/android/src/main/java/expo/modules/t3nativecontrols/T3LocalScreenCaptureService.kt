package expo.modules.t3nativecontrols

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

/** 单次系统投屏。只有应用内发起并仍有效的请求可建立投屏会话。 */
class T3LocalScreenCaptureService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var active: T3CaptureRequest? = null
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var images: ImageReader? = null
  private var recorder: T3ScreenVideoEncoder? = null
  private var recordingStartedMs = 0L
  private var recording = false
  private var output: File? = null
  private var screenObserverRegistered = false
  private val screenObserver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == Intent.ACTION_SCREEN_OFF) finish(false, "locked")
    }
  }
  private val projectionCallback = object : MediaProjection.Callback() {
    override fun onStop() = finish(false, "revoked")
  }
  private var recordingAction: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (action != null) {
      if (action == recordingAction) finish(true)
      else if (active == null) stopSelf()
      return START_NOT_STICKY
    }
    if (active != null) return START_NOT_STICKY
    val request = T3CaptureRequests.current
    val authorization = request?.authorization
    if (request == null || authorization == null || Build.VERSION.SDK_INT < 29) {
      stopSelf()
      return START_NOT_STICKY
    }
    active = request
    request.authorization = null
    request.finish = { keepResult, failure -> finish(keepResult, failure) }
    try {
      startForeground(
        NOTIFICATION_ID, notification(request.mode), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
      )
      ContextCompat.registerReceiver(
        this, screenObserver, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED
      )
      screenObserverRegistered = true
      if (!localCaptureUnlocked(this)) {
        finish(false, "locked")
        return START_NOT_STICKY
      }
      val manager = getSystemService(MediaProjectionManager::class.java)
      val session = checkNotNull(manager.getMediaProjection(request.resultCode, authorization))
      projection = session
      session.registerCallback(projectionCallback, handler)
      val size = checkNotNull(request.display)
      when (request.mode) {
        T3CaptureMode.SCREENSHOT -> screenshot(session, size)
        T3CaptureMode.RECORDING -> record(session, request, size)
      }
    } catch (_: Exception) {
      finish(false)
    }
    return START_NOT_STICKY
  }

  private fun captureSize(size: T3CaptureDisplay, maxEdge: Int): Pair<Int, Int> {
    val (width, height) = size
    val scale = minOf(1.0, maxEdge.toDouble() / maxOf(width, height, 1))
    // 视频编码器要求偶数宽度和高度。
    return (width * scale).toInt().coerceAtLeast(2) / 2 * 2 to
      (height * scale).toInt().coerceAtLeast(2) / 2 * 2
  }

  private fun outputFile(prefix: String, extension: String): File {
    val directory = File(cacheDir, "t3-local-screen")
    check(directory.isDirectory || directory.mkdirs())
    val staleBefore = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
    directory.listFiles()?.filter { it.lastModified() < staleBefore }?.forEach { it.delete() }
    return File.createTempFile(prefix, extension, directory).also { output = it }
  }

  private fun screenshot(session: MediaProjection, size: T3CaptureDisplay) {
    // 等系统分享窗口淡出再建立显示，静止画面也只需要收到第一帧。
    handler.postDelayed({
      try {
        val (width, height) = size
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        images = reader
        reader.setOnImageAvailableListener({ source ->
          val saved = runCatching {
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            image.use {
              check(localCaptureUnlocked(this))
              val plane = image.planes.first()
              val pixels = ByteBuffer.allocateDirect(width * height * 4)
              val rowBytes = width * 4
              val bytes = plane.buffer
              val first = bytes.position()
              // ImageReader 最后一行可省略填充字节，逐行只复制有效像素。
              for (row in 0 until height) {
                val start = first + row * plane.rowStride
                bytes.limit(bytes.capacity()).position(start).limit(start + rowBytes)
                pixels.put(bytes)
              }
              pixels.flip()
              val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
              try {
                bitmap.copyPixelsFromBuffer(pixels)
                outputFile("截图-", ".png").outputStream().use { stream ->
                  check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
                }
              } finally {
                bitmap.recycle()
              }
            }
          }.isSuccess
          finish(saved)
        }, handler)
        display = session.createVirtualDisplay("T3 截图", width, height, size.densityDpi,
          DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.surface, null, handler)
      } catch (_: RuntimeException) {
        finish(false)
      }
    }, 300)
    handler.postDelayed({ finish(false) }, 8_000)
  }

  private val drainVideo = object : Runnable {
    override fun run() {
      if (!recording) return
      try {
        recorder?.drain()
        handler.postDelayed(this, 12)
      } catch (_: Exception) {
        finish(false)
      }
    }
  }

  private fun record(session: MediaProjection, request: T3CaptureRequest, size: T3CaptureDisplay) {
    val file = outputFile("录屏-", ".mp4")
    // 会话媒体最多 5 MiB，按请求时长预留封装及码率波动空间。
    val budget = request.remoteDurationSeconds?.let { 4 * 1024 * 1024 * 8 / it.coerceAtLeast(1) }
    // 先按屏幕原始比例录制，较老编码器无法准备时逐级降低分辨率。
    val longRemote = (request.remoteDurationSeconds ?: 0) > 12
    // 长视频按回传预算降低像素数和刷新率，避免高刷页面滚动时超过上限。
    val frameRate = if (longRemote) 12 else 30
    val edges = if (longRemote) listOf(2400, 1920, 1280) else listOf(3840, 2560, 1920, 1280)
    val sizes = edges.map { captureSize(size, it) }.distinct()
    val (width, height) = sizes.first { (w, h) ->
      val bitRate = minOf((w.toLong() * h * 3).coerceIn(1_500_000L, 16_000_000L).toInt(), budget ?: Int.MAX_VALUE)
      try {
        recorder = T3ScreenVideoEncoder(file, w, h, bitRate, frameRate)
        true
      } catch (error: Exception) {
        if ((w to h) == sizes.last()) throw error
        false
      }
    }
    val video = checkNotNull(recorder)
    display = session.createVirtualDisplay("T3 录屏", width, height, size.densityDpi,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, video.surface, null, handler)
    recordingStartedMs = android.os.SystemClock.elapsedRealtime()
    recording = true
    handler.post(drainVideo)
    request.onStarted?.invoke()
    handler.postDelayed({ finish(true) }, (request.remoteDurationSeconds ?: 30) * 1_000L)
  }

  private fun finish(keepResult: Boolean, failure: String = "failed", stopService: Boolean = true) {
    val request = active ?: return
    active = null
    recordingAction = null
    handler.removeCallbacksAndMessages(null)
    // 保留录像时先完成 MP4 封装。锁屏或撤销时直接释放输入并删除临时文件。
    val unlocked = localCaptureUnlocked(this)
    val elapsedUs = (android.os.SystemClock.elapsedRealtime() - recordingStartedMs) * 1_000L
    val videoComplete = !recording || (
      keepResult && unlocked && runCatching { recorder?.finish(elapsedUs) }.isSuccess
    )
    display?.release()
    display = null
    images?.close()
    images = null
    recorder?.release()
    recorder = null
    recording = false
    projection?.unregisterCallback(projectionCallback)
    projection?.stop()
    projection = null
    if (screenObserverRegistered) {
      unregisterReceiver(screenObserver)
      screenObserverRegistered = false
    }
    val file = output
    output = null
    val saved = file?.takeIf {
      keepResult && unlocked && localCaptureUnlocked(this) && videoComplete && it.length() > 0
    }
    if (saved == null) file?.delete()
    request.resolve(saved, if (unlocked && localCaptureUnlocked(this)) failure else "locked")
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (stopService) stopSelf()
  }

  private fun notification(mode: T3CaptureMode): Notification {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "T3 屏幕捕获", NotificationManager.IMPORTANCE_LOW)
    )
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setContentTitle(if (mode == T3CaptureMode.SCREENSHOT) "T3 正在截图" else "T3 正在录屏")
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
    if (mode == T3CaptureMode.RECORDING) {
      val action = UUID.randomUUID().toString()
      recordingAction = action
      val stop = PendingIntent.getService(this, 0, Intent(this, javaClass).setAction(action),
        PendingIntent.FLAG_IMMUTABLE)
      builder.addAction(Notification.Action.Builder(null, "停止录屏", stop).build())
    }
    return builder.build()
  }

  override fun onDestroy() {
    finish(false, stopService = false)
    super.onDestroy()
  }

  private companion object {
    const val CHANNEL_ID = "t3-screen-capture"
    const val NOTIFICATION_ID = 7419
  }
}
