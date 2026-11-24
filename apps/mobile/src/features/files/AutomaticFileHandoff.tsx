import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  createFileHandoffAtoms,
  formatFileHandoffReceipt,
  unwrapFileHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import { AuthOrchestrationReadScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert, ToastAndroid } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { isAppActive, useAppActive } from "../../lib/appState";
import { supportsAutomaticFileHandoff } from "../../lib/systemFileDownload";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { isAgentNotificationThreadOnScreen } from "../agent-awareness/notificationNavigation";
import { advanceAutomaticHandoff } from "./automatic-file-handoff";
import { automaticFileHandoffEnabled } from "./automatic-file-handoff-preferences";
import { ReceivedApkInstallAction } from "./ReceivedApkInstallAction";

const atoms = createFileHandoffAtoms(connectionAtomRuntime);
const quiet = { reportFailure: false, reportDefect: false };
// Android 同时只显示一条下载确认。多个环境的请求由各自的收件箱继续检查。
let activeDownloadDialog: object | null = null;
function EnvironmentAutomaticFileHandoff({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const connection = usePreparedConnection(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const ready = canRead && connection._tag === "Some";
  const preferences = useAtomValue(mobilePreferencesAtom);
  const autoReceive = AsyncResult.isSuccess(preferences)
    ? automaticFileHandoffEnabled(preferences.value, environmentId)
    : false;
  const query = useEnvironmentQuery(
    ready ? atoms.list({ environmentId, input: { _tag: "inbox" } }) : null,
  );
  const receive = useAtomCommand(atoms.receive, quiet);
  const current = useRef(false);
  const running = useRef(false);
  const acknowledged = useRef(new Set<string>());
  const offeredDownload = useRef<object | null>(null);
  const retryAfter = useRef(new Map<string, number>());
  const processInbox = useEffectEvent(async () => {
    if (running.current || connection._tag !== "Some" || query.data?._tag !== "inbox") return;
    const httpBaseUrl = connection.value.httpBaseUrl;
    const active = () => current.current && isAppActive();
    running.current = true;
    try {
      const regularTransfers = query.data.transfers.map((item) => ({
        item,
        explicitlyApproved: false,
      }));
      const urlDownloads = query.data.urlDownloads ?? [];
      if (!activeDownloadDialog && active()) {
        const pending = urlDownloads.find(
          (item) => !item.ready && !acknowledged.current.has(item.id),
        );
        if (pending) {
          const { id, threadId } = pending;
          // 按钮只提交当前显示的请求。弹框关闭后的旧回调不能继续操作。
          const release = (dialog: object) => {
            if (activeDownloadDialog === dialog) activeDownloadDialog = null;
            if (offeredDownload.current === dialog) offeredDownload.current = null;
          };
          const present = (
            title: string,
            description: string,
            action: "approveUrl" | "cancel",
            confirmText: string,
          ) => {
            const dialog = {};
            activeDownloadDialog = dialog;
            offeredDownload.current = dialog;
            let responding = false;
            const respond = async (decision: "approveUrl" | "cancel") => {
              if (responding || activeDownloadDialog !== dialog) return;
              if (decision === "approveUrl" && !active()) {
                release(dialog);
                return;
              }
              responding = true;
              try {
                if (decision === "approveUrl")
                  ToastAndroid.show("正在获取来源文件…", ToastAndroid.SHORT);
                const reply = unwrapFileHandoff(
                  await receive({ environmentId, input: { _tag: decision, id, threadId } }),
                );
                if (
                  decision === "approveUrl" ? reply._tag !== "receive" : reply._tag !== "finished"
                )
                  throw new Error("无法处理下载请求。");
                if (decision === "cancel") acknowledged.current.add(id);
                release(dialog);
                query.refresh();
              } catch (error) {
                if (!active() || activeDownloadDialog !== dialog) {
                  release(dialog);
                  return;
                }
                present(
                  "无法处理下载请求",
                  error instanceof Error ? error.message : "请检查来源网址后重试。",
                  decision,
                  "重试",
                );
              }
            };
            Alert.alert(
              title,
              description,
              action === "cancel"
                ? [{ text: confirmText, onPress: () => void respond("cancel") }]
                : [
                    { text: "取消请求", style: "cancel", onPress: () => void respond("cancel") },
                    { text: confirmText, onPress: () => void respond("approveUrl") },
                  ],
              {
                onDismiss: () => {
                  if (!responding) release(dialog);
                },
              },
            );
          };
          present(
            "下载到这台设备",
            `${pending.senderLabel} 请求下载 ${pending.name}。\n\n${pending.sourceUrl}${
              pending.failure ? `\n\n${pending.failure}` : ""
            }`,
            "approveUrl",
            "确认下载",
          );
        }
      }
      const approvedTransfers = urlDownloads.flatMap((item) =>
        item.ready
          ? [
              {
                item: { ...item, ...item.ready, autoReceive: true as const },
                explicitlyApproved: true,
              },
            ]
          : [],
      );
      for (const { item, explicitlyApproved } of [...approvedTransfers, ...regularTransfers]) {
        if (!active()) return;
        if (
          acknowledged.current.has(item.id) ||
          (retryAfter.current.get(item.id) ?? 0) > Date.now()
        )
          continue;
        try {
          const outcome = await advanceAutomaticHandoff(item, {
            environmentId,
            httpBaseUrl,
            active,
            canStartDownload: () => {
              // 领取链接返回时，可能已经在设置里关掉自动接收。
              if (explicitlyApproved) return true;
              const latest = appAtomRegistry.get(mobilePreferencesAtom);
              return (
                AsyncResult.isSuccess(latest) &&
                automaticFileHandoffEnabled(latest.value, environmentId)
              );
            },
            request: async (input) => unwrapFileHandoff(await receive({ environmentId, input })),
          });
          if (outcome === "saved") {
            acknowledged.current.add(item.id);
            if (active() && !isAgentNotificationThreadOnScreen(environmentId, item.threadId)) {
              ToastAndroid.show(`已保存 ${item.name}`, ToastAndroid.SHORT);
            }
          }
        } catch {
          // 保留服务器收件和本地部分文件，短暂故障恢复后继续领取。
          retryAfter.current.set(item.id, Date.now() + 15_000);
        }
      }
    } finally {
      running.current = false;
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 异步领取期间检查环境连接和组件是否仍可接收。
  useEffect(() => {
    current.current = ready;
    return () => {
      current.current = false;
      if (activeDownloadDialog === offeredDownload.current) activeDownloadDialog = null;
      offeredDownload.current = null;
    };
  }, [ready]);
  const refresh = query.refresh;
  const refreshInterval = query.error ? 45_000 : 5_000;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 仅在应用前台、设备有认证连接时更新收件记录。
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(refresh, refreshInterval);
    return () => clearInterval(timer);
  }, [ready, refresh, refreshInterval]);
  const success = query.successResult;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 服务器列表确认后，恢复或领取发给此设备的文件。
  useEffect(() => {
    if (!ready || success === null) return;
    void processInbox();
  }, [ready, success]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 重新开启时立即检查待收任务并允许重试。
  useEffect(() => {
    if (!autoReceive) return;
    retryAfter.current.clear();
    void processInbox();
  }, [autoReceive]);
  return null;
}

export function AutomaticFileHandoff() {
  const active = useAppActive();
  const environments = useWorkspaceEnvironments();
  if (!active || !supportsAutomaticFileHandoff()) return null;
  return environments.map(({ isEnabled, environmentId, connectionState }) =>
    isEnabled && connectionState === "connected" ? (
      <EnvironmentAutomaticFileHandoff key={environmentId} environmentId={environmentId} />
    ) : null,
  );
}

export function ThreadFileHandoffReceipt({
  environmentId,
  threadId,
  transferId,
  initialText,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly transferId: string;
  readonly initialText: string;
}) {
  const active = useAppActive();
  const focused = useIsFocused();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const ready = active && focused && canRead;
  const query = useEnvironmentQuery(
    ready ? atoms.list({ environmentId, input: { _tag: "list", threadId } }) : null,
  );
  const item =
    query.data?._tag === "list"
      ? query.data.transfers.find(({ id }) => id === transferId)
      : undefined;
  const refresh = query.refresh;
  const receive = useAtomCommand(atoms.receive, quiet);
  // 用户取消后也可从已保存的 APK 继续安装，回执更新原会话。
  const awaitingInstallation =
    item?.disposition === "saved" &&
    !item.urlDownload &&
    item.name.toLowerCase().endsWith(".apk") &&
    item.installation?.status !== "verified";
  const refreshInterval = awaitingInstallation ? 15_000 : 5_000;
  const settled = item?.disposition !== undefined && !awaitingInstallation;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 可见的原会话消息显示接收设备的持久回执。
  useEffect(() => {
    if (!ready || settled) return;
    const timer = setInterval(refresh, refreshInterval);
    return () => clearInterval(timer);
  }, [ready, refresh, refreshInterval, settled]);
  const text = (item && formatFileHandoffReceipt(item)) ?? initialText;
  const apk =
    item &&
    !item.outgoing &&
    !item.urlDownload &&
    item.installRequested &&
    item.disposition === "saved" &&
    item.sha256 &&
    item.savedPath
      ? { ...item, sha256: item.sha256, savedPath: item.savedPath }
      : null;
  return (
    <>
      <AppText selectable accessibilityLiveRegion="polite" className="text-sm text-foreground">
        {text}
      </AppText>
      {apk && apk.installation?.status !== "verified" ? (
        <ReceivedApkInstallAction
          name={apk.name}
          sizeBytes={apk.sizeBytes}
          sha256={apk.sha256}
          uri={apk.savedPath}
          receiptKey={JSON.stringify([environmentId, threadId, apk.id, apk.sha256])}
          installation={apk.installation}
          systemOnly
          onReport={async (installation) => {
            unwrapFileHandoff(
              await receive({
                environmentId,
                input: {
                  _tag: "reportInstall",
                  threadId,
                  id: apk.id,
                  sha256: apk.sha256,
                  installation,
                },
              }),
            );
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
