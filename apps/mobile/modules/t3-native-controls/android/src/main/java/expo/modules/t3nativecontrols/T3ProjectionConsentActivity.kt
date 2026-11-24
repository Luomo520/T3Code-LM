package expo.modules.t3nativecontrols

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle

/** 让系统选择器归属独立任务，选中 T3 自身时，主界面的 singleTask 不会清除等待结果的页面。 */
class T3ProjectionConsentActivity : Activity() {
  private val request: T3CaptureRequest?
    get() = T3CaptureRequests.current?.takeIf { it.id == intent.getStringExtra(REQUEST_ID) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pending = request
    if (pending == null) {
      finishAndRemoveTask()
      return
    }
    if (savedInstanceState != null) return
    try {
      val manager = getSystemService(MediaProjectionManager::class.java)
      startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE)
    } catch (_: RuntimeException) {
      pending.resolve(null)
      finishAndRemoveTask()
    }
  }

  @Deprecated("Android 系统投屏结果")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != CAPTURE) return
    val pending = request
    try {
      if (pending != null) {
        when {
          !localCaptureUnlocked(this) -> pending.resolve(null, "locked")
          resultCode != RESULT_OK || data == null -> pending.resolve(null, "denied")
          else -> {
            pending.display = captureDisplay(this)
            pending.authorization = data
            pending.resultCode = resultCode
            startForegroundService(Intent(this, T3LocalScreenCaptureService::class.java))
          }
        }
      }
    } catch (_: RuntimeException) {
      pending?.resolve(null)
    } finally {
      finishAndRemoveTask()
    }
  }

  internal companion object {
    private const val REQUEST_ID = "capture-request-id"
    private const val CAPTURE = 1

    fun launch(activity: Activity, id: String) {
      activity.startActivity(Intent(activity, T3ProjectionConsentActivity::class.java)
        .putExtra(REQUEST_ID, id)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK))
    }
  }
}
