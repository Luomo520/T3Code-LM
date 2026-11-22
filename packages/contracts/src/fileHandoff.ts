import * as Schema from "effect/Schema";
import { AuthSessionId, ThreadId } from "./baseSchemas.ts";

export const FILE_HANDOFF_CHUNK_BYTES = 512 * 1024;
export const FILE_HANDOFF_ROUTE_PREFIX = "/api/assets/file-handoff";

const transferId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/));
const sizeBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const FileHandoffRequest = Schema.Union([
  Schema.TaggedStruct("list", { threadId: ThreadId }),
  Schema.TaggedStruct("receive", { threadId: ThreadId, id: transferId }),
]);
export type FileHandoffRequest = typeof FileHandoffRequest.Type;

export const FileHandoffStart = Schema.Struct({
  threadId: ThreadId,
  id: transferId,
  recipient: AuthSessionId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  sizeBytes,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type FileHandoffStart = typeof FileHandoffStart.Type;

export const FileHandoffUpload = Schema.Struct({
  relativeUrl: Schema.String,
  offset: sizeBytes,
  ready: Schema.Boolean,
});

const transfer = Schema.Struct({
  id: transferId,
  name: Schema.String,
  sizeBytes,
  senderLabel: Schema.String,
  recipientLabel: Schema.String,
  outgoing: Schema.Boolean,
  sha256: Schema.NullOr(Schema.String),
});
export type FileHandoffTransfer = typeof transfer.Type;

export const FileHandoffReply = Schema.Union([
  Schema.TaggedStruct("list", {
    transfers: Schema.Array(transfer),
    recipients: Schema.Array(
      Schema.Struct({ id: AuthSessionId, label: Schema.String, online: Schema.Boolean }),
    ),
  }),
  Schema.TaggedStruct("receive", {
    relativeUrl: Schema.String,
    name: Schema.String,
    sizeBytes,
    sha256: Schema.String,
  }),
]);
export type FileHandoffReply = typeof FileHandoffReply.Type;

export class FileHandoffError extends Schema.TaggedError<FileHandoffError>()("FileHandoffError", {
  message: Schema.String,
}) {}
