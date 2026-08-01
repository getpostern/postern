import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { aeadSeal, aeadOpen } from "./aead.js";

const KEY = randomBytes(32);
const AAD = "user-1|simplefin|access_url";

describe("aead round-trip", () => {
  const samples: Array<[string, string]> = [
    ["ascii url", "https://demo:demo@bridge.simplefin.org/simplefin/accounts"],
    ["long token", "x".repeat(4096)],
    ["unicode", "passwörd-🔐-契約-token"],
  ];

  for (const [label, pt] of samples) {
    it(`seals and opens: ${label}`, () => {
      const ptBuf = Buffer.from(pt, "utf8");
      const { ciphertext, nonce } = aeadSeal(KEY, ptBuf, AAD);
      // ciphertext must not equal plaintext bytes
      expect(ciphertext.equals(ptBuf)).toBe(false);
      const opened = aeadOpen(KEY, ciphertext, nonce, AAD);
      expect(opened.toString("utf8")).toBe(pt);
    });
  }

  it("uses a fresh 12-byte nonce each seal and packs a 16-byte tag", () => {
    const pt = Buffer.from("token", "utf8");
    const a = aeadSeal(KEY, pt, AAD);
    const b = aeadSeal(KEY, pt, AAD);
    expect(a.nonce.length).toBe(12);
    expect(a.nonce.equals(b.nonce)).toBe(false); // nonce uniqueness
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // ciphertext = ct(len pt) || tag(16)
    expect(a.ciphertext.length).toBe(pt.length + 16);
  });
});

describe("aead tamper detection", () => {
  it("throws when any ciphertext byte is flipped", () => {
    const { ciphertext, nonce } = aeadSeal(KEY, Buffer.from("secret"), AAD);
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;
    expect(() => aeadOpen(KEY, tampered, nonce, AAD)).toThrow();
  });

  it("throws when any nonce byte is flipped", () => {
    const { ciphertext, nonce } = aeadSeal(KEY, Buffer.from("secret"), AAD);
    const tampered = Buffer.from(nonce);
    tampered[0] ^= 0xff;
    expect(() => aeadOpen(KEY, ciphertext, tampered, AAD)).toThrow();
  });

  it("throws when the trailing tag is flipped", () => {
    const { ciphertext, nonce } = aeadSeal(KEY, Buffer.from("secret"), AAD);
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => aeadOpen(KEY, tampered, nonce, AAD)).toThrow();
  });
});

describe("aead AAD binding", () => {
  it("throws when decrypting with a different AAD", () => {
    const { ciphertext, nonce } = aeadSeal(KEY, Buffer.from("secret"), AAD);
    expect(() => aeadOpen(KEY, ciphertext, nonce, "user-1|simplefin|refresh_token")).toThrow();
  });

  it("opens with the matching AAD", () => {
    const { ciphertext, nonce } = aeadSeal(KEY, Buffer.from("secret"), AAD);
    expect(aeadOpen(KEY, ciphertext, nonce, AAD).toString("utf8")).toBe("secret");
  });
});
