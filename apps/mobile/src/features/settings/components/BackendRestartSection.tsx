import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentPresentation } from "../../../state/presentation";

import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";

export function BackendRestartSection({
  targets,
}: {
  readonly targets: readonly SettingsTarget[];
}) {
  if (targets.length === 0) return null;
  return (
    <SettingsSection
      title="后端"
      footer="重启会短暂断开连接，并中断该后端上正在运行的任务。连接会自动恢复。"
    >
      {targets.map((target) => (
        <BackendRestartRow key={target.environmentId} target={target} />
      ))}
    </SettingsSection>
  );
}

function BackendRestartRow({ target }: { readonly target: SettingsTarget }) {
  const allowed = useAtomValue(serverEnvironment.restartServer.permissionAtom(target.environmentId));
  const restart = useAtomCommand(serverEnvironment.restartServer, { reportFailure: false });
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = target.label || target.environmentId;
  const disconnected = useRef(false);
  const { presentation } = useEnvironmentPresentation(target.environmentId);
  const phase = presentation?.connection.phase;
  const supported = presentation?.serverConfig?.environment.capabilities.serverRestart === true;
  useEffect(() => {
    if (!requested) return;
    if (phase !== "connected") disconnected.current = true;
    else if (disconnected.current) setRequested(false);
  }, [requested, phase]);
  useEffect(() => {
    if (!requested) return;
    const timeout = setTimeout(() => {
      setRequested(false);
      setError("尚未确认重启结果，请检查连接状态。");
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [requested]);
  const start = () => {
    Dialog.confirm({
      title: `重启 ${label} 的 T3 后端？`,
      message: "正在运行的任务会中断。后端启动后，App 会自动重新连接。",
      confirmText: "重启后端",
      destructive: true,
      onConfirm: () => {
        setError(null);
        disconnected.current = false;
        setRequested(true);
        void restart({ environmentId: target.environmentId, input: {} }).then((result) => {
          if (result._tag === "Success") return;
          setRequested(false);
          setError("无法请求重启，请检查连接和权限后重试。");
        });
      },
    });
  };
  return (
    <ListActionRow
      icon="arrow.clockwise"
      label={label}
      description={
        error ??
        (requested
          ? "已请求重启，等待后端恢复连接…"
          : !allowed
            ? "当前账号没有重启权限"
            : !supported
              ? "后端尚未接入重启托管，请更新服务端并配置托管入口"
              : phase !== "connected"
                ? "等待后端连接恢复"
                : "重新加载供应商和后端配置")
      }
      disabled={!allowed || !supported || phase !== "connected" || requested}
      loading={requested}
      onPress={start}
    />
  );
}
