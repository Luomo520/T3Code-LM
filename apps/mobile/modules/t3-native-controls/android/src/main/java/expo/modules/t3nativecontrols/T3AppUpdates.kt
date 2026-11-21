package expo.modules.t3nativecontrols

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.URL
import java.security.MessageDigest

/** Owns one explicitly requested update and keeps a completed package available for installation. */
object T3AppUpdates {
  private const val STORE = "t3-app-update"
  private const val REPOSITORY_PATH = "/Luomo520/T3Code-LM/releases/download/"

  private fun preferences(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  @Synchronized
  private fun rememberCompleted(context: Context, id: String, uri: Uri) {
    val store = preferences(context)
    if (store.all["id"] != id) throw InterruptedException()
    if (!store.edit().putString("uri", uri.toString()).commit()) {
      throw DownloadFailure("无法保存更新任务，请重试。")
    }
  }

  @Synchronized
  fun enqueue(context: Context, url: String, fileName: String, version: String,
              versionCode: Int, sizeBytes: Double, sha256: String, allowMetered: Boolean): String {
    val uri = Uri.parse(url)
    val versionMatch = Regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-([1-9][0-9]*)$").matchEntire(version)
    require(versionMatch != null && versionCode >= 35 && sizeBytes > 0 &&
      sizeBytes.isFinite() && sizeBytes % 1.0 == 0.0 && sizeBytes <= 9007199254740991.0 &&
      Regex("^[a-f0-9]{64}$").matches(sha256)) { "更新包信息不完整，请重新检查更新。" }
    require(fileName == "T3Code-LM-$version-android-arm64-apk.apk" ||
      fileName == "T3Code-LM-$version-android-universal-apk.apk") { "更新包名称与版本不一致。" }
    require(uri.scheme == "https" && uri.host == "github.com" && uri.port == -1 &&
      uri.userInfo == null && uri.query == null && uri.fragment == null &&
      uri.path == "${REPOSITORY_PATH}v$version/$fileName") { "更新地址不属于此项目的 GitHub 发布包。" }
    val installed = context.packageManager.getPackageInfo(context.packageName, 0)
    require(versionCode > code(installed)) { "此更新包的构建号不高于已安装版本，请重新检查更新。" }
    val store = preferences(context)
    val existing = status(context)
    if (existing != null && existing["status"] !in listOf("failed", "missing")) {
      require(store.getString("sha256", null) == sha256) { "已有更新下载，请先完成或取消该任务。" }
      return existing.getValue("id") as String
    }
    if (existing != null) cancel(context)
    File(context.cacheDir, "t3-app-updates").deleteRecursively()
    val application = context.applicationContext
    val task = DownloadTask(URL(url), fileName, allowMetered, sizeBytes.toLong()) { id, destination ->
      rememberCompleted(application, id, destination)
    }
    check(store.edit().clear().putString("id", task.id).putString("fileName", fileName)
      .putString("version", version).putInt("versionCode", versionCode)
      .putLong("sizeBytes", sizeBytes.toLong()).putString("sha256", sha256).commit()) {
      "无法保存更新任务，请重试。"
    }
    try {
      T3Downloads.start(application, task)
    } catch (error: Exception) {
      store.edit().clear().apply()
      throw error
    }
    return task.id
  }

  @Synchronized
  fun status(context: Context): Map<String, Any>? {
    val store = preferences(context)
    val id = store.all["id"]?.toString() ?: return null
    if (code(context.packageManager.getPackageInfo(context.packageName, 0)) >= store.getInt("versionCode", Int.MAX_VALUE)) {
      File(context.cacheDir, "t3-app-updates").deleteRecursively()
      store.edit().clear().apply()
      return null
    }
    val base = mapOf<String, Any>("id" to id,
      "fileName" to (store.getString("fileName", "") ?: ""),
      "version" to (store.getString("version", "") ?: ""))
    val state = T3Downloads.get(id)?.state
    if (state?.status == "cancelled") {
      cancel(context)
      return null
    }
    val total = store.getLong("sizeBytes", 0)
    val uri = store.getString("uri", null)?.let(Uri::parse)
    val current = when {
      state != null && state.status != "downloaded" -> state
      uri == null -> DownloadState("missing", total = total)
      canRead(context, uri) -> DownloadState("downloaded", total, total, uri)
      else -> DownloadState("missing", total = total)
    }
    return base + current.toMap()
  }

  private fun canRead(context: Context, uri: Uri): Boolean = try {
    context.contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false
  } catch (_: Exception) {
    false
  }

  /** Never called on completion: installation always starts from a user action. */
  @Synchronized
  fun openInstaller(context: Context) {
    val state = status(context)
    require(state?.get("status") == "downloaded") { "更新包尚未下载完成，请稍后刷新。" }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      error("请允许此 App 安装应用，然后返回再次点击“校验并安装”。")
    }
    val store = preferences(context)
    val uri = store.getString("uri", null)?.let(Uri::parse)
      ?: error("下载文件已不存在，请重新下载。")
    val directory = File(context.cacheDir, "t3-app-updates")
    check(directory.isDirectory || directory.mkdirs()) { "无法准备安装文件，请检查可用空间。" }
    val apk = File(directory, "update.apk")
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      val expectedBytes = store.getLong("sizeBytes", -1)
      var bytes = 0L
      context.contentResolver.openInputStream(uri)?.use { input ->
        apk.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            bytes += count
            check(bytes <= expectedBytes) { "更新包大小不匹配，请删除此下载后重试。" }
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
          }
        }
      } ?: error("无法读取更新文件，请重新下载。")
      val actualHash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
      check(bytes == expectedBytes && actualHash == store.getString("sha256", null)) {
        "更新包校验失败，请删除此下载后重试。"
      }
      @Suppress("DEPRECATION")
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      val archive = context.packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
        ?: error("此文件不是可安装的 APK。")
      val installed = context.packageManager.getPackageInfo(context.packageName, flags)
      check(archive.packageName == context.packageName && archive.versionName == store.getString("version", null) &&
        code(archive) == store.getInt("versionCode", -1).toLong() && code(archive) > code(installed)) {
        "APK 内部应用标识或版本不匹配，未启动安装。"
      }
      check(signatures(archive).isNotEmpty() && signatures(archive) == signatures(installed)) {
        "APK 签名与已安装应用不一致，未启动安装。"
      }
      val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.FileSystemFileProvider", apk)
      context.startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, APK_DOWNLOAD_MIME)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    } catch (error: Exception) {
      apk.delete()
      throw error
    }
  }

  @Synchronized
  fun cancel(context: Context) {
    val store = preferences(context)
    store.all["id"]?.toString()?.let { T3Downloads.get(it)?.cancel() }
    store.getString("uri", null)?.let { T3DownloadDestination.remove(context, Uri.parse(it)) }
    store.edit().clear().apply()
    File(context.cacheDir, "t3-app-updates").deleteRecursively()
  }

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signatures(info: PackageInfo): Set<String> {
    val values = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else info.signatures
    return values?.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }?.toSet() ?: emptySet()
  }
}
