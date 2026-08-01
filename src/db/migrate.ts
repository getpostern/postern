// Forward-only migration runner (wave 9B).
//
// Replaces the apply-once `db/schema.sql` + hand-kept `alter` block with an ordered, recorded,
// transactional migrator: a `schema_migrations` table (version/checksum), immutable ordered
// `db/migrations/NNNN_*.sql` files applied one-transaction-each under a session advisory lock, with
// `0001_baseline.sql` = the current schema verbatim (a safe `if not exists` no-op that records
// existing DBs). Forward-only: an edited applied migration is a hard error; there are no down
// migrations. Fail-closed — any error throws so the caller (9A's boot/entrypoint) refuses to start.
//
// Wave 9A imports + calls `runMigrations()` at boot and runs `node dist/db/migrate.js` in the
// container entrypoint. The exported `runMigrations` / `migrationStatus` signatures are frozen
// (they match the mother-pre-staged stub). `db/schema.sql` stays as the raw `db:schema` escape hatch.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import type { ClientBase } from "pg";
import { config } from "../config.js";

// A single constant lock key shared by every replica/boot so concurrent runs serialize and never
// double-apply. Arbitrary but fixed (must fit in a signed 64-bit int for pg_advisory_lock(bigint)).
const ADVISORY_LOCK_KEY = 4_242_042_042;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Locate `db/migrations/` relative to THIS module so it resolves from src/ (tsx) and dist/ (node). */
function migrationsDir(): string {
  return path.resolve(__dirname, "..", "..", "db", "migrations");
}

type MigrationFile = { version: string; name: string; file: string; sql: string; checksum: string };

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Read + parse `NNNN_<slug>.sql` files from `dir`, sorted ascending by numeric prefix. */
function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .map((file): MigrationFile | null => {
      const m = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!m) return null;
      const buf = readFileSync(path.join(dir, file));
      return { version: m[1], name: m[2], file, sql: buf.toString("utf8"), checksum: sha256Hex(buf) };
    })
    .filter((x): x is MigrationFile => x !== null)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

/** Create the applied-state ledger if absent. Lives outside any tracked migration. */
async function ensureMigrationsTable(client: ClientBase): Promise<void> {
  await client.query(
    `create table if not exists schema_migrations (
       version    text primary key,
       name       text,
       checksum   text,
       applied_at timestamptz default now()
     )`,
  );
}

/**
 * Core runner over an already-connected client + a migrations dir. Exported for tests (the public
 * `runMigrations`/`migrationStatus` are thin wrappers that own the connection + the real dir).
 *
 * Algorithm: ensure ledger → advisory lock → read files → checksum-drift guard over applied files →
 * either `--mark-applied` (record one version WITHOUT executing) or apply each pending file in its
 * own BEGIN/exec/COMMIT (a failure rolls back THAT migration; earlier ones stay recorded) → unlock.
 */
export async function applyMigrations(opts: {
  client: ClientBase;
  dir: string;
  markApplied?: string;
}): Promise<{ applied: string[]; alreadyAt: string[] }> {
  const { client, dir, markApplied } = opts;
  await ensureMigrationsTable(client);
  await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    const files = readMigrationFiles(dir);
    const { rows } = await client.query<{ version: string; checksum: string | null }>(
      "select version, checksum from schema_migrations",
    );
    const appliedChecksums = new Map(rows.map((r) => [r.version, r.checksum]));

    // Forward-only guard: an edited already-applied file (checksum drift) is a hard error.
    for (const f of files) {
      if (!appliedChecksums.has(f.version)) continue;
      const stored = appliedChecksums.get(f.version);
      if (stored != null && stored !== f.checksum) {
        throw new Error(
          `migration ${f.version}_${f.name} has changed since it was applied ` +
            `(checksum drift) — applied migrations are immutable; add a new migration instead`,
        );
      }
    }

    // Escape hatch: record a version WITHOUT executing it (e.g. a future non-idempotent baseline
    // an operator applied by hand). The version must correspond to a real migration file.
    if (markApplied != null) {
      const target = files.find((f) => f.version === markApplied);
      if (!target) {
        throw new Error(`--mark-applied: no migration with version "${markApplied}" found in ${dir}`);
      }
      if (appliedChecksums.has(target.version)) {
        return { applied: [], alreadyAt: [target.version] };
      }
      await client.query(
        "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
        [target.version, target.name, target.checksum],
      );
      return { applied: [target.version], alreadyAt: [] };
    }

    const applied: string[] = [];
    const alreadyAt: string[] = [];
    for (const f of files) {
      if (appliedChecksums.has(f.version)) {
        alreadyAt.push(f.version);
        continue;
      }
      try {
        await client.query("begin");
        await client.query(f.sql);
        await client.query(
          "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [f.version, f.name, f.checksum],
        );
        await client.query("commit");
        applied.push(f.version);
      } catch (e) {
        await client.query("rollback");
        throw e; // fail-closed; earlier migrations stay recorded
      }
    }
    return { applied, alreadyAt };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }
}

/**
 * Apply pending migrations against `config.databaseUrl`. Owns a dedicated short-lived connection
 * (not the app pool — runs before 9A's pool tuning matters) and the real `db/migrations/` dir.
 * Fail-closed: throws on any error. Signature is frozen (matches the pre-staged stub).
 */
export async function runMigrations(
  opts?: { markApplied?: string },
): Promise<{ applied: string[]; alreadyAt: string[] }> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    return await applyMigrations({ client, dir: migrationsDir(), markApplied: opts?.markApplied });
  } finally {
    await client.end();
  }
}

/** Applied-vs-pending list for every known migration file (no apply; ledger ensured). */
export async function migrationStatus(): Promise<{ version: string; name: string; applied: boolean }[]> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ version: string }>("select version from schema_migrations");
    const appliedSet = new Set(rows.map((r) => r.version));
    return readMigrationFiles(migrationsDir()).map((f) => ({
      version: f.version,
      name: f.name,
      applied: appliedSet.has(f.version),
    }));
  } finally {
    await client.end();
  }
}

// CLI entry: `node dist/db/migrate.js` (or `tsx src/db/migrate.ts`) → run pending migrations, then
// exit(0|1). `status` lists known migrations; `--mark-applied <version>` is the record-only escape
// hatch. The guard is false on import, so 9A importing runMigrations does not trigger this.
// stderr-only logging; the connection string / secrets are never written to the log.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const main = async (): Promise<void> => {
    if (args[0] === "status") {
      const rows = await migrationStatus();
      for (const r of rows) {
        process.stderr.write(`  [${r.applied ? "applied" : "pending"}] ${r.version}_${r.name}\n`);
      }
      const appliedCount = rows.filter((r) => r.applied).length;
      process.stderr.write(`migrate: ${rows.length} migrations known, ${appliedCount} applied\n`);
      return;
    }
    const markIdx = args.indexOf("--mark-applied");
    let markApplied: string | undefined;
    if (markIdx >= 0) {
      markApplied = args[markIdx + 1];
      if (!markApplied) throw new Error("--mark-applied requires a <version> argument");
    }
    const r = await runMigrations(markApplied != null ? { markApplied } : undefined);
    process.stderr.write(
      `migrate: applied ${r.applied.length} [${r.applied.join(", ")}], already at ${r.alreadyAt.length}\n`,
    );
  };
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`migrate failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
