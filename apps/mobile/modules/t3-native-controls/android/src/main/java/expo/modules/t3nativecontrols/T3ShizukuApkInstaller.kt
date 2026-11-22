package expo.modules.t3nativecontrols

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
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

  suspend fun install(context: Context, apk: File): String? {
    check(available()) { "Shizuku / Sui 当前不可用。请在设备上启动服务后重试。" }
    check(requestPermission() && available() && authorized()) {
      "安装需要 Shizuku / Sui 授权。请检查服务和应用授权后重试。"
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
      .version(1)

    try {
      Shizuku.bindUserService(args, connection)
      val installer = withTimeoutOrNull(15_000) { service.await() }
        ?: error("连接 Shizuku / Sui 安装服务超时，请检查服务后重试。")
      check(available() && authorized()) { "Shizuku / Sui 已断开或授权已撤销。" }
      return withContext(Dispatchers.IO) {
        val pipe = installer.openInstallStream(apk.length())
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
