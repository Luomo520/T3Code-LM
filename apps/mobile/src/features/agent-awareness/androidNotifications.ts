import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { AppState, Linking, Platform } from "react-native";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
  supportsLocalTaskCompletion?(): boolean;
  readTaskCompletionWatch?(): string | null;
  setTaskCompletionWatch?(watch: string | null, expiresAt: number, background: boolean): void;
  canNotifyCaptureRequests?(): boolean;
  readCaptureRequestWatch?(): number;
  setCaptureRequestWatch?(until: number): void;
  postCaptureRequest?(
    scheme: string,
    path: string,
    environmentId: string,
    jobId: string,
    name: string,
    recording: boolean,
    expiresInMs: number,
  ): boolean | void;
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

let captureBackgroundReadyUntil = 0;
const CAPTURE_BACKGROUND_WINDOW_MS = 2 * 60 * 60 * 1000;

export function supportsAndroidCaptureRequestNotifications(): boolean {
  return typeof native?.canNotifyCaptureRequests === "function";
}

export function canNotifyAndroidCaptureRequests(): boolean {
  return native?.canNotifyCaptureRequests?.() === true;
}

export function noteAndroidCaptureBackgroundReady(): void {
  captureBackgroundReadyUntil = Date.now() + CAPTURE_BACKGROUND_WINDOW_MS;
  if (AppState.currentState === "background") syncAndroidCaptureBackgroundWatch(true);
}

export function syncAndroidCaptureBackgroundWatch(background: boolean): void {
  native?.setCaptureRequestWatch?.(
    background && canNotifyAndroidCaptureRequests() ? captureBackgroundReadyUntil : 0,
  );
}

export function readAndroidCaptureBackgroundWatch(): number {
  return native?.readCaptureRequestWatch?.() ?? 0;
}

export function postAndroidCaptureRequest(request: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly threadId: string;
  readonly jobId: string;
  readonly recording: boolean;
  readonly expiresInMs: number;
}): boolean {
  if (!native?.postCaptureRequest) return false;
  const path = `/threads/${encodeURIComponent(request.environmentId)}/${encodeURIComponent(request.threadId)}`;
  // 旧原生模块没有返回值，按以往的投递方式处理。
  return (
    native.postCaptureRequest(
      appScheme(),
      path,
      request.environmentId,
      request.jobId,
      request.environmentLabel,
      request.recording,
      request.expiresInMs,
    ) !== false
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
