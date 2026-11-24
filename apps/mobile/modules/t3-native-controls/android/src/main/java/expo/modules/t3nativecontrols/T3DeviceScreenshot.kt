package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.ServiceConnection
import android.os.IBinder
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import rikka.shizuku.Shizuku
import java.io.File

/** 截取整个屏幕前在手机上说明范围；系统共享仍可只选择一个应用。 */
internal object T3DeviceScreenshot {
  suspend fun choose(activity: Activity, access: String): String {
    val result = CompletableDeferred<String>()
    val identity = if (access == "root") "Sui / Root" else "Shizuku / ADB"
    val dialog = AlertDialog.Builder(activity)
      .setTitle("选择本次截图方式")
      .setMessage("使用 $identity 将截取当前整个屏幕。系统共享可选择单个应用。")
      .setPositiveButton("截取整个屏幕") { _, _ -> result.complete("device") }
      .setNeutralButton("系统共享") { _, _ -> result.complete("system") }
      .setNegativeButton("取消") { _, _ -> result.complete("cancel") }
      .setOnCancelListener { result.complete("cancel") }.show()
    return try { result.await() } finally { dialog.dismiss() }
  }

  suspend fun capture(activity: Activity, request: T3CaptureRequest, access: String): File {
    val context = activity.applicationContext
    val service = CompletableDeferred<IT3ScreenshotService>()
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        service.complete(IT3ScreenshotService.Stub.asInterface(binder))
      }
      override fun onServiceDisconnected(name: ComponentName) {
        service.completeExceptionally(IllegalStateException("本机截图服务已断开"))
      }
    }
    val args = Shizuku.UserServiceArgs(ComponentName(context, T3ScreenshotService::class.java))
      .daemon(false).processNameSuffix("t3Screenshot").version(1)
    val dir = File(context.cacheDir, "t3-local-screen")
    check(dir.isDirectory || dir.mkdirs())
    val raw = File.createTempFile("截图-", ".png", dir)
    var delivered = false
    try {
      Shizuku.bindUserService(args, connection)
      val endpoint = withTimeout(10_000) { service.await() }
      delay(350)
      check(T3CaptureRequests.current === request && localCaptureUnlocked(context))
      check(T3ShizukuApkInstaller.accessStatus() == access)
      val uid = if (access == "adb") 2000 else 0
      withContext(Dispatchers.IO) {
        ParcelFileDescriptor.open(raw, ParcelFileDescriptor.MODE_WRITE_ONLY).use {
          check(endpoint.capture(it, uid))
        }
        check(localCaptureUnlocked(context))
        check(raw.length() > 0)
      }
      // screencap 已输出原尺寸 PNG，直接交给调用方上传并清理。
      delivered = true
      return raw
    } finally {
      runCatching { Shizuku.unbindUserService(args, connection, true) }
      if (!delivered) raw.delete()
    }
  }
}
