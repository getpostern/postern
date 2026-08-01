// verifyVaultKey / assertVaultKey DB round-trip — gated on DATABASE_URL so CI stays green without
// Postgres. Follows rotate.db.test.ts: real pool, real AEAD primitives, own teardown.
//
// ISOLATION IS THE HARD PART. `pci_test` is shared with concurrently-running suites that seal their
// own rows under 'env'/'file'/'auto', so EVERY call here passes `refs: [...]` (and `keyIds` where it
// sharpens the case). Without that narrowing a sibling suite's row would wander into the scan and
// make these assertions non-deterministic. Fixtures are sealed with aeadSeal + a direct INSERT
// rather than seal(), so the test controls `key_id` — including ids no key can resolve, and ids that
// LIE about which key sealed the row (the whole point of the check).

import { describe, it, expect, afterAll, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

// Hoisted (runs before imports): a fixed vault key, so activeKey() resolves from the env instead of
// AUTOGENERATING .pci/master.key in the working tree as a test side effect. `??=` keeps an operator's
// own PCI_MASTER_KEY if one is already exported.
vi.hoisted(() => {
  process.env.PCI_MASTER_KEY ??= Buffer.alloc(32, 0x97).toString("base64");
});

const { aeadSeal } = await import("./aead.js");
const { activeKey } = await import("./key.js");
const { verifyVaultKey, assertVaultKey, VaultKeyError } = await import("./verify.js");
const { pool } = await import("../db.js");

const HAS_DB = !!process.env.DATABASE_URL;
const SEED_USER = "00000000-0000-0000-0000-000000000001";

/** Every ref this file inserts — including any stamped with the LIVE key id, which must not linger. */
const createdRefs: string[] = [];
const createdCredIds: string[] = [];

afterAll(async () => {
  if (!HAS_DB) return;
  // Connectors FK to credentials, credentials are what the scan joins through — drop in that order.
  if (createdCredIds.length) {
    await pool.query(`delete from connectors where credential_id = any($1)`, [createdCredIds]);
    await pool.query(`delete from provider_credentials where id = any($1)`, [createdCredIds]);
  }
  if (createdRefs.length) {
    await pool.query(`delete from secrets where ref = any($1)`, [createdRefs]);
  }
  await pool.end();
});

/**
 * Attach `ref` to a credential that HAS a live connector, which is what puts it in the scan's scope.
 *
 * Added 2026-07-25 with the scope fix. `verifyVaultKey` no longer scans bare `secrets` — it scans
 * only rows reachable from a credential with a non-revoked connector (see verify.ts LIVE_SECRET_REFS
 * for why: a bare scan refused to boot production on 64 orphaned rows). WITHOUT this helper every
 * fixture below would fall out of scope and all eleven assertions would pass on an empty result set
 * — the tests would go vacuous in exactly the way this repo keeps shipping.
 */
async function attachToLiveConnector(ref: string): Promise<void> {
  const credId = randomUUID();
  await pool.query(
    `insert into provider_credentials (id, user_id, provider, status, secret_ref)
     values ($1, $2, $3, 'active', $4)`,
    [credId, SEED_USER, `vaultverify-${credId.slice(0, 8)}`, ref],
  );
  await pool.query(
    `insert into connectors (id, user_id, credential_id, sector, provider, status)
     values ($1, $2, $3, 'finance', $4, 'active')`,
    [randomUUID(), SEED_USER, credId, `vaultverify-${credId.slice(0, 8)}`],
  );
  createdCredIds.push(credId);
}

/** Seal `plaintext` under `key` but STAMP the row with `keyId` — the two need not agree. */
async function seedSecret(
  key: Buffer,
  keyId: string,
  plaintext: string,
  aad: string,
  opts?: { orphan?: boolean; noConnector?: boolean },
): Promise<{ ref: string; ciphertext: Buffer; nonce: Buffer }> {
  const ref = "sec_" + randomUUID();
  const { ciphertext, nonce } = aeadSeal(key, Buffer.from(plaintext, "utf8"), aad);
  await pool.query(
    `insert into secrets (ref, user_id, ciphertext, nonce, key_id, aad) values ($1, $2, $3, $4, $5, $6)`,
    [ref, SEED_USER, ciphertext, nonce, keyId, aad],
  );
  createdRefs.push(ref);
  if (opts?.orphan) return { ref, ciphertext, nonce }; // no credential at all
  if (opts?.noConnector) {
    const credId = randomUUID();
    await pool.query(
      `insert into provider_credentials (id, user_id, provider, status, secret_ref)
       values ($1, $2, $3, 'active', $4)`,
      [credId, SEED_USER, `vaultorphan-${credId.slice(0, 8)}`, ref],
    );
    createdCredIds.push(credId);
    return { ref, ciphertext, nonce };
  }
  await attachToLiveConnector(ref);
  return { ref, ciphertext, nonce };
}

describe.skipIf(!HAS_DB)("verifyVaultKey (real pool + real AEAD)", () => {
  it("an empty vault verifies clean — a first run has nothing sealed and must boot", async () => {
    // Scoped to a ref that cannot exist: exactly the shape of a fresh install's whole vault.
    const absent = ["sec_" + randomUUID()];
    const res = await verifyVaultKey({ refs: absent });
    expect(res).toEqual({ sealedRows: 0, scannedKeyIds: [], failures: [] });
    // The fail-closed wrapper must RESOLVE here. An `if (!openedAtLeastOne) throw` would refuse to
    // boot every first run — the single most damaging way to get this check wrong.
    await expect(assertVaultKey({ refs: absent })).resolves.toBeUndefined();
  });

  it("a vault sealed under the resolved key verifies clean", async () => {
    const live = activeKey();
    const aad = `${SEED_USER}|simplefin|access`;
    const { ref } = await seedSecret(live.key, live.keyId, "an-access-url", aad);

    const res = await verifyVaultKey({ refs: [ref] });
    expect(res.sealedRows).toBe(1);
    expect(res.scannedKeyIds).toEqual([live.keyId]);
    expect(res.failures).toEqual([]);
    await expect(assertVaultKey({ refs: [ref] })).resolves.toBeUndefined();
  });

  it("a row sealed under a different key of the same key_id fails as did_not_open", async () => {
    // The row CLAIMS the live key id but was sealed under another key — the restored-DB-without-the-
    // key shape. An implementation that only counts rows, or that resolves keyById without ever
    // calling aeadOpen, reports this as clean.
    const live = activeKey();
    const aad = `${SEED_USER}|home_assistant|access`;
    const { ref } = await seedSecret(randomBytes(32), live.keyId, "a-long-lived-token", aad);

    const res = await verifyVaultKey({ refs: [ref] });
    expect(res.sealedRows).toBe(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ keyId: live.keyId, ref, rows: 1, reason: "did_not_open" });
  });

  it("a row whose key_id has no resolvable key fails as no_key", async () => {
    const goneId = `kv_gone_${randomUUID()}`;
    const aad = `${SEED_USER}|google|refresh`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "a-refresh-token", aad);

    const res = await verifyVaultKey({ refs: [ref], keyIds: [goneId] });
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ keyId: goneId, ref, reason: "no_key" });
  });

  it("reports how many rows sit under each failing key id", async () => {
    // Drop the `count(*) over (partition by key_id)` window and this reads 1 — the operator would be
    // told one credential is unopenable when the true number is the whole vault.
    const goneId = `kv_gone_${randomUUID()}`;
    const aad = `${SEED_USER}|whoop|refresh`;
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      refs.push((await seedSecret(randomBytes(32), goneId, `tok-${i}`, aad)).ref);
    }

    const res = await verifyVaultKey({ keyIds: [goneId], refs });
    expect(res.sealedRows).toBe(3);
    expect(res.scannedKeyIds).toEqual([goneId]); // ONE representative row per key id
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].rows).toBe(3);
  });

  it("scans one representative row per distinct key id, ascending", async () => {
    // A partially-completed rotation legitimately leaves two key ids in the vault; both are checked.
    const idA = `kv_aaa_${randomUUID()}`;
    const idB = `kv_bbb_${randomUUID()}`;
    const aad = `${SEED_USER}|microsoft|refresh`;
    const refs = [
      (await seedSecret(randomBytes(32), idA, "a1", aad)).ref,
      (await seedSecret(randomBytes(32), idA, "a2", aad)).ref,
      (await seedSecret(randomBytes(32), idB, "b1", aad)).ref,
    ];

    const res = await verifyVaultKey({ keyIds: [idA, idB], refs });
    expect(res.scannedKeyIds).toEqual([idA, idB].sort()); // ascending by key_id
    expect(res.sealedRows).toBe(3);
    expect(res.failures.map((f) => f.keyId).sort()).toEqual([idA, idB].sort());
  });

  it("assertVaultKey names a diverged PCI_MASTER_KEY_ID as a cause — the key is not always the thing that moved", async () => {
    // #97 review, blocker 3: the packaging change made a LABEL divergence a realistic way to reach
    // this error (a `PCI_MASTER_KEY_ID=  # comment` line seals rows under the comment text; tidying
    // the line later strands them). "Restore the key that sealed this database" is FALSE advice for
    // that state — the key is fine. The message must name the variable and the id to put back.
    const goneId = `kv_gone_${randomUUID()}`;
    const aad = `${SEED_USER}|microsoft|access`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "a-refresh-token", aad);

    const msg = await assertVaultKey({ refs: [ref], keyIds: [goneId] }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(msg).not.toBe(""); // guard: it really did throw
    expect(msg).toContain("PCI_MASTER_KEY_ID");
    // And it says WHICH id to restore, not just that one exists.
    expect(msg).toContain(`set it back to '${goneId}'`);
  });

  it("assertVaultKey throws VaultKeyError naming the ref, the key path and the down -v warning", async () => {
    const goneId = `kv_gone_${randomUUID()}`;
    const aad = `${SEED_USER}|apple|access`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "an-app-specific-password", aad);

    let caught: unknown;
    try {
      await assertVaultKey({ refs: [ref], keyIds: [goneId] });
      throw new Error("expected assertVaultKey to throw");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VaultKeyError);
    const msg = (caught as Error).message;
    expect(msg).toContain(ref);
    expect(msg).toContain(goneId);
    expect(msg).toContain("pci_master_key");
    expect(msg).toContain("down -v");
    expect(msg).toContain("Refusing to start");
  });

  it("the failure message carries no key bytes, plaintext, ciphertext or AAD", async () => {
    const sealingKey = randomBytes(32);
    const plaintext = "super-secret-access-url-not-for-logs";
    const aad = `${SEED_USER}|simplefin|access`;
    const goneId = `kv_gone_${randomUUID()}`;
    const { ref, ciphertext, nonce } = await seedSecret(sealingKey, goneId, plaintext, aad);

    let msg = "";
    try {
      await assertVaultKey({ refs: [ref], keyIds: [goneId] });
      throw new Error("expected assertVaultKey to throw");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(plaintext);
    expect(msg).not.toContain(sealingKey.toString("base64"));
    expect(msg).not.toContain(sealingKey.toString("hex"));
    expect(msg).not.toContain(ciphertext.toString("base64"));
    expect(msg).not.toContain(ciphertext.toString("hex"));
    expect(msg).not.toContain(nonce.toString("hex"));
    expect(msg).not.toContain(aad);
  });

  it("verification never modifies the vault", async () => {
    const live = activeKey();
    const goneId = `kv_gone_${randomUUID()}`;
    const aad = `${SEED_USER}|plaid|access`;
    const good = await seedSecret(live.key, live.keyId, "ok-row", aad);
    const bad = await seedSecret(randomBytes(32), goneId, "bad-row", aad);
    const refs = [good.ref, bad.ref];

    const snapshot = async () =>
      (
        await pool.query(
          `select ref, encode(ciphertext,'hex') as ct, encode(nonce,'hex') as nc, key_id,
                  rotated_at::text as rotated, aad
             from secrets where ref = any($1) order by ref`,
          [refs],
        )
      ).rows;

    const before = await snapshot();
    expect(before).toHaveLength(2); // guard: an empty snapshot would compare nothing to nothing

    await verifyVaultKey({ refs });
    await assertVaultKey({ refs }).catch(() => {}); // throws on the bad row — deliberately ignored

    expect(await snapshot()).toEqual(before);
  });
});

describe("verify.ts is read-only by construction", () => {
  it("contains no insert/update/delete", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./verify.ts", import.meta.url), "utf8").toLowerCase();
    expect(src).not.toMatch(/\binsert\s+into\b/);
    expect(src).not.toMatch(/\bupdate\s+secrets\b/);
    expect(src).not.toMatch(/\bdelete\s+from\b/);
    // Guard: the file was actually read (an empty string passes every assertion above).
    expect(src).toContain("select distinct on (key_id)");
  });
});

/**
 * THE PRODUCTION FALSE POSITIVE, pinned. Added 2026-07-25 after this gate refused to boot a real
 * deployment on its first deploy. Both cases below are shapes that deployment actually held: orphaned
 * blobs left behind by re-consents and rotations (#105 item 1), and a `rotatetest-<uuid>` credential
 * from a rotation test that still referenced a row under a dead `rt-new-…` key id.
 *
 * Neither can make a sync fail — a sync opens the credential of the connector it is running — so
 * neither may refuse a boot. The gate's value is entirely in the case below them: a REAL credential
 * that cannot be opened must still stop the boot.
 */
describe.skipIf(!HAS_DB)("verifyVaultKey scope — orphans must not brick the boot (#105 item 1)", () => {
  it("an unopenable ORPHAN (no credential references it) is out of scope and boots", async () => {
    const goneId = "rt-old-" + randomUUID(); // a key id no key can resolve — a real deploy held several
    const aad = `${SEED_USER}|orphan|access`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "a-superseded-blob", aad, { orphan: true });

    const res = await verifyVaultKey({ refs: [ref] });
    expect(res.sealedRows).toBe(0);
    expect(res.failures).toEqual([]);
    await expect(assertVaultKey({ refs: [ref] })).resolves.toBeUndefined();
  });

  it("an unopenable secret on a credential with NO CONNECTOR is out of scope and boots", async () => {
    // Verbatim the `rotatetest-<uuid>` shape that bricked the 2026-07-25 deploy: an ACTIVE credential
    // referencing a dead key id, with no connector — so nothing will ever try to sync it.
    const goneId = "rt-new-" + randomUUID();
    const aad = `${SEED_USER}|rotatetest|access`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "a-rotation-test-artifact", aad, {
      noConnector: true,
    });

    const res = await verifyVaultKey({ refs: [ref] });
    expect(res.sealedRows).toBe(0);
    expect(res.failures).toEqual([]);
    await expect(assertVaultKey({ refs: [ref] })).resolves.toBeUndefined();
  });

  it("STILL refuses when a credential with a LIVE connector cannot be opened", async () => {
    // The whole point of the gate. Narrowing the scope must not narrow away its reason to exist:
    // this is the restored-wrong-key disaster, and it must remain fail-closed.
    const goneId = "k_" + randomUUID().slice(0, 16);
    const aad = `${SEED_USER}|realprovider|access`;
    const { ref } = await seedSecret(randomBytes(32), goneId, "a-live-credential", aad);

    const res = await verifyVaultKey({ refs: [ref] });
    expect(res.sealedRows).toBe(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.reason).toBe("no_key");
    await expect(assertVaultKey({ refs: [ref] })).rejects.toThrow(VaultKeyError);
  });
});
