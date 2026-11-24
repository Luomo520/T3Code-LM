package expo.modules.t3nativecontrols

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.security.MessageDigest

/** 本机授权不随系统备份迁移到另一台手机。前台与后台读取同一份记录。 */
internal object T3CapturePolicy {
  private fun file(context: Context, environment: String, kind: String): AtomicFile {
    require(environment.isNotBlank() && environment.length <= 512)
    require(kind == "screenshot" || kind == "recording")
    val digest = MessageDigest.getInstance("SHA-256").digest(environment.toByteArray(Charsets.UTF_8))
    val id = android.util.Base64.encodeToString(digest,
      android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
    return AtomicFile(File(context.noBackupFilesDir, "capture-$kind-$id"))
  }

  @Synchronized
  fun read(context: Context, environment: String, kind: String): String {
    val entry = file(context, environment, kind)
    if (!entry.baseFile.exists() && !File(entry.baseFile.path + ".bak").exists()) return "ask"
    return runCatching { entry.openRead().bufferedReader().use { it.readText() } }
      .getOrNull()?.takeIf { it == "system" || it == "ask" } ?: "deny"
  }

  @Synchronized
  fun write(context: Context, environment: String, kind: String, value: String) {
    require(value == "ask" || value == "system" || value == "deny")
    val entry = file(context, environment, kind)
    val stream = entry.startWrite()
    try {
      stream.write(value.toByteArray(Charsets.UTF_8))
      entry.finishWrite(stream)
    } catch (error: Exception) {
      entry.failWrite(stream)
      throw error
    }
  }
}
