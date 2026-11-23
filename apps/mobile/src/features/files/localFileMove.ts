import type { FileHandoffMoveResult } from "@t3tools/contracts";

export interface LocalFileMove {
  pick(): Promise<{ readonly token: string; readonly uri: string; readonly name: string } | null>;
  finish(token: string, sha256: string): Promise<FileHandoffMoveResult>;
  discard(token: string): Promise<void>;
}

export const localFileMove: LocalFileMove | null = null;
