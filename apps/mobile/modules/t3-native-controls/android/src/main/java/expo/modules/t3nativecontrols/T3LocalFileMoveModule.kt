package expo.modules.t3nativecontrols

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.events.OnActivityResultPayload
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume

class T3LocalFileMoveModule : Module() {
  private val operation = Mutex()
  private var pickerResult: Continuation<OnActivityResultPayload>? = null
  private var selection: Selection? = null

  private data class Identity(
    val device: Long,
    val inode: Long,
    val size: Long,
    val modified: Long,
    val modifiedNanos: Long,
    val changed: Long,
    val changedNanos: Long,
  )
  private data class Selection(
    val token: String,
    val uri: Uri,
    val cache: File,
    val source: ParcelFileDescriptor?,
    val identity: Identity?,
    val sha256: String,
  ) {
    fun close() {
      runCatching { source?.close() }
      cache.delete()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("T3LocalFileMove")

    AsyncFunction("pick").Coroutine<Map<String, String>?> {
      operation.withLock {
        val result = pickDocument()
        if (result.resultCode != Activity.RESULT_OK) return@withLock null
        val uri = result.data?.data ?: error("文件选择器未返回文件。")
        val context = context()
        require(DocumentsContract.isDocumentUri(context, uri)) { "请选择本机文件。" }
        withContext(Dispatchers.IO) {
          val resolver = context.contentResolver
          val name = resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: error("无法读取选中的文件名。")
          val directory = File(context.cacheDir, "t3-handoff-move")
          check(directory.isDirectory || directory.mkdirs()) { "无法暂存选中的文件。" }
          directory.listFiles()?.filter { it != selection?.cache }?.forEach { it.delete() }
          val cache = File.createTempFile("selection-", ".part", directory)
          var source: ParcelFileDescriptor? = null
          try {
            val descriptor = resolver.openFileDescriptor(uri, "r") ?: error("无法读取选中的文件。")
            val (identity, hash) = ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
              val identity = identity(input.fd)
              val hash = cache.outputStream().use { output -> digest(input, output) }
              check(identity == identity(input.fd) && (identity == null || identity.size == cache.length())) {
                "源文件已变化，请重新选择。"
              }
              if (identity != null) source = ParcelFileDescriptor.dup(input.fd)
              identity to hash
            }
            selection?.close()
            val token = UUID.randomUUID().toString()
            selection = Selection(token, uri, cache, source, identity, hash)
            mapOf("token" to token, "uri" to Uri.fromFile(cache).toString(), "name" to name)
          } catch (cause: Exception) {
            runCatching { source?.close() }
            cache.delete()
            throw cause
          }
        }
      }
    }

    AsyncFunction("finish") Coroutine { token: String, sha256: String ->
      operation.withLock {
        val selected = selection?.takeIf { it.token == token } ?: return@withLock "retained"
        selection = null
        withContext(Dispatchers.IO) {
          try {
            finish(context(), selected, sha256)
          } catch (_: Exception) {
            "retained"
          } finally {
            selected.close()
          }
        }
      }
    }

    AsyncFunction("discard") Coroutine { token: String ->
      operation.withLock {
        val selected = selection?.takeIf { it.token == token } ?: return@withLock
        selection = null
        withContext(Dispatchers.IO) { selected.close() }
      }
    }

    OnActivityResult { _, result ->
      if (result.requestCode == REQUEST) {
        val continuation = pickerResult
        pickerResult = null
        continuation?.resume(result)
      }
    }
  }

  private fun context(): Context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  @Suppress("DEPRECATION")
  private suspend fun pickDocument(): OnActivityResultPayload {
    val activity = appContext.currentActivity ?: error("请在应用前台选择文件。")
    check(activity.hasWindowFocus()) { "请在应用前台选择文件。" }
    return try {
      suspendCancellableCoroutine { continuation ->
        pickerResult = continuation
        activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          type = "*/*"
          addCategory(Intent.CATEGORY_OPENABLE)
          putExtra(Intent.EXTRA_LOCAL_ONLY, true)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }, REQUEST)
      }
    } finally {
      pickerResult = null
    }
  }

  private fun identity(fd: java.io.FileDescriptor): Identity? = runCatching {
    val status = Os.fstat(fd)
    if (!OsConstants.S_ISREG(status.st_mode) || status.st_ino == 0L) null
    else Identity(
      status.st_dev, status.st_ino, status.st_size, status.st_mtime,
      if (Build.VERSION.SDK_INT >= 27) status.st_mtim.tv_nsec else 0L,
      status.st_ctime, if (Build.VERSION.SDK_INT >= 27) status.st_ctim.tv_nsec else 0L,
    )
  }.getOrNull()

  private fun digest(input: java.io.InputStream, output: OutputStream? = null): String {
    val sha256 = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(128 * 1024)
    var bytes = 0L
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      bytes += count
      require(bytes <= MAX_BYTES) { "所选文件超过 10 GiB。" }
      sha256.update(buffer, 0, count)
      output?.write(buffer, 0, count)
    }
    return sha256.digest().joinToString("") { "%02x".format(it) }
  }

  private fun finish(context: Context, selected: Selection, sha256: String): String {
    if (selected.sha256 != sha256) return "changed"
    val expected = selected.identity ?: return "retained"
    val source = selected.source ?: return "retained"
    if (identity(source.fileDescriptor) != expected) return "changed"
    val uri = selected.uri
    val authority = uri.authority ?: return "retained"
    if (authority !in LOCAL_DOCUMENT_PROVIDERS ||
      context.packageManager.resolveContentProvider(authority, PackageManager.MATCH_SYSTEM_ONLY) == null) {
      return "retained"
    }
    val resolver = context.contentResolver
    if (context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      != PackageManager.PERMISSION_GRANTED) return "retained"
    val canDelete = resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)
      ?.use { it.moveToFirst() && (it.getInt(0) and DocumentsContract.Document.FLAG_SUPPORTS_DELETE != 0) } == true
    if (!canDelete) return "retained"

    val descriptor = resolver.openFileDescriptor(uri, "r") ?: return "retained"
    return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
      if (identity(input.fd) != expected || digest(input) != sha256 || identity(input.fd) != expected) {
        return@use "changed"
      }
      // 读入期间 URI 可能已被重新绑定，删除前再次解析并核对选中文档。
      val current = resolver.openFileDescriptor(uri, "r") ?: return@use "retained"
      current.use {
        if (identity(it.fileDescriptor) != expected || identity(input.fd) != expected) "changed"
        else if (DocumentsContract.deleteDocument(resolver, uri)) "removed"
        else "retained"
      }
    }
  }

  companion object {
    private const val REQUEST = 42204
    private const val MAX_BYTES = 10L * 1024 * 1024 * 1024
    private val LOCAL_DOCUMENT_PROVIDERS = setOf(
      "com.android.externalstorage.documents",
      "com.android.providers.downloads.documents",
      "com.android.providers.media.documents",
    )
  }
}
