import { AuthAccessWriteScope, type CompanionDevice, type EnvironmentId } from "@t3tools/contracts";
import {
  lookupWindowsCompanionMac,
  windowsCompanionAvailability,
  windowsCompanionCapabilityEntries,
  windowsCompanionNetworkAdapters,
} from "@t3tools/client-runtime/device/windows-companion";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useGT, useLocale } from "gt-react";
import { useEffect, useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
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
        <>
          <CompanionMacLookup devices={devices.data.devices} />
          {devices.data.devices.map((device) => (
            <CompanionDeviceRow
              key={device.deviceId}
              environmentId={environmentId}
              device={device}
              enabled={enabled}
              refresh={devices.refresh}
            />
          ))}
        </>
      )}
    </>
  );
}

function CompanionMacLookup({ devices }: { readonly devices: readonly CompanionDevice[] }) {
  const gt = useGT();
  const inputId = useId();
  const [address, setAddress] = useState("");
  const matches = lookupWindowsCompanionMac(devices, address);
  const match = matches?.length === 1 ? matches[0] : undefined;
  const result = !address.trim()
    ? undefined
    : !matches
      ? gt("Enter a valid MAC address.")
      : match
        ? gt("Reported by {device}. Verify the device using its pairing.", { device: match.name })
        : matches.length === 0
          ? gt("No paired device has reported this MAC address.")
          : gt(
              "Multiple paired devices have reported this MAC address. Verify the device using its pairing.",
            );

  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{gt("Find a paired device by MAC address")}</label>}
    >
      <Input
        id={inputId}
        aria-describedby={result ? `${inputId}-result` : undefined}
        autoCapitalize="none"
        autoComplete="off"
        className="mt-2 max-w-64"
        maxLength={32}
        placeholder="02:11:22:33:44:55"
        spellCheck={false}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <p className="mt-1 text-xs text-muted-foreground" id={`${inputId}-result`} role="status">
        {result}
      </p>
      {matches && matches.length > 1 ? (
        <ul className="text-xs text-muted-foreground">
          {matches.map((device) => (
            <li key={device.deviceId}>
              {device.name} · {device.info.hostname || device.deviceId}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
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
  enabled,
  refresh,
}: {
  environmentId: EnvironmentId;
  device: CompanionDevice;
  enabled: boolean;
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
  const taskActions: Readonly<Record<string, string>> = {
    screenshot: gt("Screenshot"),
    "record-screen": gt("Screen recording"),
    "open-t3": gt("Open T3 Code"),
    "open-notepad": gt("Open Notepad"),
    "close-window": gt("Close window"),
    "send-file": gt("Send files"),
    "receive-file": gt("Receive files"),
    "write-notepad": gt("Write to Notepad"),
    "inspect-window-controls": gt("Inspect window controls"),
    "run-approved-script": gt("Run a local diagnostic or approved script"),
    "open-ssh-profile": gt("Open a local SSH profile"),
    "read-notepad": gt("Read Notepad"),
  };
  const availability = windowsCompanionAvailability(device, enabled);
  const connectionLabel = {
    disabled: gt("Disabled"),
    locked: gt("Windows locked"),
    paused: gt("Paused"),
    offline: gt("Offline"),
    unknown: gt("Online"),
    confirmOnDevice: gt("Online"),
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
          {connectionLabel[availability]}
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
      <CompanionDeviceDetails device={device} enabled={enabled} />
      <details className="py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">{gt("Recent tasks")}</summary>
        {device.recentTasks.length === 0 ? (
          <p className="pt-2">{gt("No recent tasks")}</p>
        ) : (
          <ul className="space-y-1 pt-2">
            {device.recentTasks.map((task) => (
              <li className="break-all" key={task.id}>
                {taskActions[task.action] ?? task.action} · {taskStatuses[task.status]} ·{" "}
                {formatCompanionTime(task.updatedAt, locale)}
                <div className="select-all font-mono">{task.id}</div>
                {task.savedPath ? <div className="select-text">{task.savedPath}</div> : null}
                {task.threadId ? (
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId))}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {gt("Open original conversation")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Button className="mt-2" variant="outline" size="sm" onClick={refresh}>
          {gt("Refresh recent tasks")}
        </Button>
      </details>
    </SettingsRow>
  );
}

function CompanionDeviceDetails({
  device,
  enabled,
}: {
  readonly device: CompanionDevice;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const details = [
    { key: "hostname", label: gt("Computer name"), value: device.info.hostname },
    { key: "os", label: gt("Windows version"), value: device.info.os },
    { key: "version", label: gt("Companion version"), value: device.info.version },
    { key: "cpu", label: gt("Processor"), value: device.info.cpu },
    { key: "gpu", label: gt("Graphics"), value: device.info.gpu },
    { key: "memory", label: gt("Memory"), value: device.info.memory },
    ...windowsCompanionNetworkAdapters(device.info).map(([key, value]) => ({
      key,
      label: gt("Network adapter"),
      value,
    })),
  ].filter(({ value }) => value);
  const capabilities = windowsCompanionCapabilityEntries(device, enabled);
  const capabilityLabels = {
    sendFile: gt("Send files"),
    receiveFile: gt("Receive files"),
    screenshot: gt("Screenshot"),
    screenRecording: gt("Start screen recording"),
    desktopInput: gt("Open T3 Code or use Notepad"),
    inspectControls: gt("Inspect window controls"),
    localScript: gt("Run a local diagnostic or approved script"),
    sshProfile: gt("Open a local SSH profile"),
    stopRecording: gt("Stop screen recording"),
    installApp: gt("Install apps"),
  };
  const capabilityReasons = {
    disabled: gt("Turn on Windows companions in this environment."),
    offline: gt("Open the companion on this PC and resume receiving requests."),
    paused: gt("Resume receiving requests on this PC."),
    inputPaused: gt("Resume remote input from the tray menu on this PC."),
    locked: gt("Unlock Windows and resume receiving requests on this PC."),
    unknown: gt("Run the device check on this PC."),
    confirmOnDevice: gt("Available with confirmation on this PC."),
    stopLocally: gt("Stop the recording in the companion on this PC."),
    stopFromConversation: gt("Available from the original conversation or on this PC."),
    noRecording: gt("Available while a recording is running."),
    unsupported: gt("This Windows companion cannot install apps."),
  };
  return (
    <details className="py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{gt("Device details")}</summary>
      <p className="pt-2" role="status">
        {gt("Details updated {time}", {
          time: formatCompanionTime(device.detailsUpdatedAt ?? device.lastSeen, locale),
        })}
      </p>
      <dl className="grid gap-x-3 gap-y-1 pt-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
        {capabilities.map(([key, state]) => (
          <div key={key} className="contents">
            <dt className="text-foreground">{capabilityLabels[key]}</dt>
            <dd>{capabilityReasons[state]}</dd>
          </div>
        ))}
      </dl>
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
