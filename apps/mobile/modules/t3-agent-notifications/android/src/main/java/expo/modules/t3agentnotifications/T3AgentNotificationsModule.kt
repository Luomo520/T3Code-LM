package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
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

    OnActivityEntersForeground { AgentNotifications.setActivityForeground(true) }
    OnActivityEntersBackground { AgentNotifications.setActivityForeground(false) }

    Function("supportsLocalTaskCompletion") {
      appContext.reactContext?.let(AgentNotifications::supportsLocalTaskCompletion) ?: false
    }

    Function("setTaskCompletionMonitoring") { enabled: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, TaskCompletionMonitorService::class.java)
      try {
        if (enabled) {
          if (!AgentNotifications.canPostAlerts(context)) return@Function false
          ContextCompat.startForegroundService(context, intent)
        } else {
          context.stopService(intent)
        }
        true
      } catch (_: IllegalStateException) {
        // Android may reject a start that raced the app's transition to background.
        false
      } catch (_: SecurityException) {
        false
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
