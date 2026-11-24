package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
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

private fun captureMode(kind: String) = when (kind) {
  "screenshot" -> T3CaptureMode.SCREENSHOT
  "recording" -> T3CaptureMode.RECORDING
  else -> error("未知的屏幕捕获用途。")
}

internal data class T3CaptureDisplay(val width: Int, val height: Int, val densityDpi: Int)

@Suppress("DEPRECATION")
internal fun captureDisplay(activity: Activity): T3CaptureDisplay {
  val density = activity.resources.displayMetrics.densityDpi
  if (Build.VERSION.SDK_INT >= 30) {
    val bounds = activity.windowManager.maximumWindowMetrics.bounds
    return T3CaptureDisplay(bounds.width(), bounds.height(), density)
  }
  val metrics = android.util.DisplayMetrics()
  activity.windowManager.defaultDisplay.getRealMetrics(metrics)
  return T3CaptureDisplay(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
}

internal data class T3CaptureScope(
  val environment: String,
  val thread: String,
  val route: String,
  val mode: T3CaptureMode,
)

internal class T3CaptureRequest(
  val owner: String,
  val mode: T3CaptureMode,
  val id: String,
  val remoteDurationSeconds: Int?,
  val environment: String? = null,
  val sharedScope: T3CaptureScope? = null,
  val canShareInForeground: (() -> Boolean)? = null,
) {
  val result = CompletableDeferred<Map<String, String>>()
  var onConsentRequested: (() -> Unit)? = null
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
  var sharedService: T3LocalScreenCaptureService? = null

  fun stop(owner: String, keepResult: Boolean, requestId: String? = null) {
    val request = current?.takeIf { it.owner == owner && (requestId == null || it.id == requestId) } ?: return
    request.finish?.invoke(keepResult, "canceled") ?: request.resolve(null, "canceled")
  }
}

internal fun localCaptureUnlocked(context: Context): Boolean =
  context.getSystemService(PowerManager::class.java).isInteractive &&
    !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

class T3LocalScreenCaptureModule : Module() {
  private val prompt = T3CapturePrompt()
  private val owner = UUID.randomUUID().toString()

  override fun definition() = ModuleDefinition {
    Name("T3LocalScreenCapture")
    Events("onRecordingStarted", "onConsentRequested")

    AsyncFunction("showRequestPrompt").Coroutine { id: String, title: String, message: String, hold: String?, remainingMs: Int ->
      withContext(Dispatchers.Main) {
        val activity = appContext.currentActivity ?: return@withContext "expired"
        prompt.show(activity, id, title, message, hold, remainingMs)
      }
    }
    AsyncFunction("dismissRequestPrompt") { id: String -> prompt.dismiss(id) }.runOnQueue(Queues.MAIN)

    AsyncFunction("isUnlocked") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      localCaptureUnlocked(context)
    }.runOnQueue(Queues.MAIN)

    Function("getEnvironmentPolicy") { environment: String, kind: String ->
      val context = appContext.reactContext
      if (context == null) "deny" else T3CapturePolicy.read(context, environment, kind)
    }

    AsyncFunction("setEnvironmentPolicy").Coroutine { environment: String, kind: String, value: String ->
      require(value in setOf("ask", "system", "deny"))
      val context = checkNotNull(appContext.reactContext)
      withContext(Dispatchers.IO) {
        T3CapturePolicy.write(context, environment, kind, value)
      }
      withContext(Dispatchers.Main) {
        T3CaptureRequests.sharedService?.stopShare(owner, environment, "revoked")
        val current = T3CaptureRequests.current
        if (current != null && current.environment == environment &&
          current.mode == (if (kind == "screenshot") T3CaptureMode.SCREENSHOT else T3CaptureMode.RECORDING)) {
          T3CaptureRequests.stop(owner, false, current.id)
        }
      }
    }

    AsyncFunction("captureEnvironmentRequest").Coroutine { kind: String, requestId: String, seconds: Int, environment: String ->
      require(seconds in 1..30)
      capture(kind, requestId, seconds, environment)
    }

    AsyncFunction("canKeepSharing") {
      val context = appContext.reactContext
      context != null && T3LocalScreenCaptureService.shareNotificationAvailable(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("canAutoReuseSharing") { kind: String, environment: String, thread: String, route: String, seconds: Int ->
      require(seconds in 0..30)
      T3CaptureRequests.sharedService?.canReuse(
        owner, T3CaptureScope(environment, thread, route, captureMode(kind)), seconds,
      ) == true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("endSharing") { environment: String ->
      val pending = T3CaptureRequests.current
      if (pending?.owner == owner && pending.sharedScope?.environment == environment) {
        T3CaptureRequests.stop(owner, false, pending.id)
      }
      T3CaptureRequests.sharedService?.stopShare(owner, environment, "revoked")
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("captureScopedRequest").Coroutine {
      kind: String, requestId: String, seconds: Int, environment: String, thread: String, route: String, choice: String ->
      require(seconds in 1..30 && choice in setOf("hold", "reuse"))
      capture(
        kind, requestId, seconds, environment, T3CaptureScope(environment, thread, route, captureMode(kind)),
        choice == "reuse",
      )
    }

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
      val pending = T3CaptureRequests.current
      if (pending?.owner == owner && pending.id == requestId && pending.sharedScope != null) {
        T3CaptureRequests.sharedService?.stopShare(owner, pending.environment, "revoked")
      }
      T3CaptureRequests.stop(owner, false, requestId)
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersBackground {
      // 系统选择器会暂停主界面。只有已回到原界面并建立投屏后才监听离开。
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        T3CaptureRequests.sharedService?.onHostPaused(owner)
      }
    }

    OnDestroy {
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        prompt.dismiss()
        T3CaptureRequests.sharedService?.stopShare(owner, null, "revoked")
        T3CaptureRequests.stop(owner, false)
      }
    }
  }

  private suspend fun capture(
    kind: String,
    requestId: String,
    remoteDurationSeconds: Int?,
    environment: String? = null,
    sharedScope: T3CaptureScope? = null,
    reuse: Boolean = false,
  ): Map<String, String> =
    withContext(Dispatchers.Main) {
      val mode = captureMode(kind)
      check(Build.VERSION.SDK_INT >= 29) { "此 Android 版本不支持会话屏幕捕获。" }
      val activity = appContext.currentActivity ?: error("请回到会话后重试。")
      if (!localCaptureUnlocked(activity)) return@withContext mapOf("status" to "locked")
      val inForeground = {
        appContext.currentActivity === activity &&
          (activity as? LifecycleOwner)?.lifecycle?.currentState == Lifecycle.State.RESUMED
      }
      val visible = if (remoteDurationSeconds == null) activity.hasWindowFocus() else inForeground()
      check(visible) { "请回到会话后再确认本次屏幕捕获。" }
      check(T3CaptureRequests.current == null) { "已有屏幕捕获请求，请先结束它。" }
      val setting = environment?.let { T3CapturePolicy.read(activity, it, kind) } ?: "ask"
      if (setting !in setOf("ask", "system")) return@withContext mapOf("status" to "denied")
      if (sharedScope != null &&
        (setting != "ask" || !T3LocalScreenCaptureService.shareNotificationAvailable(activity))
      ) {
        T3CaptureRequests.sharedService?.stopShare(owner, environment, "revoked")
        return@withContext mapOf("status" to if (reuse) "sharing_unavailable" else "revoked")
      }
      val existing = T3CaptureRequests.sharedService
      if (reuse && (sharedScope == null ||
          existing?.canReuse(owner, sharedScope, remoteDurationSeconds ?: 0) != true)
      ) {
        return@withContext mapOf("status" to "sharing_unavailable")
      }
      if (!reuse) existing?.stopShare(owner, null, "canceled")
      val request = T3CaptureRequest(
        owner, mode, requestId, remoteDurationSeconds, environment, sharedScope,
        inForeground.takeIf { sharedScope != null },
      )
      T3CaptureRequests.current = request
      request.onConsentRequested = { sendEvent("onConsentRequested", mapOf("requestId" to requestId)) }
      request.onStarted = { sendEvent("onRecordingStarted", mapOf("requestId" to requestId)) }
      try {
        if (reuse) {
          checkNotNull(existing).startSharedRequest(request)
          return@withContext request.result.await()
        }
        if (sharedScope != null) {
          T3ProjectionConsentActivity.launch(activity, request.id)
          return@withContext request.result.await()
        }
        val access = if (setting == "ask" && mode == T3CaptureMode.SCREENSHOT) T3ShizukuApkInstaller.accessStatus() else null
        val method = if (access == "root" || access == "adb") T3DeviceScreenshot.choose(activity, access) else "system"
        if (T3CaptureRequests.current === request) {
          when (method) {
            "cancel" -> request.resolve(null, "canceled")
            "device" -> {
              val file = T3DeviceScreenshot.capture(activity, request, checkNotNull(access))
              if (localCaptureUnlocked(activity)) request.resolve(file)
              else { file.delete(); request.resolve(null, "locked") }
            }
            else -> T3ProjectionConsentActivity.launch(activity, request.id)
          }
        }
        request.result.await()
      } finally {
        if (T3CaptureRequests.current === request) T3CaptureRequests.stop(owner, false)
      }
    }

}
