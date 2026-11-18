package expo.modules.t3nativecontrols

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest

/** One explicit APK download, owned by Android and recoverable after the app exits. */
object T3AppUpdates {
  private const val STORE = "t3-app-update"
  private const val APK_MIME = "application/vnd.android.package-archive"
  private const val REPOSITORY_PATH = "/Luomo520/T3Code-LM/releases/download/"

  private fun preferences(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
  private fun manager(context: Context) = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

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
      return store.getLong("id", -1).toString()
    }
    val previousId = store.getLong("id", -1)
    if (previousId >= 0) manager(context).remove(previousId)
    File(context.cacheDir, "t3-app-updates").deleteRecursively()
    val request = DownloadManager.Request(uri)
      .setTitle(fileName)
      .setDescription("T3Code-LM 更新 · 下载完成后返回 App 校验并安装")
      .setMimeType(APK_MIME)
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      .setAllowedOverMetered(allowMetered)
      .setAllowedOverRoaming(false)
      .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "T3Code/$fileName")
    val id = manager(context).enqueue(request)
    check(store.edit().clear().putLong("id", id).putString("fileName", fileName)
      .putString("version", version).putInt("versionCode", versionCode)
      .putLong("sizeBytes", sizeBytes.toLong()).putString("sha256", sha256).commit()) {
      manager(context).remove(id)
      "无法保存更新任务，请重试。"
    }
    return id.toString()
  }

  @Synchronized
  fun status(context: Context): Map<String, Any>? {
    val store = preferences(context)
    val id = store.getLong("id", -1)
    if (id < 0) return null
    if (code(context.packageManager.getPackageInfo(context.packageName, 0)) >= store.getInt("versionCode", Int.MAX_VALUE)) {
      File(context.cacheDir, "t3-app-updates").deleteRecursively()
      store.edit().clear().apply()
      return null
    }
    val base = mutableMapOf<String, Any>("id" to id.toString(),
      "fileName" to (store.getString("fileName", "") ?: ""),
      "version" to (store.getString("version", "") ?: ""))
    manager(context).query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
      if (cursor.moveToFirst()) {
        val state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        base["status"] = when (state) {
          DownloadManager.STATUS_SUCCESSFUL -> "downloaded"
          DownloadManager.STATUS_FAILED -> "failed"
          DownloadManager.STATUS_PAUSED -> "paused"
          DownloadManager.STATUS_RUNNING -> "downloading"
          else -> "pending"
        }
        base["bytesDownloaded"] = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble()
        base["totalBytes"] = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble()
        base["reason"] = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        return base
      }
    }
    base["status"] = "missing"
    return base
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
    val id = store.getLong("id", -1)
    val uri = manager(context).getUriForDownloadedFile(id) ?: error("下载文件已不存在，请重新下载。")
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
        setDataAndType(contentUri, APK_MIME)
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
    val id = store.getLong("id", -1)
    if (id >= 0) manager(context).remove(id)
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
