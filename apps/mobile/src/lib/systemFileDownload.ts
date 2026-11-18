import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

interface NativeDownloads {
  enqueueFileDownload?: (url: string, name: string) => Promise<string>;
  showFileDownloads?: () => Promise<void>;
}
function nativeDownloads(): NativeDownloads {
  const module = requireOptionalNativeModule<NativeDownloads>("T3NativeControls");
  if (!module?.enqueueFileDownload)
    throw new Error("当前 App 不支持系统下载，请安装包含下载功能的新 APK。");
  return module;
}
export async function enqueueSystemFileDownload(url: string, name: string): Promise<string> {
  if (Platform.OS !== "android") throw new Error("此下载方式仅支持安卓。");
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
      throw new Error("保存到 Download/T3Code 需要存储权限，请允许后重试。");
    }
  }
  return nativeDownloads().enqueueFileDownload!(url, name);
}
export async function showSystemFileDownloads(): Promise<void> {
  await nativeDownloads().showFileDownloads?.();
}
