package expo.modules.t3agentnotifications

import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

class LegacyTaskCompletionCleanupReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      TaskCompletionBackgroundCheck.clearLegacyNotification(context)
    }
  }
}

internal object TaskCompletionBackgroundCheck {
  private const val STORE = "t3-task-completion-watch"
  private const val JOB_ID = 73002
  private const val FOLLOW_UP_JOB_ID = 73003
  private const val RETRY_DELAY_MS = 60_000L
  private const val LEGACY_CHANNEL = "task-completion-monitor"
  private const val LEGACY_NOTIFICATION_ID = 73002

  fun clearLegacyNotification(context: Context) {
    val notifications = context.getSystemService(NotificationManager::class.java)
    notifications.cancel(LEGACY_NOTIFICATION_ID)
    if (Build.VERSION.SDK_INT >= 26) notifications.deleteNotificationChannel(LEGACY_CHANNEL)
  }

  fun read(context: Context): String? {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    return prefs.getString("watch", null)
      ?.takeIf { prefs.getLong("expiresAt", 0) > System.currentTimeMillis() }
  }

  fun hasWork(context: Context): Boolean =
    (read(context) != null && AgentNotifications.canPostAlerts(context)) ||
      CaptureRequestNotifications.hasWork(context)

  @Synchronized
  fun cancelIfIdle(context: Context) {
    if (hasWork(context)) return
    val scheduler = context.getSystemService(JobScheduler::class.java)
    scheduler.cancel(JOB_ID)
    scheduler.cancel(FOLLOW_UP_JOB_ID)
  }

  @Synchronized
  fun update(context: Context, watch: String?, expiresAt: Long, background: Boolean) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    if (watch == null) {
      prefs.edit().clear().apply()
      cancelIfIdle(context)
      return
    }
    prefs.edit().putString("watch", watch).putLong("expiresAt", expiresAt).apply()
    if (background) schedule(context)
  }

  @Synchronized
  fun schedule(context: Context, finishingJobId: Int? = null) {
    if (!hasWork(context)) return
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (JOB_ID != finishingJobId && scheduler.getPendingJob(JOB_ID) != null) return
    if (FOLLOW_UP_JOB_ID != finishingJobId && scheduler.getPendingJob(FOLLOW_UP_JOB_ID) != null) return
    // jobFinished() is asynchronous. Schedule the next check under the other ID so
    // it cannot replace a job that Android still considers running.
    val id = if (finishingJobId == JOB_ID) FOLLOW_UP_JOB_ID else JOB_ID
    val component = ComponentName(context, TaskCompletionCheckJobService::class.java)
    val job = JobInfo.Builder(id, component).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
    if (finishingJobId == null && Build.VERSION.SDK_INT >= 31 &&
      scheduler.schedule(job.setExpedited(true).build()) == JobScheduler.RESULT_SUCCESS
    ) return
    if (Build.VERSION.SDK_INT >= 31) job.setExpedited(false)
    if (finishingJobId != null) job.setMinimumLatency(RETRY_DELAY_MS)
    scheduler.schedule(job.build())
  }
}

/** Lets Android schedule a short check using the existing authenticated React Native client. */
class TaskCompletionCheckJobService : JobService(), HeadlessJsTaskEventListener {
  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { running?.let(::finish) }
  private var running: JobParameters? = null
  private var host: ReactHost? = null
  private var reactListener: ReactInstanceEventListener? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskId: Int? = null

  override fun onStartJob(params: JobParameters): Boolean {
    if (!TaskCompletionBackgroundCheck.hasWork(this)) return false
    val reactHost = (application as? ReactApplication)?.reactHost ?: return false
    if (reactHost.currentReactContext?.lifecycleState == LifecycleState.RESUMED) return false
    running = params
    host = reactHost
    handler.postDelayed(timeout, CHECK_TIMEOUT_MS)
    val existing = reactHost.currentReactContext
    if (existing != null && existing.hasActiveReactInstance()) {
      startCheck(params, existing)
    } else {
      val listener = object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          startCheck(params, context)
        }
      }
      reactListener = listener
      reactHost.addReactInstanceEventListener(listener)
      reactHost.start()
    }
    return true
  }

  private fun startCheck(params: JobParameters, context: ReactContext) {
    if (running !== params) return
    if (!TaskCompletionBackgroundCheck.hasWork(this) ||
      context.lifecycleState == LifecycleState.RESUMED
    ) {
      handler.post { finish(params) }
      return
    }
    val tasks = HeadlessJsTaskContext.getInstance(context)
    taskContext = tasks
    tasks.addTaskEventListener(this)
    taskId = tasks.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), CHECK_TIMEOUT_MS, true))
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (this.taskId == taskId) running?.let(::finish)
  }

  private fun finish(params: JobParameters) {
    if (running !== params) return
    val foreground = host?.currentReactContext?.lifecycleState == LifecycleState.RESUMED
    releaseCheck()
    jobFinished(params, false)
    if (!foreground) TaskCompletionBackgroundCheck.schedule(this, finishingJobId = params.jobId)
  }

  override fun onStopJob(params: JobParameters): Boolean {
    if (running !== params) return false
    val foreground = host?.currentReactContext?.lifecycleState == LifecycleState.RESUMED
    releaseCheck()
    return !foreground && TaskCompletionBackgroundCheck.hasWork(this)
  }

  override fun onDestroy() {
    releaseCheck()
    super.onDestroy()
  }

  private fun releaseCheck() {
    handler.removeCallbacks(timeout)
    running = null
    reactListener?.let { host?.removeReactInstanceEventListener(it) }
    reactListener = null
    host = null
    taskContext?.removeTaskEventListener(this)
    taskId?.let { taskContext?.finishTask(it) }
    taskId = null
    taskContext = null
  }

  companion object {
    private const val TASK = "T3TaskCompletionCheck"
    private const val CHECK_TIMEOUT_MS = 30_000L
  }
}
