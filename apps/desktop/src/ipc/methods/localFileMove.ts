import { FILE_HANDOFF_CHUNK_BYTES, FileHandoffMoveResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { webContents, type WebContents } from "electron";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  discardLocalFileMove as discard,
  finishLocalFileMove as finish,
  pickLocalFileMove as pick,
  readLocalFileMove as read,
} from "../../downloads/LocalFileMove.ts";

class LocalFileMoveError extends Schema.TaggedError<
  LocalFileMoveError,
  { readonly brand: unique symbol }
>()("LocalFileMoveError", { message: Schema.String }) {}

const token = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
const size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

function withSender<A>(senderId: number | undefined, run: (sender: WebContents) => Promise<A>) {
  const sender = senderId === undefined ? null : webContents.fromId(senderId);
  return sender
    ? Effect.tryPromise({
        try: () => run(sender),
        catch: (cause) =>
          new LocalFileMoveError({
            message: cause instanceof Error ? cause.message : "无法处理本机选中的文件。",
          }),
      })
    : Effect.fail(new LocalFileMoveError({ message: "窗口已关闭。" }));
}

export const pickLocalFileMove = DesktopIpc.makeIpcMethod({
  channel: "desktop:pick-local-file-move",
  payload: Schema.Void,
  result: Schema.NullOr(Schema.Struct({ token, name: Schema.String, sizeBytes: size })),
  handler: (_input, event) => withSender(event?.sender.id, pick),
});

export const readLocalFileMove = DesktopIpc.makeIpcMethod({
  channel: "desktop:read-local-file-move",
  payload: Schema.Struct({
    token,
    offset: size,
    length: size.check(Schema.isLessThanOrEqualTo(FILE_HANDOFF_CHUNK_BYTES)),
  }),
  result: Schema.Uint8Array,
  handler: (input, event) =>
    withSender(event?.sender.id, (sender) => read(sender, input.token, input.offset, input.length)),
});

export const discardLocalFileMove = DesktopIpc.makeIpcMethod({
  channel: "desktop:discard-local-file-move",
  payload: token,
  result: Schema.Void,
  handler: (input, event) => withSender(event?.sender.id, (sender) => discard(sender, input)),
});

export const finishLocalFileMove = DesktopIpc.makeIpcMethod({
  channel: "desktop:finish-local-file-move",
  payload: Schema.Struct({
    token,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  result: FileHandoffMoveResult,
  handler: (input, event) =>
    withSender(event?.sender.id, (sender) => finish(sender, input.token, input.sha256)),
});
