import { useIsFocused } from "@react-navigation/native";
import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import { deviceName, modelName, supportedCpuArchitectures } from "expo-device";
import * as Network from "expo-network";
import type { ForkUpdateChannel } from "@t3tools/shared/forkRelease";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, View } from "react-native";
import { Progress } from "../../../components/ui/Progress";

import * as Dialog from "../../../components/ui/Dialog";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import {
  cancelAppUpdateDownload,
  enqueueAppUpdate,
  openAppUpdateInstaller,
  readAppUpdateDownload,
  type AppUpdateDownload,
} from "../../../lib/systemAppUpdate";
import { showDownloadedFiles } from "../../../lib/systemFileDownload";
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
      return "已下载，可校验并安装。";
    case "failed":
      return task.error ?? "下载失败，可取消后重新下载。";
    case "missing":
      return "下载任务已不存在，请取消后重新下载。";
    case "paused":
      return "下载已暂停，等待网络恢复。";
    case "pending":
      return "等待开始下载，切到后台后仍会继续。";
    case "downloading":
      return task.totalBytes && task.totalBytes > 0
        ? `${sizeLabel(task.bytesDownloaded ?? 0)} / ${sizeLabel(task.totalBytes)}`
        : "正在后台下载。";
  }
}

export function useAndroidAppUpdate(checkOnOpen = false, channel: ForkUpdateChannel = "stable") {
  const focused = useIsFocused();
  const [checking, setChecking] = useState(false);
  const [checkedChannel, setCheckedChannel] = useState<ForkUpdateChannel | null>(null);
  const checkComplete = checkedChannel === channel;
  const [working, setWorking] = useState(false);
  const [asset, setAsset] = useState<AndroidUpdateAsset | null>(null);
  const [task, setTask] = useState<AppUpdateDownload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const busy = useRef(false);
  const initialCheckStarted = useRef<ForkUpdateChannel | null>(null);
  const activeTask =
    task?.status === "pending" || task?.status === "downloading" || task?.status === "paused";
  const fraction =
    task?.totalBytes && task.totalBytes > 0
      ? Math.max(0, Math.min(1, (task.bytesDownloaded ?? 0) / task.totalBytes))
      : undefined;

  const refreshTask = useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
      const value = await readAppUpdateDownload();
      if (mounted.current && generation === readGeneration.current) setTask(value);
    } catch (error) {
      if (mounted.current && generation === readGeneration.current) setNotice(messageOf(error));
    }
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native download task on mount and when Android resumes the app.
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls persisted native download progress while this screen is visible.
  useEffect(() => {
    if (!activeTask || !focused) return;
    let reading = false;
    const timer = setInterval(async () => {
      if (AppState.currentState !== "active" || busy.current || reading) return;
      reading = true;
      try {
        await refreshTask();
      } finally {
        reading = false;
      }
    }, 750);
    return () => clearInterval(timer);
  }, [activeTask, focused]);

  const check = useCallback(async () => {
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
          channel,
        },
        request.signal,
      );
      if (!mounted.current) return;
      setAsset(result);
      setCheckedChannel(channel);
    } catch (error) {
      if (mounted.current)
        setNotice(request.signal.aborted ? "检查更新超时，请重试。" : messageOf(error));
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [channel]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 首次打开关于页时读取发布信息，下载仍由用户触发。
  useEffect(() => {
    if (
      Platform.OS !== "android" ||
      !checkOnOpen ||
      !focused ||
      initialCheckStarted.current === channel
    )
      return;
    let active = true;
    queueMicrotask(() => {
      if (!active || initialCheckStarted.current === channel) return;
      initialCheckStarted.current = channel;
      void check();
    });
    return () => {
      active = false;
    };
  }, [channel, check, checkOnOpen, focused]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy.current) return false;
    busy.current = true;
    setWorking(true);
    setNotice(null);
    try {
      await action();
      await refreshTask();
      return true;
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const startDownload = (candidate: AndroidUpdateAsset, allowMetered: boolean) =>
    run(() => enqueueAppUpdate(candidate, allowMetered));

  const requestDownload = async () => {
    if (!asset || busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      const metered = await getAndroidUpdateMetered();
      if (!mounted.current) return;
      Dialog.confirm({
        title: metered ? "使用移动网络下载更新？" : "下载 App 更新？",
        message: `${asset.productVersion}-${asset.build} · ${sizeLabel(asset.sizeBytes)}。${metered ? "当前为移动网络或网络类型未知，可能产生流量费用。" : "若切换到移动网络，下载会暂停。"}下载完成后仍需你确认安装。`,
        confirmText: "下载 APK",
        onConfirm: () => {
          void startDownload(asset, metered);
        },
      });
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  return {
    activeTask,
    asset: checkComplete ? asset : null,
    available: !checking && !working && task === null,
    check,
    checkComplete,
    checking,
    fraction,
    notice,
    refreshTask,
    requestDownload,
    run,
    startDownload,
    task,
    working,
  };
}

export async function getAndroidUpdateMetered() {
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected === false || network.isInternetReachable === false) {
    throw new Error("当前无法访问网络，请连接后重试。");
  }
  return requiresMobileDownloadConfirmation(network.type);
}

export const androidUpdateDeviceName = () => deviceName?.trim() || modelName?.trim() || "此手机";
export const androidUpdateVersion = () => nativeApplicationVersion ?? "未知";

export function AndroidAppUpdateSection() {
  const update = useAndroidAppUpdate();
  return <AndroidAppUpdateDevice update={update} />;
}

export function AndroidAppUpdateDevice({
  update,
  selection,
  inUpdateCenter = false,
  disabled = false,
}: {
  readonly update: ReturnType<typeof useAndroidAppUpdate>;
  readonly selection?: ReactNode;
  readonly inUpdateCenter?: boolean;
  readonly disabled?: boolean;
}) {
  if (Platform.OS !== "android") return null;
  const {
    activeTask,
    asset,
    check,
    checkComplete,
    checking,
    fraction,
    notice,
    refreshTask,
    requestDownload,
    run,
    task,
    working,
  } = update;
  const availableVersion = asset ? `${asset.productVersion}-${asset.build}` : task?.version;
  const availableVersionLabel = checking
    ? "正在检查"
    : (availableVersion ?? (checkComplete ? "无适用于此设备的新版" : "未确认"));

  return (
    <SettingsSection
      title={
        inUpdateCenter ? androidUpdateDeviceName() : `Android 客户端 · ${androidUpdateDeviceName()}`
      }
      titleIcon={
        inUpdateCenter ? (
          <SymbolView name="iphone" size={16} tintColorClassName="accent-icon" />
        ) : undefined
      }
      footer={notice ?? "更新包保存到 Download/t3code，下载完成后可确认安装。"}
    >
      {selection}
      <ListActionRow
        icon="arrow.clockwise"
        label={checking ? "正在检查更新…" : "检查客户端更新"}
        description={
          selection
            ? undefined
            : `${inUpdateCenter ? "Android App\n" : ""}运行版本 ${androidUpdateVersion()} · 构建 ${nativeBuildVersion ?? "未知"}\n可更新版本 ${availableVersionLabel}`
        }
        loading={checking}
        disabled={disabled || working}
        onPress={() => {
          void check();
        }}
      />
      {!inUpdateCenter && asset && !task ? (
        <ListActionRow
          icon="arrow.down.circle"
          label={`下载 ${asset.productVersion}-${asset.build}`}
          description={sizeLabel(asset.sizeBytes)}
          loading={working}
          disabled={checking}
          onPress={() => {
            void requestDownload();
          }}
        />
      ) : null}
      {task ? (
        <>
          <ListActionRow
            icon={task.status === "downloaded" ? "checkmark.circle" : "arrow.clockwise"}
            label={task.status === "downloaded" ? "校验并安装" : "刷新下载状态"}
            description={[
              task.version,
              taskDescription(task),
              activeTask && fraction !== undefined ? `${Math.floor(fraction * 100)}%` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            loading={working}
            disabled={disabled || checking}
            onPress={() => {
              void run(task.status === "downloaded" ? openAppUpdateInstaller : refreshTask);
            }}
          />
          {activeTask ? (
            <View className="px-4 pb-3">
              <Progress
                label="App 更新下载进度"
                {...(fraction === undefined ? {} : { value: fraction })}
              />
            </View>
          ) : null}
          <ListActionRow
            icon="arrow.down.circle"
            label="查看下载文件"
            onPress={() => {
              void run(showDownloadedFiles);
            }}
            disabled={disabled || working || checking}
          />
          <ListActionRow
            icon="trash"
            label={task.status === "downloaded" ? "删除此更新下载" : "取消此更新下载"}
            tone="danger"
            disabled={disabled || working || checking}
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
