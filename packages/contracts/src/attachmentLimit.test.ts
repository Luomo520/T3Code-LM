import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ChatAttachment,
  MAX_FILE_ATTACHMENT_BYTES,
  parseAttachmentMaxFileSizeMiB,
} from "./chatAttachment.ts";
import { AttachmentCreateUploadUrlInput } from "./assets.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

describe("attachment size setting", () => {
  it("migrates absent settings and preserves the configurable range", () => {
    const decode = Schema.decodeUnknownSync(ServerSettings);
    expect(decode({}).attachmentMaxFileSizeMiB).toBe(50);
    for (const size of [1, 50, 256, 10240]) {
      expect(decode({ attachmentMaxFileSizeMiB: size }).attachmentMaxFileSizeMiB).toBe(size);
    }
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch);
    for (const size of [0, -1, 1.5, 10241, Infinity, "256", null]) {
      expect(() => patch({ attachmentMaxFileSizeMiB: size })).toThrow();
    }
  });
  it("validates numeric input without accepting decimals or exponents", () => {
    for (const value of ["", "0", "-1", "1.5", "1e3", "10241", "NaN"]) {
      expect(parseAttachmentMaxFileSizeMiB(value)).toBeNull();
    }
    expect(parseAttachmentMaxFileSizeMiB(" 256 ")).toBe(256);
  });
  it("admits large uploaded file metadata in RPC and persisted history", () => {
    const file = {
      type: "file",
      name: "large.zip",
      mimeType: "application/zip",
      sizeBytes: 51 * 1024 * 1024,
    };
    expect(Schema.decodeUnknownSync(AttachmentCreateUploadUrlInput)(file).sizeBytes).toBe(
      file.sizeBytes,
    );
    expect(
      Schema.decodeSync(ChatAttachment)({
        ...file,
        id: "thread-1-00000000-0000-4000-8000-000000000003-zip",
      }),
    ).toMatchObject({ sizeBytes: file.sizeBytes });
    expect(() =>
      Schema.decodeUnknownSync(AttachmentCreateUploadUrlInput)({
        ...file,
        sizeBytes: MAX_FILE_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow();
  });
});
