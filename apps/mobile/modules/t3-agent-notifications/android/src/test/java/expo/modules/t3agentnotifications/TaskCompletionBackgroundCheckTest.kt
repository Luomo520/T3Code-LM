package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class TaskCompletionBackgroundCheckTest {
  private val context = RuntimeEnvironment.getApplication()
  private val scheduler = context.getSystemService(JobScheduler::class.java)
  private val notifications = context.getSystemService(NotificationManager::class.java)

  @Test
  fun schedulesOnlyWhileABackgroundWatchIsPending() {
    shadowOf(notifications).setNotificationsEnabled(true)
    val watch = "{}"
    val expiresAt = System.currentTimeMillis() + 120_000
    TaskCompletionBackgroundCheck.update(context, watch, expiresAt, background = false)
    assertEquals(watch, TaskCompletionBackgroundCheck.read(context))
    assertTrue(scheduler.allPendingJobs.isEmpty())

    TaskCompletionBackgroundCheck.update(context, watch, expiresAt, background = true)
    val first = scheduler.allPendingJobs.single()
    assertEquals(TaskCompletionCheckJobService::class.java.name, first.service.className)
    assertTrue(first.isExpedited)
    assertTrue(notifications.activeNotifications.isEmpty())

    TaskCompletionBackgroundCheck.schedule(context, finishingJobId = first.id)
    val followUp = scheduler.allPendingJobs.single { it.id != first.id }
    assertNotEquals(first.id, followUp.id)
    assertTrue(followUp.minLatencyMillis > 0)

    TaskCompletionBackgroundCheck.update(context, null, 0, background = true)
    assertNull(TaskCompletionBackgroundCheck.read(context))
    assertTrue(scheduler.allPendingJobs.isEmpty())
  }

  @Test
  fun upgradeClearsOnlyTheLegacyMonitorAndRetainsTheCompletionLink() {
    shadowOf(notifications).setNotificationsEnabled(true)
    val channel = "task-completion-monitor"
    notifications.createNotificationChannel(
      NotificationChannel(channel, "Task monitor", NotificationManager.IMPORTANCE_LOW)
    )
    val launcher = ComponentName(context, Activity::class.java)
    shadowOf(context.packageManager).addActivityIfNotPresent(launcher)
    shadowOf(context.packageManager).addIntentFilterForActivity(
      launcher,
      IntentFilter(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
    )
    notifications.notify(
      73002,
      Notification.Builder(context, channel)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .build()
    )
    val path = "/threads/environment/thread"
    AgentNotifications.postTaskCompletion(context, "t3code", path, "one", "Thread", false)

    LegacyTaskCompletionCleanupReceiver().onReceive(context, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))

    assertNull(notifications.getNotificationChannel(channel))
    val completion = notifications.activeNotifications.single().notification
    assertEquals("任务已完成", completion.extras.getString(Notification.EXTRA_TITLE))
    assertEquals(
      "t3code://threads/environment/thread",
      shadowOf(completion.contentIntent).savedIntent.data.toString()
    )
  }
}
