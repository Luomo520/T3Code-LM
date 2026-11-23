package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.File

/** 系统安装会话的回执由 Android 发送，Activity 返回码仅表示确认界面已退出。 */
class T3ReceivedApkInstallSession : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_RESULT) return
    val key = intent.getStringExtra(EXTRA_RECEIPT) ?: return
    val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
    val store = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val attempt = readAttempt(store.getString(key, null)) ?: return
    if (attempt.optInt("sessionId") != id || attempt.optString("status") != "pending") return
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      @Suppress("DEPRECATION")
      val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
      if (confirmation != null && openConfirmation?.invoke(confirmation) == true) return
      // 应用暂时离开前台时，用户可以回到收件卡片继续。
      if (confirmation != null) pendingConfirmation = id to confirmation
      return
    }
    val result = resultStatus(status) ?: return
    if (pendingConfirmation?.first == id) pendingConfirmation = null
    val saved = synchronized(this::class.java) {
      // 写入前重查会话，避免后台线程新建的会话被旧结果覆盖。
      val current = readAttempt(store.getString(key, null))
      if (current?.optInt("sessionId") != id || current.optString("status") != "pending") return@synchronized false
      current.put("status", result)
      if (result == "failed") {
        current.put("message", "系统未完成安装（$status）。可重新安装。")
      }
      store.edit().putString(key, current.toString()).commit()
    }
    if (saved) onResult?.invoke(key)
  }

  companion object {
    const val STORE = "received-apk-install"
    private const val ACTION_RESULT = "expo.modules.t3nativecontrols.RECEIVED_APK_INSTALL_RESULT"
    private const val EXTRA_RECEIPT = "receiptKey"

    // 确认界面只从当前前台 Activity 打开。结果持久化不依赖 Activity 或 JS。
    internal var openConfirmation: ((Intent) -> Boolean)? = null
    internal var onResult: ((String) -> Unit)? = null
    private var pendingConfirmation: Pair<Int, Intent>? = null

    internal fun readAttempt(value: String?): JSONObject? =
      value?.takeIf { it.startsWith("{") }?.let { runCatching { JSONObject(it) }.getOrNull() }

    internal fun resultStatus(status: Int): String? = when (status) {
      PackageInstaller.STATUS_SUCCESS -> "verified"
      PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
      PackageInstaller.STATUS_PENDING_USER_ACTION, Int.MIN_VALUE -> null
      else -> "failed"
    }

    internal fun resumeConfirmation(context: Context, key: String, activity: Activity): Boolean {
      val (id, confirmation) = pendingConfirmation ?: return false
      val attempt = readAttempt(context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(key, null))
      if (attempt?.optInt("sessionId") != id) return false
      activity.startActivity(confirmation)
      pendingConfirmation = null
      return true
    }

    internal fun launch(
      context: Context, key: String, file: File, packageName: String, version: String, versionCode: Long,
    ) {
      val installer = context.packageManager.packageInstaller
      val store = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      val before = store.getString(key, null)
      val previous = readAttempt(before)
      val previousId = previous?.optInt("sessionId")
      if (previous?.optString("status") == "pending" && previousId != null && installer.getSessionInfo(previousId) != null) {
        // 仅在用户重试同一收件时收回未完成的会话。
        installer.abandonSession(previousId)
      }
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(packageName)
        setSize(file.length())
        if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      }
      val id = installer.createSession(params)
      val resultIntent = Intent(context, T3ReceivedApkInstallSession::class.java).apply {
        action = ACTION_RESULT
        data = Uri.fromParts("t3-received-apk", id.toString(), null)
        putExtra(EXTRA_RECEIPT, key)
      }
      // Android 需要把确认 Intent 和最终状态写入回调。组件固定且未导出。
      val callback = PendingIntent.getBroadcast(
        context, id, resultIntent, if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0,
      )
      val attempt = JSONObject().put("sessionId", id).put("status", "pending")
        .put("packageName", packageName).put("version", version).put("versionCode", versionCode.toString())
      try {
        installer.openSession(id).use { session ->
          session.openWrite("base.apk", 0, file.length()).use { output ->
            file.inputStream().use { it.copyTo(output) }
            session.fsync(output)
          }
          synchronized(T3ReceivedApkInstallSession::class.java) {
            val current = store.getString(key, null)
            check(readAttempt(current)?.optString("status") != "verified") { "已核实此 APK 的安装结果。" }
            check(store.edit().putString(key, attempt.toString()).commit()) { "无法保存安装记录，请重试。" }
            try {
              session.commit(callback.intentSender)
            } catch (error: Exception) {
              store.edit().putString(key, current).commit()
              throw error
            }
          }
        }
      } catch (error: Exception) {
        callback.cancel()
        runCatching { installer.abandonSession(id) }
        throw error
      }
    }
  }
}
