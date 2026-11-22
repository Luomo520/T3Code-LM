import { useAtomValue } from "@effect/atom-react";
import { formatProviderMaintenanceMessage } from "@t3tools/client-runtime/providerUpdates";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { environmentIdsKey } from "~/state/environmentAtomList";
import { useEnvironmentProviders } from "~/state/environments";
import { environmentUpdateStatesAtom } from "~/state/server";
import {
  ServerUpdateProgress,
  UpdateDownloadProgress,
  useServerUpdate,
} from "../ServerUpdateAction";
import { Button } from "../ui/button";
import {
  dismissSettledUpdateRunMachines,
  postponeUpdateRestart,
  retryFailedUpdateRunServers,
} from "./updateEverythingRun";
import {
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunMachineStatus,
} from "./updateEverything.logic";

import { updateCenterProviderName } from "./useUpdateCenter";

const statusLabels: Record<UpdateRunMachineStatus, string> = {
  providers: "正在更新 CLI…",
  waiting: "等待开始",
  downloading: "正在下载更新…",
  restarting: "正在重启并重新连接…",
  done: "更新完成",
  failed: "更新失败",
};

function subscribeToSeconds(notify: () => void) {
  const timer = setInterval(notify, 250);
  return () => clearInterval(timer);
}

function DesktopRestartCountdown({ restartAt }: { readonly restartAt: number }) {
  const seconds = useSyncExternalStore(subscribeToSeconds, () =>
    Math.max(0, Math.ceil((restartAt - Date.now()) / 1_000)),
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span role="status">{seconds} 秒后重启桌面端。</span>
      <Button size="sm" variant="outline" onClick={postponeUpdateRestart}>
        稍后重启
      </Button>
    </div>
  );
}

export function UpdateCenterProgress({
  desktopState,
  run,
}: {
  readonly desktopState: DesktopUpdateState | null;
  readonly run: UpdateEverythingRun;
}) {
  const updateServer = useServerUpdate();
  const providersByEnvironment = useEnvironmentProviders();
  const states = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(run.machines.map(({ environmentId }) => environmentId)),
    ),
  );
  const settled =
    run.machines.every((machine) => machine.result !== null) && run.localVersion === null;
  const hasFailure = run.machines.some((machine) => machine.result === "failed");
  const canRetry =
    !run.trackSwitch &&
    run.machines.some((machine) => machine.result === "failed" && machine.server !== null);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {run.localVersion !== null ? (
        <section>
          <h3 className="font-medium">
            T3 桌面端 <span className="font-mono text-xs">{run.localVersion}</span>
          </h3>
          {run.phase === "countdown" && run.restartAt !== null ? (
            <DesktopRestartCountdown restartAt={run.restartAt} />
          ) : run.phase === "installing" ? (
            <p role="status">正在重启…</p>
          ) : desktopState?.status === "downloading" ? (
            <UpdateDownloadProgress
              label="T3 桌面端下载进度"
              detail="正在下载更新…"
              percent={desktopState.downloadPercent ?? undefined}
            />
          ) : (
            <p role="status" className="text-muted-foreground">
              其他设备完成更新后将重启。
            </p>
          )}
        </section>
      ) : null}
      {run.machines.map((machine, index) => {
        const state = states[index]!;
        const status = resolveUpdateRunMachineStatus(machine, run.phase, state);
        return (
          <section key={machine.environmentId} className="min-w-0">
            <h3 className="wrap-anywhere font-medium">{machine.label}</h3>
            <div className="text-muted-foreground">
              {machine.server !== null && state.status === "running" && machine.result === null ? (
                <ServerUpdateProgress state={state} />
              ) : (
                <p role="status">{statusLabels[status]}</p>
              )}
            </div>
            {machine.providers?.map(({ instanceId, driver }) => {
              const current = providersByEnvironment
                .get(machine.environmentId)
                ?.find((provider) => provider.instanceId === instanceId);
              const state = current?.updateState;
              const label = state?.message ? formatProviderMaintenanceMessage(state.message) : null;
              return (
                <p key={instanceId} className="wrap-anywhere text-xs text-muted-foreground">
                  {updateCenterProviderName(driver)}
                  {current?.version ? ` · ${current.version}` : ""}
                  {label ? ` · ${label}` : ""}
                </p>
              );
            })}
            {machine.failure ? (
              <p role="alert" className="wrap-anywhere text-xs text-destructive">
                {machine.failure}
              </p>
            ) : null}
          </section>
        );
      })}
      {settled && hasFailure ? (
        <div className="flex flex-wrap justify-end gap-2">
          {canRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => retryFailedUpdateRunServers(updateServer)}
            >
              重试服务端更新
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
            关闭失败提示
          </Button>
        </div>
      ) : null}
    </div>
  );
}
