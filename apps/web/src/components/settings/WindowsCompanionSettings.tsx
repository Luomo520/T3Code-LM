import { AuthAccessWriteScope, type CompanionDevice, type EnvironmentId } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import { useEffect, useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  windowsCompanionList,
  windowsCompanionPair,
  windowsCompanionRename,
  windowsCompanionRevoke,
} from "~/state/windowsCompanion";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function WindowsCompanionSettings() {
  const gt = useGT();
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environment =
    (scope.kind === "environment" || scope.kind === "all") && environments.length === 1
      ? connectedEnvironments[0]
      : undefined;
  const environmentId = environment?.environmentId ?? null;
  const canManage = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const supported = environment?.serverConfig?.environment.capabilities.windowsCompanion === true;
  const enabled = settings.windowsCompanionEnabled;
  const enabledLabel = gt("Allow Windows companions");
  const unavailable = !environment
    ? gt("Choose one connected environment to manage its Windows companions.")
    : !supported
      ? gt("Update this environment to manage Windows companions.")
      : !canManage
        ? gt("You need permission to manage access on this environment.")
        : undefined;

  return (
    <SettingsSection id="windows-companion" title={gt("Windows companion (Beta)")}>
      <SettingsRow
        serverScoped
        serverWriteScope={AuthAccessWriteScope}
        settingKeys={["windowsCompanionEnabled"]}
        title={enabledLabel}
        description={gt("Allow paired Windows companions to connect to this T3 Code environment.")}
        status={unavailable}
        control={
          <ScopedSwitch
            settingKeys={["windowsCompanionEnabled"]}
            checked={enabled}
            disabled={unavailable !== undefined}
            onCheckedChange={(checked) =>
              updateSettings({ windowsCompanionEnabled: Boolean(checked) })
            }
            aria-label={enabledLabel}
          />
        }
      />
      {environment && supported && canManage ? (
        <CompanionDeviceList
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          enabled={enabled}
        />
      ) : null}
    </SettingsSection>
  );
}

function CompanionDeviceList({
  environmentId,
  environmentLabel,
  enabled,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  enabled: boolean;
}) {
  const gt = useGT();
  const devices = useEnvironmentQuery(windowsCompanionList({ environmentId, input: undefined }));
  useLiveRefresh(
    () => {
      if (!devices.isPending) devices.refresh();
    },
    {
      key: `windows-companion:${environmentId}`,
      intervalMs: 15_000,
    },
  );

  return (
    <>
      <SettingsRow
        title={gt("Paired Windows devices")}
        description={enabled ? undefined : gt("Turn on Windows companions to add a device.")}
        control={
          enabled ? (
            <AddWindowsCompanion
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              onClose={devices.refresh}
            />
          ) : undefined
        }
      />
      {devices.error ? (
        <SettingsRow
          title={gt("Could not load Windows devices")}
          control={
            <Button variant="outline" size="sm" onClick={devices.refresh}>
              {gt("Retry")}
            </Button>
          }
        />
      ) : devices.data === null ? (
        <SettingsRow title={gt("Loading Windows devices…")} role="status" />
      ) : devices.data.devices.length === 0 ? (
        <SettingsRow title={gt("No paired Windows devices")} />
      ) : (
        devices.data.devices.map((device) => (
          <CompanionDeviceRow
            key={device.deviceId}
            environmentId={environmentId}
            device={device}
            refresh={devices.refresh}
          />
        ))
      )}
    </>
  );
}

type PairingDialogState =
  | { kind: "loading" | "expired" | "error" }
  | { kind: "ready"; code: string; expiresAt: string };

function AddWindowsCompanion({
  environmentId,
  environmentLabel,
  onClose,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  onClose: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const pair = useAtomCommand(windowsCompanionPair, { reportFailure: false, reportDefect: false });
  const [dialog, setDialog] = useState<PairingDialogState | null>(null);
  const currentRequest = useRef<symbol | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 配对码到期时清除弹层中的明文
  useEffect(() => {
    if (dialog?.kind !== "ready") return;
    const expiry = Math.max(0, Date.parse(dialog.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setDialog({ kind: "expired" }), expiry);
    return () => window.clearTimeout(timer);
  }, [dialog]);

  const handleOpenChange = async (open: boolean) => {
    if (!open) {
      currentRequest.current = null;
      setDialog(null);
      onClose();
      return;
    }
    if (currentRequest.current !== null) return;
    const request = Symbol();
    currentRequest.current = request;
    setDialog({ kind: "loading" });
    const result = await pair({ environmentId, input: undefined });
    if (currentRequest.current !== request) return;
    if (result._tag !== "Success" || !Number.isFinite(Date.parse(result.value.expiresAt))) {
      setDialog({ kind: "error" });
    } else if (Date.parse(result.value.expiresAt) <= Date.now()) {
      setDialog({ kind: "expired" });
    } else {
      setDialog({ ...result.value, kind: "ready" });
    }
  };

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => void handleOpenChange(open)}>
      <DialogTrigger render={<Button variant="outline" size="sm-multiline" />}>
        {gt("Add Windows device")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{gt("Pair a Windows device")}</DialogTitle>
          <DialogDescription>
            {gt("Enter this one-time code in the Windows companion to connect to {environment}.", {
              environment: environmentLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div role="status" className="space-y-2 text-sm">
            {dialog?.kind === "ready" ? (
              <>
                <code className="block break-all rounded-lg bg-muted px-3 py-2 text-lg font-semibold select-all">
                  {dialog.code}
                </code>
                <p className="text-muted-foreground">
                  {gt("Expires at {time}", { time: formatCompanionTime(dialog.expiresAt, locale) })}
                </p>
              </>
            ) : dialog?.kind === "loading" ? (
              <p>{gt("Creating a pairing code…")}</p>
            ) : dialog?.kind === "expired" ? (
              <p>{gt("This code expired. Open Add Windows device again to get a new code.")}</p>
            ) : dialog?.kind === "error" ? (
              <p>{gt("Could not create a pairing code. Close this window and try again.")}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{gt("Done")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function formatCompanionTime(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function CompanionDeviceRow({
  environmentId,
  device,
  refresh,
}: {
  environmentId: EnvironmentId;
  device: CompanionDevice;
  refresh: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const nameId = useId();
  const saveName = useAtomCommand(windowsCompanionRename, { reportFailure: false });
  const revokeDevice = useAtomCommand(windowsCompanionRevoke, { reportFailure: false });
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const mutationPending = useRef(false);
  const taskStatuses = {
    queued: gt("Queued"),
    running: gt("Running"),
    done: gt("Completed"),
    failed: gt("Failed"),
    canceled: gt("Canceled"),
  };

  const rename = async () => {
    const trimmed = name?.trim();
    if (!trimmed || trimmed === device.name || mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    const result = await saveName({
      environmentId,
      input: { deviceId: device.deviceId, name: trimmed },
    });
    mutationPending.current = false;
    setBusy(false);
    if (result._tag !== "Success") {
      setRenameError(true);
      return;
    }
    setName(null);
    refresh();
  };
  const revoke = async () => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    const confirmed = await requestConfirmDialog(
      gt("Unpair {device}? It will need a new code to connect again.", { device: device.name }),
      { variant: "destructive" },
    );
    if (!confirmed) {
      mutationPending.current = false;
      return;
    }
    setBusy(true);
    const result = await revokeDevice({ environmentId, input: device.deviceId });
    mutationPending.current = false;
    setBusy(false);
    if (result._tag === "Success") refresh();
    else toastManager.add({ type: "error", title: gt("Could not unpair Windows device") });
  };

  return (
    <SettingsRow
      title={<span className="break-all">{device.name}</span>}
      description={
        <>
          {device.online ? gt("Online") : gt("Offline")}
          {" · "}
          {gt("Last seen {time}", { time: formatCompanionTime(device.lastSeen, locale) })}
        </>
      }
      control={
        <div className="flex flex-wrap gap-2">
          <Dialog
            open={name !== null}
            onOpenChange={(open) => {
              if (busy) return;
              setName(open ? device.name : null);
              setRenameError(false);
            }}
          >
            <DialogTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
              {gt("Rename")}
            </DialogTrigger>
            <DialogPopup>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void rename();
                }}
              >
                <DialogHeader>
                  <DialogTitle>{gt("Rename Windows device")}</DialogTitle>
                </DialogHeader>
                <DialogPanel>
                  <label htmlFor={nameId} className="mb-2 block text-sm">
                    {gt("Device name")}
                  </label>
                  <Input
                    id={nameId}
                    value={name ?? ""}
                    maxLength={128}
                    disabled={busy}
                    onValueChange={setName}
                  />
                  {renameError ? (
                    <p className="mt-2 text-sm text-destructive-foreground" role="alert">
                      {gt("Could not rename Windows device")}
                    </p>
                  ) : null}
                </DialogPanel>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={busy} />}>
                    {gt("Cancel")}
                  </DialogClose>
                  <Button
                    type="submit"
                    disabled={busy || !name?.trim() || name.trim() === device.name}
                  >
                    {gt("Save")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogPopup>
          </Dialog>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void revoke()}
          >
            {gt("Unpair")}
          </Button>
        </div>
      }
    >
      <CompanionDeviceDetails device={device} />
      <details className="py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">{gt("Recent tasks")}</summary>
        {device.recentTasks.length === 0 ? (
          <p className="pt-2">{gt("No recent tasks")}</p>
        ) : (
          <ul className="space-y-1 pt-2">
            {device.recentTasks.map((task) => (
              <li className="break-all" key={task.id}>
                {task.action} · {taskStatuses[task.status]} ·{" "}
                {formatCompanionTime(task.updatedAt, locale)}
                <div className="select-all font-mono">{task.id}</div>
                {task.savedPath ? <div className="select-text">{task.savedPath}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </details>
    </SettingsRow>
  );
}

function CompanionDeviceDetails({ device }: { readonly device: CompanionDevice }) {
  const gt = useGT();
  const locale = useLocale();
  const details = [
    { key: "hostname", label: gt("Computer name"), value: device.info.hostname },
    { key: "os", label: gt("Windows version"), value: device.info.os },
    { key: "version", label: gt("Companion version"), value: device.info.version },
    { key: "cpu", label: gt("Processor"), value: device.info.cpu },
    { key: "gpu", label: gt("Graphics"), value: device.info.gpu },
    { key: "memory", label: gt("Memory"), value: device.info.memory },
    ...Object.entries(device.info)
      .filter(([key]) => /^network(?:[1-6])?$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, label: gt("Network adapter"), value })),
  ].filter(({ value }) => value);
  return (
    <details className="py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{gt("Device details")}</summary>
      <p className="pt-2" role="status">
        {gt("Details updated {time}", {
          time: formatCompanionTime(device.detailsUpdatedAt ?? device.lastSeen, locale),
        })}
      </p>
      <p className="pt-2">
        {!device.online
          ? gt("Open the Windows companion and resume receiving requests.")
          : device.info.desktopState === "locked"
            ? gt("Unlock Windows to confirm file transfers, screenshots and recordings.")
            : device.info.desktopState === "ready"
              ? gt("File transfers, screenshots and recordings can be confirmed on this PC.")
              : gt("Check the desktop status on this PC before sending a request.")}
      </p>
      {details.filter((field) => field.key.startsWith("network")).length > 1 ? (
        <p className="pt-2">{gt("These network adapters belong to the same paired PC.")}</p>
      ) : null}
      {details.length > 0 ? (
        <dl className="grid gap-x-3 gap-y-1 pt-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
          {details.map(({ key, label, value }) => (
            <div key={key} className="contents">
              <dt>{label}</dt>
              <dd className="break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="pt-2">
          {gt("Run the device check in the Windows companion to send details.")}
        </p>
      )}
    </details>
  );
}
