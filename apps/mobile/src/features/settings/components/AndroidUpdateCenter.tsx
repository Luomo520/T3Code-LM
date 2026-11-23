import { useAtomValue } from "@effect/atom-react";
import { formatProviderMaintenanceMessage } from "@t3tools/client-runtime/providerUpdates";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverUpdateDownloadPercent } from "@t3tools/client-runtime/state/server";
import { useRef, useState } from "react";
import type { ForkUpdateChannel } from "@t3tools/shared/forkRelease";
import { Linking, Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Progress } from "../../../components/ui/Progress";
import { appAtomRegistry } from "../../../state/atom-registry";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { ENVIRONMENT_RELEASES_PAGE_URL } from "../environment-maintenance";
import {
  matchesConfirmedUpdate,
  providerUpdateResult,
  remoteUpdateChoices,
  remoteUpdateDevicesAtom,
  serverUpdateImpact,
  type AppUpdateChoice,
  type RemoteUpdateDevice,
  type UpdateChoice,
} from "../updateCenter";
import {
  AndroidAppUpdateDevice,
  androidUpdateDeviceName,
  androidUpdateVersion,
  getAndroidUpdateMetered,
  useAndroidAppUpdate,
} from "./AndroidAppUpdateSection";
import { SettingsSection } from "./SettingsSection";

export function AndroidUpdateCenter() {
  const [channel, setChannel] = useState<ForkUpdateChannel>("stable");
  const devicesAtom = remoteUpdateDevicesAtom(channel);
  const devices = useAtomValue(devicesAtom);
  const app = useAndroidAppUpdate(true, channel);
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [review, setReview] = useState<{
    readonly choices: readonly UpdateChoice[];
    readonly allowMetered: boolean;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);

  const appChoice: AppUpdateChoice | null =
    app.asset && app.available
      ? {
          key: "android-app",
          kind: "app",
          label: "Android App",
          device: androidUpdateDeviceName(),
          fromVersion: androidUpdateVersion(),
          targetVersion: `${app.asset.productVersion}-${app.asset.build}`,
          asset: app.asset,
        }
      : null;
  // 同一设备先更新 CLI，CLI 完成后才重启服务端。APK 下载放在最后。
  const choices: readonly UpdateChoice[] = [
    ...devices.flatMap(remoteUpdateChoices),
    ...(appChoice ? [appChoice] : []),
  ];
  const selected = choices.filter((item) => picked.get(item.key) === item.targetVersion);

  function toggle(item: UpdateChoice) {
    setPicked((previous) => {
      const next = new Map(previous);
      if (next.get(item.key) === item.targetVersion) next.delete(item.key);
      else next.set(item.key, item.targetVersion);
      return next;
    });
  }

  async function prepare() {
    if (lock.current || selected.length === 0) return;
    lock.current = true;
    setWorking(true);
    setNotice(null);
    try {
      const allowMetered = selected.some(({ kind }) => kind === "app")
        ? await getAndroidUpdateMetered()
        : false;
      setReview({ choices: selected, allowMetered });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法确认下载网络，请重试。");
    } finally {
      setWorking(false);
      lock.current = false;
    }
  }

  function freshChoice(item: UpdateChoice) {
    if (item.kind === "app") return appChoice;
    const device = appAtomRegistry
      .get(devicesAtom)
      .find(({ environmentId }) => environmentId === item.environmentId);
    return device ? remoteUpdateChoices(device).find(({ key }) => key === item.key) : undefined;
  }

  async function confirm() {
    if (lock.current || !review) return;
    lock.current = true;
    setWorking(true);
    setReview(null);
    setPicked(new Map());
    setNotice(null);
    const results: string[] = [];

    try {
      for (const [index, item] of review.choices.entries()) {
        const label = `${item.device} · ${item.label}`;
        try {
          // 复核权限、目标版本和重启影响，避免复用已变化的确认信息。
          const current = freshChoice(item);
          if (!current || !matchesConfirmedUpdate(item, current)) {
            results.push(`${label}：更新条件已有变化，请重新检查并确认。`);
            continue;
          }
          if (item.kind === "app") {
            const started = await app.startDownload(item.asset, review.allowMetered);
            results.push(
              `${label}：${started ? "已开始下载，完成后可校验并安装。" : "无法开始下载，请检查设备上的提示。"}`,
            );
          } else if (item.kind === "server") {
            const output = await updateServer({
              environmentId: item.environmentId,
              ...(item.desktopManaged && item.confirmedDesktopUpdateVersion
                ? { requireConfirmedDesktopVersion: true }
                : {}),
              input: { targetVersion: item.targetVersion },
            });
            if (output._tag === "Failure") throw squashAtomCommandFailure(output);
            results.push(`${label}：已确认运行版本 ${output.value.targetVersion}。`);
          } else {
            const output = await updateProvider({
              environmentId: item.environmentId,
              input: { provider: item.driver, instanceId: item.instanceId },
            });
            if (output._tag === "Failure") throw squashAtomCommandFailure(output);
            const provider = output.value.providers.find(
              ({ instanceId }) => instanceId === item.instanceId,
            );
            const installed = provider?.installedVersion ?? provider?.version;
            const status =
              providerUpdateResult(provider?.updateState) ?? "收到更新结果，尚未确认状态。";
            results.push(`${label}：${status}${installed ? `当前版本 ${installed}。` : ""}`);
            if (
              review.choices
                .slice(index + 1)
                .some((next) => next.kind !== "app" && next.environmentId === item.environmentId)
            ) {
              await waitForProviderStatus(devicesAtom, item.environmentId);
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : null;
          results.push(
            `${label}：无法完成更新。${detail ? formatProviderMaintenanceMessage(detail) : "请检查连接与权限后重试。"}`,
          );
        }
      }
    } finally {
      setNotice(results.join("\n"));
      setWorking(false);
      lock.current = false;
    }
  }

  if (review) {
    const groups = new Map<string, { label: string; items: UpdateChoice[] }>();
    for (const item of review.choices) {
      const key = item.kind === "app" ? "android-app" : item.environmentId;
      const group = groups.get(key);
      if (group) group.items.push(item);
      else groups.set(key, { label: item.device, items: [item] });
    }
    return (
      <View className="gap-4">
        <Text accessibilityRole="header" className="px-4 text-xl font-t3-semibold text-foreground">
          确认更新
        </Text>
        {[...groups].map(([key, { label, items }]) => (
          <SettingsSection key={key} title={label}>
            {items.map((item) => (
              <ListRowLayout
                key={item.key}
                label={item.label}
                description={[
                  `${item.fromVersion} → ${item.targetVersion}`,
                  item.kind === "server"
                    ? serverUpdateImpact(item)
                    : item.kind === "cli"
                      ? "服务端保持运行。CLI 会等待相关任务结束后再更新，预计中断 0 个会话。服务端会重新核对最新兼容版本。"
                      : `下载 ${(item.asset.sizeBytes / 1024 / 1024).toFixed(1)} MB。${review.allowMetered ? "当前为移动网络或网络类型未知，可能产生流量费用。" : "若切换到移动网络，下载会暂停。"}下载后需在系统中确认安装。安装时 App 会关闭，服务端会话继续运行。`,
                ].join("\n")}
              />
            ))}
          </SettingsSection>
        ))}
        <View className="gap-2 px-4">
          <Button label="确认更新" tone="primary" fullWidth onPress={() => void confirm()} />
          <Button label="返回选择" tone="text" fullWidth onPress={() => setReview(null)} />
        </View>
      </View>
    );
  }

  const deviceCount =
    devices.filter((device) => remoteUpdateChoices(device).length > 0).length +
    Number(appChoice !== null);
  return (
    <View className="gap-4">
      <View className="gap-1 px-4">
        <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
          更新中心
        </Text>
        <Text className="text-sm text-foreground-muted">
          {choices.length ? `${choices.length} 项可更新 · ${deviceCount} 台设备` : "暂无可选更新"}
        </Text>
      </View>
      <SettingsSection title="更新通道">
        {(["stable", "beta"] as const).map((value) => {
          const selected = value === channel;
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: working || app.checking }}
              disabled={working || app.checking}
              onPress={() => {
                setChannel(value);
                setPicked(new Map());
                setNotice(null);
              }}
            >
              <ListRowLayout
                label={value === "stable" ? "正式版" : "测试版（Beta）"}
                leading={
                  <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <SymbolView name={selected ? "checkmark.circle" : "circle"} size={22} />
                  </View>
                }
              />
            </Pressable>
          );
        })}
      </SettingsSection>
      <AndroidAppUpdateDevice
        update={app}
        inUpdateCenter
        disabled={working}
        selection={
          appChoice ? (
            <UpdateSelectionRow
              item={appChoice}
              checked={selected.includes(appChoice)}
              disabled={working}
              onPress={() => toggle(appChoice)}
            />
          ) : undefined
        }
      />
      {devices.map((device) => (
        <RemoteUpdateDeviceCard
          key={device.environmentId}
          device={device}
          selected={selected}
          disabled={working}
          onToggle={toggle}
          onNotice={setNotice}
        />
      ))}
      <View className="gap-2 px-4">
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {working ? "正在处理所选更新…" : `已选 ${selected.length} 项`}
        </Text>
        {notice ? (
          <Text selectable accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {notice}
          </Text>
        ) : null}
        <Button
          label="更新所选项"
          tone="primary"
          fullWidth
          disabled={selected.length === 0}
          loading={working}
          onPress={() => void prepare()}
        />
        {selected.length > 0 ? (
          <Button
            label="取消选择"
            tone="text"
            fullWidth
            disabled={working}
            onPress={() => setPicked(new Map())}
          />
        ) : null}
      </View>
    </View>
  );
}

async function waitForProviderStatus(
  devicesAtom: ReturnType<typeof remoteUpdateDevicesAtom>,
  environmentId: RemoteUpdateDevice["environmentId"],
) {
  const pending = (devices: readonly RemoteUpdateDevice[]) =>
    devices.some((device) => device.environmentId === environmentId && device.providerBusy);
  if (!pending(appAtomRegistry.get(devicesAtom))) return;
  // CLI RPC 已完成，订阅中的设备状态可能晚一步到达。等待短时间再复核下一项。
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const timeout = setTimeout(finish, 3000);
    const unsubscribe = appAtomRegistry.subscribe(devicesAtom, (devices) => {
      if (!pending(devices)) finish();
    });
  });
}

function UpdateSelectionRow({
  item,
  checked,
  disabled,
  onPress,
}: {
  readonly item: UpdateChoice;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const ripple = useResolveClassNames("bg-subtle-strong");
  const versions = `运行版本 ${item.fromVersion}\n目标版本 ${item.targetVersion}`;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={`${item.device} · ${item.label}`}
      accessibilityHint={versions}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      android_ripple={{ color: ripple.backgroundColor }}
      onPress={onPress}
    >
      <ListRowLayout
        label={item.label}
        description={versions}
        disabled={disabled}
        leading={
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <SymbolView
              name={checked ? "checkmark.circle" : "circle"}
              size={22}
              tintColorClassName={checked ? "accent-primary-text" : "accent-icon"}
            />
          </View>
        }
      />
    </Pressable>
  );
}

function RemoteUpdateDeviceCard({
  device,
  selected,
  disabled,
  onToggle,
  onNotice,
}: {
  readonly device: RemoteUpdateDevice;
  readonly selected: readonly UpdateChoice[];
  readonly disabled: boolean;
  readonly onToggle: (item: UpdateChoice) => void;
  readonly onNotice: (message: string) => void;
}) {
  const { state, server } = device;
  const progress = state.status === "running" ? serverUpdateDownloadPercent(state) : undefined;
  const serverVersions = device.runningVersion
    ? `运行版本 ${device.runningVersion}`
    : `运行版本未确认${device.lastVersion ? `（上次连接 ${device.lastVersion}）` : ""}`;
  const serverTarget = state.status === "running" ? state.targetVersion : device.targetVersion;
  const serverNote =
    state.status === "running"
      ? state.stage === "resuming"
        ? "正在重启并重新连接…"
        : state.stage === "installing"
          ? "正在安装服务端更新…"
          : `正在下载服务端更新…${progress === undefined ? "" : ` ${Math.floor(progress)}%`}`
      : device.serverNote;
  const serverFailure =
    state.status === "failed"
      ? state.message
      : device.releaseError instanceof Error
        ? device.releaseError.message
        : null;

  return (
    <SettingsSection
      title={device.device}
      titleIcon={<SymbolView name="server.rack" size={16} tintColorClassName="accent-icon" />}
    >
      {device.activeSessions !== null && device.activeSessions > 0 ? (
        <Text className="px-4 pt-3 text-sm text-foreground-muted">
          {`${device.activeSessions} 个会话运行中`}
        </Text>
      ) : null}
      {server ? (
        <>
          <UpdateSelectionRow
            item={server}
            checked={selected.includes(server)}
            disabled={disabled}
            onPress={() => onToggle(server)}
          />
          {selected.includes(server) ? (
            <Text className="px-4 pb-3 text-sm text-foreground-muted">
              {serverUpdateImpact(server)}
            </Text>
          ) : null}
        </>
      ) : (
        <ListRowLayout
          label="T3 服务端"
          description={[
            serverVersions,
            serverTarget
              ? `目标版本 ${serverTarget}`
              : device.releaseChecking
                ? "正在检查更新…"
                : device.upToDate
                  ? "已是最新版本"
                  : "目标版本未确认",
            serverNote,
          ]
            .filter(Boolean)
            .join("\n")}
        />
      )}
      {serverFailure ? (
        <Text
          selectable
          accessibilityRole="alert"
          className="px-4 pb-3 text-sm text-danger-foreground"
        >
          {state.status === "failed" ? "服务端更新失败。" : "检查服务端更新失败。"}
          {serverFailure}
        </Text>
      ) : null}
      {state.status === "running" && state.stage === "downloading" ? (
        <View className="px-4 pb-3">
          <Progress
            label={`${device.device} 服务端更新下载进度`}
            {...(progress === undefined ? {} : { value: progress / 100 })}
          />
        </View>
      ) : null}
      {device.manual && state.status !== "running" ? (
        <ListActionRow
          icon="arrow.up.right"
          label="查看发布包"
          disabled={disabled}
          onPress={() =>
            void Linking.openURL(ENVIRONMENT_RELEASES_PAGE_URL).catch(() =>
              onNotice("无法打开发布页，请检查网络后重试。"),
            )
          }
        />
      ) : device.releaseAtom && state.status !== "running" ? (
        <ListActionRow
          icon="arrow.clockwise"
          label="检查服务端更新"
          disabled={disabled}
          loading={device.releaseChecking}
          onPress={() => {
            if (device.releaseAtom) appAtomRegistry.refresh(device.releaseAtom);
          }}
        />
      ) : null}
      {device.cliRows.map(({ provider, label, fromVersion, target, choice }) => (
        <View key={provider.instanceId}>
          {choice ? (
            <UpdateSelectionRow
              item={choice}
              disabled={disabled}
              checked={selected.includes(choice)}
              onPress={() => onToggle(choice)}
            />
          ) : (
            <ListRowLayout
              label={label}
              description={[
                `${device.connected ? "运行版本" : "上次连接版本"} ${fromVersion}`,
                target
                  ? `目标版本 ${target}`
                  : provider.versionAdvisory?.status === "current"
                    ? "已是最新版本"
                    : "目标版本未确认",
                target &&
                device.connected &&
                provider.updateState?.status !== "running" &&
                provider.updateState?.status !== "queued"
                  ? !device.canManageProviders
                    ? "当前连接没有 CLI 管理权限。"
                    : device.providerBusy || state.status === "running"
                      ? "等待设备上的其他更新结束。"
                      : provider.compatibilityAdvisory?.latestVersionStatus === "broken" ||
                          provider.compatibilityAdvisory?.latestVersionStatus === "unsupported"
                        ? "目标版本与当前 T3 Code 不兼容。"
                        : "需手动更新。请在运行该 CLI 的设备上操作。"
                  : null,
              ]
                .filter(Boolean)
                .join("\n")}
            />
          )}
          {provider.versionAdvisory?.message && !choice && !provider.updateState?.message ? (
            <Text selectable className="px-4 pb-3 text-sm text-foreground-muted">
              {formatProviderMaintenanceMessage(provider.versionAdvisory.message)}
            </Text>
          ) : null}
          {providerUpdateResult(provider.updateState) ? (
            <View className="gap-1 px-4 pb-3">
              <Text className="text-sm text-foreground-muted">
                {providerUpdateResult(provider.updateState)}
              </Text>
              {provider.updateState?.message ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {formatProviderMaintenanceMessage(provider.updateState.message)}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
    </SettingsSection>
  );
}
