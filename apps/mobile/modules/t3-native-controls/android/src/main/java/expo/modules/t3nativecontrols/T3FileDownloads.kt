package expo.modules.t3nativecontrols

import android.content.Context
import android.net.Uri
import java.io.File
import java.io.FileNotFoundException
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject

object T3FileDownloads {
  @Synchronized
  fun enqueue(
    context: Context, rawUrl: String, rawName: String, sizeBytes: Long?,
    sha256: String? = null, handoffKey: String? = null,
  ): String {
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
      if (handoffKey != null) {
        checkKey(handoffKey)
        T3Downloads.findHandoff(handoffKey, sizeBytes, sha256)?.let { return it.id }
        val pending = JSONObject().put("size", sizeBytes).put("sha256", sha256)
        check(receipts(context).edit().putString("pending/$handoffKey", pending.toString()).commit()) {
          "无法保存下载进度，请检查可用空间。"
        }
      } else T3Downloads.findVerified(URL(rawUrl))?.let { return it.id }
    }
    val task = DownloadTask(URL(rawUrl), safeFileName(rawName), allowCellular = true,
      fileBytes = sizeBytes, expectedSha256 = sha256, handoffKey = handoffKey)
    T3Downloads.start(context.applicationContext, task)
    return task.id
  }

  private fun checkKey(key: String) {
    require(key.matches(Regex("[a-f0-9]{64}"))) { "收件编号无效，请重新领取。" }
  }

  private fun receipts(context: Context) =
    context.getSharedPreferences("t3-file-handoff-receipts", Context.MODE_PRIVATE)

  private fun sha256Hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  internal fun partialFile(context: Context, key: String, sha256: String): File {
    val identity = sha256Hex(MessageDigest.getInstance("SHA-256").digest("$key:$sha256".toByteArray()))
    return File(File(context.cacheDir, "file-handoff-downloads"), "$identity.part")
  }

  private fun verifiedReceipt(context: Context, key: String, size: Long, sha256: String): Uri? {
    val saved = receipts(context).getString(key, null)?.let(::JSONObject) ?: return null
    check(saved.getString("sha256") == sha256 && saved.getLong("size") == size) {
      "收件内容与已保存记录不一致，请刷新会话。"
    }
    val uri = Uri.parse(saved.getString("uri"))
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val input = try { context.contentResolver.openInputStream(uri) } catch (_: FileNotFoundException) { null }
    if (input == null) return null
    input.use {
      val buffer = ByteArray(128 * 1024)
      while (true) {
        val count = it.read(buffer)
        if (count < 0) break
        total += count
        if (total > size) return null
        digest.update(buffer, 0, count)
      }
    }
    if (total != size || sha256Hex(digest.digest()) != sha256) return null
    T3DownloadDestination.publishRecovered(context, uri)
    return uri
  }

  @Synchronized
  internal fun saveHandoff(
    context: Context, key: String?, size: Long, sha256: String,
    publish: ((Uri) -> Unit) -> Uri,
  ): Uri {
    if (key == null) return publish {}
    checkKey(key)
    verifiedReceipt(context, key, size, sha256)?.let { return it }
    return publish { uri ->
      // 先同步写入日志。进程在后续发布或回执之间退出时，可按已分配的 URI 恢复。
      val data = JSONObject().put("uri", uri.toString()).put("size", size).put("sha256", sha256)
      check(receipts(context).edit().putString(key, data.toString()).remove("pending/$key").commit()) {
        "无法保存收件记录，请检查可用空间。"
      }
    }
  }

  @Synchronized
  internal fun handoffStatus(context: Context, key: String, size: Long, sha256: String): Map<String, Any>? {
    checkKey(key)
    T3Downloads.findHandoff(key, size, sha256)?.let { active ->
      return active.state.toMap() + ("nativeId" to active.id)
    }
    verifiedReceipt(context, key, size, sha256)?.let { uri ->
      return DownloadState("downloaded", size, size, uri).toMap()
    }
    val partial = partialFile(context, key, sha256)
    val pending = receipts(context).getString("pending/$key", null)?.let(::JSONObject)
    val matchesPending = pending?.let { it.getLong("size") == size && it.getString("sha256") == sha256 } == true
    return if (matchesPending || partial.isFile) {
      DownloadState("paused", partial.length().coerceAtMost(size), size, retryable = true).toMap()
    } else null
  }

  internal fun safeFileName(rawName: String): String {
    var fileName = rawName.map { if (it.code < 32 || it in "/\\:*?\"<>|") '_' else it }
      .joinToString("").trim().trimEnd('.').take(160).ifEmpty { "download" }
    while (fileName.toByteArray(Charsets.UTF_8).size > 200) fileName = fileName.dropLast(1)
    if (fileName.lastOrNull()?.isHighSurrogate() == true) fileName = fileName.dropLast(1)
    return fileName.ifEmpty { "download" }
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
