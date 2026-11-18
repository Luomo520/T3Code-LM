import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

import type { AndroidUpdateAsset } from "../features/settings/androidAppUpdate";

export interface AppUpdateDownload {
  readonly id: string;
  readonly status: "pending" | "downloading" | "paused" | "downloaded" | "failed" | "missing";
  readonly version: string;
  readonly fileName: string;
  readonly bytesDownloaded?: number;
  readonly totalBytes?: number;
  readonly reason?: number;
}

interface NativeAppUpdates {
  enqueueAppUpdateDownload: (
    url: string,
    fileName: string,
    version: string,
    versionCode: number,
    sizeBytes: number,
    sha256: string,
    allowMetered: boolean,
  ) => Promise<string>;
  getAppUpdateDownload: () => Promise<AppUpdateDownload | null>;
  openAppUpdateInstaller: () => Promise<void>;
  cancelAppUpdateDownload: () => Promise<void>;
}

function nativeUpdates(): NativeAppUpdates {
  const native = requireOptionalNativeModule<NativeAppUpdates>("T3NativeControls");
  if (Platform.OS !== "android" || !native?.enqueueAppUpdateDownload) {
    throw new Error("此 App 尚不支持应用内更新，请手动下载并安装新版 APK。");
  }
  return native;
}

export async function enqueueAppUpdate(asset: AndroidUpdateAsset, allowMetered: boolean) {
  const native = nativeUpdates();
  if (Number(Platform.Version) < 29) {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (
      !(await PermissionsAndroid.check(permission)) &&
      (await PermissionsAndroid.request(permission)) !== PermissionsAndroid.RESULTS.GRANTED
    ) {
      throw new Error("下载 APK 到 Download/T3Code 需要存储权限，请允许后重试。");
    }
  }
  return native.enqueueAppUpdateDownload(
    asset.url,
    asset.fileName,
    `${asset.productVersion}-${asset.build}`,
    asset.androidVersionCode,
    asset.sizeBytes,
    asset.sha256,
    allowMetered,
  );
}

export const readAppUpdateDownload = () => nativeUpdates().getAppUpdateDownload();
export const openAppUpdateInstaller = () => nativeUpdates().openAppUpdateInstaller();
export const cancelAppUpdateDownload = () => nativeUpdates().cancelAppUpdateDownload();
