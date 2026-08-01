// mintAgentKey — DB-free. The bearer is 32 random bytes base64url; keyHash === sha256hex(key); each
// call is distinct; only the hash is ever a candidate for persistence (we never expose the raw key
// from any stored form). Importing ./admin.js (where mintAgentKey lives) creates the pg pool lazily
// but never connects — no DB needed for this suite.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mintAgentKey } from "./admin.js";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("mintAgentKey", () => {
  it("key is 32 random bytes, base64url encoded", () => {
    const { key } = mintAgentKey();
    // base64url of 32 bytes = 43 chars, no padding, url-safe alphabet only.
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, "base64url").length).toBe(32);
  });

  it("keyHash === sha256hex(key)", () => {
    const { key, keyHash } = mintAgentKey();
    expect(keyHash).toBe(sha256Hex(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each call yields a distinct key + hash", () => {
    const a = mintAgentKey();
    const b = mintAgentKey();
    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it("the raw key is not derivable from the hash (one-way)", () => {
    const { key, keyHash } = mintAgentKey();
    // The hash never contains the key substring; persisting the hash never persists the key.
    expect(keyHash).not.toContain(key);
  });
});
