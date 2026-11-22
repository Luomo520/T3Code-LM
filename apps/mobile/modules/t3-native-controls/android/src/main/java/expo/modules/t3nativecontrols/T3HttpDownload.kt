package expo.modules.t3nativecontrols

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLException

internal class DownloadFailure(
  message: String,
  val retryable: Boolean = false,
  val status: Int? = null,
) : IOException(message)

/** Transfers one HTTP representation into a seekable file. Each range must match the same ETag. */
internal class T3HttpDownload(
  private val connect: (URL) -> HttpURLConnection,
  private val checkActive: () -> Unit,
  private val redirectAllowed: (URL, URL) -> Boolean,
  private val progress: (Long, Long?) -> Unit,
  private val observeResponse: (String, Int) -> Unit = { _, _ -> },
) {
  private val connections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
  private val received = AtomicLong()
  @Volatile private var stopped = false

  fun transfer(url: URL, output: FileChannel, expectedBytes: Long?) {
    if (expectedBytes == null || expectedBytes < MIN_SEGMENT_BYTES * 2) {
      transferWhole(url, output, expectedBytes)
      return
    }
    val probe = try {
      response(url, "分段探测", "bytes=0-0") { http, finalUrl, status ->
        when (status) {
          HttpURLConnection.HTTP_OK -> {
            whole(http, output, expectedBytes)
            null
          }
          HttpURLConnection.HTTP_PARTIAL -> {
            val range = parseRange(http.getHeaderField("Content-Range"))
            if (range == null || range.start != 0L || range.end != 0L) {
              throw DownloadFailure("服务器返回的分段范围无效，请重试。", retryable = true)
            }
            checkSize(range.total, expectedBytes)
            Probe(finalUrl, range.total, http.getHeaderField("ETag")?.takeIf(::strongETag))
          }
          else -> reject(status, "分段探测")
        }
      }
    } catch (error: DownloadFailure) {
      // Rejected probes have not written any bytes. Keep the same signed URL and try a plain GET.
      if (error.status !in RANGE_FALLBACK_STATUSES) throw error
      transferWhole(url, output, expectedBytes)
      return
    }
    if (probe == null) return
    val parts = (probe.total / MIN_SEGMENT_BYTES).coerceIn(1, MAX_SEGMENTS.toLong()).toInt()
    if (probe.etag == null) {
      transferWhole(probe.url, output, probe.total)
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
          response(probe.url, "分段下载", "bytes=$start-$end", probe.etag) { http, _, status ->
            if (status !in listOf(HttpURLConnection.HTTP_OK, HttpURLConnection.HTTP_PARTIAL, 416)) {
              reject(status, "分段下载")
            }
            val range = parseRange(http.getHeaderField("Content-Range"))
            if (status != HttpURLConnection.HTTP_PARTIAL ||
              http.getHeaderField("ETag") != probe.etag || range != Range(start, end, probe.total)
            ) throw DownloadFailure("下载期间文件已变化，或服务器返回了错误的分段，请重新下载。", retryable = true)
            copy(http, output, start, end - start + 1, probe.total)
          }
        }
      }
      repeat(parts) { work.take().get() }
      if (output.size() != probe.total) throw DownloadFailure("下载文件大小不匹配，请重试。", retryable = true)
    } catch (error: ExecutionException) {
      throw (error.cause ?: error)
    } finally {
      stopped = true
      connections.forEach(HttpURLConnection::disconnect)
      pool.shutdownNow()
    }
  }

  // 单个有序分段保留连续字节，网络或进程中断后从临时文件长度继续。
  fun transferVerified(url: URL, output: FileChannel, expectedBytes: Long, sha256: String) {
    val etag = "\"sha256-$sha256\""
    var offset = output.size()
    if (offset > expectedBytes) {
      output.truncate(0)
      offset = 0
    }
    received.set(offset)
    if (offset == expectedBytes) {
      response(url, "校验", method = "HEAD") { http, _, status ->
        if (status != HttpURLConnection.HTTP_OK) reject(status, "校验")
        if (http.getHeaderField("ETag") != etag) {
          throw DownloadFailure("下载期间文件已变化，请重新领取。", retryable = true)
        }
      }
      return
    }
    val rangeHeader = "bytes=$offset-"
    response(url, "续传", rangeHeader, etag) { http, _, status ->
      if (status !in listOf(HttpURLConnection.HTTP_PARTIAL, HttpURLConnection.HTTP_OK)) {
        reject(status, "续传")
      }
      if (http.getHeaderField("ETag") != etag) {
        throw DownloadFailure("下载期间文件已变化，请重新领取。", retryable = true)
      }
      if (status == HttpURLConnection.HTTP_OK) {
        output.truncate(0)
        received.set(0)
        whole(http, output, expectedBytes)
      } else {
        val range = parseRange(http.getHeaderField("Content-Range"))
        if (range != Range(offset, expectedBytes - 1, expectedBytes)) {
          throw DownloadFailure("服务器返回的续传范围无效，请重试。", retryable = true)
        }
        progress(offset, expectedBytes)
        copy(http, output, offset, expectedBytes - offset, expectedBytes)
      }
      output.force(true)
    }
  }

  private fun transferWhole(url: URL, output: FileChannel, expectedBytes: Long?) {
    try {
      readWholeResponse(url, output, expectedBytes)
    } catch (error: DownloadFailure) {
      // A gateway status arrives before reading the body, so retry without touching partial data.
      if (error.status != 502 && error.status != 504) throw error
      Thread.sleep(350)
      readWholeResponse(url, output, expectedBytes)
    }
  }

  private fun readWholeResponse(url: URL, output: FileChannel, expectedBytes: Long?) {
    response(url, "读取正文") { http, _, status ->
      if (status != HttpURLConnection.HTTP_OK) reject(status, "读取正文")
      whole(http, output, expectedBytes)
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
    networkOperation { http.inputStream }.use { input ->
      while (true) {
        ensureActive()
        val count = networkOperation { input.read(bytes) }
        if (count < 0) break
        if (length != null && count > length - (offset - start)) {
          throw DownloadFailure("接收的数据超出文件大小，请重新下载。", retryable = true)
        }
        ensureActive()
        val buffer = ByteBuffer.wrap(bytes, 0, count)
        while (buffer.hasRemaining()) offset += output.write(buffer, offset)
        progress(received.addAndGet(count.toLong()), total)
      }
    }
    if (length != null && offset - start != length) {
      throw DownloadFailure("下载内容不完整，请重试。", retryable = true)
    }
  }

  private fun <T> response(
    url: URL,
    phase: String,
    range: String? = null,
    etag: String? = null,
    method: String = "GET",
    read: (HttpURLConnection, URL, Int) -> T,
  ): T {
    var target = url
    repeat(6) {
      ensureActive()
      val http = networkOperation { connect(target) }
      connections.add(http)
      try {
        ensureActive()
        http.instanceFollowRedirects = false
        http.requestMethod = method
        http.connectTimeout = 20_000
        http.readTimeout = 20_000
        http.useCaches = false
        http.setRequestProperty("Accept-Encoding", "identity")
        range?.let { http.setRequestProperty("Range", it) }
        etag?.let { http.setRequestProperty("If-Range", it) }
        val status = networkOperation { http.responseCode }
        observeResponse(phase, status)
        if (status !in listOf(301, 302, 303, 307, 308)) return read(http, target, status)
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
      throw DownloadFailure("下载文件大小与预期不匹配，请重新下载。", retryable = true)
    }
  }

  private fun strongETag(value: String) = value.length >= 2 && value.startsWith('"') && value.endsWith('"')

  private fun reject(status: Int, phase: String): Nothing {
    val message = when (status) {
      401 -> "下载授权无效，请重新申请下载。"
      403 -> "服务器拒绝下载。工作区大文件需要使用局域网直连。"
      404, 410 -> "下载文件已不可用，请重新申请下载。"
      409 -> "文件已变化，请重新申请下载。"
      429 -> "下载请求过多，请稍后重试。"
      502, 503, 504 -> "${phase}时，服务器或代理暂时无法提供下载（HTTP $status）。请检查网络及 VPN 的局域网访问设置后重试。"
      else -> "${phase}时收到 HTTP $status。"
    }
    throw DownloadFailure(message, retryable = status in RETRYABLE_STATUSES || status in 500..599,
      status = status)
  }

  private inline fun <T> networkOperation(operation: () -> T): T {
    try {
      return operation()
    } catch (error: IOException) {
      ensureActive()
      throw when (error) {
        is UnknownHostException -> DownloadFailure("无法找到下载服务器，请检查网络及代理设置。", retryable = true)
        is SocketTimeoutException -> DownloadFailure("连接或读取下载内容超时，请检查网络后重试。", retryable = true)
        is SSLException -> DownloadFailure("无法建立安全下载连接，请检查服务器证书及代理设置。")
        else -> DownloadFailure("下载连接中断，请检查网络及代理设置后重试。", retryable = true)
      }
    }
  }

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
    private val RANGE_FALLBACK_STATUSES = setOf(400, 405, 416, 501, 502, 503, 504)
    private val RETRYABLE_STATUSES = setOf(401, 404, 408, 409, 410, 429)
    private const val MAX_SEGMENTS = 4
    private const val MIN_SEGMENT_BYTES = 2 * 1024 * 1024L
  }
}
