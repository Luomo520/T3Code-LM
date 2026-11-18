import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  downloadFile as start,
  cancelFileDownload as cancel,
} from "../../downloads/FileDownloads.ts";

class FileDownloadError extends Schema.TaggedError<FileDownloadError>()("FileDownloadError", { cause: Schema.Unknown }) {}

export const downloadFile = DesktopIpc.makeIpcMethod({
  channel: "desktop:download-file",
  payload: Schema.Struct({ url: Schema.String, fileName: Schema.String }),
  result: Schema.Struct({
    method: Schema.Literals(["idm", "electron", "cancelled"]),
    id: Schema.optionalKey(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.fileDownloads.start")(function* (input, event) {
    const platform = yield* HostProcess.Platform;
    return yield* Effect.tryPromise({ try: () => start(input, event?.sender.id, platform), catch: (cause) => new FileDownloadError({ cause }) });
  }),
});
export const cancelFileDownload = DesktopIpc.makeIpcMethod({
  channel: "desktop:cancel-file-download",
  payload: Schema.String,
  result: Schema.Void,
  handler: (id, event) => Effect.sync(() => cancel(id, event?.sender.id)),
});
