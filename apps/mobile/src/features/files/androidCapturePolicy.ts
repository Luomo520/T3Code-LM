import { localScreenCapture, type CapturePolicy } from "./localScreenCapture";

export type CaptureAction = "screenshot" | "record-screen";

export function readAndroidCapturePolicy(
  environmentId: string,
  action: CaptureAction,
): CapturePolicy {
  const native = localScreenCapture;
  // 旧包没有本机策略，只能沿用逐次询问。新包读取失败时不领取请求。
  if (!native?.getEnvironmentPolicy) return "ask";
  try {
    const value = native.getEnvironmentPolicy(
      environmentId,
      action === "screenshot" ? "screenshot" : "recording",
    );
    return value === "ask" || value === "system" ? value : "deny";
  } catch {
    return "deny";
  }
}
