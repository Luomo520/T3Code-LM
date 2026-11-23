import { requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, AppState, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { AppText } from "../../components/ui/AppText";
import type { ReceivedApkInstallProps, ReceivedInstallation } from "./ReceivedApkInstallAction";

type InstallMethod = "system" | "adb" | "root";
type LocalInstallStatus =
  | Exclude<ReceivedInstallation, { status: "failed" }>
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly message: string };

const native = requireOptionalNativeModule<{
  getDeviceAccess: () => Promise<
    "unavailable" | "unsupported" | "available" | "denied" | "adb" | "root"
  >;
  readReceivedInstall: (receiptKey: string) => Promise<LocalInstallStatus | null>;
  resumeReceivedInstall: (receiptKey: string) => Promise<boolean>;
  addListener: (
    event: "onReceivedInstallChanged",
    listener: (event: { key: string }) => void,
  ) => { remove(): void };
  cancelReceivedInstall: (receiptKey: string) => Promise<boolean>;
  prepareReceivedApk: (
    uri: string,
    name: string,
    size: number,
    sha256: string,
    receiptKey: string,
  ) => Promise<{ id: string; packageName: string; version: string | null; versionCode: string }>;
  installApk: (id: string, method: InstallMethod) => Promise<{ status: string; message?: string }>;
}>("T3LocalApkInstall");

export function ReceivedApkInstallAction(file: ReceivedApkInstallProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retryReceipt, setRetryReceipt] = useState<ReceivedInstallation | null>(null);
  const verified = file.installation?.status === "verified";
  const reporting = useRef<ReceivedInstallation | null>(null);
  async function report(result: ReceivedInstallation) {
    if (reporting.current?.status === result.status) return;
    reporting.current = result;
    try {
      await file.onReport(result);
      if (reporting.current !== result) return;
      setRetryReceipt(null);
      setMessage(
        result.status === "verified"
          ? `已核实安装 ${result.packageName} · ${result.version}`
          : result.status === "cancelled"
            ? "已取消安装，文件已保留。"
            : "安装未完成，文件已保留。",
      );
    } catch {
      if (reporting.current !== result) return;
      reporting.current = null;
      setRetryReceipt(result);
      setMessage("安装结果暂未送达，可重试回执。");
    }
  }
  const recover = useEffectEvent((current: LocalInstallStatus) => {
    if (current.status === "verified") void report(current);
    else if (current.status === "cancelled" && file.installation?.status !== "cancelled")
      void report(current);
    else if (current.status === "failed") {
      setMessage(current.message);
      if (file.systemOnly && file.installation?.status !== "failed")
        void report({ status: "failed" });
    } else if (current.status === "pending")
      setMessage("等待系统完成安装。若确认界面未出现，可再次点按安装。");
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 在安装广播或返回前台时读取该包的系统安装回执。
  useEffect(() => {
    if (!native || verified) return;
    let active = true;
    const read = () => {
      void native.readReceivedInstall(file.receiptKey).then(
        (current) => {
          if (active && current) recover(current);
        },
        () => {},
      );
    };
    const install = native.addListener("onReceivedInstallChanged", ({ key }) => {
      if (key === file.receiptKey) read();
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    read();
    return () => {
      active = false;
      install.remove();
      foreground.remove();
    };
  }, [file.receiptKey, verified]);
  if (!native || !file.name.toLowerCase().endsWith(".apk")) return null;
  const installer = native;

  async function prepare() {
    setBusy(true);
    setMessage("");
    try {
      if (await installer.resumeReceivedInstall(file.receiptKey)) return;
      const apk = await installer.prepareReceivedApk(
        file.uri,
        file.name,
        file.sizeBytes,
        file.sha256,
        file.receiptKey,
      );
      const access = file.systemOnly
        ? "unavailable"
        : await installer.getDeviceAccess().catch(() => "unavailable" as const);
      const method = await new Promise<InstallMethod | null>((resolve) => {
        Alert.alert(
          "安装收到的 APK？",
          `${apk.packageName} · ${apk.version ? `版本 ${apk.version} · ` : ""}构建 ${apk.versionCode}`,
          [
            { text: "取消", style: "cancel", onPress: () => resolve(null) },
            { text: "系统安装器", onPress: () => resolve("system") },
            ...(access === "adb" || access === "root"
              ? [
                  {
                    text: access === "root" ? "使用 Root" : "使用 ADB",
                    onPress: () => resolve(access),
                  },
                ]
              : []),
          ],
          { cancelable: true, onDismiss: () => resolve(null) },
        );
      });
      if (!method) {
        if (await installer.cancelReceivedInstall(file.receiptKey))
          await report({ status: "cancelled" });
        return;
      }
      reporting.current = null;
      const result = await installer.installApk(apk.id, method);
      if (result.status === "installed" || result.status === "pending") {
        const current = await installer.readReceivedInstall(file.receiptKey);
        if (current?.status === "verified" || current?.status === "cancelled")
          await report(current);
        else if (current?.status === "failed") {
          if (file.systemOnly) await report({ status: "failed" });
          setMessage(current.message);
        } else if (current?.status === "pending")
          setMessage("等待系统完成安装。若确认界面未出现，可再次点按安装。");
        else setMessage("安装器已返回，暂未从系统核实版本。");
      } else if (result.status === "permission-required")
        setMessage("允许安装应用后，可在这里继续。");
      else if (result.status === "cancelled") await report({ status: "cancelled" });
      else {
        if (file.systemOnly) await report({ status: "failed" });
        setMessage(result.message ?? "安装失败，可重试。");
      }
    } catch (error) {
      if (file.systemOnly) await report({ status: "failed" });
      setMessage(error instanceof Error ? error.message : "无法打开已保存的 APK。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="mt-1 items-start gap-1">
      {retryReceipt ? (
        <Button label="重试安装回执" size="compact" onPress={() => void report(retryReceipt)} />
      ) : verified && file.installation?.status === "verified" ? (
        <AppText textRole="footnote">{`已核实安装 ${file.installation.packageName} · ${file.installation.version}`}</AppText>
      ) : (
        <Button
          label={file.systemOnly ? "核对 APK 并安装" : "安装已接收的 APK"}
          size="compact"
          loading={busy}
          onPress={() => void prepare()}
        />
      )}
      {message && !verified ? (
        <AppText accessibilityLiveRegion="polite" textRole="footnote">
          {message}
        </AppText>
      ) : null}
    </View>
  );
}
