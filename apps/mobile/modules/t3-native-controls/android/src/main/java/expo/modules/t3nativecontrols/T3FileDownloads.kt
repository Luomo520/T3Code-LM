package expo.modules.t3nativecontrols

import android.content.Context
import android.net.Uri
import java.net.URL

object T3FileDownloads {
  @Synchronized
  fun enqueue(context: Context, rawUrl: String, rawName: String, sizeBytes: Long?, sha256: String? = null): String {
    val uri = Uri.parse(rawUrl)
    require((uri.scheme == "http" || uri.scheme == "https") && uri.host != null &&
      uri.userInfo == null && uri.fragment == null && uri.path?.startsWith("/api/assets/") == true) {
      "下载地址无效，请重新点击下载。"
    }
    if (sha256 != null) {
      require(sizeBytes != null && sha256.matches(Regex("[0-9a-f]{64}")) &&
        uri.path?.startsWith("/api/assets/file-handoff/") == true) {
        "文件校验信息无效，请重新领取。"
      }
      T3Downloads.findVerified(URL(rawUrl))?.let { return it.id }
    }
    var fileName = rawName.map { if (it.code < 32 || it in "/\\:*?\"<>|") '_' else it }
      .joinToString("").trim().trimEnd('.').take(160).ifEmpty { "download" }
    while (fileName.toByteArray(Charsets.UTF_8).size > 200) fileName = fileName.dropLast(1)
    if (fileName.lastOrNull()?.isHighSurrogate() == true) fileName = fileName.dropLast(1)
    val task = DownloadTask(URL(rawUrl), fileName.ifEmpty { "download" }, allowCellular = true,
      fileBytes = sizeBytes, expectedSha256 = sha256)
    T3Downloads.start(context.applicationContext, task)
    return task.id
  }

  fun status(id: String): Map<String, Any>? =
    T3Downloads.get(id)?.takeUnless(DownloadTask::isUpdate)?.state?.toMap()

  fun cancel(id: String) {
    T3Downloads.get(id)?.takeUnless(DownloadTask::isUpdate)?.cancel()
  }

  fun show(context: Context) {
    context.startActivity(T3DownloadDestination.folderIntent())
  }
}
