import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import { supportedCpuArchitectures } from "expo-device";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import {
  cancelAppUpdateDownload,
  enqueueAppUpdate,
  openAppUpdateInstaller,
  readAppUpdateDownload,
  type AppUpdateDownload,
} from "../../../lib/systemAppUpdate";
import { showSystemFileDownloads } from "../../../lib/systemFileDownload";
import {
  findAndroidAppUpdate,
  requiresMobileDownloadConfirmation,
  type AndroidUpdateAsset,
} from "../androidAppUpdate";
import { SettingsSection } from "./SettingsSection";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后重试。";
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function taskDescription(task: AppUpdateDownload): string {
  switch (task.status) {
    case "downloaded":
      return "已下载；点击校验并交给系统安装。";
    case "failed":
      return "系统下载失败，可查看详情或取消后重新下载。";
    case "missing":
      return "下载任务已不存在，请取消后重新下载。";
    case "paused":
      return "系统下载已暂停；等待网络或查看系统下载。";
    case "pending":
      return "等待系统开始下载，切到后台后仍会继续。";
    case "downloading":
      return task.totalBytes && task.totalBytes > 0
        ? `${sizeLabel(task.bytesDownloaded ?? 0)} / ${sizeLabel(task.totalBytes)} · 由系统后台下载`
        : "正在由系统后台下载。";
  }
}

export function AndroidAppUpdateSection() {
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [asset, setAsset] = useState<AndroidUpdateAsset | null>(null);
  const [task, setTask] = useState<AppUpdateDownload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);

  const refreshTask = useCallback(async () => {
    try {
      const value = await readAppUpdateDownload();
      if (mounted.current) setTask(value);
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
    }
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the system-owned DownloadManager task on mount and after Android resumes the App.
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS !== "android") return;
    // oxlint-disable-next-line react/set-state-in-effect -- queries an external native task asynchronously; no APK fetch or React-derived state reset.
    void refreshTask();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshTask();
    });
    return () => {
      mounted.current = false;
      controller.current?.abort();
      subscription.remove();
    };
  }, [refreshTask]);

  if (Platform.OS !== "android") return null;

  const check = async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    setNotice(null);
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(() => request.abort(), 30_000);
    try {
      const result = await findAndroidAppUpdate(
        {
          installedBuild: Number(nativeBuildVersion),
          architectures: supportedCpuArchitectures ?? [],
        },
        request.signal,
      );
      if (!mounted.current) return;
      setAsset(result);
      setNotice(result ? null : "未发现适用于此设备的更新。可继续使用当前版本。");
    } catch (error) {
      if (mounted.current)
        setNotice(request.signal.aborted ? "检查更新超时，请重试。" : messageOf(error));
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setNotice(null);
    try {
      await action();
      await refreshTask();
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const download = async () => {
    if (!asset || busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      const network = await Network.getNetworkStateAsync();
      if (!mounted.current) return;
      if (network.isConnected === false || network.isInternetReachable === false) {
        setNotice("当前无法访问网络，请连接后重试。");
        return;
      }
      const metered = requiresMobileDownloadConfirmation(network.type);
      Dialog.confirm({
        title: metered ? "使用移动网络下载更新？" : "下载 App 更新？",
        message: `${asset.productVersion}-${asset.build} · ${sizeLabel(asset.sizeBytes)}。${metered ? "当前为移动网络或网络类型未知，可能产生流量费用。" : "若切换到移动网络，下载会暂停。"}下载完成后仍需你确认安装。`,
        confirmText: "下载 APK",
        onConfirm: () => {
          void run(() => enqueueAppUpdate(asset, metered));
        },
      });
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  return (
    <SettingsSection
      title="App 更新"
      footer={notice ?? "下载到 Download/T3Code，安装由系统确认。不会更新已连接的服务端。"}
    >
      <ListActionRow
        icon="arrow.clockwise"
        label={checking ? "正在检查更新…" : "检查 App 更新"}
        description={`当前 ${nativeApplicationVersion ?? "未知版本"} · 构建 ${nativeBuildVersion ?? "未知"}`}
        loading={checking}
        disabled={working}
        onPress={() => {
          void check();
        }}
      />
      {asset && !task ? (
        <ListActionRow
          icon="arrow.down.circle"
          label={`下载 ${asset.productVersion}-${asset.build}`}
          description={sizeLabel(asset.sizeBytes)}
          loading={working}
          disabled={checking}
          onPress={() => {
            void download();
          }}
        />
      ) : null}
      {task ? (
        <>
          <ListActionRow
            icon={task.status === "downloaded" ? "checkmark.circle" : "arrow.clockwise"}
            label={task.status === "downloaded" ? "校验并安装" : "刷新下载状态"}
            description={`${task.version} · ${taskDescription(task)}`}
            loading={working}
            disabled={checking}
            onPress={() => {
              void run(task.status === "downloaded" ? openAppUpdateInstaller : refreshTask);
            }}
          />
          <ListActionRow
            icon="arrow.down.circle"
            label="查看系统下载"
            onPress={() => {
              void run(showSystemFileDownloads);
            }}
            disabled={working || checking}
          />
          <ListActionRow
            icon="trash"
            label={task.status === "downloaded" ? "删除此更新下载" : "取消此更新下载"}
            tone="danger"
            disabled={working || checking}
            onPress={() =>
              Dialog.confirm({
                title: "取消并删除此更新下载？",
                message: "仅删除本次 App 更新包，不影响会话文件。",
                confirmText: "删除更新包",
                destructive: true,
                onConfirm: () => {
                  void run(cancelAppUpdateDownload);
                },
              })
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
