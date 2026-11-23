package expo.modules.t3nativecontrols

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import rikka.shizuku.Shizuku
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

internal object T3ShizukuApkInstaller {
  const val ROOT_UID = 0
  const val ADB_UID = 2000
  const val ACCESS_CHANGED = "设备授权已变化。请选择系统安装器，或刷新设备授权后重新确认。"

  private val nextRequestCode = AtomicInteger(7346)

  private fun available() = Shizuku.pingBinder() && !Shizuku.isPreV11()

  private fun authorized() = Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED

  private suspend fun requestPermission(): Boolean = withContext(Dispatchers.Main) {
    if (authorized()) return@withContext true
    if (Shizuku.shouldShowRequestPermissionRationale()) return@withContext false

    val code = nextRequestCode.incrementAndGet()
    val decision = CompletableDeferred<Boolean>()
    val listener = Shizuku.OnRequestPermissionResultListener { requestCode, result ->
      if (requestCode == code) decision.complete(result == PackageManager.PERMISSION_GRANTED)
    }
    val disconnected = Shizuku.OnBinderDeadListener { decision.complete(false) }
    Shizuku.addRequestPermissionResultListener(listener)
    Shizuku.addBinderDeadListener(disconnected)
    try {
      Shizuku.requestPermission(code)
      withTimeoutOrNull(120_000) { decision.await() } == true
    } finally {
      Shizuku.removeRequestPermissionResultListener(listener)
      Shizuku.removeBinderDeadListener(disconnected)
    }
  }

  fun accessStatus(): String = runCatching {
    when {
      // Android 9 起，系统命令可核对安装会话与 APK 的包名。
      Build.VERSION.SDK_INT < Build.VERSION_CODES.P -> "unsupported"
      !available() -> "unavailable"
      !authorized() -> if (Shizuku.shouldShowRequestPermissionRationale()) "denied" else "available"
      Shizuku.getUid() == ROOT_UID -> "root"
      Shizuku.getUid() == ADB_UID -> "adb"
      else -> "unavailable"
    }
  }.getOrDefault("unavailable")

  suspend fun requestAccess(): String {
    if (accessStatus() == "available" && !requestPermission()) {
      return if (available()) "denied" else "unavailable"
    }
    return accessStatus()
  }

  suspend fun install(context: Context, apk: File, packageName: String, method: String): String? {
    check(accessStatus() == method) { ACCESS_CHANGED }
    val expectedUid = when (method) {
      "adb" -> ADB_UID
      "root" -> ROOT_UID
      else -> error("无法识别所选设备身份。")
    }

    val service = CompletableDeferred<IT3ApkInstallService>()
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        service.complete(IT3ApkInstallService.Stub.asInterface(binder))
      }

      override fun onServiceDisconnected(name: ComponentName) {
        service.completeExceptionally(IllegalStateException("Shizuku / Sui 安装服务已断开。"))
      }
    }
    val args = Shizuku.UserServiceArgs(ComponentName(context, T3ApkInstallService::class.java))
      .daemon(false)
      .processNameSuffix("t3ApkInstall")
      .version(2)

    try {
      Shizuku.bindUserService(args, connection)
      val installer = withTimeoutOrNull(15_000) { service.await() }
        ?: error("连接 Shizuku / Sui 安装服务超时，请检查服务后重试。")
      return withContext(Dispatchers.IO) {
        check(accessStatus() == method) { ACCESS_CHANGED }
        val pipe = installer.openInstallStream(apk.length(), expectedUid, packageName)
        val transfer = runCatching {
          ParcelFileDescriptor.AutoCloseOutputStream(pipe).use { output ->
            apk.inputStream().use { input -> input.copyTo(output) }
          }
        }
        installer.awaitInstallResult() ?: run {
          transfer.getOrThrow()
          null
        }
      }
    } finally {
      runCatching { Shizuku.unbindUserService(args, connection, true) }
    }
  }
}
