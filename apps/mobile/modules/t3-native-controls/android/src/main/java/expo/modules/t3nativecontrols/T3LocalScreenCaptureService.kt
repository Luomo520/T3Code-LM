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
import android.os.SystemClock
import android.view.Surface
import androidx.core.content.ContextCompat
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

/** 系统投屏只在机主确认后启动。短时共享空闲时不连接截图或录像输出。 */
class T3LocalScreenCaptureService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val captureHandler = Handler(Looper.getMainLooper())
  private data class Share(
    val owner: String,
    val scope: T3CaptureScope,
    val canUseForeground: () -> Boolean,
    val expiresAt: Long,
  )
  private var share: Share? = null
  private var shareAction: String? = null
  private var sourceSize: T3CaptureDisplay? = null
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
      if (intent.action == Intent.ACTION_SCREEN_OFF) shutdown("locked")
    }
  }
  private val projectionCallback = object : MediaProjection.Callback() {
    override fun onStop() = shutdown("revoked")

    override fun onCapturedContentResize(width: Int, height: Int) {
      if (width > 0 && height > 0) {
        sourceSize = sourceSize?.copy(width = width, height = height)
      }
    }
  }
  private var recordingAction: String? = null

  private fun shareFailure(session: Share): String? = when {
    !localCaptureUnlocked(this) -> "locked"
    SystemClock.elapsedRealtime() >= session.expiresAt -> "revoked"
    !shareNotificationAvailable(this) || !shareNotificationPosted() || !session.canUseForeground() -> "revoked"
    else -> null
  }

  internal fun canReuse(owner: String, scope: T3CaptureScope, seconds: Int): Boolean {
    val session = share ?: return false
    val failure = shareFailure(session)
    if (failure != null) {
      shutdown(failure)
      return false
    }
    if (session.owner != owner || session.scope != scope || active != null) return false
    // 临近超时的录屏通过逐次授权，避免在共享到期时截断录像。
    return scope.mode != T3CaptureMode.RECORDING || seconds == 0 ||
      session.expiresAt - SystemClock.elapsedRealtime() >= seconds * 1_000L + 500L
  }

  internal fun stopShare(owner: String, environment: String?, reason: String) {
    val session = share ?: return
    if (session.owner == owner && (environment == null || session.scope.environment == environment)) {
      shutdown(reason)
    }
  }

  internal fun onHostPaused(owner: String) {
    val session = share ?: return
    if (session.owner == owner && !session.canUseForeground()) shutdown("revoked")
  }

  private fun shareNotificationPosted(): Boolean =
    getSystemService(NotificationManager::class.java).activeNotifications.any {
      it.id == NOTIFICATION_ID && it.notification.channelId == SHARE_CHANNEL_ID
    }

  internal fun startSharedRequest(request: T3CaptureRequest) {
    val scope = request.sharedScope
    if (scope == null || !canReuse(request.owner, scope, request.remoteDurationSeconds ?: 0)) {
      request.resolve(null, "sharing_unavailable")
      return
    }
    accept(request)
    startCapture(request)
  }

  private val watchShare = object : Runnable {
    override fun run() {
      val session = share ?: return
      val failure = shareFailure(session)
      if (failure != null) shutdown(failure)
      else handler.postDelayed(this, 250)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (action != null) {
      if (action == shareAction) shutdown("revoked")
      else if (action == recordingAction) finishCapture(true)
      else if (active == null && share == null) stopSelf()
      return START_NOT_STICKY
    }
    if (active != null || share != null) return START_NOT_STICKY
    val request = T3CaptureRequests.current
    val authorization = request?.authorization
    if (request == null || authorization == null || Build.VERSION.SDK_INT < 29) {
      stopSelf()
      return START_NOT_STICKY
    }
    accept(request)
    request.authorization = null
    try {
      if (request.sharedScope != null && !shareNotificationAvailable(this)) {
        shutdown("revoked")
        return START_NOT_STICKY
      }
      startForeground(
        NOTIFICATION_ID, notification(request.mode, request.sharedScope != null),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
      )
      ContextCompat.registerReceiver(
        this, screenObserver, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED
      )
      screenObserverRegistered = true
      if (!localCaptureUnlocked(this)) {
        shutdown("locked")
        return START_NOT_STICKY
      }
      val manager = getSystemService(MediaProjectionManager::class.java)
      val session = checkNotNull(manager.getMediaProjection(request.resultCode, authorization))
      projection = session
      session.registerCallback(projectionCallback, handler)
      sourceSize = checkNotNull(request.display)
      val scope = request.sharedScope
      if (scope == null) startCapture(request)
      else waitForHost(request, scope, SystemClock.elapsedRealtime() + 5_000L)
    } catch (_: Exception) {
      shutdown("failed")
    }
    return START_NOT_STICKY
  }

  private fun accept(request: T3CaptureRequest) {
    active = request
    request.finish = { keepResult, failure ->
      if (keepResult) finishCapture(true, failure) else shutdown(failure)
    }
  }

  private fun waitForHost(request: T3CaptureRequest, scope: T3CaptureScope, deadline: Long) {
    val canUseForeground = checkNotNull(request.canShareInForeground)
    if (!localCaptureUnlocked(this)) {
      shutdown("locked")
    } else if (SystemClock.elapsedRealtime() >= deadline || !shareNotificationAvailable(this)) {
      shutdown("revoked")
    } else if (canUseForeground() && shareNotificationPosted()) {
      share = Share(request.owner, scope, canUseForeground, SystemClock.elapsedRealtime() + SHARE_MS)
      T3CaptureRequests.sharedService = this
      handler.post(watchShare)
      handler.postDelayed({ shutdown("revoked") }, SHARE_MS)
      startCapture(request)
    } else {
      handler.postDelayed({ waitForHost(request, scope, deadline) }, 100)
    }
  }

  private fun startCapture(request: T3CaptureRequest) {
    try {
      val size = checkNotNull(sourceSize)
      when (request.mode) {
        T3CaptureMode.SCREENSHOT -> screenshot(size)
        T3CaptureMode.RECORDING -> record(request, size)
      }
    } catch (_: Exception) {
      shutdown("failed")
    }
  }

  private fun connectSurface(surface: Surface, width: Int, height: Int, density: Int) {
    // 同一次系统投屏只创建一次虚拟显示。后续请求调整尺寸并接上该次请求的 Surface。
    val current = display
    if (current == null) {
      display = checkNotNull(projection).createVirtualDisplay(
        "T3 屏幕捕获", width, height, density, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        surface, null, handler,
      )
      checkNotNull(display)
    } else {
      current.resize(width, height, density)
      current.setSurface(surface)
    }
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

  private fun screenshot(size: T3CaptureDisplay) {
    // 等系统分享窗口淡出再建立显示，静止画面也只需要收到第一帧。
    captureHandler.postDelayed({
      try {
        val (width, height) = sourceSize ?: size
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        images = reader
        reader.setOnImageAvailableListener({ source ->
          if (images !== source) return@setOnImageAvailableListener
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
          finishCapture(saved)
        }, handler)
        connectSurface(reader.surface, width, height, size.densityDpi)
      } catch (_: RuntimeException) {
        shutdown("failed")
      }
    }, 300)
    captureHandler.postDelayed({ shutdown("failed") }, 8_000)
  }

  private val drainVideo = object : Runnable {
    override fun run() {
      if (!recording) return
      try {
        recorder?.drain()
        captureHandler.postDelayed(this, 12)
      } catch (_: Exception) {
        shutdown("failed")
      }
    }
  }

  private fun record(request: T3CaptureRequest, size: T3CaptureDisplay) {
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
    connectSurface(video.surface, width, height, size.densityDpi)
    recordingStartedMs = android.os.SystemClock.elapsedRealtime()
    recording = true
    if (share != null) {
      // 每段录像有自己的停止按钮，上一段的旧通知不能截断下一段。
      recordingAction = UUID.randomUUID().toString()
      updateSharedRecordingNotification()
    }
    captureHandler.post(drainVideo)
    request.onStarted?.invoke()
    captureHandler.postDelayed({ finishCapture(true) }, (request.remoteDurationSeconds ?: 30) * 1_000L)
  }

  private fun finishCapture(keepResult: Boolean, failure: String = "failed") {
    if (active == null) return
    val session = share
    val invalid = session?.let(::shareFailure)
    if (invalid != null) {
      shutdown(invalid)
      return
    }
    finishOutput(keepResult, failure)
    if (session == null) shutdown(failure)
    else if (session.scope.mode == T3CaptureMode.RECORDING) updateSharedRecordingNotification()
  }

  private fun finishOutput(keepResult: Boolean, failure: String) {
    val request = active ?: return
    active = null
    captureHandler.removeCallbacksAndMessages(null)
    // 空闲时断开输出，新的截图或录屏请求才会再次获得屏幕内容。
    runCatching { display?.setSurface(null) }
    val unlocked = localCaptureUnlocked(this)
    val elapsedUs = (SystemClock.elapsedRealtime() - recordingStartedMs) * 1_000L
    val videoComplete = !recording || (
      keepResult && unlocked && runCatching { recorder?.finish(elapsedUs) }.isSuccess
    )
    images?.setOnImageAvailableListener(null, null)
    images?.close()
    images = null
    recorder?.release()
    recorder = null
    recording = false
    recordingAction = null
    val file = output
    output = null
    val stillValid = share?.let(::shareFailure) == null
    val saved = file?.takeIf {
      keepResult && unlocked && stillValid && localCaptureUnlocked(this) && videoComplete && it.length() > 0
    }
    if (saved == null) file?.delete()
    request.resolve(saved, if (unlocked && localCaptureUnlocked(this)) failure else "locked")
  }

  private fun shutdown(failure: String, stopService: Boolean = true) {
    if (T3CaptureRequests.sharedService === this) T3CaptureRequests.sharedService = null
    share = null
    shareAction = null
    recordingAction = null
    handler.removeCallbacksAndMessages(null)
    finishOutput(false, failure)
    display?.release()
    display = null
    projection?.unregisterCallback(projectionCallback)
    projection?.stop()
    projection = null
    sourceSize = null
    if (screenObserverRegistered) {
      unregisterReceiver(screenObserver)
      screenObserverRegistered = false
    }
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (stopService) stopSelf()
  }

  private fun notification(mode: T3CaptureMode, holding: Boolean): Notification {
    val channel = if (holding) SHARE_CHANNEL_ID else CHANNEL_ID
    createCaptureChannel(this, channel)
    val builder = Notification.Builder(this, channel)
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setContentTitle(when {
        holding -> "T3 会话正在共享屏幕"
        mode == T3CaptureMode.SCREENSHOT -> "T3 正在截图"
        else -> "T3 正在录屏"
      })
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
    fun actionIntent(action: String): PendingIntent = PendingIntent.getService(
      this, 0, Intent(this, javaClass).setAction(action), PendingIntent.FLAG_IMMUTABLE
    )
    if (holding) {
      // 更新通知时沿用同一共享的撤销入口，即使机主点的是尚未刷新的旧通知也有效。
      val end = actionIntent(shareAction ?: UUID.randomUUID().toString().also { shareAction = it })
      recordingAction?.let {
        builder.addAction(Notification.Action.Builder(null, "停止并回传", actionIntent(it)).build())
      }
      builder.addAction(Notification.Action.Builder(null, "结束共享", end).build())
      if (Build.VERSION.SDK_INT >= 31) {
        builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      }
      val kind = if (mode == T3CaptureMode.SCREENSHOT) "截图" else "录屏"
      builder.setContentText(if (recording) "正在录屏，可提前回传到原会话" else "原会话的${kind}请求会自动处理，最多 60 秒")
      builder.setDeleteIntent(end)
    } else if (mode == T3CaptureMode.RECORDING) {
      val action = UUID.randomUUID().toString().also { recordingAction = it }
      builder.addAction(Notification.Action.Builder(null, "停止录屏", actionIntent(action)).build())
    }
    return builder.build()
  }

  private fun updateSharedRecordingNotification() {
    getSystemService(NotificationManager::class.java).notify(
      NOTIFICATION_ID, notification(T3CaptureMode.RECORDING, true)
    )
  }

  override fun onDestroy() {
    shutdown("revoked", stopService = false)
    super.onDestroy()
  }

  internal companion object {
    private const val CHANNEL_ID = "t3-screen-capture"
    private const val SHARE_CHANNEL_ID = "t3-screen-sharing"
    private const val NOTIFICATION_ID = 7419
    private const val SHARE_MS = 60_000L

    private fun createCaptureChannel(context: Context, channel: String) {
      val title = if (channel == SHARE_CHANNEL_ID) "T3 屏幕共享" else "T3 屏幕捕获"
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(channel, title, NotificationManager.IMPORTANCE_LOW)
      )
    }

    fun shareNotificationAvailable(context: Context): Boolean {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (!manager.areNotificationsEnabled()) return false
      createCaptureChannel(context, SHARE_CHANNEL_ID)
      return (manager.getNotificationChannel(SHARE_CHANNEL_ID)?.importance ?: 0) >
        NotificationManager.IMPORTANCE_NONE
    }
  }
}
