package expo.modules.t3nativecontrols

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

internal class DownloadFailure(message: String) : IOException(message)

/** Transfers one HTTP representation into a seekable file. Each range must match the same ETag. */
internal class T3HttpDownload(
  private val connect: (URL) -> HttpURLConnection,
  private val checkActive: () -> Unit,
  private val redirectAllowed: (URL, URL) -> Boolean,
  private val progress: (Long, Long?) -> Unit,
) {
  private val connections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
  private val received = AtomicLong()
  @Volatile private var stopped = false

  fun transfer(url: URL, output: FileChannel, expectedBytes: Long?) {
    val probe = response(url, "bytes=0-0") { http, finalUrl ->
      when (val status = http.responseCode) {
        HttpURLConnection.HTTP_OK -> {
          whole(http, output, expectedBytes)
          null
        }
        HttpURLConnection.HTTP_PARTIAL -> {
          val range = parseRange(http.getHeaderField("Content-Range"))
          if (range == null || range.start != 0L || range.end != 0L) {
            throw DownloadFailure("服务器返回的分段范围无效，请重试。")
          }
          checkSize(range.total, expectedBytes)
          Probe(finalUrl, range.total, http.getHeaderField("ETag")?.takeIf(::strongETag))
        }
        416 -> {
          if (http.getHeaderField("Content-Range") != "bytes */0") reject(status)
          checkSize(0, expectedBytes)
          Probe(finalUrl, 0, null)
        }
        else -> reject(status)
      }
    }
    if (probe == null) return
    val parts = (probe.total / MIN_SEGMENT_BYTES).coerceIn(1, MAX_SEGMENTS.toLong()).toInt()
    if (probe.etag == null || parts == 1) {
      response(probe.url) { http, _ ->
        if (http.responseCode != HttpURLConnection.HTTP_OK) reject(http.responseCode)
        whole(http, output, probe.total)
      }
      return
    }
    progress(0, probe.total)
    val pool = Executors.newFixedThreadPool(parts)
    val work = ExecutorCompletionService<Unit>(pool)
    try {
      val partBytes = probe.total / parts
      for (part in 0 until parts) {
        val start = part * partBytes
        val end = if (part == parts - 1) probe.total - 1 else start + partBytes - 1
        work.submit {
          response(probe.url, "bytes=$start-$end", probe.etag) { http, _ ->
            val status = http.responseCode
            if (status !in listOf(HttpURLConnection.HTTP_OK, HttpURLConnection.HTTP_PARTIAL, 416)) {
              reject(status)
            }
            val range = parseRange(http.getHeaderField("Content-Range"))
            if (status != HttpURLConnection.HTTP_PARTIAL ||
              http.getHeaderField("ETag") != probe.etag || range != Range(start, end, probe.total)
            ) throw DownloadFailure("下载期间文件已变化，或服务器返回了错误的分段，请重新下载。")
            copy(http, output, start, end - start + 1, probe.total)
          }
        }
      }
      repeat(parts) { work.take().get() }
      if (output.size() != probe.total) throw DownloadFailure("下载文件大小不匹配，请重试。")
    } catch (error: ExecutionException) {
      throw (error.cause ?: error)
    } finally {
      stopped = true
      connections.forEach(HttpURLConnection::disconnect)
      pool.shutdownNow()
    }
  }

  private fun whole(http: HttpURLConnection, output: FileChannel, expectedBytes: Long?) {
    val length = http.getHeaderField("Content-Length")?.toLongOrNull()?.takeIf { it >= 0 }
    checkSize(length, expectedBytes)
    val total = expectedBytes ?: length
    progress(0, total)
    copy(http, output, 0, total, total)
  }

  private fun copy(http: HttpURLConnection, output: FileChannel, start: Long, length: Long?, total: Long?) {
    val encoding = http.getHeaderField("Content-Encoding")
    if (encoding != null && !encoding.equals("identity", ignoreCase = true)) {
      throw DownloadFailure("服务器返回了不支持的下载编码。")
    }
    var offset = start
    val bytes = ByteArray(128 * 1024)
    http.inputStream.use { input ->
      while (true) {
        ensureActive()
        val count = input.read(bytes)
        if (count < 0) break
        if (length != null && count > length - (offset - start)) {
          throw DownloadFailure("接收的数据超出文件大小，请重新下载。")
        }
        ensureActive()
        val buffer = ByteBuffer.wrap(bytes, 0, count)
        while (buffer.hasRemaining()) offset += output.write(buffer, offset)
        progress(received.addAndGet(count.toLong()), total)
      }
    }
    if (length != null && offset - start != length) {
      throw DownloadFailure("下载内容不完整，请重试。")
    }
  }

  private fun <T> response(
    url: URL,
    range: String? = null,
    etag: String? = null,
    read: (HttpURLConnection, URL) -> T,
  ): T {
    var target = url
    repeat(6) {
      ensureActive()
      val http = connect(target)
      connections.add(http)
      try {
        ensureActive()
        http.instanceFollowRedirects = false
        http.connectTimeout = 20_000
        http.readTimeout = 20_000
        http.useCaches = false
        http.setRequestProperty("Accept-Encoding", "identity")
        range?.let { http.setRequestProperty("Range", it) }
        etag?.let { http.setRequestProperty("If-Range", it) }
        if (http.responseCode !in listOf(301, 302, 303, 307, 308)) return read(http, target)
        val location = http.getHeaderField("Location") ?: throw DownloadFailure("下载地址重定向无效。")
        val redirected = URL(target, location)
        if (!redirectAllowed(target, redirected)) throw DownloadFailure("下载地址重定向无效。")
        target = redirected
      } finally {
        connections.remove(http)
        http.disconnect()
      }
    }
    throw DownloadFailure("下载地址重定向次数过多。")
  }

  private fun ensureActive() {
    if (stopped) throw IOException("Download stopped")
    checkActive()
  }

  private fun checkSize(actual: Long?, expected: Long?) {
    if (actual != null && expected != null && actual != expected) {
      throw DownloadFailure("下载文件大小与预期不匹配，请重新下载。")
    }
  }

  private fun strongETag(value: String) = value.length >= 2 && value.startsWith('"') && value.endsWith('"')

  private fun reject(status: Int): Nothing = throw DownloadFailure(when (status) {
    403 -> "服务器拒绝下载。工作区大文件可改用局域网直连后重试。"
    404, 410 -> "下载文件已不可用，请重新申请下载。"
    409 -> "文件已变化，请重新点击下载。"
    else -> "服务器暂时无法提供下载（HTTP $status），请重试。"
  })

  private data class Probe(val url: URL, val total: Long, val etag: String?)
  private data class Range(val start: Long, val end: Long, val total: Long)

  private fun parseRange(value: String?): Range? {
    val match = value?.let(CONTENT_RANGE::matchEntire) ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].toLongOrNull() ?: return null
    val total = match.groupValues[3].toLongOrNull() ?: return null
    return if (start <= end && end < total) Range(start, end, total) else null
  }

  private companion object {
    private val CONTENT_RANGE = Regex("bytes ([0-9]+)-([0-9]+)/([0-9]+)")
    private const val MAX_SEGMENTS = 4
    private const val MIN_SEGMENT_BYTES = 2 * 1024 * 1024L
  }
}
