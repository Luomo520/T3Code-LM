package expo.modules.t3nativecontrols

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.util.Locale

internal const val APK_DOWNLOAD_MIME = "application/vnd.android.package-archive"

internal interface T3DownloadDestination : Closeable {
  val channel: FileChannel
  fun publish(record: (Uri) -> Unit = {}): Uri

  companion object {
    private const val FOLDER = "t3code"

    fun create(context: Context, fileName: String, update: Boolean): T3DownloadDestination {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val extension = fileName.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val mimeType = if (update) APK_DOWNLOAD_MIME
        else MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
        return SharedDownload(context, fileName, mimeType)
      }
      return LegacyDownload(fileName)
    }

    fun publishRecovered(context: Context, uri: Uri) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || uri.scheme != "content") return
      val column = MediaStore.MediaColumns.IS_PENDING
      val pending = context.contentResolver.query(uri, arrayOf(column), null, null, null)
        ?.use { it.moveToFirst() && it.getInt(0) != 0 } == true
      if (!pending) return
      val values = ContentValues().apply { put(column, 0) }
      if (context.contentResolver.update(uri, values, null, null) != 1) {
        throw DownloadFailure("无法恢复下载文件，请重新领取。")
      }
    }

    fun remove(context: Context, uri: Uri) {
      if (uri.scheme == "file") uri.path?.let { File(it).delete() }
      else context.contentResolver.delete(uri, null, null)
    }

    fun folderIntent() = Intent("android.intent.action.VIEW_DOWNLOADS")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private class SharedDownload(context: Context, fileName: String, mimeType: String) : T3DownloadDestination {
    private val resolver = context.contentResolver
    private val uri = resolver.insert(
      MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
      ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER/")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      },
    ) ?: throw DownloadFailure("无法创建下载文件，请检查可用空间。")
    private val stream = try {
      ParcelFileDescriptor.AutoCloseOutputStream(
        resolver.openFileDescriptor(uri, "rw")
          ?: throw DownloadFailure("无法写入下载文件，请检查设备存储。"),
      )
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
    override val channel: FileChannel = stream.channel
    private var published = false

    override fun publish(record: (Uri) -> Unit): Uri {
      channel.force(true)
      stream.close()
      record(uri)
      val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      if (resolver.update(uri, values, null, null) != 1) {
        throw DownloadFailure("无法将文件保存到 Download/t3code。")
      }
      published = true
      return uri
    }

    override fun close() {
      try {
        stream.close()
      } finally {
        if (!published) resolver.delete(uri, null, null)
      }
    }
  }

  @Suppress("DEPRECATION")
  private class LegacyDownload(private val fileName: String) : T3DownloadDestination {
    private val directory = File(
      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER,
    )
    private val temporary = run {
      if (!directory.isDirectory && !directory.mkdirs()) {
        throw DownloadFailure("无法创建 Download/t3code，请检查存储权限和可用空间。")
      }
      File.createTempFile(".t3-", ".part", directory)
    }
    private val file = try {
      RandomAccessFile(temporary, "rw")
    } catch (error: Exception) {
      temporary.delete()
      throw error
    }
    override val channel: FileChannel = file.channel

    override fun publish(record: (Uri) -> Unit): Uri {
      channel.force(true)
      file.close()
      val dot = fileName.lastIndexOf('.').takeIf { it > 0 } ?: fileName.length
      val stem = fileName.substring(0, dot)
      val extension = fileName.substring(dot)
      var target = File(directory, fileName)
      var suffix = 1
      while (!target.createNewFile()) target = File(directory, "$stem (${suffix++})$extension")
      val uri = Uri.fromFile(target)
      try {
        record(uri)
        if (!temporary.renameTo(target)) {
          throw DownloadFailure("无法将文件保存到 Download/t3code。")
        }
      } catch (error: Exception) {
        target.delete()
        throw error
      }
      return uri
    }

    override fun close() {
      try {
        file.close()
      } finally {
        temporary.delete()
      }
    }
  }
}
