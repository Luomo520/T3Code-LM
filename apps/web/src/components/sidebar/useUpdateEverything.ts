import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

import { APP_VERSION } from "~/branding";
import type { EnvironmentId } from "@t3tools/contracts";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { isClientHostEnvironment } from "~/state/clientHostEnvironment";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import {
  canUpdateServer,
  type ServerUpdateOutcome,
  type ServerUpdateTarget,
  useServerUpdate,
} from "../ServerUpdateAction";
import {
  type ChannelSwitchRelease,
  closeFinishedUpdateRun,
  collectChannelSwitchTargets,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  beginUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateHandoff,
  waitForUpdateRestart,
} from "./updateEverythingRun";

const UPDATE_RESTART_DELAY_MS = 5_000;

/** Servers this desktop app runs; they update with it. */
export function useIsHostedByThisApp() {
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  return (environment: EnvironmentPresentation) =>
    isElectron &&
    (isClientHostEnvironment(
      environment.environmentId,
      hostEnvironmentId,
      environment.entry.target,
      true,
    ) ||
      isDesktopLocalConnectionTarget(environment.entry.target));
}

export const desktopUpdateId = "desktop";
export const serverUpdateId = (environmentId: EnvironmentId) =>
  JSON.stringify(["server", environmentId]);

export type ReportLocalUpdateError = (title: string, description: string) => void;

/** `channelSwitch` makes the run move the fleet to that release's track instead of updating it. */
export function useUpdateEverything(
  localUpdateVersion: string | null,
  channelSwitch?: ChannelSwitchRelease,
  centerTargets?: ReadonlyArray<ServerUpdateTarget>,
) {
  const isHostedByThisApp = useIsHostedByThisApp();
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp: isHostedByThisApp(environment),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const { targets: servers, skipped } = channelSwitch
    ? collectChannelSwitchTargets(machines, channelSwitch)
    : centerTargets === undefined
      ? collectServerUpdateTargets(machines, targetVersion)
      : { targets: centerTargets, skipped: [] };
  // Track-only hosts save a setting and restart nothing, so they are neither listed nor counted.
  const moving = servers.filter((server) => server.trackOnly !== true);
  const restarts = collectRestartingMachines(machines, moving, localUpdateVersion !== null);
  const providerUpdates = useProviderUpdates();
  // A track switch moves app and servers only; provider updates stay a separate choice.
  const providers = channelSwitch
    ? { machines: [], selectMachines: () => [], updateAll: async () => [] }
    : providerUpdates;
  const updateServer = useServerUpdate();
  const stageServerUpdate = useAtomCommand(serverEnvironment.stageServerUpdate, {
    reportFailure: false,
  });

  const view = describeUpdateEverything({
    localVersion: localUpdateVersion,
    localMachines: machines.filter((machine) => machine.hostedByThisApp),
    servers: moving,
    skipped,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    ...view,
    restarts,
    providerMachines: providers.machines,
    run: async ({
      selection,
      downloadLocal,
      installLocal,
    }: {
      selection?: ReadonlySet<string>;
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
    }) => {
      const selectedServers = selection
        ? servers.filter(({ environmentId }) => selection.has(serverUpdateId(environmentId)))
        : servers;
      const selectedProviders = providers.selectMachines(selection);
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of selectedProviders) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          providers: machine.candidates.map(({ instanceId, driver }) => ({ instanceId, driver })),
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of selectedServers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          ...(existing?.providers ? { providers: existing.providers } : {}),
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      const started = beginUpdateEverythingRun({
        ...(channelSwitch ? { trackSwitch: true } : {}),
        localVersion,
        phase: "providers",
        restartAt: null,
        machines: Array.from(machinesById.values()),
      });
      if (!started) throw new Error("另一项更新正在执行。");
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            const runs = await providers.updateAll({
              quiet: true,
              ...(selection ? { selected: selection } : {}),
            });
            const outcomes = runs.map((run) => {
              const result = getProviderUpdateRunOutcome(run);
              const runOutcome =
                selection && result.status === "interrupted"
                  ? { status: "failed" as const, line: `${run.machineLabel} · 软件更新已中断` }
                  : result;
              if (runOutcome.status !== "updated") {
                providerFailures.set(
                  run.environmentId,
                  runOutcome.status === "failed" ? runOutcome.line : "软件更新已中断",
                );
              }
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (machine.server === null) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  providerFailures.get(machine.environmentId) ?? null,
                );
              }
            }
            const serversStartedAt = Date.now();
            setUpdateEverythingRun(
              (run) =>
                run && {
                  ...run,
                  phase: "servers",
                  machines: run.machines.map((machine) =>
                    machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
                  ),
                },
            );
            return outcomes;
          },
          ...(selectedProviders.length > 0
            ? {
                stageServers: () =>
                  new Map(
                    selectedServers
                      .filter(
                        (server) =>
                          machines.find((machine) => machine.environmentId === server.environmentId)
                            ?.serverConfig?.environment.capabilities.serverUpdateStaging === true,
                      )
                      .map((server) => [
                        server.environmentId,
                        stageServerUpdate({
                          environmentId: server.environmentId,
                          input: { targetVersion: server.targetVersion, stageOnly: true },
                        }),
                      ]),
                  ),
              }
            : {}),
          updateServers: async (staged) => {
            const runs = selectedServers.map(async (server) => {
              await staged.get(server.environmentId);
              const outcome = await updateServer(server, { quiet: true });
              const serverOutcome: ServerUpdateOutcome =
                selection && outcome.status === "skipped"
                  ? { status: "failed", message: "未能完成更新，请重新连接后再试。" }
                  : outcome;
              settleUpdateRunMachine(
                server.environmentId,
                serverOutcome.status === "failed"
                  ? serverOutcome.message
                  : (providerFailures.get(server.environmentId) ?? null),
                {
                  serverUpdated: serverOutcome.status !== "failed",
                  providerFailure: providerFailures.get(server.environmentId) ?? null,
                },
              );
              const finished = { label: server.serverLabel, outcome: serverOutcome };
              finishedServers.push(finished);
              return finished;
            });
            await Promise.all(
              selectedServers.map((server, index) =>
                waitForServerUpdateHandoff(server.environmentId, runs[index]!),
              ),
            );
            return runs;
          },
        });
        const result = (finished: ReadonlyArray<{ label: string; outcome: ServerUpdateOutcome }>) =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            servers: finished,
            providers: outcome.providers,
          });
        let postponed = false;
        if (outcome.localReady && installLocal) {
          if (await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS)) {
            setUpdateEverythingRun(
              (run) => run && { ...run, phase: "installing", restartAt: null },
            );
            saveUpdateEverythingResult({ ...result(finishedServers), localVersion });
            if (await installLocal(reportLocalError)) {
              return "正在重启桌面端…" as const;
            }
            clearSavedUpdateEverythingResult();
            if (localFailures.length === 0) localFailures.push("桌面端更新安装未完成。");
          } else {
            postponed = true;
          }
        }
        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
              restartAt: null,
              localVersion: null,
            }),
        );
        if (installLocal && !outcome.localReady && localFailures.length === 0) {
          localFailures.push("桌面端更新下载未完成。");
        }
        const finished = result(await Promise.all(outcome.servers));
        showUpdateEverythingResult(finished);
        if (postponed) return "桌面端更新已下载，可稍后安装并重启。" as const;
        if (localFailures.length) return "桌面端更新未完成，详细原因见通知。" as const;
        if (finished.failures.length) return null;
        return "已完成所选更新" as const;
      } catch (error) {
        setUpdateEverythingRun(() => null);
        throw error;
      }
    },
  };
}
