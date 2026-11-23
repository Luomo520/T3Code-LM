// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { COMPANION_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { CompanionError } from "./store.ts";

export function readCompanionTransferFile(attachmentsDir: string, attachmentId: string) {
  const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
  const unavailable = () => new CompanionError(404, "The thread file is unavailable.");
  if (path === null) throw unavailable();
  let handle: number;
  try {
    handle = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch {
    throw unavailable();
  }
  try {
    const info = NodeFS.fstatSync(handle);
    if (!info.isFile() || info.size > COMPANION_MAX_IMAGE_BYTES) {
      throw new CompanionError(413, "The file is larger than 5 MiB.");
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = NodeFS.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length || NodeFS.fstatSync(handle).size !== info.size) {
      throw new CompanionError(409, "The file changed. Create a new transfer.");
    }
    return {
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      data: bytes.toString("base64"),
    };
  } finally {
    NodeFS.closeSync(handle);
  }
}
