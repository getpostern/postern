// Forward-only migrator round-trip — gated on DATABASE_URL so CI stays green without Postgres.
//
// Drives the real `applyMigrations` core (the connection-owning `runMigrations`/`migrationStatus`
// are thin wrappers over it) against EPHEMERAL databases it creates + drops, so no scenario touches
// the shared per-unit DB.
//
// THIS FILE IS THE SUITE'S SECOND `create database` (#114 — the first is scripts/test-db.sh). Two
// rules bind, and both were violated until 2026-07-26:
//
//  1. EVERY name it creates ENDS IN `_test` (see `ephemeralDbName`). The old names (`pci_mig_t_<ms>_<n>`)
//     did not, which made them invisible to every `_test`-shaped sweep AND — the sharp consequence —
//     tripped scripts/test-db.sh's SAFETY (c) cluster scan, which REFUSES to run at all when the
//     cluster holds a database that is not `postgres`, a template or a `*_test`. So one SIGKILLed run
//     of this file bricked the whole DB gate until someone reaped the container by hand. The same name
//     would also make `assertDisposableTestDb` refuse a run pointed at one, which is safe but
//     confusing: these databases ARE disposable and must say so in their name.
//  2. They are dropped by their creator (`afterAll`) AND swept by the next run (`sweepLeftovers`),
//     because `afterAll` cannot run when a run is SIGKILLed. The sweep is deliberately CONSERVATIVE:
//     it only drops a database whose name carries THIS host's tag and a pid that is no longer alive,
//     and which currently has no sessions attached. Concurrent runs are the normal case here (several
//     worktrees share one throwaway cluster), and dropping a sibling's in-use database would be a new
//     flake in someone else's gate — strictly worse than the leftover it cleans up.
//
// Residual, stated rather than hidden: a run killed between `create database` and the drop leaves its
// database until the NEXT run of this file sweeps it, or until the throwaway container is reaped
// (`npm run test:db:reap`) — its storage is a tmpfs, so nothing survives that.
//
// Proves the spec's acceptance criteria:
//   - FRESH DB: applies 0001 + records it; a re-run is a no-op (applied: []).
//   - EXISTING DB (tables present, no schema_migrations row): 0001 runs as a safe no-op + is recorded.
//   - A pending 0002 applies in its own transaction + records; a FAILING 0002 rolls back fully and
//     leaves schema_migrations at 0001 (no partial table, no 0002 row).
//   - CHECKSUM DRIFT: editing an applied file makes a re-run throw (forward-only guard).
//   - ADVISORY LOCK: two concurrent runs serialize — exactly one applies, no double-apply, no throw.
//   - --mark-applied records a version WITHOUT executing its SQL.
//   - runMigrations/migrationStatus wrappers work against the configured DB.
//   - CLI: `node … migrate.ts` exits 0 on success, non-zero on failure (fail-closed).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations, runMigrations, migrationStatus } from "./migrate.js";

const HAS_DB = !!process.env.DATABASE_URL;
const baseUrl = process.env.DATABASE_URL ?? "";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const realMigrationsDir = path.join(repoRoot, "db", "migrations");
const migrateScript = path.join(testDir, "migrate.ts");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function urlWithDb(db: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}
const adminUrl = (): string => urlWithDb("postgres");

let dbCounter = 0;
const createdDbs: string[] = [];
const tempDirs: string[] = [];

/**
 * A stable, short tag for THIS machine. The sweep uses it to refuse to reason about a leftover it
 * cannot attribute: a pid is only meaningful on the host that issued it, and several hosts can share
 * one throwaway cluster (a container talking to the host's Postgres). Leftovers from another host are
 * left alone — bounded accumulation beats dropping a live sibling's database.
 */
const HOST_TAG = createHash("sha256").update(hostname()).digest("hex").slice(0, 8);

/**
 * `pci_mig_<host>_<pid>_<seq>_test` — the `_test` suffix is what makes it visible to the guard and to
 * any sweep (see the header); the host+pid is what makes staleness decidable. Kept well inside
 * Postgres's 63-byte identifier limit.
 */
function ephemeralDbName(): string {
  return `pci_mig_${HOST_TAG}_${process.pid}_${dbCounter++}_test`;
}

/** Matches only names this file creates on THIS host, capturing the creating pid. */
const LEFTOVER_RE = new RegExp(`^pci_mig_${HOST_TAG}_(\\d+)_\\d+_test$`);

/** Is a process from this host still running? EPERM means "alive but not ours" — treat as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Drop databases this file leaked on a previous, KILLED run of this host. Conservative by design: a
 * name must carry this host's tag, a pid that is no longer alive, and have no sessions attached.
 * Anything else — another host's leftovers, a live sibling run, a differently shaped name — is left
 * exactly where it is. Best-effort: a sweep failure must never fail the suite it is tidying up for.
 */
async function sweepLeftovers(): Promise<string[]> {
  const dropped: string[] = [];
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string; sessions: number }>(
      `select d.datname,
              (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as sessions
         from pg_database d
        where not d.datistemplate and d.datname like 'pci\\_mig\\_%\\_test'`,
    );
    for (const { datname, sessions } of rows) {
      const pid = Number(LEFTOVER_RE.exec(datname)?.[1]);
      if (!Number.isInteger(pid)) continue; // another host, or a name we do not own
      if (pid === process.pid || pidAlive(pid)) continue; // ours-in-flight, or a live sibling run
      if (sessions > 0) continue; // something is attached; not ours to judge
      try {
        await admin.query(`drop database if exists "${datname}" with (force)`);
        dropped.push(datname);
      } catch {
        /* best-effort: a racing sweep may have dropped it first */
      }
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

async function createEphemeralDb(): Promise<string> {
  const name = ephemeralDbName();
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  createdDbs.push(name);
  return urlWithDb(name);
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function makeTempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pci-mig-"));
  tempDirs.push(d);
  return d;
}
function writeFixture(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content, "utf8");
}

const BASELINE = "-- test baseline\ncreate table if not exists mig_test_base (id int);\n";
const GOOD_0002 = "create table if not exists mig_test_0002 (id int);\n";
const BAD_0002 = "create table mig_test_should_rollback (id int);\nthis is not valid sql;\n";
const SLOW_0002 = "select pg_sleep(0.4);\ncreate table if not exists mig_test_slow (id int);\n";

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const { rows } = await c.query("select to_regclass($1) as r", [`public.${table}`]);
  return rows[0].r !== null;
}
async function appliedVersions(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ version: string }>(
    "select version from schema_migrations order by version asc",
  );
  return rows.map((r) => r.version);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // Clean up after a PREVIOUS killed run before adding more (#114). Best-effort by construction: the
  // suite's job is the migrator, not the housekeeping, so a sweep that cannot connect must not fail it.
  try {
    const dropped = await sweepLeftovers();
    if (dropped.length > 0) {
      process.stderr.write(`[migrate.db.test] swept ${dropped.length} leftover test database(s)\n`);
    }
  } catch {
    /* best-effort */
  }
}, 60_000);

afterAll(async () => {
  for (const name of createdDbs) {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } catch {
      /* best-effort cleanup */
    } finally {
      await admin.end();
    }
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe.skipIf(!HAS_DB)("forward-only migrator", () => {
  it("FRESH DB: applies 0001 (real baseline) + records it; re-run is a no-op", async () => {
    const url = await createEphemeralDb();
    await withClient(url, async (c) => {
      const r1 = await applyMigrations({ client: c, dir: realMigrationsDir });
      expect(r1.applied).toContain("0001");
      expect(r1.alreadyAt).toEqual([]);
      expect(await appliedVersions(c)).toContain("0001");
      expect(await tableExists(c, "users")).toBe(true); // baseline actually executed

      const r2 = await applyMigrations({ client: c, dir: realMigrationsDir });
      expect(r2.applied).toEqual([]);
      expect(r2.alreadyAt).toContain("0001");
    });
  }, 30000);

  it("EXISTING DB (tables, no schema_migrations row): 0001 is a safe no-op + gets recorded", async () => {
    const url = await createEphemeralDb();
    const baselineSql = readFileSync(path.join(realMigrationsDir, "0001_baseline.sql"), "utf8");
    await withClient(url, async (c) => {
      // Simulate a pre-existing DB: tables created out-of-band, NO schema_migrations row.
      await c.query(baselineSql);
      expect(await tableExists(c, "users")).toBe(true);
      const { rows: before } = await c.query("select to_regclass('public.schema_migrations') as r");
      expect(before[0].r).toBeNull(); // ledger does not exist yet

      const r = await applyMigrations({ client: c, dir: realMigrationsDir });
      expect(r.applied).toContain("0001"); // run-and-record: no-op exec, then recorded
      expect(await appliedVersions(c)).toContain("0001");
      expect(await tableExists(c, "users")).toBe(true); // still there, untouched
    });
  }, 30000);

  it("pending 0002 applies in its own transaction + records", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "0001_baseline.sql", BASELINE);
    writeFixture(dir, "0002_add_thing.sql", GOOD_0002);
    const url = await createEphemeralDb();
    await withClient(url, async (c) => {
      const r = await applyMigrations({ client: c, dir });
      expect(r.applied).toEqual(["0001", "0002"]);
      expect(await appliedVersions(c)).toEqual(["0001", "0002"]);
      expect(await tableExists(c, "mig_test_0002")).toBe(true);
    });
  }, 30000);

  it("a FAILING 0002 rolls back fully and leaves schema_migrations at 0001", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "0001_baseline.sql", BASELINE);
    writeFixture(dir, "0002_broken.sql", BAD_0002);
    const url = await createEphemeralDb();
    await withClient(url, async (c) => {
      await expect(applyMigrations({ client: c, dir })).rejects.toThrow();
      expect(await appliedVersions(c)).toEqual(["0001"]); // 0002 not recorded
      expect(await tableExists(c, "mig_test_should_rollback")).toBe(false); // rolled back
      expect(await tableExists(c, "mig_test_base")).toBe(true); // 0001 stayed committed
    });
  }, 30000);

  it("CHECKSUM DRIFT: editing an applied file makes a re-run throw (forward-only)", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "0001_baseline.sql", BASELINE);
    const url = await createEphemeralDb();
    await withClient(url, async (c) => {
      const r = await applyMigrations({ client: c, dir });
      expect(r.applied).toEqual(["0001"]);

      // Mutate the already-applied file — its checksum no longer matches the recorded one.
      writeFixture(dir, "0001_baseline.sql", BASELINE + "-- edited after apply\n");
      await expect(applyMigrations({ client: c, dir })).rejects.toThrow(/drift|changed|immutable/i);
    });
  }, 30000);

  it("ADVISORY LOCK: two concurrent runs serialize — exactly one applies 0002, no double-apply", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "0001_baseline.sql", BASELINE);
    const url = await createEphemeralDb();
    // Seed 0001 (also creates the ledger) so the race is purely over the pending 0002.
    await withClient(url, async (c) => {
      await applyMigrations({ client: c, dir });
    });
    writeFixture(dir, "0002_slow.sql", SLOW_0002);

    const a = new pg.Client({ connectionString: url });
    const b = new pg.Client({ connectionString: url });
    await a.connect();
    await b.connect();
    try {
      const [ra, rb] = await Promise.all([
        applyMigrations({ client: a, dir }),
        applyMigrations({ client: b, dir }),
      ]);
      // Neither call threw (the lock prevented a PK-conflict double-insert).
      const appliedBoth = [...ra.applied, ...rb.applied];
      expect(appliedBoth.filter((v) => v === "0002")).toEqual(["0002"]); // applied exactly once
      const { rows } = await a.query("select count(*)::int as n from schema_migrations where version = '0002'");
      expect(rows[0].n).toBe(1);
      expect(await tableExists(a, "mig_test_slow")).toBe(true);
    } finally {
      await a.end();
      await b.end();
    }
  }, 30000);

  it("--mark-applied records a version WITHOUT executing its SQL", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "0001_baseline.sql", BASELINE);
    const url = await createEphemeralDb();
    await withClient(url, async (c) => {
      const r = await applyMigrations({ client: c, dir, markApplied: "0001" });
      expect(r.applied).toEqual(["0001"]);
      expect(await appliedVersions(c)).toEqual(["0001"]); // recorded
      expect(await tableExists(c, "mig_test_base")).toBe(false); // NOT executed

      const r2 = await applyMigrations({ client: c, dir, markApplied: "0001" });
      expect(r2.applied).toEqual([]);
      expect(r2.alreadyAt).toEqual(["0001"]);
    });
  }, 30000);

  it("runMigrations/migrationStatus wrappers work against the configured DB", async () => {
    // Wrappers use config.databaseUrl (the per-unit test DB, which already has the domain tables).
    const r = await runMigrations();
    expect(Array.isArray(r.applied)).toBe(true);
    expect(Array.isArray(r.alreadyAt)).toBe(true);

    const status = await migrationStatus();
    const baseline = status.find((s) => s.version === "0001");
    expect(baseline).toBeDefined();
    expect(baseline?.applied).toBe(true);

    const r2 = await runMigrations();
    expect(r2.applied).not.toContain("0001"); // already applied by the first call
    expect(r2.alreadyAt).toContain("0001");
  }, 30000);

  it("CLI: exits 0 on success and non-zero on failure (fail-closed)", async () => {
    const url = await createEphemeralDb();
    const ok = spawnSync(process.execPath, [tsxCli, migrateScript], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);

    // A database that does not exist -> connect fails -> fail-closed non-zero exit. The name still
    // ends in `_test`: nothing creates it, but every DATABASE_URL this file constructs names a
    // disposable database, so a reader never has to ask whether this one is safe.
    const fail = spawnSync(process.execPath, [tsxCli, migrateScript, "status"], {
      env: { ...process.env, DATABASE_URL: urlWithDb("pci_does_not_exist_xyz_test") },
      encoding: "utf8",
    });
    expect(fail.status).not.toBe(0);
  }, 60000);
});
