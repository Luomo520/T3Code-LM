import * as Schema from "effect/Schema";
import { AuthSessionId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FILE_HANDOFF_CHUNK_BYTES = 512 * 1024;
export const FILE_HANDOFF_ROUTE_PREFIX = "/api/assets/file-handoff";

const transferId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/));
const sizeBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const directSdp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24_000));
const savedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const handoffDisposition = Schema.Literals(["saved", "cancelled"]);

export const FileHandoffInstallation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("verified"),
    packageName: TrimmedNonEmptyString.check(
      Schema.isMaxLength(255),
      Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u),
    ),
    version: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    versionCode: Schema.String.check(Schema.isPattern(/^[0-9]{1,19}$/)),
  }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
]);
export type FileHandoffInstallation = typeof FileHandoffInstallation.Type;

export const FileHandoffRequest = Schema.Union([
  Schema.TaggedStruct("list", { threadId: ThreadId }),
  Schema.TaggedStruct("directStatus", { threadId: ThreadId, id: transferId }),
  Schema.TaggedStruct("directOffer", { threadId: ThreadId, id: transferId, sdp: directSdp }),
  Schema.TaggedStruct("directAnswer", { threadId: ThreadId, id: transferId, sdp: directSdp }),
  Schema.TaggedStruct("directAbandon", { threadId: ThreadId, id: transferId }),
  Schema.TaggedStruct("receive", { threadId: ThreadId, id: transferId }),
  Schema.TaggedStruct("cancel", { threadId: ThreadId, id: transferId }),
  Schema.TaggedStruct("reportInstall", {
    threadId: ThreadId,
    id: transferId,
    sha256,
    installation: FileHandoffInstallation,
  }),
  Schema.TaggedStruct("confirmSaved", {
    threadId: ThreadId,
    id: transferId,
    sizeBytes,
    sha256,
    savedPath: Schema.optionalKey(savedPath),
  }),
]);
export type FileHandoffRequest = typeof FileHandoffRequest.Type;

export const FileHandoffStart = Schema.Struct({
  threadId: ThreadId,
  id: transferId,
  recipient: AuthSessionId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  sizeBytes,
  sha256,
  direct: Schema.optionalKey(Schema.Boolean),
});
export type FileHandoffStart = typeof FileHandoffStart.Type;

export const FileHandoffUpload = Schema.Struct({
  relativeUrl: Schema.String,
  offset: sizeBytes,
  ready: Schema.Boolean,
  direct: Schema.optionalKey(Schema.Boolean),
});

const transfer = Schema.Struct({
  id: transferId,
  name: Schema.String,
  sizeBytes,
  senderLabel: Schema.String,
  recipientLabel: Schema.String,
  outgoing: Schema.Boolean,
  directSha256: Schema.optionalKey(sha256),
  savedPath: Schema.optionalKey(savedPath),
  installation: Schema.optionalKey(FileHandoffInstallation),
  expiresAt: Schema.optionalKey(Schema.Int),
  disposition: Schema.optionalKey(handoffDisposition),
  sha256: Schema.NullOr(Schema.String),
});
export type FileHandoffTransfer = typeof transfer.Type;

export const FileHandoffReply = Schema.Union([
  Schema.TaggedStruct("finished", { disposition: handoffDisposition }),
  Schema.TaggedStruct("direct", {
    state: Schema.Literals(["active", "closed", "saved"]),
    offer: Schema.optionalKey(directSdp),
    answer: Schema.optionalKey(directSdp),
  }),
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
