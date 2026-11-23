package expo.modules.t3nativecontrols

import android.content.Context
import java.io.File
import java.net.URI
import java.nio.ByteBuffer
import java.security.MessageDigest

internal object T3DirectFileHandoff {
  fun save(context: Context, uri: String, name: String, size: Long, sha256: String, handoffKey: String? = null): String {
    val source = File(URI(uri)).canonicalFile
    require(source.parentFile == context.cacheDir.canonicalFile &&
      source.name.matches(Regex("t3-handoff-[0-9a-f-]{36}")) &&
      source.isFile && source.length() == size && sha256.matches(Regex("[a-f0-9]{64}"))) {
      "直连文件的校验信息无效。"
    }
    val hash = MessageDigest.getInstance("SHA-256")
    return T3FileDownloads.saveHandoff(context, handoffKey, size, sha256) { record ->
      T3DownloadDestination.create(context, T3FileDownloads.safeFileName(name), update = false).use { target ->
        var total = 0L
        source.inputStream().use { input ->
          val bytes = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(bytes)
            if (read < 0) break
            total += read
            check(total <= size) { "直连文件大小与传输记录不符。" }
            hash.update(bytes, 0, read)
            val buffer = ByteBuffer.wrap(bytes, 0, read)
            while (buffer.hasRemaining()) target.channel.write(buffer)
          }
        }
        check(total == size && hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == sha256) {
          "直连文件的 SHA-256 或大小校验失败。"
        }
        target.publish(record)
      }
    }.toString()
  }
}
