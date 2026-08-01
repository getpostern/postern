// Fail-closed test-DB guard. Vitest runs this default-exported function ONCE, before any test
// module loads (configured as test.globalSetup in vitest.config.ts). It makes it structurally
// impossible for the suite to run against a non-disposable database: many DB-gated suites mutate
// and DELETE rows (admin.db.test.ts deletes seed-user credentials, FK-cascading domain rows), so a
// run pointed at the live "pci" database is a data-loss incident — exactly the 2026-06-17
// finance-wipe (700 finance rows). See docs/specs/decisions/0015-test-db-isolation.md.
//
// SAFETY: the thrown message names the offending DB *name only* — never the full DATABASE_URL or
// the password it carries. Nothing here logs the URL.
//
// It carries a SECOND, non-destructive preflight: assertConsoleDepsInstalled. Root vitest collects
// apps/web's *.test.tsx files but root `npm ci` does not install apps/web's deps, so a fresh clone
// or a fresh worktree turns one missing install step into ~29 red Console suites reporting
// "Cannot find package 'react'" — a setup problem wearing a dependency bug's costume, and the
// mis-read that let CI stay red for 50 consecutive runs (#94). Same pattern as the DB guard: one
// sentence carrying the fix command, and no env bypass.
//
// REACH — stated as the shipped topology actually has it, not as the stronger thing it is tempting
// to claim. BOTH preflights run on every entry path that resolves the ROOT vitest config: `npm test`,
// `npx vitest` (run or watch) from the repo root, `npm run test:db` / `test:db:file`, an IDE runner
// pointed at the root, and a worktree — which is a repo root of its own. They do NOT run when vitest
// resolves a DIFFERENT config: `cd apps/web && npx vitest run <file>` loads apps/web/vite.config.ts,
// which declares no globalSetup, so neither this file nor the destructive-DB guard is even imported.
// That gap is deliberately NOT closed here — wiring globalSetup into the Console's build config is a
// change to apps/web's config surface, decided outside this file. Do not upgrade this paragraph back
// to "every entry path": an asserted property the topology does not have is binding-in-error
// (CLAUDE.md § "A spec is falsifiable, never binding-in-error").

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, derived from THIS file's own location rather than process.cwd() — vitest may be
 * invoked from anywhere (a worktree, an IDE, a subdirectory with --root) and the guard must still
 * look at the right apps/web.
 */
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The one command that installs the Console's own dependencies. Named in the thrown message. */
export const CONSOLE_INSTALL_COMMAND = "npm ci --prefix apps/web";

/**
 * Extract the database name from a Postgres connection URL: the last non-empty path segment, with
 * any leading "/" and trailing "?query" stripped. Dependency-free (WHATWG URL).
 */
export function dbNameFromUrl(databaseUrl: string): string {
  // URL.pathname never carries the query string (that lives on URL.search), so userinfo, port and
  // ?sslmode=... fall away automatically.
  const { pathname } = new URL(databaseUrl);
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  // Defensive: drop a stray "?query" if some non-standard input ever leaves one on the segment.
  return last.split("?")[0];
}

/**
 * The guard rule (fail-closed):
 *   - DATABASE_URL unset            -> null  (no-op; DB-gated tests self-skip via HAS_DB)
 *   - db name matches /_test$/i     -> allow (returns the name)
 *   - PCI_TEST_DB === '1'           -> allow (explicit escape hatch)
 *   - otherwise                     -> throw, naming the offending DB + the remedy
 *
 * The thrown message includes the DB NAME but NEVER the full DATABASE_URL or its password.
 */
export function assertDisposableTestDb(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DATABASE_URL;
  if (!url) return null; // no DB configured — DB-gated suites self-skip via HAS_DB

  const dbName = dbNameFromUrl(url);

  if (/_test$/i.test(dbName)) return dbName; // disposable by naming convention
  if (env.PCI_TEST_DB === "1") return dbName; // explicit operator override

  throw new Error(
    `Refusing to run the test suite against database "${dbName}": it is not a disposable test DB. ` +
      `The suite mutates and DELETEs rows and would corrupt real data (the 2026-06-17 finance-wipe). ` +
      `Point DATABASE_URL at a database whose name ends in "_test" (e.g. pci_test), or set ` +
      `PCI_TEST_DB=1 to override. Never run the suite against the live application database.`,
  );
}

/**
 * Preflight: the Console (`apps/web`) is a separate npm project with its own lockfile, but root
 * vitest collects its `*.test.tsx` files — so its dependencies must be installed for a root run to
 * mean anything. Checks every package `apps/web/package.json` DECLARES (deps + devDeps, which is
 * exactly what `npm ci --prefix apps/web` installs) against `apps/web/node_modules`, so the guard
 * follows the manifest instead of a hardcoded package list that would rot.
 *
 * FS existence, not module resolution: `require.resolve` of a types-only or `exports`-restricted
 * package fails for reasons that are not "missing install", and this guard must never be the thing
 * that turns a green tree red. But the thing whose existence is checked is the package's OWN
 * `package.json`, not the bare directory: an INTERRUPTED `npm ci` leaves empty
 * `apps/web/node_modules/<pkg>/` directories behind, and a bare-directory check certifies exactly
 * that tree — 11 empty directories pass, and the run then dies on "Cannot find package 'react'" with
 * this guard having already said the install was fine. Every npm-installed package has a manifest at
 * its root by definition, so this is still pure existence, one path deeper.
 *
 *   - no `apps/web/package.json` under this root -> null (nothing to check; not an error)
 *   - `apps/web/package.json` unparseable        -> throw, naming the manifest path (a leading
 *                                                  UTF-8 BOM is stripped first, because npm's own
 *                                                  manifest reader tolerates one and so a
 *                                                  BOM-prefixed file is a manifest npm considers
 *                                                  legal — it must not brick every test entry path)
 *   - nothing declared                           -> null
 *   - every declared package present             -> the names it verified
 *   - anything missing or empty                  -> throw, naming the count, examples, and the fix
 *
 * NO env bypass, deliberately: this repo already has the `PCI_TEST_DB` lesson about escape hatches,
 * and unlike the DB guard the remedy here costs ~1 s.
 */
export function assertConsoleDepsInstalled(root: string = REPO_ROOT): string[] | null {
  const consoleDir = path.join(root, "apps", "web");
  const manifestPath = path.join(consoleDir, "package.json");
  if (!existsSync(manifestPath)) return null; // no Console project under this root — nothing to check

  // npm's own manifest reader strips a leading BOM, so a BOM-prefixed package.json is a file npm
  // installs from happily. JSON.parse does not: it throws a bare SyntaxError naming neither the file
  // nor a remedy, and because this runs in globalSetup that error would abort EVERY test entry path
  // with no clue what to fix. Strip the BOM, and rethrow anything genuinely malformed WITH the path.
  const raw = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  let manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch (e) {
    throw new Error(
      `Could not parse the Console's manifest at ${manifestPath}: ${(e as Error).message}. ` +
        `This preflight reads it to learn which packages must be installed under ` +
        `apps/web/node_modules, so an unparseable manifest aborts every test run. Fix the JSON in ` +
        `that file (a leading UTF-8 BOM is tolerated and stripped; anything else here is a real ` +
        `syntax error at the reported position), then re-run.`,
    );
  }
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  if (declared.length === 0) return null;

  // Scoped names ("@testing-library/react") are a nested directory, hence the split. The trailing
  // "package.json" is what distinguishes a real install from an interrupted one (see above).
  const missing = declared.filter(
    (name) =>
      !existsSync(path.join(consoleDir, "node_modules", ...name.split("/"), "package.json")),
  );
  if (missing.length === 0) return declared;

  const examples = missing.slice(0, 3).join(", ");
  const more = missing.length > 3 ? `, +${missing.length - 3} more` : "";
  throw new Error(
    `The Console's dependencies are not installed: apps/web/node_modules is missing ` +
      `${missing.length} of ${declared.length} declared package(s) (${examples}${more}) — absent, ` +
      `or present as an empty directory left by an interrupted install. ` +
      `Root vitest collects apps/web's *.test.tsx files, so without them every Console suite dies ` +
      `on "Cannot find package 'react'" — a missing install step, not a dependency bug. ` +
      `Run: ${CONSOLE_INSTALL_COMMAND} (or "npm run setup" from the repo root). ` +
      `Do NOT excuse it by excluding apps/web from vitest.config.ts: that drops real tests.`,
  );
}

/**
 * The preflights, IN THE ORDER THEY RUN. Ordered data rather than two bare calls in `setup()` so the
 * wiring itself has a witness: before this existed, deleting `assertConsoleDepsInstalled()` from the
 * entry point left the whole suite green — the guard's entire value is that EVERY run pays it, and
 * that was the one property nothing tested (this repo's signature defect).
 *
 * `destructive: true` marks the guard whose absence risks DATA LOSS rather than a confusing red run.
 * It must be first: if a run is pointed at a real database, the abort has to happen before anything
 * else can fail for a lesser reason and send the reader chasing the wrong fix.
 */
export const PREFLIGHTS: ReadonlyArray<{
  readonly name: string;
  readonly destructive: boolean;
  readonly run: (env: NodeJS.ProcessEnv, root: string) => unknown;
}> = [
  { name: "assertDisposableTestDb", destructive: true, run: (env) => assertDisposableTestDb(env) },
  {
    name: "assertConsoleDepsInstalled",
    destructive: false,
    run: (_env, root) => assertConsoleDepsInstalled(root),
  },
];

/** Names of the preflights the most recent runPreflights() reached, in order (partial on a throw). */
let executed: readonly string[] = [];

/**
 * What the last runPreflights() actually executed, in order. The witness a test needs: `setup()` is
 * the function vitest calls, and nothing else can observe from the outside whether it ran one guard,
 * both, or neither.
 */
export function preflightsExecuted(): readonly string[] {
  return executed;
}

/**
 * Run every preflight, in order, aborting on the first failure. Split out from the default export so
 * a test can drive it with a throwaway env and root — and so vitest's own argument to globalSetup can
 * never be mistaken for one. Measured on vitest 3.2.6 by logging `arguments` inside `setup()`: vitest
 * calls the default export with EXACTLY ONE argument, a context object — `{ provide, config }` on one
 * path and the whole TestProject (`{ vitest, globalConfig, provide, … }`) on another. Neither is an
 * env, so a defaulted `env` parameter THERE would silently receive that object, read `DATABASE_URL`
 * off it as undefined, and turn the destructive-DB guard into a permanent no-op. That is why
 * `setup()` below takes no parameters — and why a test pins it (vitest.globalSetup.test.ts).
 */
export function runPreflights(
  env: NodeJS.ProcessEnv = process.env,
  root: string = REPO_ROOT,
): readonly string[] {
  const ran: string[] = [];
  executed = ran; // live handle: a throw still leaves the partial record readable
  for (const preflight of PREFLIGHTS) {
    ran.push(preflight.name);
    preflight.run(env, root);
  }
  return ran;
}

/**
 * Vitest globalSetup entry: runs once before any test module. Fail-closed — aborts the whole run.
 * Takes NO parameters on purpose (see runPreflights): vitest passes a GlobalSetupContext here.
 */
export default function setup(): void {
  runPreflights();
}
