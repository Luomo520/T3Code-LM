import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

export interface FileDownload {
  readonly status: "pending" | "downloading" | "paused" | "downloaded" | "failed" | "cancelled";
  readonly bytesDownloaded: number;
  readonly totalBytes?: number;
  readonly error?: string;
}

interface NativeDownloads {
  enqueueFileDownload: (url: string, name: string) => Promise<string>;
  getFileDownload: (id: string) => Promise<FileDownload | null>;
  cancelFileDownload: (id: string) => Promise<void>;
  showFileDownloads: () => Promise<void>;
}
function nativeDownloads(): NativeDownloads {
  const module = requireOptionalNativeModule<NativeDownloads>("T3NativeControls");
  if (Platform.OS !== "android" || !module?.getFileDownload)
    throw new Error("当前 App 不支持内置下载，请安装新版 APK。");
  return module;
}
export async function enqueueFileDownload(url: string, name: string): Promise<string> {
  const native = nativeDownloads();
  const response = await fetch(url, { method: "HEAD", cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "大文件仅支持局域网直接下载，请连接局域网后重试。"
        : response.status === 409
          ? "文件已变化，请重新点击下载。"
          : "下载文件暂不可用，请检查文件、权限及网络后重试。",
    );
  }
  if (Number(Platform.Version) < 29) {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (
      !(await PermissionsAndroid.check(permission)) &&
      (await PermissionsAndroid.request(permission)) !== PermissionsAndroid.RESULTS.GRANTED
    ) {
      throw new Error("保存到 Download/t3code 需要存储权限，请允许后重试。");
    }
  }
  return native.enqueueFileDownload(url, name);
}
export const readFileDownload = (id: string) => nativeDownloads().getFileDownload(id);
export const cancelFileDownload = (id: string) => nativeDownloads().cancelFileDownload(id);
export const showDownloadedFiles = () => nativeDownloads().showFileDownloads();
