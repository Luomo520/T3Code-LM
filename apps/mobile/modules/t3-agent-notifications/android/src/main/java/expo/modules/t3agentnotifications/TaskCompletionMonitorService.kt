package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/** Retains the existing authenticated React Native connection while its UI is paused. */
class TaskCompletionMonitorService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val stop = Runnable { stopSelf() }
  private var wakeLock: PowerManager.WakeLock? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskId: Int? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (taskId != null) return START_NOT_STICKY
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "任务监控", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val openApp = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, NOTIFICATION_ID, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle("正在监控任务")
      .setContentText("任务结束时会发送通知")
      .setOngoing(true)
      .setSilent(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(openApp)
      .build()
    startForeground(NOTIFICATION_ID, notification)

    val reactContext = (application as? ReactApplication)?.reactHost?.currentReactContext
    if (reactContext == null || !reactContext.hasActiveReactInstance()) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    // Android React Native pauses JS timers on Home until it has a headless task.
    val context = HeadlessJsTaskContext.getInstance(reactContext)
    taskContext = context
    taskId = context.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
    wakeLock = getSystemService(Context.POWER_SERVICE).let { power ->
      (power as PowerManager).newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "$packageName:task-completion"
      ).apply { acquire(MAX_MONITOR_MS) }
    }
    handler.postDelayed(stop, MAX_MONITOR_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(stop)
    taskId?.let { taskContext?.finishTask(it) }
    wakeLock?.takeIf { it.isHeld }?.release()
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "task-completion-monitor"
    private const val NOTIFICATION_ID = 73002
    private const val MAX_MONITOR_MS = 2 * 60 * 60 * 1000L
    private const val TASK = "T3TaskCompletionMonitor"
  }
}
