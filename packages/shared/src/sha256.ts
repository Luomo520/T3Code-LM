import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export function createSha256() {
  const hash = sha256.create();
  return {
    update: (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    digestHex: () => bytesToHex(hash.digest()),
  };
}
