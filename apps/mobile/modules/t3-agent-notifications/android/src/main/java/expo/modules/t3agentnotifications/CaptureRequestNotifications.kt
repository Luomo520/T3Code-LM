package expo.modules.t3agentnotifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal object CaptureRequestNotifications {
  private const val STORE = "t3-capture-request-notifications"
  private const val CHANNEL = "capture-requests"
  private const val TAG_PREFIX = "t3-capture-request:"
  private const val NOTIFICATION_ID = 73004

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  fun canPost(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < 26 ||
        manager(context).getNotificationChannel(CHANNEL)?.importance !=
        NotificationManager.IMPORTANCE_NONE)

  fun watchUntil(context: Context): Long =
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getLong("watchUntil", 0L)

  fun hasWork(context: Context): Boolean = watchUntil(context) > System.currentTimeMillis() &&
    canPost(context)

  fun updateWatch(context: Context, until: Long) {
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      .edit().putLong("watchUntil", until).apply()
    if (hasWork(context)) TaskCompletionBackgroundCheck.schedule(context)
    else TaskCompletionBackgroundCheck.cancelIfIdle(context)
  }

  @Synchronized
  fun clearPosted(context: Context) {
    val manager = manager(context)
    manager.activeNotifications.filter { it.tag?.startsWith(TAG_PREFIX) == true }
      .forEach { manager.cancel(it.tag, it.id) }
  }

  @Synchronized
  fun post(
    context: Context,
    scheme: String,
    path: String,
    environmentId: String,
    jobId: String,
    name: String,
    recording: Boolean,
    expiresInMs: Long
  ) {
    if (expiresInMs <= 0 || !canPost(context) ||
      !path.startsWith("/threads/") || path.contains('?') || path.contains('#')
    ) return

    val tag = "$TAG_PREFIX$environmentId"
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    if (prefs.getString(tag, null) == jobId) return

    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$path"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val manager = manager(context)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "截图和录屏请求", NotificationManager.IMPORTANCE_HIGH)
      )
    }
    val alert = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setDefaults(Notification.DEFAULT_ALL)
      .setContentTitle(if (recording) "收到录屏请求" else "收到截图请求")
      .setContentText("「$name」请求屏幕捕获。打开应用后选择是否授权。")
      .setContentIntent(tap)
      .setAutoCancel(true)
      .setTimeoutAfter(expiresInMs)
      .build()
    try {
      manager.notify(tag, NOTIFICATION_ID, alert)
      prefs.edit().putString(tag, jobId).apply()
    } catch (_: SecurityException) {
      // 通知权限可能刚刚被用户关闭。
    }
  }
}
