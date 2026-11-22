import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { AppText } from "../../../components/ui/AppText";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

interface SelectedApk {
  readonly id: string;
  readonly name: string;
  readonly packageName: string;
  readonly version: string | null;
  readonly versionCode: string;
}

type InstallMethod = "system" | "shizuku";
type InstallResult =
  | { readonly status: "installed" | "cancelled" | "permission-required" }
  | { readonly status: "failed"; readonly message: string };

const installer = requireOptionalNativeModule<{
  getSelectedApk: () => Promise<SelectedApk | null>;
  pickApk: () => Promise<SelectedApk | null>;
  installApk: (id: string, method: InstallMethod) => Promise<InstallResult>;
}>("T3LocalApkInstall");

function apkDetails(apk: SelectedApk) {
  const version = apk.version
    ? `版本 ${apk.version} · 构建 ${apk.versionCode}`
    : `构建 ${apk.versionCode}`;
  return `${apk.packageName}\n${version}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重新选择 APK 后重试。";
}

export function LocalApkInstallSection() {
  const [selected, setSelected] = useState<SelectedApk | null>(null);
  const [pending, setPending] = useState<"pick" | InstallMethod | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 设置页重新打开时，读取 Android 模块保存的 APK 选择。
  useEffect(() => {
    let active = true;
    void installer?.getSelectedApk().then(
      (apk) => {
        if (active) setSelected(apk);
      },
      (error: unknown) => {
        if (active) setMessage(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (!installer) return null;
  const native = installer;

  async function pick() {
    setMessage(null);
    setPending("pick");
    try {
      const apk = await native.pickApk();
      if (apk) setSelected(apk);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function install(apk: SelectedApk, method: InstallMethod) {
    setMessage(null);
    setPending(method);
    try {
      const result = await native.installApk(apk.id, method);
      switch (result.status) {
        case "installed":
          setSelected(null);
          setMessage(`已安装 ${apk.name}\n${apkDetails(apk)}`);
          break;
        case "cancelled":
          setMessage("安装已取消。");
          break;
        case "permission-required":
          setMessage("请允许此 App 安装应用，然后返回并再次选择系统安装器。");
          break;
        case "failed":
          setMessage(`安装失败。${result.message}`);
          break;
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  function confirmShizuku(apk: SelectedApk) {
    Alert.alert("通过 Shizuku / Sui 安装？", `${apk.name}\n${apkDetails(apk)}`, [
      { text: "取消", style: "cancel" },
      { text: "安装", onPress: () => void install(apk, "shizuku") },
    ]);
  }

  return (
    <View className="gap-2">
      <SettingsSection title="安装本地 APK">
        <SettingsRow
          icon="folder"
          label={selected ? "重新选择 APK" : "选择 APK"}
          value={selected ? `${selected.name}\n${apkDetails(selected)}` : "从设备文件中选择 APK"}
          disabled={pending !== null}
          onPress={() => void pick()}
        />
        {selected ? (
          <>
            <SettingsRow
              icon="archivebox"
              label="通过系统安装器安装"
              disabled={pending !== null}
              onPress={() => void install(selected, "system")}
            />
            <SettingsRow
              icon="bolt.circle"
              label="通过 Shizuku / Sui 安装"
              disabled={pending !== null}
              onPress={() => confirmShizuku(selected)}
            />
          </>
        ) : null}
      </SettingsSection>
      {pending || message ? (
        <AppText
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="px-4 text-foreground-muted"
        >
          {pending === "pick" ? "正在读取 APK…" : pending ? "正在等待安装结果…" : message}
        </AppText>
      ) : null}
    </View>
  );
}
