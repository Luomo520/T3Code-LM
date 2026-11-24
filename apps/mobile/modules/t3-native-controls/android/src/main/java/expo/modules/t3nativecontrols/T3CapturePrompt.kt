package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred

/** 只关闭本模块创建的请求框，系统共享选择器由 Android 管理。所有调用均在主线程。 */
internal class T3CapturePrompt {
  private var currentId: String? = null
  private var dialog: AlertDialog? = null

  fun dismiss(id: String? = null) {
    if (id == null || id == currentId) dialog?.dismiss()
  }

  suspend fun show(activity: Activity, id: String, title: String, message: String,
                   holdLabel: String?, remainingMs: Int): String {
    dismiss()
    if (remainingMs <= 0 || activity.isFinishing || activity.isDestroyed) return "expired"
    val choice = CompletableDeferred<String>()
    val builder = AlertDialog.Builder(activity)
      .setTitle(title).setMessage(message)
      .setNegativeButton("拒绝") { _, _ -> choice.complete("deny") }
      .setPositiveButton("继续系统授权") { _, _ -> choice.complete("once") }
      .setOnCancelListener { choice.complete("deny") }
    if (holdLabel != null) builder.setNeutralButton(holdLabel) { _, _ -> choice.complete("hold") }
    val own = builder.create()
    own.setOnDismissListener { choice.complete("expired") }
    currentId = id
    dialog = own
    val handler = Handler(Looper.getMainLooper())
    val expire = Runnable { own.dismiss() }
    try {
      own.show()
      handler.postDelayed(expire, remainingMs.toLong())
      return choice.await()
    } finally {
      handler.removeCallbacks(expire)
      if (dialog === own) {
        dialog = null
        currentId = null
      }
      own.dismiss()
    }
  }
}
