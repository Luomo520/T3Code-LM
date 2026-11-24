package expo.modules.t3nativecontrols

import android.os.ParcelFileDescriptor
import android.os.Process
import kotlin.system.exitProcess

/** 固定执行一张系统截图，只向 App 已打开的私有文件描述符写入。 */
class T3ScreenshotService : IT3ScreenshotService.Stub() {
  override fun destroy() = exitProcess(0)

  override fun capture(destination: ParcelFileDescriptor, expectedUid: Int): Boolean =
    ParcelFileDescriptor.AutoCloseOutputStream(destination).use { output ->
      check(expectedUid in setOf(0, 2000) && Process.myUid() == expectedUid)
      val process = ProcessBuilder("/system/bin/screencap", "-p").start()
      try {
        val bytes = process.inputStream.use { it.copyTo(output) }
        bytes > 0 && process.waitFor() == 0
      } finally {
        process.destroy()
      }
    }
}
