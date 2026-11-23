package expo.modules.t3nativecontrols

import android.os.Binder
import android.os.ParcelFileDescriptor
import android.os.Process
import java.io.InputStream
import java.util.concurrent.FutureTask
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/** Shizuku/Sui 只接收 APK 数据，安装到调用应用所属的 Android 用户。 */
class T3ApkInstallService : IT3ApkInstallService.Stub() {
  @Volatile private var installation: FutureTask<String?>? = null

  override fun destroy() = exitProcess(0)

  @Synchronized
  override fun openInstallStream(sizeBytes: Long, expectedUid: Int, packageName: String): ParcelFileDescriptor {
    check((expectedUid == T3ShizukuApkInstaller.ADB_UID || expectedUid == T3ShizukuApkInstaller.ROOT_UID)
      && Process.myUid() == expectedUid) { T3ShizukuApkInstaller.ACCESS_CHANGED }
    require(packageName.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))) {
      "APK 包名无效或属于系统。"
    }
    require(sizeBytes > 0) { "APK 文件为空或无法读取。" }
    check(installation == null) { "已有 APK 安装正在进行。" }
    // Android UID 以每用户 100000 个 ID 分区。显式指定用户可以避免安装到所有用户。
    val userId = Binder.getCallingUid() / 100_000
    // 让安装进程创建管道，ADB Shell 无需读取普通应用的私有缓存目录。
    val (readSide, writeSide) = ParcelFileDescriptor.createPipe()
    val task = FutureTask {
      ParcelFileDescriptor.AutoCloseInputStream(readSide).use { install(it, userId, sizeBytes, packageName) }
    }
    installation = task
    thread(name = "t3-apk-install") { task.run() }
    return writeSide
  }

  override fun awaitInstallResult(): String? {
    val task = checkNotNull(installation) { "APK 安装尚未开始。" }
    return task.get()
  }

  private fun install(input: InputStream, userId: Int, sizeBytes: Long, packageName: String): String? {
    // 以安装进程的身份检查系统包，包括当前用户已移除的预装包。
    val listing = ProcessBuilder(
      "/system/bin/cmd", "package", "list", "packages", "-s", "-u", "--user", userId.toString(), packageName
    ).redirectErrorStream(true).start()
    val packages = listing.inputStream.bufferedReader().use { it.readLines() }
    if (listing.waitFor() != 0 || packages.any { !it.startsWith("package:") }) {
      return "无法核对系统应用，请改用系统安装器。"
    }
    if ("package:$packageName" in packages) return "设备授权安装不适用于系统应用，请使用系统安装器。"

    // 固定安装包名，Android 会核对实际 APK 内的包名。

    val process = ProcessBuilder(
      "/system/bin/cmd", "package", "install", "-r", "--user", userId.toString(),
      "--pkg", packageName, "-S", sizeBytes.toString(), "-"
    ).redirectErrorStream(true).start()
    val readResult = FutureTask {
      process.inputStream.bufferedReader().use { it.readText().trim() }
    }
    thread(name = "t3-apk-install-result") { readResult.run() }
    try {
      val transferredBytes = runCatching {
        process.outputStream.use { output -> input.copyTo(output) }
      }.getOrNull()
      val result = readResult.get()
      if (process.waitFor() == 0 && transferredBytes == sizeBytes && result == "Success") return null
      // 安装器可能在读取输入前拒绝安装。保留它给出的原因。
      return result.take(400).ifBlank { "Android 安装器未返回成功结果。" }
    } finally {
      process.destroy()
    }
  }
}
