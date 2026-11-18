package expo.modules.t3nativecontrols

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.Build
import java.io.File

/** Uses the system service; no app worker, polling timer or foreground service. */
object T3FileDownloads {
  @Synchronized
  fun enqueue(context: Context, rawUrl: String, rawName: String): String {
    val uri = Uri.parse(rawUrl)
    require((uri.scheme == "http" || uri.scheme == "https") && uri.host != null &&
      uri.userInfo == null && uri.path?.startsWith("/api/assets/") == true) {
      "下载地址无效，请重新点击下载。"
    }
    var base = rawName.map { if (it.code < 32 || it in "/\\:*?\"<>|") '_' else it }
      .joinToString("").trim().trimEnd('.').take(160).ifEmpty { "download" }
    while (base.toByteArray(Charsets.UTF_8).size > 200) base = base.dropLast(1)
    if (base.lastOrNull()?.isHighSurrogate() == true) base = base.dropLast(1)
    val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "T3Code")
    // On scoped-storage Android, let the system download provider create the folder.
    if (Build.VERSION.SDK_INT < 29) {
      check(directory.isDirectory || directory.mkdirs()) { "无法创建 Download/T3Code，请检查存储权限和剩余空间。" }
    }
    val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    val reserved = mutableSetOf<String>()
    manager.query(DownloadManager.Query())?.use { cursor ->
      while (cursor.moveToNext()) {
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        if (status != DownloadManager.STATUS_FAILED && status != DownloadManager.STATUS_SUCCESSFUL) {
          val local = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
          Uri.parse(local ?: "").lastPathSegment?.let { reserved.add(it) }
          reserved.add(cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)))
        }
      }
    }
    val dot = base.lastIndexOf('.').takeIf { it > 0 } ?: base.length
    val stem = base.substring(0, dot)
    val extension = base.substring(dot)
    var name = base
    var index = 1
    while (File(directory, name).exists() || reserved.contains(name)) {
      name = "$stem ($index)$extension"
      index++
    }
    val request = DownloadManager.Request(uri)
      .setTitle(name)
      .setDescription("T3 Code · Download/T3Code")
      .setMimeType("application/octet-stream")
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      .setAllowedOverMetered(true)
      .setAllowedOverRoaming(false)
      .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "T3Code/$name")
    return manager.enqueue(request).toString()
  }

  fun show(context: Context) {
    context.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
