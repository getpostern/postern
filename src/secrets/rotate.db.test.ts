// rotateMasterKey DB round-trip — gated on DATABASE_URL so CI stays green without Postgres.
//
// Uses the REAL pool + the REAL AEAD primitives. Each test seals its fixtures under a UNIQUE pair of
// key ids (so a concurrently-running suite's secrets are never touched) and passes that pair as
// `keyIds`, scoping the rotation to its own rows. We assert against aeadOpen directly — the faithful
// "open under the new key" — plus the secrets row's key_id / rotated_at, because rotateMasterKey is a
// pure crypto+SQL operation that holds both keys locally (it never goes through key.ts's resolver).
//
// Covered (the spec's acceptance criteria):
//   - re-seals every row: key_id === newKeyId, rotated_at set, opens under newKey to the ORIGINAL
//     plaintext; a credential's secret_ref still resolves (no repoint).
//   - idempotent: a re-run skips rows already at newKeyId.
//   - resumable: a simulated mid-rotation crash (a mix of old- and new-key rows) is completed by a re-run.
//   - CLI id derivation (deriveKeyId): the new key id is a STABLE fingerprint of the key bytes, so a
//     second run with the SAME new key recomputes the same id, skips the already-re-keyed rows, and
//     completes the rest — the exact resume the prior random-per-run id broke.
//   - wrong old key -> aeadOpen fails closed (no silent corruption); the rows are left intact.
//   - no key bytes / plaintext appear in any thrown error message.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { aeadSeal, aeadOpen } from "./aead.js";
import { rotateMasterKey, deriveKeyId } from "./rotate.js";
import { pool } from "../db.js";

const HAS_DB = !!process.env.DATABASE_URL;
const SEED_USER = "00000000-0000-0000-0000-000000000001";

// Every secret + credential this suite creates, for teardown (credentials first — FK on secret_ref).
const createdRefs: string[] = [];
const createdProviders: string[] = [];

beforeEach(() => {
  createdRefs.length = 0;
  createdProviders.length = 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (createdProviders.length) {
    await pool.query(`delete from provider_credentials where provider = any($1) and user_id = $2`, [
      createdProviders,
      SEED_USER,
    ]);
  }
  if (createdRefs.length) {
    await pool.query(`delete from secrets where ref = any($1)`, [createdRefs]);
  }
  await pool.end();
});

/** Seal `plaintext` under (`key`,`keyId`) and insert it as a secrets row; returns the opaque ref. */
async function seedSecret(key: Buffer, keyId: string, plaintext: string, aad: string): Promise<string> {
  const ref = "sec_" + randomUUID();
  const { ciphertext, nonce } = aeadSeal(key, Buffer.from(plaintext, "utf8"), aad);
  await pool.query(
    `insert into secrets (ref, user_id, ciphertext, nonce, key_id, aad) values ($1, $2, $3, $4, $5, $6)`,
    [ref, SEED_USER, ciphertext, nonce, keyId, aad],
  );
  createdRefs.push(ref);
  return ref;
}

interface SecretRow {
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  aad: string | null;
  rotated_at: Date | null;
}

async function readSecret(ref: string): Promise<SecretRow> {
  const r = await pool.query(
    `select ciphertext, nonce, key_id, aad, rotated_at from secrets where ref = $1`,
    [ref],
  );
  return r.rows[0] as SecretRow;
}

// Pure (no DB): the CLI's key-id derivation. This is the seam the resume blocker turned on — a STABLE
// id per key, never the key bytes. Runs even without DATABASE_URL.
describe("deriveKeyId (pure)", () => {
  it("is deterministic and key-dependent, and never reveals the key", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(deriveKeyId(a)).toBe(deriveKeyId(a)); // same key -> same id (the property resume relies on)
    expect(deriveKeyId(a)).not.toBe(deriveKeyId(b)); // different keys -> different ids
    expect(deriveKeyId(a)).toMatch(/^k_[0-9a-f]{16}$/); // a short hex fingerprint
    expect(deriveKeyId(a)).not.toContain(a.toString("hex")); // never the key bytes
    expect(deriveKeyId(a)).not.toContain(a.toString("base64"));
  });
});

describe.skipIf(!HAS_DB)("rotateMasterKey (real pool + real AEAD)", () => {
  it("re-seals every row in place: key_id, rotated_at, opens under newKey; credential ref unchanged", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyId = `rt-old-${randomUUID()}`;
    const newKeyId = `rt-new-${randomUUID()}`;

    // three secrets under the old key, each with its own AAD + plaintext
    const secrets = [
      { pt: "simplefin-access-url-token", aad: `${SEED_USER}|simplefin|access` },
      { pt: "ha-long-lived-token", aad: `${SEED_USER}|home_assistant|access` },
      { pt: "whoop-refresh-token", aad: `${SEED_USER}|whoop|refresh` },
    ];
    const refs: string[] = [];
    for (const s of secrets) refs.push(await seedSecret(oldKey, oldKeyId, s.pt, s.aad));

    // a credential row that references the FIRST secret — must survive rotation WITHOUT a repoint
    const provider = `rotatetest-${randomUUID()}`;
    createdProviders.push(provider);
    await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
         values ($1, $2, 'static_token', $3, 'active')`,
      [SEED_USER, provider, refs[0]],
    );

    const res = await rotateMasterKey({ oldKey, oldKeyId, newKey, newKeyId, keyIds: [oldKeyId, newKeyId] });
    expect(res).toEqual({ reSealed: 3, skipped: 0 });

    // every row is now at newKeyId, has rotated_at set, and opens UNDER THE NEW KEY to its original plaintext
    for (let i = 0; i < refs.length; i++) {
      const row = await readSecret(refs[i]);
      expect(row.key_id).toBe(newKeyId);
      expect(row.rotated_at).not.toBeNull();
      const opened = aeadOpen(newKey, row.ciphertext, row.nonce, secrets[i].aad);
      expect(opened.toString("utf8")).toBe(secrets[i].pt);
      // the OLD key can no longer open the re-sealed row (it was genuinely re-keyed)
      expect(() => aeadOpen(oldKey, row.ciphertext, row.nonce, secrets[i].aad)).toThrow();
    }

    // the credential's secret_ref is UNCHANGED — no repoint; it still resolves to a valid, re-keyed row
    const cred = (
      await pool.query(`select secret_ref from provider_credentials where provider = $1 and user_id = $2`, [
        provider,
        SEED_USER,
      ])
    ).rows[0];
    expect(cred.secret_ref).toBe(refs[0]);
    const credRow = await readSecret(cred.secret_ref);
    expect(aeadOpen(newKey, credRow.ciphertext, credRow.nonce, secrets[0].aad).toString("utf8")).toBe(secrets[0].pt);
  });

  it("is idempotent: a re-run re-seals nothing and skips every row already at the new key", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyId = `rt-old-${randomUUID()}`;
    const newKeyId = `rt-new-${randomUUID()}`;

    const aad = `${SEED_USER}|simplefin|access`;
    await seedSecret(oldKey, oldKeyId, "token-a", aad);
    await seedSecret(oldKey, oldKeyId, "token-b", aad);

    const first = await rotateMasterKey({ oldKey, oldKeyId, newKey, newKeyId, keyIds: [oldKeyId, newKeyId] });
    expect(first).toEqual({ reSealed: 2, skipped: 0 });

    // exact same call again — every row is already at newKeyId, so nothing is re-sealed
    const second = await rotateMasterKey({ oldKey, oldKeyId, newKey, newKeyId, keyIds: [oldKeyId, newKeyId] });
    expect(second).toEqual({ reSealed: 0, skipped: 2 });
  });

  it("is resumable: a re-run completes a vault left half-rotated by a simulated crash", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyId = `rt-old-${randomUUID()}`;
    const newKeyId = `rt-new-${randomUUID()}`;
    const aad = `${SEED_USER}|google|refresh`;

    // simulate a crash AFTER two rows were already re-keyed but before the rest: two rows seeded
    // directly under the NEW key/id, three still under the OLD key/id
    const doneRefs = [
      await seedSecret(newKey, newKeyId, "already-1", aad),
      await seedSecret(newKey, newKeyId, "already-2", aad),
    ];
    const pendingRefs = [
      await seedSecret(oldKey, oldKeyId, "pending-1", aad),
      await seedSecret(oldKey, oldKeyId, "pending-2", aad),
      await seedSecret(oldKey, oldKeyId, "pending-3", aad),
    ];

    const res = await rotateMasterKey({ oldKey, oldKeyId, newKey, newKeyId, keyIds: [oldKeyId, newKeyId] });
    // only the three pending rows are re-sealed; the two already-done rows are skipped
    expect(res).toEqual({ reSealed: 3, skipped: 2 });

    // the whole set now opens under the new key, and every row carries newKeyId
    for (const ref of [...doneRefs, ...pendingRefs]) {
      const row = await readSecret(ref);
      expect(row.key_id).toBe(newKeyId);
      expect(() => aeadOpen(newKey, row.ciphertext, row.nonce, aad)).not.toThrow();
    }
  });

  it("CLI id derivation: a second run with the SAME new key resumes a half-rotated vault to completion", async () => {
    // This is the operator-facing blocker, reproduced at the rotateMasterKey seam: the CLI derives the
    // new key id from the new key BYTES (deriveKeyId), so a re-run with the same key reproduces the SAME
    // id. The prior CLI minted a fresh random id every run, so a re-run could neither skip the already-
    // re-keyed rows nor open them under the old key -> it aborted. With a derived id, the re-run skips
    // them and finishes the rest.
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyId = deriveKeyId(oldKey); // exactly what runCli() computes for the old key
    const newKeyId = deriveKeyId(newKey); // exactly what runCli() computes for the new key
    const aad = `${SEED_USER}|microsoft|refresh`;

    expect(deriveKeyId(newKey)).toBe(newKeyId); // a second "run" derives the identical id
    expect(newKeyId).not.toBe(oldKeyId);

    // a crashed FIRST run left one row already re-keyed (under the DERIVED new id) and two still old
    const doneRef = await seedSecret(newKey, newKeyId, "done-1", aad);
    const pendingRefs = [
      await seedSecret(oldKey, oldKeyId, "pending-1", aad),
      await seedSecret(oldKey, oldKeyId, "pending-2", aad),
    ];

    // SECOND run, same new key -> same derived newKeyId: the done row is SKIPPED (never opened under the
    // old key, which would throw + abort), the two pending rows are completed.
    const res = await rotateMasterKey({
      oldKey,
      oldKeyId,
      newKey,
      newKeyId,
      keyIds: [oldKeyId, newKeyId],
    });
    expect(res).toEqual({ reSealed: 2, skipped: 1 });

    // a THIRD run is a clean no-op — every row is now at the derived new id
    const again = await rotateMasterKey({
      oldKey,
      oldKeyId,
      newKey,
      newKeyId,
      keyIds: [oldKeyId, newKeyId],
    });
    expect(again).toEqual({ reSealed: 0, skipped: 3 });

    for (const ref of [doneRef, ...pendingRefs]) {
      const row = await readSecret(ref);
      expect(row.key_id).toBe(newKeyId);
      expect(() => aeadOpen(newKey, row.ciphertext, row.nonce, aad)).not.toThrow();
    }
  });

  it("fails closed on a wrong old key: aeadOpen throws, no row is corrupted, nothing leaks", async () => {
    const oldKey = randomBytes(32);
    const wrongKey = randomBytes(32); // NOT the key the rows were sealed under
    const newKey = randomBytes(32);
    const oldKeyId = `rt-old-${randomUUID()}`;
    const newKeyId = `rt-new-${randomUUID()}`;
    const aad = `${SEED_USER}|simplefin|access`;
    const plaintext = "super-secret-access-url";

    const ref = await seedSecret(oldKey, oldKeyId, plaintext, aad);

    // rotate with the WRONG old key — must reject (GCM tag/AAD mismatch), not silently corrupt
    let caught: unknown;
    try {
      await rotateMasterKey({ oldKey: wrongKey, oldKeyId, newKey, newKeyId, keyIds: [oldKeyId, newKeyId] });
      throw new Error("expected rotateMasterKey to throw on a wrong old key");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);

    // no key bytes / plaintext appear in the thrown error message
    const msg = (caught as Error).message;
    expect(msg).not.toContain(plaintext);
    expect(msg).not.toContain(oldKey.toString("base64"));
    expect(msg).not.toContain(oldKey.toString("hex"));
    expect(msg).not.toContain(wrongKey.toString("base64"));
    expect(msg).not.toContain(wrongKey.toString("hex"));
    expect(msg).not.toContain(newKey.toString("base64"));
    expect(msg).not.toContain(newKey.toString("hex"));

    // the row is UNTOUCHED: still at oldKeyId, never re-keyed, and still opens under the REAL old key
    const row = await readSecret(ref);
    expect(row.key_id).toBe(oldKeyId);
    expect(row.rotated_at).toBeNull();
    expect(aeadOpen(oldKey, row.ciphertext, row.nonce, aad).toString("utf8")).toBe(plaintext);
  });

  it("refuses a rotation whose old and new key ids are identical", async () => {
    const key = randomBytes(32);
    const sameId = `rt-same-${randomUUID()}`;
    await expect(
      rotateMasterKey({ oldKey: key, oldKeyId: sameId, newKey: randomBytes(32), newKeyId: sameId }),
    ).rejects.toThrow(/must differ/);
  });
});
