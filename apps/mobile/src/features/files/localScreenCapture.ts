export type LocalCaptureKind = "screenshot" | "recording";
export type LocalCaptureResult = { readonly uri: string; readonly name: string };

export type CapturePolicy = "ask" | "system" | "deny";
export type CaptureSharingChoice = "hold" | "reuse";

export interface LocalScreenCapture {
  getEnvironmentPolicy?(environmentId: string, kind: LocalCaptureKind): CapturePolicy;
  setEnvironmentPolicy?(
    environmentId: string,
    kind: LocalCaptureKind,
    policy: CapturePolicy,
  ): Promise<void>;
  captureEnvironmentRequest?(
    kind: LocalCaptureKind,
    requestId: string,
    seconds: number,
    environmentId: string,
  ): ReturnType<NonNullable<LocalScreenCapture["captureApprovedRequest"]>>;
  canKeepSharing?(): Promise<boolean>;
  canReuseSharing?(environmentId: string, threadId: string, routeKey: string): Promise<boolean>;
  endSharing?(environmentId: string): Promise<void>;
  captureScopedRequest?(
    kind: LocalCaptureKind,
    requestId: string,
    seconds: number,
    environmentId: string,
    threadId: string,
    routeKey: string,
    choice: CaptureSharingChoice,
  ): ReturnType<NonNullable<LocalScreenCapture["captureApprovedRequest"]>>;
  captureApprovedRequest?(
    kind: LocalCaptureKind,
    requestId: string,
    seconds: number,
  ): Promise<
    | ({ readonly status: "done" } & LocalCaptureResult)
    | { readonly status: "denied" | "locked" | "revoked" | "canceled" | "failed" }
  >;
  isUnlocked(): Promise<boolean>;
  capture(kind: LocalCaptureKind, requestId: string): Promise<LocalCaptureResult | null>;
  stopRecording(requestId: string): Promise<void>;
  cancelCapture(requestId: string): Promise<void>;
  addListener(
    event: "onRecordingStarted",
    listener: (value: { readonly requestId: string }) => void,
  ): { remove(): void };
}

export const localScreenCapture: LocalScreenCapture | null = null;
