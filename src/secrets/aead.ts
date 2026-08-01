// Pure AES-256-GCM seal/open — the security core. No DB, no key resolution, no logging.
//
// Layout (matches db/schema.sql `secrets`): a 12-byte random nonce is stored separately in
// `secrets.nonce`; the 16-byte GCM auth tag is APPENDED to the ciphertext (`ciphertext = ct || tag`)
// because the schema has no dedicated tag column. `aeadOpen` splits the trailing 16 bytes back off.
// The AAD string is bound into the GCM tag via setAAD, so tampering with it (or a wrong context)
// fails verification.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12; // 96-bit GCM nonce
const TAG_BYTES = 16; // GCM auth tag

/** Seal a plaintext buffer under `key` (32 bytes), binding `aad`. Returns ciphertext (ct||tag) + nonce. */
export function aeadSeal(
  key: Buffer,
  plaintext: Buffer,
  aad: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([ct, tag]), nonce };
}

/**
 * Open `ciphertext` (ct||tag) with `nonce` and `aad`. Throws on tag/AAD mismatch (tamper, wrong key,
 * or wrong context). Callers translate the throw into SecretAuthError.
 */
export function aeadOpen(key: Buffer, ciphertext: Buffer, nonce: Buffer, aad: string): Buffer {
  if (ciphertext.length < TAG_BYTES) {
    throw new Error("ciphertext too short to contain a GCM tag");
  }
  const ct = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
