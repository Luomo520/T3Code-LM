import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentPresentation } from "../../state/presentation";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const restartPermissionsAtom = environmentAtomList(
  "web-server-restart-permissions",
  serverEnvironment.restartServer.permissionAtom,
);

export function BackendRestartSection({
  environments,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const environmentIds = environments.map((environment) => environment.environmentId);
  const permissions = useAtomValue(restartPermissionsAtom(environmentIdsKey(environmentIds)));
  if (environments.length === 0) return null;
  return (
    <SettingsSection id="backend-restart" title="后端">
      <SettingsRow
        title="重启 T3 后端"
        description="重新加载选定后端的配置。正在运行的任务会中断，客户端将自动重连。"
      />
      {environments.map((environment, index) => (
        <BackendRestartRow
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          allowed={permissions[index] === true}
        />
      ))}
    </SettingsSection>
  );
}

function BackendRestartRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly allowed: boolean;
}) {
  const restart = useAtomCommand(serverEnvironment.restartServer);
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);
  const disconnected = useRef(false);
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const phase = presentation?.connection.phase;
  const supported = presentation?.serverConfig?.environment.capabilities.serverRestart === true;
  useEffect(() => {
    if (!requested) return;
    if (phase !== "connected") disconnected.current = true;
    else if (disconnected.current) {
      setRequested(false);
      toastManager.add({ type: "success", title: `已重新连接 ${props.label}` });
    }
  }, [requested, phase, props.label]);
  useEffect(() => {
    if (!requested) return;
    const timeout = setTimeout(() => {
      setRequested(false);
      toastManager.add({ type: "info", title: "尚未确认后端重启结果", description: "请检查连接状态，连接恢复后可重试。" });
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [requested]);
  const start = async () => {
    setConfirming(false);
    disconnected.current = false;
    setRequested(true);
    const result = await restart({ environmentId: props.environmentId, input: {} });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `已请求重启 ${props.label}`,
        description: "The connection will return automatically when the backend is ready.",
      });
      return;
    }
    setRequested(false);
    toastManager.add({
      type: "error",
      title: `Could not restart T3 backend on ${props.label}`,
      description: String(squashAtomCommandFailure(result)),
    });
  };
  return (
    <SettingsRow
      title={props.label}
      description={
        !props.allowed
          ? "当前账号没有重启权限。"
          : !supported
            ? "此后端尚未接入重启托管，请更新服务端并配置托管入口。"
            : phase !== "connected"
              ? "等待后端连接恢复。"
              : "重新加载后端和供应商配置。"
      }
      control={
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={!props.allowed || !supported || phase !== "connected" || requested}
            onClick={() => setConfirming(true)}
          >
            {requested ? "等待重连…" : "重启"}
          </Button>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Restart T3 backend on {props.label}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Running tasks on this backend will be interrupted. The backend will restart and
                  connected apps will reconnect automatically.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button onClick={() => void start()}>Restart backend</Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      }
    />
  );
}
