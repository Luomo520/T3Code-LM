import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import { ThreadId } from "@t3tools/contracts";
import { locateSavedFileHandoff as locateHandoff } from "../../downloads/SavedFileHandoffs.ts";
import {
  downloadFile as start,
  downloadHandoffFile as startHandoff,
  cancelFileDownload as cancel,
} from "../../downloads/FileDownloads.ts";

class FileDownloadError extends Schema.TaggedError<FileDownloadError>()("FileDownloadError", {
  cause: Schema.Unknown,
}) {}

export const downloadFile = DesktopIpc.makeIpcMethod({
  channel: "desktop:download-file",
  payload: Schema.Struct({ url: Schema.String, fileName: Schema.String }),
  result: Schema.Struct({
    method: Schema.Literals(["builtin", "electron", "cancelled"]),
    id: Schema.optionalKey(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.fileDownloads.start")(function* (input, event) {
    const platform = yield* HostProcess.Platform;
    return yield* Effect.tryPromise({
      try: () => start(input, event?.sender.id, platform),
      catch: (cause) => new FileDownloadError({ cause }),
    });
  }),
});
export const downloadHandoffFile = DesktopIpc.makeIpcMethod({
  channel: "desktop:download-handoff-file",
  payload: Schema.Struct({
    url: Schema.String,
    fileName: Schema.String,
    transferId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
    sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  result: Schema.Struct({ savedPath: Schema.String }),
  handler: Effect.fn("desktop.ipc.fileDownloads.startHandoff")(function* (input, event) {
    return yield* Effect.tryPromise({
      try: () => startHandoff(input, event?.sender.id),
      catch: (cause) => new FileDownloadError({ cause }),
    });
  }),
});

export const locateSavedFileHandoff = DesktopIpc.makeIpcMethod({
  channel: "desktop:locate-saved-file-handoff",
  payload: Schema.Struct({
    threadId: ThreadId,
    transferId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
    reveal: Schema.Boolean,
  }),
  result: Schema.Literals(["available", "missing", "unknown"]),
  handler: Effect.fn("desktop.ipc.fileDownloads.locateHandoff")(function* (input) {
    return yield* Effect.tryPromise({
      try: () => locateHandoff(input),
      catch: (cause) => new FileDownloadError({ cause }),
    });
  }),
});

export const cancelFileDownload = DesktopIpc.makeIpcMethod({
  channel: "desktop:cancel-file-download",
  payload: Schema.String,
  result: Schema.Void,
  handler: (id, event) => Effect.sync(() => cancel(id, event?.sender.id)),
});
