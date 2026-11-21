package expo.modules.t3nativecontrols

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal data class DownloadState(
  val status: String,
  val bytes: Long = 0,
  val total: Long? = null,
  val uri: Uri? = null,
  val error: String? = null,
) {
  fun toMap(): Map<String, Any> = buildMap {
    put("status", status)
    put("bytesDownloaded", bytes.toDouble())
    total?.let { put("totalBytes", it.toDouble()) }
    error?.let { put("error", it) }
  }
}

internal class DownloadTask(
  val url: URL,
  val fileName: String,
  val allowCellular: Boolean,
  val updateBytes: Long? = null,
  private val saveUpdate: ((String, Uri) -> Unit)? = null,
) {
  val id = UUID.randomUUID().toString()
  val isUpdate = updateBytes != null
  val cancelled = AtomicBoolean(false)
  @Volatile var state = DownloadState("pending", total = updateBytes)
    private set

  fun cancel() {
    cancelled.set(true)
  }

  @Synchronized
  fun transition(next: DownloadState) {
    state = next
  }

  @Synchronized
  fun progress(bytes: Long, total: Long?) {
    state = DownloadState("downloading", maxOf(state.bytes, bytes), total)
  }

  fun complete(context: Context, uri: Uri) {
    try {
      checkRunning()
      saveUpdate?.invoke(id, uri)
      checkRunning()
      transition(DownloadState("downloaded", state.total ?: state.bytes, state.total, uri))
    } catch (error: Exception) {
      T3DownloadDestination.remove(context, uri)
      throw error
    }
  }

  fun checkRunning() {
    if (cancelled.get() || Thread.currentThread().isInterrupted) throw InterruptedException()
  }

  fun acceptsRedirect(from: URL, to: URL): Boolean {
    if (to.userInfo != null || to.ref != null) return false
    if (isUpdate) {
      return to.protocol == "https" && (to.port == -1 || to.port == 443) &&
        to.host in listOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
    }
    val fromPort = if (from.port == -1) from.defaultPort else from.port
    val toPort = if (to.port == -1) to.defaultPort else to.port
    return from.host.equals(to.host, ignoreCase = true) && (
      (from.protocol == to.protocol && fromPort == toPort) ||
        (from.protocol == "http" && to.protocol == "https" && fromPort == 80 && toPort == 443)
      )
  }
}

internal object T3Downloads {
  private val tasks = LinkedHashMap<String, DownloadTask>()

  @Synchronized
  fun start(context: Context, task: DownloadTask) {
    tasks[task.id] = task
    val expired = tasks.values.filter { it.state.status in TERMINAL }.dropLast(32)
    expired.forEach { tasks.remove(it.id) }
    try {
      val intent = Intent(context, T3DownloadService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    } catch (error: Exception) {
      tasks.remove(task.id)
      throw error
    }
  }

  @Synchronized
  fun get(id: String) = tasks[id]

  @Synchronized
  fun waiting(): List<DownloadTask> = tasks.values.filter { it.state.status in WAITING }

  @Synchronized
  fun failPending(message: String) {
    waiting().forEach {
      it.transition(DownloadState("failed", total = it.updateBytes, error = message))
    }
  }

  private val TERMINAL = setOf("downloaded", "failed", "cancelled")
  private val WAITING = setOf("pending", "paused")
}

class T3DownloadService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val notifications get() = getSystemService(NotificationManager::class.java)
  private val connectivity get() = getSystemService(ConnectivityManager::class.java)
  private var active: DownloadTask? = null
  private var destroyed = false
  private var startId = 0
  private val networkChanges = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) { main.post { pump() } }
    override fun onLost(network: Network) { main.post { pump() } }
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
      main.post { pump() }
    }
  }

  private val refresh = object : Runnable {
    override fun run() {
      val task = active ?: return
      notifications.notify(FOREGROUND_ID, ongoing(task))
      main.postDelayed(this, 750)
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notifications.createNotificationChannel(NotificationChannel(CHANNEL, "T3 Code 下载", NotificationManager.IMPORTANCE_LOW))
    }
    connectivity.registerDefaultNetworkCallback(networkChanges)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    this.startId = startId
    if (intent?.action == CANCEL) intent.getStringExtra("id")?.let { T3Downloads.get(it)?.cancel() }
    val notification = ongoing(active)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(FOREGROUND_ID, notification)
    }
    pump()
    return START_NOT_STICKY
  }

  private fun pump() {
    if (destroyed || active != null || startId == 0) return
    var paused: DownloadTask? = null
    for (task in T3Downloads.waiting()) {
      if (task.cancelled.get()) {
        task.transition(DownloadState("cancelled", total = task.updateBytes))
        continue
      }
      val gate = DownloadNetwork(connectivity, task.allowCellular)
      val network = gate.allowed()
      if (network != null) {
        startTransfer(task, gate, network)
        return
      }
      task.transition(DownloadState("paused", total = task.updateBytes))
      if (paused == null) paused = task
    }
    if (paused != null) notifications.notify(FOREGROUND_ID, ongoing(paused))
    else if (stopSelfResult(startId)) stopForeground(STOP_FOREGROUND_REMOVE)
  }

  private fun startTransfer(task: DownloadTask, gate: DownloadNetwork, network: Network) {
    active = task
    task.transition(DownloadState("downloading", total = task.updateBytes))
    refresh.run()
    worker.execute {
      download(task, gate, network)
      main.post {
        if (destroyed) return@post
        main.removeCallbacks(refresh)
        active = null
        if (!task.cancelled.get() && task.state.status in listOf("downloaded", "failed")) {
          notifications.notify(task.id, 1, finished(task))
        }
        pump()
      }
    }
  }

  private fun download(task: DownloadTask, gate: DownloadNetwork, network: Network) {
    val wake = getSystemService(PowerManager::class.java).newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK, "$packageName:download",
    )
    try {
      task.checkRunning()
      wake.acquire()
      T3DownloadDestination.create(this, task.fileName, task.isUpdate).use { destination ->
        T3HttpDownload(
          connect = { network.openConnection(it) as HttpURLConnection },
          checkActive = {
            task.checkRunning()
            if (gate.allowed() != network) throw IOException("Download network changed")
          },
          redirectAllowed = task::acceptsRedirect,
          progress = task::progress,
        ).transfer(task.url, destination.channel, task.updateBytes)
        task.checkRunning()
        task.complete(this, destination.publish())
      }
    } catch (_: InterruptedException) {
      task.transition(DownloadState("cancelled", total = task.updateBytes))
    } catch (error: Exception) {
      val next = when {
        task.cancelled.get() -> DownloadState("cancelled", total = task.updateBytes)
        error is IOException && error !is DownloadFailure && gate.allowed(refresh = true) != network ->
          DownloadState("paused", total = task.updateBytes)
        else -> DownloadState("failed", total = task.updateBytes,
          error = (error as? DownloadFailure)?.message ?: "下载中断，请检查网络和可用空间后重试。")
      }
      task.transition(next)
    } finally {
      if (wake.isHeld) wake.release()
    }
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    active?.cancel()
    T3Downloads.failPending("Android 后台下载时间已用完，请打开应用后重试。")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    destroyed = true
    main.removeCallbacks(refresh)
    active?.cancel()
    worker.shutdownNow()
    connectivity.unregisterNetworkCallback(networkChanges)
    super.onDestroy()
  }

  private fun builder(): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
    else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

  private fun openApp(): PendingIntent? =
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }

  private fun ongoing(task: DownloadTask?): Notification {
    val state = task?.state
    val total = state?.total
    val percent = if (total != null && total > 0) {
      ((state.bytes.toDouble() / total) * 100).toInt().coerceIn(0, 100)
    } else 0
    val detail = when (state?.status) {
      "paused" -> if (task?.allowCellular == false) "等待 Wi-Fi 或以太网" else "等待网络连接"
      "downloading" -> if (total != null && total > 0) "正在下载 · $percent%" else "正在下载"
      else -> "正在准备下载"
    }
    val notification = builder().setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(task?.fileName ?: "T3 Code 下载")
      .setContentText(detail).setOnlyAlertOnce(true).setOngoing(true)
      .setContentIntent(openApp())
      .setProgress(100, percent, total == null || state?.status != "downloading")
    if (task != null) {
      val cancel = Intent(this, T3DownloadService::class.java).setAction(CANCEL)
        .setData(Uri.parse("t3download:${task.id}")).putExtra("id", task.id)
      val action = PendingIntent.getService(this, 0, cancel, PendingIntent.FLAG_IMMUTABLE)
      notification.addAction(Notification.Action.Builder(null, "取消下载", action).build())
    }
    return notification.build()
  }

  private fun finished(task: DownloadTask): Notification {
    val success = task.state.status == "downloaded"
    val intent = if (success && !task.isUpdate) {
      val folder = T3DownloadDestination.folderIntent()
      if (folder.resolveActivity(packageManager) != null) {
        PendingIntent.getActivity(this, 0, folder, PendingIntent.FLAG_IMMUTABLE)
      } else openApp()
    } else openApp()
    val detail = if (!success) task.state.error
    else if (task.isUpdate) "返回应用校验并安装"
    else "已保存到 Download/t3code"
    return builder().setSmallIcon(if (success) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error)
      .setContentTitle(task.fileName).setContentText(detail)
      .setStyle(Notification.BigTextStyle().bigText(detail))
      .setContentIntent(intent).setAutoCancel(true).build()
  }

  private companion object {
    const val CHANNEL = "t3-downloads"
    const val FOREGROUND_ID = 0x7433444C
    const val CANCEL = "expo.modules.t3nativecontrols.CANCEL_DOWNLOAD"
  }
}

private class DownloadNetwork(
  private val connectivity: ConnectivityManager,
  private val allowCellular: Boolean,
) {
  private var checkedAt = -200L
  private var lastNetwork: Network? = null

  @Synchronized
  fun allowed(refresh: Boolean = false): Network? {
    val now = SystemClock.elapsedRealtime()
    if (!refresh && now - checkedAt < 200) return lastNetwork
    checkedAt = now
    val network = connectivity.activeNetwork
    val capabilities = network?.let(connectivity::getNetworkCapabilities)
    lastNetwork = if (capabilities != null && permitted(capabilities)) network else null
    return lastNetwork
  }

  @Suppress("DEPRECATION")
  private fun permitted(capabilities: NetworkCapabilities): Boolean {
    val roaming = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING)
    } else connectivity.activeNetworkInfo?.isRoaming == true
    if (roaming) return false
    return allowCellular || (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
      !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
      (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)))
  }
}
