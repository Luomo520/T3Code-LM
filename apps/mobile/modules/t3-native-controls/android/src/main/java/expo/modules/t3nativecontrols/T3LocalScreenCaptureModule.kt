package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.PowerManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

internal enum class T3CaptureMode { SCREENSHOT, RECORDING }

internal data class T3CaptureDisplay(val width: Int, val height: Int, val densityDpi: Int)

@Suppress("DEPRECATION")
private fun captureDisplay(activity: Activity): T3CaptureDisplay {
  val density = activity.resources.displayMetrics.densityDpi
  if (Build.VERSION.SDK_INT >= 30) {
    val bounds = activity.windowManager.maximumWindowMetrics.bounds
    return T3CaptureDisplay(bounds.width(), bounds.height(), density)
  }
  val metrics = android.util.DisplayMetrics()
  activity.windowManager.defaultDisplay.getRealMetrics(metrics)
  return T3CaptureDisplay(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
}

internal class T3CaptureRequest(
  val owner: String,
  val mode: T3CaptureMode,
  val id: String,
  val remoteDurationSeconds: Int?,
) {
  val result = CompletableDeferred<Map<String, String>>()
  var onStarted: (() -> Unit)? = null
  var finish: ((Boolean, String) -> Unit)? = null
  var authorization: Intent? = null
  var display: T3CaptureDisplay? = null
  var resultCode: Int = Activity.RESULT_CANCELED

  fun resolve(file: File?, failure: String = "failed") {
    if (T3CaptureRequests.current !== this) {
      file?.delete()
      return
    }
    authorization = null
    T3CaptureRequests.current = null
    finish = null
    onStarted = null
    result.complete(file?.let {
      mapOf("status" to "done", "name" to it.name, "uri" to android.net.Uri.fromFile(it).toString())
    } ?: mapOf("status" to failure))
  }
}

/** 仅在主线程保存当前请求，Android 投屏令牌只交给同进程前台服务一次。 */
internal object T3CaptureRequests {
  var current: T3CaptureRequest? = null

  fun stop(owner: String, keepResult: Boolean, requestId: String? = null) {
    val request = current?.takeIf { it.owner == owner && (requestId == null || it.id == requestId) } ?: return
    request.finish?.invoke(keepResult, "canceled") ?: request.resolve(null, "canceled")
  }
}

internal fun localCaptureUnlocked(context: Context): Boolean =
  context.getSystemService(PowerManager::class.java).isInteractive &&
    !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

class T3LocalScreenCaptureModule : Module() {
  private val owner = UUID.randomUUID().toString()
  private var systemRequest: T3CaptureRequest? = null

  override fun definition() = ModuleDefinition {
    Name("T3LocalScreenCapture")
    Events("onRecordingStarted")

    AsyncFunction("isUnlocked") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      localCaptureUnlocked(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("capture").Coroutine { kind: String, requestId: String ->
      val result = capture(kind, requestId, null)
      result.takeIf { it["status"] == "done" }
    }

    AsyncFunction("captureApprovedRequest").Coroutine { kind: String, requestId: String, seconds: Int ->
      require(seconds in 1..30)
      capture(kind, requestId, seconds)
    }

    AsyncFunction("stopRecording") { requestId: String ->
      if (T3CaptureRequests.current?.mode == T3CaptureMode.RECORDING) {
        T3CaptureRequests.stop(owner, true, requestId)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelCapture") { requestId: String ->
      T3CaptureRequests.stop(owner, false, requestId)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { activity, response ->
      if (response.requestCode != REQUEST_CAPTURE) return@OnActivityResult
      val request = systemRequest ?: return@OnActivityResult
      systemRequest = null
      // 面板已经离开时，丢弃迟到的系统授权。
      if (T3CaptureRequests.current !== request) return@OnActivityResult
      val data = response.data
      if (!localCaptureUnlocked(activity)) {
        request.resolve(null, "locked")
      } else if (response.resultCode != Activity.RESULT_OK || data == null) {
        request.resolve(null, "denied")
      } else {
        try {
          request.display = captureDisplay(activity)
          request.authorization = data
          request.resultCode = response.resultCode
          activity.startForegroundService(Intent(activity, T3LocalScreenCaptureService::class.java))
        } catch (_: RuntimeException) {
          request.resolve(null)
        }
      }
    }

    OnDestroy {
      android.os.Handler(android.os.Looper.getMainLooper()).post { T3CaptureRequests.stop(owner, false) }
    }
  }

  private suspend fun capture(kind: String, requestId: String, remoteDurationSeconds: Int?): Map<String, String> =
    withContext(Dispatchers.Main) {
      val mode = when (kind) {
        "screenshot" -> T3CaptureMode.SCREENSHOT
        "recording" -> T3CaptureMode.RECORDING
        else -> error("未知的屏幕捕获用途。")
      }
      check(Build.VERSION.SDK_INT >= 29) { "此 Android 版本不支持会话屏幕捕获。" }
      val activity = appContext.currentActivity ?: error("请回到会话后重试。")
      if (!localCaptureUnlocked(activity)) return@withContext mapOf("status" to "locked")
      val visible = if (remoteDurationSeconds == null) activity.hasWindowFocus()
        else (activity as? LifecycleOwner)?.lifecycle?.currentState == Lifecycle.State.RESUMED
      check(visible) { "请回到会话后再确认本次屏幕捕获。" }
      check(T3CaptureRequests.current == null && systemRequest == null) { "已有屏幕捕获请求，请先结束它。" }
      val request = T3CaptureRequest(owner, mode, requestId, remoteDurationSeconds)
      T3CaptureRequests.current = request
      systemRequest = request
      request.onStarted = { sendEvent("onRecordingStarted", mapOf("requestId" to requestId)) }
      try {
        launchConsent(activity)
        request.result.await()
      } finally {
        if (T3CaptureRequests.current === request) T3CaptureRequests.stop(owner, false)
      }
    }

  @Suppress("DEPRECATION")
  private fun launchConsent(activity: Activity) {
    try {
      val manager = activity.getSystemService(MediaProjectionManager::class.java)
      activity.startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    } catch (cause: RuntimeException) {
      systemRequest = null
      throw cause
    }
  }

  private companion object {
    const val REQUEST_CAPTURE = 0x7491
  }
}
