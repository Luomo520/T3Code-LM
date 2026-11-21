package expo.modules.t3nativecontrols

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URL
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

class T3HttpDownloadTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test
  fun joinsExactRangesFromOneRepresentation() {
    val file = ByteArray(8 * 1024 * 1024 + 169) { ((it / 251) xor it).toByte() }
    val requests = ConcurrentLinkedQueue<Pair<String, String?>>()
    val progress = ConcurrentLinkedQueue<Pair<Long, Long?>>()
    val output = temporary.newFile()
    serve({ exchange ->
      val range = exchange.requestHeaders.getFirst("Range")
      requests.add(range to exchange.requestHeaders.getFirst("If-Range"))
      exchange.respondRange(file, range, "\"asset\"")
    }) { url ->
      RandomAccessFile(output, "rw").use {
        download { bytes, total -> progress.add(bytes to total) }.transfer(url, it.channel, file.size.toLong())
      }
    }
    assertEquals(5, requests.size)
    assertTrue(requests.contains("bytes=0-0" to null))
    assertEquals(4, requests.count { it.second == "\"asset\"" })
    assertTrue(progress.contains(file.size.toLong() to file.size.toLong()))
    assertArrayEquals(file, output.readBytes())
  }

  @Test
  fun usesFullResponseWhenRangeIsIgnored() {
    val data = "There is no range support".toByteArray()
    val requests = ConcurrentLinkedQueue<String>()
    val output = temporary.newFile()
    serve({ exchange ->
      requests.add(exchange.requestHeaders.getFirst("Range"))
      exchange.sendResponseHeaders(200, 0)
      exchange.responseBody.use { it.write(data) }
    }) { url ->
      RandomAccessFile(output, "rw").use { download().transfer(url, it.channel, null) }
    }
    assertEquals(listOf("bytes=0-0"), requests.toList())
    assertArrayEquals(data, output.readBytes())
  }

  @Test
  fun rejectsRangesThatBelongToAnotherRepresentation() {
    val data = ByteArray(4 * 1024 * 1024)
    serve({ exchange ->
      val range = exchange.requestHeaders.getFirst("Range")
      exchange.respondRange(data, range, if (range == "bytes=0-0") "\"original\"" else "\"changed\"")
    }) { url ->
      RandomAccessFile(temporary.newFile(), "rw").use {
        assertThrows(DownloadFailure::class.java) { download().transfer(url, it.channel, null) }
      }
    }
  }

  private fun download(progress: (Long, Long?) -> Unit = { _, _ -> }) = T3HttpDownload(
    connect = { it.openConnection() as HttpURLConnection },
    checkActive = {},
    redirectAllowed = { _, _ -> false },
    progress = progress,
  )

  private fun HttpExchange.respondRange(bytes: ByteArray, range: String, etag: String) {
    val (first, last) = range.removePrefix("bytes=").split('-').map(String::toInt)
    responseHeaders.add("Content-Range", "bytes $first-$last/${bytes.size}")
    responseHeaders.add("ETag", etag)
    val length = last - first + 1
    sendResponseHeaders(206, length.toLong())
    responseBody.use { it.write(bytes, first, length) }
  }

  private fun serve(handler: (HttpExchange) -> Unit, test: (URL) -> Unit) {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val pool = Executors.newCachedThreadPool()
    try {
      server.executor = pool
      server.createContext("/") { exchange -> exchange.use(handler) }
      server.start()
      test(URL("http://127.0.0.1:${server.address.port}/"))
    } finally {
      server.stop(0)
      pool.shutdownNow()
    }
  }
}
