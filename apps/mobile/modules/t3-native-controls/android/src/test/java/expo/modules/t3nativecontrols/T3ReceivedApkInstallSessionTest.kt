package expo.modules.t3nativecontrols

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import org.json.JSONObject
import org.junit.Assert.assertEquals
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
      receiver.onReceive(context, Intent("expo.modules.t3nativecontrols.RECEIVED_APK_INSTALL_RESULT")
        .putExtra("receiptKey", key)
        .putExtra(PackageInstaller.EXTRA_SESSION_ID, id)
        .putExtra(PackageInstaller.EXTRA_STATUS, status))
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
}
