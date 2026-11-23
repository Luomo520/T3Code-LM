package expo.modules.t3nativecontrols

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class T3ReceivedApkInstallSessionTest {
  @Test
  fun onlyTheCurrentSessionCanReplaceThePreviousCancellation() {
    val context = RuntimeEnvironment.getApplication()
    val store = context.getSharedPreferences(T3ReceivedApkInstallSession.STORE, Context.MODE_PRIVATE)
    val key = "handoff"
    store.edit().putString(key, "cancelled").commit()

    val receiver = T3ReceivedApkInstallSession()
    fun receive(id: Int, status: Int) {
      receiver.onReceive(context, resultIntent(key, id, status))
    }
    fun state() = T3ReceivedApkInstallSession.readAttempt(store.getString(key, null))?.getString("status")

    receive(2, PackageInstaller.STATUS_SUCCESS)
    assertEquals("cancelled", store.getString(key, null))

    store.edit().putString(key, JSONObject().put("sessionId", 2).put("status", "pending").toString()).commit()
    receive(1, PackageInstaller.STATUS_FAILURE_ABORTED)
    receive(2, PackageInstaller.STATUS_PENDING_USER_ACTION)
    assertEquals("pending", state())

    receive(2, PackageInstaller.STATUS_SUCCESS)
    receive(2, PackageInstaller.STATUS_FAILURE_ABORTED)
    assertEquals("verified", state())

    store.edit().putString(key, JSONObject().put("sessionId", 3).put("status", "pending").toString()).commit()
    receive(3, PackageInstaller.STATUS_FAILURE_ABORTED)
    assertEquals("cancelled", state())
  }

  @Test
  fun recreatedReceiverPersistsCancellationAndSuccessWithoutAnAppListener() {
    val context = RuntimeEnvironment.getApplication()
    val store = context.getSharedPreferences(T3ReceivedApkInstallSession.STORE, Context.MODE_PRIVATE)
    val key = "restarted-handoff"
    fun writePending(id: Int) {
      val attempt = JSONObject().put("sessionId", id).put("status", "pending")
        .put("packageName", "com.example.savedapk").put("version", "1.2.3").put("versionCode", "42")
      check(store.edit().putString(key, attempt.toString()).commit())
    }
    fun sendResult(id: Int, status: Int) {
      T3ReceivedApkInstallSession().onReceive(context, resultIntent(key, id, status))
    }
    fun saved() = T3ReceivedApkInstallSession.readAttempt(store.getString(key, null))

    // 丢弃应用内监听器后，新的广播接收器仍从持久记录核对会话编号。
    T3ReceivedApkInstallSession.onResult = null
    assertNull(saved())
    writePending(21)
    sendResult(21, PackageInstaller.STATUS_FAILURE_ABORTED)
    assertEquals("cancelled", saved()?.getString("status"))

    writePending(22)
    sendResult(21, PackageInstaller.STATUS_SUCCESS)
    assertEquals("pending", saved()?.getString("status"))
    sendResult(22, PackageInstaller.STATUS_SUCCESS)
    assertEquals("verified", saved()?.getString("status"))
    assertEquals("com.example.savedapk", saved()?.getString("packageName"))
    assertEquals("42", saved()?.getString("versionCode"))
  }

  @Test
  fun duplicateAndStaleCompletionCallbacksNotifyOnce() {
    val context = RuntimeEnvironment.getApplication()
    val store = context.getSharedPreferences(T3ReceivedApkInstallSession.STORE, Context.MODE_PRIVATE)
    val key = "receipt-with-retry"
    val registration = JSONObject().put("sessionId", 51).put("status", "pending")
    check(store.edit().putString(key, registration.toString()).commit())
    val notifications = mutableListOf<String>()
    T3ReceivedApkInstallSession.onResult = { receiptKey -> notifications.add(receiptKey) }
    fun finish(id: Int, status: Int) {
      T3ReceivedApkInstallSession().onReceive(context, resultIntent(key, id, status))
    }

    try {
      finish(50, PackageInstaller.STATUS_SUCCESS)
      finish(51, PackageInstaller.STATUS_SUCCESS)
      finish(51, PackageInstaller.STATUS_SUCCESS)
      finish(51, PackageInstaller.STATUS_FAILURE_ABORTED)
      assertEquals(listOf(key), notifications)
      assertEquals("verified", T3ReceivedApkInstallSession.readAttempt(store.getString(key, null))?.getString("status"))
    } finally {
      T3ReceivedApkInstallSession.onResult = null
    }
  }

  private fun resultIntent(key: String, id: Int, status: Int) =
    Intent("expo.modules.t3nativecontrols.RECEIVED_APK_INSTALL_RESULT")
      .putExtra("receiptKey", key)
      .putExtra(PackageInstaller.EXTRA_SESSION_ID, id)
      .putExtra(PackageInstaller.EXTRA_STATUS, status)
}
