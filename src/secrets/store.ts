// secrets-table read/write via the shared pool. No crypto, no key resolution here.
// Tokens never live in credential/domain rows — only the opaque `ref` does.

import { pool } from "../db.js";

export interface SecretRow {
  ciphertext: Buffer; // ct || GCM tag
  nonce: Buffer;
  keyId: string;
  aad: string | null;
  userId: string;
}

/** Insert one sealed secret row. */
export async function insertSecret(row: {
  ref: string;
  userId: string;
  ciphertext: Buffer;
  nonce: Buffer;
  keyId: string;
  aad: string;
}): Promise<void> {
  await pool.query(
    `insert into secrets (ref, user_id, ciphertext, nonce, key_id, aad)
     values ($1, $2, $3, $4, $5, $6)`,
    [row.ref, row.userId, row.ciphertext, row.nonce, row.keyId, row.aad],
  );
}

/** Delete one sealed secret row by ref. Idempotent: deleting an absent ref is a no-op. */
export async function deleteSecret(ref: string): Promise<void> {
  await pool.query(`delete from secrets where ref = $1`, [ref]);
}

/** Fetch a sealed secret row by ref, or null if absent. */
export async function selectSecret(ref: string): Promise<SecretRow | null> {
  const res = await pool.query(
    `select ciphertext, nonce, key_id, aad, user_id from secrets where ref = $1`,
    [ref],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    ciphertext: r.ciphertext as Buffer,
    nonce: r.nonce as Buffer,
    keyId: r.key_id as string,
    aad: (r.aad ?? null) as string | null,
    userId: r.user_id as string,
  };
}
