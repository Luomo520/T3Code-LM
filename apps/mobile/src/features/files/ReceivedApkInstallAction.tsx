import type { FileHandoffRequest } from "@t3tools/contracts";

export type ReceivedInstallation = Extract<
  FileHandoffRequest,
  { _tag: "reportInstall" }
>["installation"];

export interface ReceivedApkInstallProps {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uri: string;
  readonly receiptKey: string;
  readonly systemOnly?: boolean;
  readonly installation?: ReceivedInstallation | undefined;
  readonly onReport: (result: ReceivedInstallation) => Promise<void>;
}

export function ReceivedApkInstallAction(_props: ReceivedApkInstallProps) {
  return null;
}
