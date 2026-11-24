package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    OnActivityEntersForeground {
      AgentNotifications.setActivityForeground(true)
      appContext.reactContext?.let(CaptureRequestNotifications::clearPosted)
    }
    OnActivityEntersBackground { AgentNotifications.setActivityForeground(false) }

    Function("supportsLocalTaskCompletion") {
      appContext.reactContext?.let(AgentNotifications::supportsLocalTaskCompletion) ?: false
    }

    OnCreate {
      appContext.reactContext?.let(TaskCompletionBackgroundCheck::clearLegacyNotification)
    }

    Function("readTaskCompletionWatch") {
      appContext.reactContext?.let(TaskCompletionBackgroundCheck::read)
    }

    Function("setTaskCompletionWatch") { watch: String?, expiresAt: Double, background: Boolean ->
      appContext.reactContext?.let {
        TaskCompletionBackgroundCheck.update(it, watch, expiresAt.toLong(), background)
      }
    }

    Function("postTaskCompletion") {
        scheme: String,
        path: String,
        runId: String,
        title: String,
        failed: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.postTaskCompletion(it, scheme, path, runId, title, failed)
      }
    }

    Function("canNotifyCaptureRequests") {
      appContext.reactContext?.let(CaptureRequestNotifications::canPost) ?: false
    }

    Function("readCaptureRequestWatch") {
      appContext.reactContext?.let(CaptureRequestNotifications::watchUntil)?.toDouble() ?: 0.0
    }

    Function("setCaptureRequestWatch") { until: Double ->
      appContext.reactContext?.let { CaptureRequestNotifications.updateWatch(it, until.toLong()) }
    }

    Function("postCaptureRequest") {
        scheme: String,
        path: String,
        environmentId: String,
        jobId: String,
        name: String,
        recording: Boolean,
        expiresInMs: Double
      ->
      val context = appContext.reactContext
      if (context is ReactContext && context.lifecycleState != LifecycleState.RESUMED) {
        CaptureRequestNotifications.post(
          context, scheme, path, environmentId, jobId, name, recording, expiresInMs.toLong()
        )
      }
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
