package expo.modules.t3nativecontrols

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.events.OnActivityResultPayload
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume

class T3LocalApkInstallModule : Module() {
  private val operation = Mutex()
  private var resultContinuation: Continuation<OnActivityResultPayload>? = null
  private var selection: SelectedApk? = null

  private data class SelectedApk(
    val file: File, val name: String, val packageName: String, val version: String?, val versionCode: Long
  ) {
    fun toMap() = mapOf(
      "id" to file.name, "name" to name, "packageName" to packageName,
      "version" to version, "versionCode" to versionCode.toString()
    )
  }

  override fun definition() = ModuleDefinition {
    Name("T3LocalApkInstall")

    AsyncFunction("getDeviceAccess") { T3ShizukuApkInstaller.accessStatus() }

    AsyncFunction("requestDeviceAccess").Coroutine<String> {
      runExclusive { T3ShizukuApkInstaller.requestAccess() }
    }

    AsyncFunction("getSelectedApk") {
      selection?.takeIf { it.file.isFile }?.toMap()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pickApk").Coroutine<Map<String, String?>?> {
      runExclusive {
        val result = launchForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          type = "*/*"
          putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(APK_DOWNLOAD_MIME, "application/octet-stream"))
          putExtra(Intent.EXTRA_LOCAL_ONLY, true)
          addCategory(Intent.CATEGORY_OPENABLE)
        }, PICK_APK)
        if (result.resultCode != Activity.RESULT_OK) return@runExclusive null
        val uri = result.data?.data ?: error("文件选择器未返回 APK。")
        require(uri.scheme == "content") { "文件选择器未返回可读取的 APK。" }
        val keptFile = selection?.file
        val apk = withContext(Dispatchers.IO) { prepareApk(context(), uri, keptFile) }
        selection?.file?.delete()
        selection = apk
        apk.toMap()
      }
    }

    AsyncFunction("installApk") Coroutine { id: String, method: String ->
      runExclusive {
        val apk = selection?.takeIf { it.file.name == id && it.file.isFile }
          ?: error("所选 APK 已失效，请重新选择文件。")
        val result = when (method) {
          "system" -> systemInstall(apk)
          "shizuku" -> {
            val error = T3ShizukuApkInstaller.install(context(), apk.file)
            if (error == null) mapOf("status" to "installed")
            else mapOf("status" to "failed", "message" to error)
          }
          else -> error("无法识别所选安装方式。")
        }
        if (result["status"] == "installed") {
          apk.file.delete()
          selection = null
        }
        result
      }
    }

    OnActivityResult { _, result ->
      if (result.requestCode == PICK_APK || result.requestCode == SYSTEM_INSTALL) {
        val continuation = resultContinuation
        resultContinuation = null
        continuation?.resume(result)
      }
    }
  }

  private fun context(): Context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private suspend fun <T> runExclusive(action: suspend () -> T): T = withContext(Dispatchers.Main) {
    check(operation.tryLock()) { "现有 APK 操作尚未完成。" }
    try {
      action()
    } finally {
      operation.unlock()
    }
  }

  @Suppress("DEPRECATION")
  private suspend fun launchForResult(intent: Intent, requestCode: Int): OnActivityResultPayload {
    val activity = appContext.currentActivity ?: error("请在应用前台继续操作。")
    try {
      return suspendCancellableCoroutine { continuation ->
        resultContinuation = continuation
        activity.startActivityForResult(intent, requestCode)
      }
    } finally {
      resultContinuation = null
    }
  }

  @Suppress("DEPRECATION")
  private fun prepareApk(context: Context, uri: Uri, keptFile: File?): SelectedApk {
    val resolver = context.contentResolver
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    } ?: "APK 文件"
    val directory = File(context.cacheDir, "t3-local-apk")
    check(directory.isDirectory || directory.mkdirs()) { "无法准备 APK，请检查设备存储空间。" }
    // 保留当前选择，清除应用被终止后留下的临时副本。
    directory.listFiles()?.filter { it != keptFile }?.forEach { it.delete() }
    val file = File.createTempFile("selection-", ".apk", directory)
    try {
      resolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
      } ?: error("无法读取选中的 APK 文件。")
      val info = context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        ?: error("无法解析此 APK。请选择可独立安装的 APK 文件。")
      require(info.packageName != context.packageName) { "请通过应用更新页面安装 T3Code-LM。" }
      val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
      return SelectedApk(file, name, info.packageName, info.versionName, code)
    } catch (error: Exception) {
      file.delete()
      throw error
    }
  }

  @Suppress("DEPRECATION")
  private suspend fun systemInstall(apk: SelectedApk): Map<String, String> {
    val activity = appContext.currentActivity ?: error("请在应用前台继续操作。")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
      return mapOf("status" to "permission-required")
    }
    val apkUri = FileProvider.getUriForFile(activity, "${activity.packageName}.FileSystemFileProvider", apk.file)
    val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
      data = apkUri
      putExtra(Intent.EXTRA_RETURN_RESULT, true)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val installer = activity.packageManager.resolveActivity(
      intent, PackageManager.MATCH_DEFAULT_ONLY or PackageManager.MATCH_SYSTEM_ONLY
    )?.activityInfo ?: error("系统安装器不可用，请检查设备设置。")
    intent.component = ComponentName(installer.packageName, installer.name)
    val result = launchForResult(intent, SYSTEM_INSTALL)
    return when (result.resultCode) {
      Activity.RESULT_OK -> mapOf("status" to "installed")
      Activity.RESULT_CANCELED -> mapOf("status" to "cancelled")
      else -> mapOf("status" to "failed", "message" to "Android 安装器返回错误（${
        result.data?.getIntExtra("android.intent.extra.INSTALL_RESULT", result.resultCode) ?: result.resultCode
      }）。")
    }
  }

  private companion object {
    const val PICK_APK = 7344
    const val SYSTEM_INSTALL = 7345
  }
}
