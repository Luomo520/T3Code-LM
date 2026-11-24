package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.events.OnActivityResultPayload
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume

class T3LocalDirectoryModule : Module() {
  private val picker = Mutex()
  private val grantLock = Any()
  private var pickerResult: Continuation<OnActivityResultPayload>? = null

  private data class Grant(val sessionId: String, val uri: Uri, val name: String, val revision: String) {
    fun summary() = mapOf("name" to name, "revision" to revision, "sessionId" to sessionId)
  }

  override fun definition() = ModuleDefinition {
    Name("T3LocalDirectory")

    AsyncFunction("getGrant").Coroutine { environment: String, session: String? ->
      withContext(Dispatchers.IO) {
        val context = context()
        synchronized(grantLock) {
          readGrant(context, environment)
            ?.takeIf { (session == null || it.sessionId == session) && hasReadPermission(context, it.uri) }
            ?.summary()
        }
      }
    }

    AsyncFunction("chooseGrant").Coroutine {
      environment: String, session: String, checkedRevision: String? ->
      picker.withLock {
        val result = pickDirectory()
        if (result.resultCode != Activity.RESULT_OK) return@withLock null
        val uri = result.data?.data ?: error("系统未返回目录。")
        require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri)) { "请选择系统文件目录。" }
        withContext(Dispatchers.IO) {
          val context = context()
          val authority = uri.authority
          require(authority in LOCAL_DOCUMENT_PROVIDERS &&
            context.packageManager.resolveContentProvider(authority!!, PackageManager.MATCH_SYSTEM_ONLY) != null) {
            "请选择手机本机的目录。"
          }
          synchronized(grantLock) {
            val previous = readGrant(context, environment)
            check(previous?.takeIf { hasReadPermission(context, it.uri) }?.revision == checkedRevision) {
              "目录授权已变化，请重试。"
            }
            val resolver = context.contentResolver
            val hadPermission = hasReadPermission(context, uri)
            if (!hadPermission) resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
              check(hasReadPermission(context, uri)) { "系统未保留目录读取权限。" }
              val document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
              val name = resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
                ?: error("无法读取目录名称。")
              val grant = Grant(session, uri, name, UUID.randomUUID().toString())
              val stored = JSONObject().put("sessionId", session).put("uri", uri.toString())
                .put("name", name).put("revision", grant.revision)
              check(grants(context).edit().putString(environment, stored.toString()).commit()) {
                "无法记住目录授权。"
              }
              if (previous != null && previous.uri != uri) releaseUnused(context, previous.uri)
              grant.summary()
            } catch (error: Exception) {
              if (!hadPermission) releaseUnused(context, uri)
              throw error
            }
          }
        }
      }
    }

    AsyncFunction("revokeGrant").Coroutine { environment: String ->
      withContext(Dispatchers.IO) {
        val context = context()
        synchronized(grantLock) {
          val previous = readGrant(context, environment) ?: return@synchronized
          check(grants(context).edit().remove(environment).commit()) { "无法撤销目录授权。" }
          releaseUnused(context, previous.uri)
        }
      }
    }

    AsyncFunction("readFile").Coroutine {
      environment: String, session: String, revision: String, name: String, maxBytes: Double ->
      require(validFileName(name) && maxBytes in 0.0..MAX_BYTES.toDouble()) { "文件名或大小限制无效。" }
      try {
        snapshot(environment, session, revision, name, maxBytes.toLong())
      } catch (_: SecurityException) {
        mapOf("status" to "revoked")
      } catch (_: java.io.FileNotFoundException) {
        mapOf("status" to "missing")
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

  private fun grants(context: Context) = context.getSharedPreferences("t3-authorized-directories", Context.MODE_PRIVATE)

  private fun readGrant(context: Context, environment: String): Grant? =
    grants(context).getString(environment, null)?.let { stored ->
      runCatching {
        val entry = JSONObject(stored)
        Grant(entry.getString("sessionId"), Uri.parse(entry.getString("uri")),
          entry.getString("name"), entry.getString("revision"))
      }.getOrNull()
    }

  private fun hasReadPermission(context: Context, uri: Uri) =
    context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }

  private fun releaseUnused(context: Context, uri: Uri) {
    if (grants(context).all.keys.any { readGrant(context, it)?.uri == uri }) return
    runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
  }

  private fun activeGrant(context: Context, environment: String, session: String, revision: String): Grant {
    val grant = readGrant(context, environment)
    if (grant?.sessionId != session || grant.revision != revision ||
      !hasReadPermission(context, grant.uri) || context.getSystemService(KeyguardManager::class.java).isDeviceLocked
    ) throw SecurityException("读取授权已失效。")
    return grant
  }

  @Suppress("DEPRECATION")
  private suspend fun pickDirectory() = withContext(Dispatchers.Main) {
    val activity = appContext.currentActivity ?: error("请在应用前台选择目录。")
    check(activity.hasWindowFocus()) { "请在应用前台选择目录。" }
    try {
      suspendCancellableCoroutine { continuation ->
        pickerResult = continuation
        activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
          putExtra(Intent.EXTRA_LOCAL_ONLY, true)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }, REQUEST)
      }
    } finally {
      pickerResult = null
    }
  }

  private suspend fun snapshot(environment: String, session: String, revision: String, name: String, maxBytes: Long) =
    withContext(Dispatchers.IO) {
      val context = context()
      val grant = activeGrant(context, environment, session, revision)
      val resolver = context.contentResolver
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(grant.uri, DocumentsContract.getTreeDocumentId(grant.uri))
      val columns = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS,
      )
      // 通用文档提供者可忽略查询条件，只核对目录的直接子项并拒绝同名结果。
      val ids = resolver.query(children, columns, null, null, null)?.use { rows ->
        buildList<String> {
          while (rows.moveToNext()) {
            ensureActive()
            if (rows.getString(1) == name && rows.getString(2) != DocumentsContract.Document.MIME_TYPE_DIR &&
              rows.getInt(3) and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT == 0) {
              add(rows.getString(0))
              if (size == 2) break
            }
          }
        }
      } ?: throw IllegalStateException("无法读取授权目录。")
      if (ids.size != 1) return@withContext mapOf("status" to if (ids.isEmpty()) "missing" else "ambiguous")
      activeGrant(context, environment, session, revision)
      val document = DocumentsContract.buildDocumentUriUsingTree(grant.uri, ids.single())
      val cacheDir = File(context.cacheDir, "t3-directory-files")
      check(cacheDir.isDirectory || cacheDir.mkdirs() || cacheDir.isDirectory) { "无法暂存文件。" }
      cacheDir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24L * 60 * 60 * 1000 }
        ?.forEach { it.delete() }
      val cache = File.createTempFile("authorized-", ".part", cacheDir)
      var complete = false
      try {
        val source = resolver.openInputStream(document) ?: throw java.io.FileNotFoundException()
        source.use { input ->
          cache.outputStream().use { output ->
            val buffer = ByteArray(128 * 1024)
            var size = 0L
            while (true) {
              ensureActive()
              val count = input.read(buffer)
              if (count < 0) break
              size += count
              if (size > maxBytes) return@withContext mapOf("status" to "too-large")
              output.write(buffer, 0, count)
            }
          }
        }
        activeGrant(context, environment, session, revision)
        complete = true
        mapOf("status" to "ready", "uri" to Uri.fromFile(cache).toString())
      } finally {
        if (!complete) cache.delete()
      }
    }

  private companion object {
    const val REQUEST = 42205
    const val MAX_BYTES = 10L * 1024 * 1024 * 1024
    val LOCAL_DOCUMENT_PROVIDERS = setOf(
      "com.android.externalstorage.documents",
      "com.android.providers.downloads.documents",
      "com.android.providers.media.documents",
    )

    fun validFileName(name: String) =
      name.length in 1..240 && name.any { it != '.' && it != ' ' } &&
        name.none { it == '/' || it == '\\' || it.code < 32 || it.code == 127 }
  }
}
