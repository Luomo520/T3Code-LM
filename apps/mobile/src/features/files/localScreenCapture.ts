export type LocalCaptureKind = "screenshot" | "recording";
export type LocalCaptureResult = { readonly uri: string; readonly name: string };

export interface LocalScreenCapture {
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
