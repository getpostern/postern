// Test-only cross-worker serialization for singleton DB tables (#38). Vitest's parallel forks share
// the ONE *_test database, so suites that `delete from` a one-row table (plaid_app,
// oauth_provider_apps) race each other and flake. A SESSION-level Postgres advisory lock — not
// `_xact`, because the hold spans many statements across a suite — serializes the contenders; the
// key string is hashed server-side via hashtext(), the same idiom as src/db/migrate.ts.
//
// Hygiene: hold ONE key per suite. If a suite ever needs TWO keys, acquire them in SORTED order at
// every call site (classic deadlock avoidance) and release in reverse; never interleave
// acquisitions across keys. Imported ONLY from *.test.ts files.

/**
 * Acquire the named test-resource lock on a pinned pool client; returns the release fn
 * (`pg_advisory_unlock` + `client.release()`, idempotent under double-call). When
 * `process.env.DATABASE_URL` is unset (DB-free run) it resolves immediately to an async no-op
 * releaser — callers never need their own gate.
 */
export async function lockTestResource(name: string): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) {
    return async () => {};
  }
  const { pool } = await import("../db.js");
  // A pinned client: advisory locks are session-scoped, so the SAME connection must hold the lock
  // for the whole suite and issue the unlock — a pool.query() could land on any connection.
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [name]);
  } catch (err) {
    client.release();
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [name]);
    } finally {
      client.release();
    }
  };
}
