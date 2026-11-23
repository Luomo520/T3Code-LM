import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  createFileHandoffAtoms,
  formatFileHandoffReceipt,
  unwrapFileHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import { AuthOrchestrationReadScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { ToastAndroid } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { AppText } from "../../components/ui/AppText";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { isAppActive, useAppActive } from "../../lib/appState";
import { supportsAutomaticFileHandoff } from "../../lib/systemFileDownload";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { advanceAutomaticHandoff } from "./automatic-file-handoff";
import { automaticFileHandoffEnabled } from "./automatic-file-handoff-preferences";

const atoms = createFileHandoffAtoms(connectionAtomRuntime);
const quiet = { reportFailure: false, reportDefect: false };
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
  const retryAfter = useRef(new Map<string, number>());
  const processInbox = useEffectEvent(async () => {
    if (running.current || connection._tag !== "Some" || query.data?._tag !== "inbox") return;
    const httpBaseUrl = connection.value.httpBaseUrl;
    const active = () => current.current && isAppActive();
    running.current = true;
    try {
      for (const item of query.data.transfers) {
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
            if (active()) ToastAndroid.show(`已保存 ${item.name}`, ToastAndroid.SHORT);
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
  // 保存 APK 后仍可能收到安装回执，包括用户取消后重新安装的结果。
  const awaitingInstallation =
    item?.disposition === "saved" &&
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
  return (
    <AppText selectable accessibilityLiveRegion="polite" className="text-sm text-foreground">
      {text}
    </AppText>
  );
}
