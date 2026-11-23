import { requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent, useState } from "react";
import { Alert, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { AppText } from "../../components/ui/AppText";
import type { ReceivedApkInstallProps, ReceivedInstallation } from "./ReceivedApkInstallAction";

const native = requireOptionalNativeModule<{
  readReceivedInstall: (receiptKey: string) => Promise<ReceivedInstallation | null>;
  cancelReceivedInstall: (receiptKey: string) => Promise<void>;
  prepareReceivedApk: (
    uri: string,
    name: string,
    size: number,
    sha256: string,
    receiptKey: string,
  ) => Promise<{ id: string; packageName: string; version: string | null; versionCode: string }>;
  installApk: (
    id: string,
    method: "system" | "shizuku",
  ) => Promise<{ status: string; message?: string }>;
}>("T3LocalApkInstall");

export function ReceivedApkInstallAction(file: ReceivedApkInstallProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retryReceipt, setRetryReceipt] = useState<ReceivedInstallation | null>(null);
  const verified = file.installation?.status === "verified";
  async function report(result: ReceivedInstallation) {
    try {
      await file.onReport(result);
      setRetryReceipt(null);
      setMessage(
        result.status === "verified"
          ? `已核实安装 ${result.packageName} · ${result.version}`
          : "已取消安装，文件已保留。",
      );
    } catch {
      setRetryReceipt(result);
      setMessage("安装结果暂未送达，可重试回执。");
    }
  }
  const recover = useEffectEvent(async (current: ReceivedInstallation) => {
    if (current.status === "cancelled" && file.installation?.status === "cancelled") return;
    await report(current);
  });
  useEffect(() => {
    if (verified) return;
    let active = true;
    void native?.readReceivedInstall(file.receiptKey).then(
      (current) => {
        if (active && current) void recover(current);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [file.receiptKey, verified]);
  if (!native || !file.name.toLowerCase().endsWith(".apk")) return null;
  const installer = native;

  async function prepare() {
    setBusy(true);
    setMessage("");
    try {
      const apk = await installer.prepareReceivedApk(
        file.uri,
        file.name,
        file.sizeBytes,
        file.sha256,
        file.receiptKey,
      );
      const method = await new Promise<"system" | "shizuku" | null>((resolve) => {
        Alert.alert(
          "安装收到的 APK？",
          `${apk.packageName} · ${apk.version ?? apk.versionCode}`,
          [
            { text: "取消", style: "cancel", onPress: () => resolve(null) },
            { text: "系统安装器", onPress: () => resolve("system") },
            { text: "Shizuku / Sui", onPress: () => resolve("shizuku") },
          ],
          { cancelable: true, onDismiss: () => resolve(null) },
        );
      });
      if (!method) {
        await installer.cancelReceivedInstall(file.receiptKey);
        await report({ status: "cancelled" });
        return;
      }
      const result = await installer.installApk(apk.id, method);
      if (result.status === "installed") {
        const current = await installer.readReceivedInstall(file.receiptKey);
        if (current?.status === "verified") await report(current);
        else setMessage("安装器已返回，暂未从系统核实版本。");
      } else if (result.status === "permission-required")
        setMessage("允许安装应用后，可在这里继续。");
      else if (result.status === "cancelled") await report({ status: "cancelled" });
      else setMessage(result.message ?? "安装失败，可重试。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法打开已保存的 APK。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-1">
      {retryReceipt ? (
        <Button label="重试安装回执" size="compact" onPress={() => void report(retryReceipt)} />
      ) : verified && file.installation?.status === "verified" ? (
        <AppText textRole="footnote">{`已核实安装 ${file.installation.packageName} · ${file.installation.version}`}</AppText>
      ) : (
        <Button
          label="安装已接收的 APK"
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
