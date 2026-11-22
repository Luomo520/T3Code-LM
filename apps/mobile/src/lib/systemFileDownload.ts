import { WorkspaceDownloadError } from "@t3tools/client-runtime/state/assets";
import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

export interface FileDownload {
  readonly status: "pending" | "downloading" | "paused" | "downloaded" | "failed" | "cancelled";
  readonly bytesDownloaded: number;
  readonly totalBytes?: number;
  readonly error?: string;
  readonly retryable?: boolean;
}

interface NativeDownloads {
  enqueueFileDownload: (url: string, name: string, sizeBytes: number | null) => Promise<string>;
  enqueueVerifiedFileDownload?: (
    url: string,
    name: string,
    sizeBytes: number,
    sha256: string,
  ) => Promise<string>;
  getFileDownload: (id: string) => Promise<FileDownload | null>;
  cancelFileDownload: (id: string) => Promise<void>;
  showFileDownloads: () => Promise<void>;
}
function nativeDownloads(): NativeDownloads {
  const module = requireOptionalNativeModule<NativeDownloads>("T3NativeControls");
  if (Platform.OS !== "android" || !module?.getFileDownload)
    throw new WorkspaceDownloadError({ message: "当前 App 不支持内置下载，请安装新版 APK。" });
  return module;
}
export async function enqueueFileDownload(
  url: string,
  name: string,
  sizeBytes?: number,
  sha256?: string,
): Promise<string> {
  const native = nativeDownloads();
  if (Number(Platform.Version) < 29) {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (
      !(await PermissionsAndroid.check(permission)) &&
      (await PermissionsAndroid.request(permission)) !== PermissionsAndroid.RESULTS.GRANTED
    ) {
      throw new WorkspaceDownloadError({
        message: "保存到 Download/t3code 需要存储权限，请允许后重试。",
      });
    }
  }
  if (sha256 !== undefined && sizeBytes !== undefined) {
    if (!native.enqueueVerifiedFileDownload) {
      throw new WorkspaceDownloadError({ message: "安装新版 APK 后可领取设备传输的文件。" });
    }
    return native.enqueueVerifiedFileDownload(url, name, sizeBytes, sha256);
  }
  return native.enqueueFileDownload(url, name, sizeBytes ?? null);
}
export const readFileDownload = (id: string) => nativeDownloads().getFileDownload(id);
export const cancelFileDownload = (id: string) => nativeDownloads().cancelFileDownload(id);
export const showDownloadedFiles = () => nativeDownloads().showFileDownloads();
