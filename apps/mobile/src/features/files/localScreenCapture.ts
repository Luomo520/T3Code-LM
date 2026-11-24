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
  canAutoReuseSharing?(
    kind: LocalCaptureKind,
    environmentId: string,
    threadId: string,
    routeKey: string,
    seconds: number,
  ): Promise<boolean>;
  endSharing?(environmentId: string): Promise<void>;
  captureScopedRequest?(
    kind: LocalCaptureKind,
    requestId: string,
    seconds: number,
    environmentId: string,
    threadId: string,
    routeKey: string,
    choice: CaptureSharingChoice,
  ): Promise<
    | Awaited<ReturnType<NonNullable<LocalScreenCapture["captureApprovedRequest"]>>>
    | { readonly status: "sharing_unavailable" }
  >;
  captureApprovedRequest?(
    kind: LocalCaptureKind,
    requestId: string,
    seconds: number,
  ): Promise<
    | ({ readonly status: "done" } & LocalCaptureResult)
    | { readonly status: "denied" | "locked" | "revoked" | "canceled" | "failed" }
  >;
  showRequestPrompt?(
    id: string,
    title: string,
    message: string,
    hold: string | null,
    remainingMs: number,
  ): Promise<"once" | "hold" | "deny" | "expired">;
  dismissRequestPrompt?(id: string): Promise<void>;
  isUnlocked(): Promise<boolean>;
  capture(kind: LocalCaptureKind, requestId: string): Promise<LocalCaptureResult | null>;
  stopRecording(requestId: string): Promise<void>;
  cancelCapture(requestId: string): Promise<void>;
  addListener(
    event: "onRecordingStarted" | "onConsentRequested",
    listener: (value: { readonly requestId: string }) => void,
  ): { remove(): void };
}

export const localScreenCapture: LocalScreenCapture | null = null;
