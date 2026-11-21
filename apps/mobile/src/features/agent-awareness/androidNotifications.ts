import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
  supportsLocalTaskCompletion?(): boolean;
  readTaskCompletionWatch?(): string | null;
  setTaskCompletionWatch?(watch: string | null, expiresAt: number, background: boolean): void;
  postTaskCompletion?(
    scheme: string,
    path: string,
    runId: string,
    title: string,
    failed: boolean,
  ): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLocalTaskCompletion(): boolean {
  return native?.supportsLocalTaskCompletion?.() === true;
}

export function readAndroidTaskCompletionWatch(): string | null {
  return native?.readTaskCompletionWatch?.() ?? null;
}

export function setAndroidTaskCompletionWatch(
  watch: string | null,
  expiresAt: number,
  background: boolean,
): void {
  native?.setTaskCompletionWatch?.(watch, expiresAt, background);
}

export function postAndroidTaskCompletion(completion: {
  readonly path: string;
  readonly runId: string;
  readonly title: string;
  readonly failed: boolean;
}): void {
  native?.postTaskCompletion?.(
    appScheme(),
    completion.path,
    completion.runId,
    completion.title,
    completion.failed,
  );
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}
