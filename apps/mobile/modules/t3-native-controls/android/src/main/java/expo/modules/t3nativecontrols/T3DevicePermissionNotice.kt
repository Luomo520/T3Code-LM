package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.os.CountDownTimer
import android.text.SpannableString
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CompletableDeferred

/** 仅在即将弹出授权管理器时展示。离开前台后结束本次阅读，返回时可重新申请。 */
internal suspend fun readDevicePermissionNotice(activity: Activity): Boolean {
  val lifecycle = (activity as? LifecycleOwner)?.lifecycle ?: return false
  if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return false
  val heading = "此授权允许 T3 使用设备级权限"
  val message = SpannableString(
    "$heading\n\nT3 可使用授权服务安装 APK 或截取屏幕。截图可能包含其他应用的内容，并发送到发起请求的会话。你可以随时在 Shizuku 或 Sui 中撤销授权。"
  ).apply {
    setSpan(StyleSpan(Typeface.BOLD), 0, heading.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    setSpan(RelativeSizeSpan(1.25f), 0, heading.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }
  val choice = CompletableDeferred<Boolean>()
  val dialog = AlertDialog.Builder(activity)
    .setTitle("Shizuku / Sui 授权说明")
    .setMessage(message)
    .setNegativeButton("取消") { _, _ -> choice.complete(false) }
    .setPositiveButton("请阅读 10 秒", null)
    .create()
  dialog.setOnDismissListener { choice.complete(false) }
  val observer = LifecycleEventObserver { _, event ->
    if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_DESTROY) choice.complete(false)
  }
  lifecycle.addObserver(observer)
  var timer: CountDownTimer? = null
  try {
    dialog.show()
    val button = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
    button.isEnabled = false
    timer = object : CountDownTimer(10_000, 1_000) {
      override fun onTick(remaining: Long) {
        button.text = "请阅读 ${(remaining + 999) / 1000} 秒"
      }
      override fun onFinish() {
        button.text = "继续授权"
        button.isEnabled = true
      }
    }.start()
    button.setOnClickListener {
      if (button.isEnabled && dialog.window?.decorView?.hasWindowFocus() == true) choice.complete(true)
    }
    return choice.await()
  } finally {
    timer?.cancel()
    lifecycle.removeObserver(observer)
    dialog.dismiss()
  }
}
