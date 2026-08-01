// Unit coverage for the two globalSetup preflights (vitest.globalSetup.ts). DB-free — the test-DB
// guard is called with controlled env objects and the Console-deps guard with throwaway trees, never
// the real process.env / the real repo (except one deliberate cell that pins the default root), so
// they run everywhere.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import setup, {
  assertDisposableTestDb,
  dbNameFromUrl,
  assertConsoleDepsInstalled,
  CONSOLE_INSTALL_COMMAND,
  PREFLIGHTS,
  runPreflights,
  preflightsExecuted,
} from "./vitest.globalSetup.js";

describe("dbNameFromUrl", () => {
  it("parses the db name from a plain URL", () => {
    expect(dbNameFromUrl("postgres://pci:pci@localhost:5432/pci_test")).toBe("pci_test");
  });

  it("parses through userinfo + port + ?sslmode=require", () => {
    expect(dbNameFromUrl("postgres://pci:pci@localhost:5432/pci_test?sslmode=require")).toBe(
      "pci_test",
    );
  });

  it("parses a non-test db name", () => {
    expect(dbNameFromUrl("postgres://pci:pci@localhost:5432/pci")).toBe("pci");
  });
});

describe("assertDisposableTestDb", () => {
  it("is a no-op when DATABASE_URL is unset (DB tests self-skip via HAS_DB)", () => {
    expect(assertDisposableTestDb({})).toBeNull();
  });

  it("allows a db name ending in _test", () => {
    expect(
      assertDisposableTestDb({ DATABASE_URL: "postgres://pci:pci@localhost:5432/pci_test" }),
    ).toBe("pci_test");
  });

  it("allows _test case-insensitively", () => {
    expect(
      assertDisposableTestDb({ DATABASE_URL: "postgres://pci:pci@localhost:5432/PCI_TEST" }),
    ).toBe("PCI_TEST");
  });

  it("allows a non-test db name when PCI_TEST_DB=1 (escape hatch)", () => {
    expect(
      assertDisposableTestDb({
        DATABASE_URL: "postgres://pci:pci@localhost:5432/scratch",
        PCI_TEST_DB: "1",
      }),
    ).toBe("scratch");
  });

  it("throws on a non-test db name without the flag", () => {
    expect(() =>
      assertDisposableTestDb({ DATABASE_URL: "postgres://pci:pci@localhost:5432/pci" }),
    ).toThrow();
  });

  it("throws even through ?sslmode=require on a non-test name", () => {
    expect(() =>
      assertDisposableTestDb({
        DATABASE_URL: "postgres://pci:pci@localhost:5432/pci_notatest?sslmode=require",
      }),
    ).toThrow(/pci_notatest/);
  });

  it("names the offending db in the error but NEVER leaks the password (pci:pci) or the URL", () => {
    let message = "";
    try {
      assertDisposableTestDb({ DATABASE_URL: "postgres://pci:pci@localhost:5432/pci" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("pci"); // the db name is present
    expect(message).not.toContain("pci:pci"); // the password is NOT
    expect(message).not.toContain("postgres://"); // the full URL is NOT
    expect(message).not.toContain("localhost:5432"); // host:port is NOT
  });
});

// ── The Console-deps preflight (#94) ─────────────────────────────────────────────
//
// A throwaway tree stands in for the repo root: apps/web/package.json declares packages, and
// apps/web/node_modules either has them or does not. Nothing here touches the real apps/web.

describe("assertConsoleDepsInstalled", () => {
  let root: string;
  const consoleDir = (): string => path.join(root, "apps", "web");

  /** Write apps/web/package.json into the throwaway root. */
  const declare = (manifest: Record<string, unknown>): void => {
    mkdirSync(consoleDir(), { recursive: true });
    writeFileSync(path.join(consoleDir(), "package.json"), JSON.stringify(manifest), "utf8");
  };

  /**
   * Install apps/web/node_modules/<name> the way npm leaves it: a directory WITH its own manifest.
   * The stub matters — a fixture that only mkdirs reproduces the tree an INTERRUPTED `npm ci` leaves
   * behind, not a real install, and a guard tested only against that fixture certifies a tree that
   * still dies on "Cannot find package 'react'". Scoped names are a nested directory, hence split.
   */
  const install = (...names: string[]): void => {
    for (const name of names) {
      const dir = path.join(consoleDir(), "node_modules", ...name.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
    }
  };

  /** The tree an interrupted install leaves: the package directory exists and is EMPTY. */
  const installHalfway = (...names: string[]): void => {
    for (const name of names) {
      mkdirSync(path.join(consoleDir(), "node_modules", ...name.split("/")), { recursive: true });
    }
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pci-console-deps-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when there is no apps/web under the root (nothing to check)", () => {
    expect(assertConsoleDepsInstalled(root)).toBeNull();
  });

  it("is a no-op when apps/web declares no dependencies at all", () => {
    declare({ name: "@pci/console" });
    expect(assertConsoleDepsInstalled(root)).toBeNull();
  });

  it("passes when every DECLARED package (deps AND devDeps, scoped included) is installed", () => {
    declare({
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { "@testing-library/react": "^16.3.2", jsdom: "^27.0.1" },
    });
    install("react", "react-dom", "@testing-library/react", "jsdom");
    expect(assertConsoleDepsInstalled(root)).toEqual([
      "react",
      "react-dom",
      "@testing-library/react",
      "jsdom",
    ]);
  });

  it("throws naming the missing package AND the fix command when node_modules is absent", () => {
    declare({ dependencies: { react: "^18.3.1" } });
    let message = "";
    expect(() => {
      try {
        assertConsoleDepsInstalled(root);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow();
    expect(message).toContain("react");
    // The whole point of the guard: the sentence carries the command that fixes it.
    expect(message).toContain(CONSOLE_INSTALL_COMMAND);
    expect(CONSOLE_INSTALL_COMMAND).toBe("npm ci --prefix apps/web");
  });

  it("throws when node_modules exists but a declared package is missing from it (partial install)", () => {
    declare({ dependencies: { react: "^18.3.1" }, devDependencies: { jsdom: "^27.0.1" } });
    install("react"); // jsdom never installed
    expect(() => assertConsoleDepsInstalled(root)).toThrow(/jsdom/);
  });

  it("throws when a SCOPED declared package is missing even though its scope directory exists", () => {
    // Anti-vacuity: a check that only looked at the "@testing-library" segment would pass here.
    declare({ devDependencies: { "@testing-library/react": "^16.3.2" } });
    mkdirSync(path.join(consoleDir(), "node_modules", "@testing-library", "dom"), {
      recursive: true,
    });
    expect(() => assertConsoleDepsInstalled(root)).toThrow(/@testing-library\/react/);
  });

  it("counts every missing package, not just the first", () => {
    declare({ dependencies: { react: "^1", "react-dom": "^1", "react-router-dom": "^1" } });
    expect(() => assertConsoleDepsInstalled(root)).toThrow(/3 of 3 declared/);
  });

  it("throws when the package directories exist but are EMPTY (interrupted npm ci)", () => {
    // The exact tree a Ctrl-C'd `npm ci` leaves: 11 named directories, nothing inside them. A guard
    // that checked bare directory existence returned "OK" here and the run then died on
    // "Cannot find package 'react'" WITH the guard having certified the tree.
    declare({
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { "@testing-library/react": "^16.3.2", jsdom: "^27.0.1" },
    });
    installHalfway("react", "react-dom", "@testing-library/react", "jsdom");
    expect(() => assertConsoleDepsInstalled(root)).toThrow(/4 of 4 declared/);
  });

  it("throws when ONE package is empty and the rest are real (a partially interrupted install)", () => {
    declare({ dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" } });
    install("react");
    installHalfway("react-dom");
    expect(() => assertConsoleDepsInstalled(root)).toThrow(/react-dom/);
  });

  it("tolerates a leading UTF-8 BOM on apps/web/package.json (npm's own reader strips one)", () => {
    // A BOM is a manifest npm installs from happily, so it must not brick every test entry path with
    // a raw JSON SyntaxError naming neither the file nor a fix.
    mkdirSync(consoleDir(), { recursive: true });
    writeFileSync(
      path.join(consoleDir(), "package.json"),
      "\uFEFF" + JSON.stringify({ dependencies: { react: "^18.3.1" } }),
      "utf8",
    );
    install("react");
    expect(assertConsoleDepsInstalled(root)).toEqual(["react"]);
  });

  it("a genuinely malformed manifest throws NAMING the manifest path, not a bare SyntaxError", () => {
    mkdirSync(consoleDir(), { recursive: true });
    writeFileSync(path.join(consoleDir(), "package.json"), '{"dependencies": {,}', "utf8");
    let message = "";
    expect(() => {
      try {
        assertConsoleDepsInstalled(root);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow();
    expect(message).toContain(path.join(consoleDir(), "package.json"));
    expect(message).toContain("Could not parse");
  });

  // The default-root cell. Without it the guard could resolve its root to the wrong place, return
  // null on every real run, and be perfectly green while checking nothing. It asserts against THIS
  // repo: `react` is declared by apps/web and installed by `npm ci --prefix apps/web`, so a red
  // here means either the root resolution broke or the Console deps really are missing — and in the
  // latter case globalSetup has already aborted the run with the same message.
  it("defaults to the repo root — it finds THIS repo's apps/web and its installed react", () => {
    expect(assertConsoleDepsInstalled()).toContain("react");
  });
});

// ── The WIRING — the property that has no other witness ──────────────────────────
//
// Both guards can be perfect and the suite still unguarded: before these cells, deleting
// `assertConsoleDepsInstalled()` from the globalSetup entry point left the whole suite green. A guard
// nothing calls is a guard that does not exist, and "every run pays it" is the entire claim.

describe("the globalSetup entry point runs BOTH preflights, destructive one first", () => {
  let root: string;

  /** A throwaway root whose apps/web is a REAL install, so the Console preflight passes on it. */
  const goodRoot = (): string => {
    const consoleDir = path.join(root, "apps", "web");
    mkdirSync(consoleDir, { recursive: true });
    writeFileSync(
      path.join(consoleDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.3.1" } }),
      "utf8",
    );
    const pkgDir = path.join(consoleDir, "node_modules", "react");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react" }));
    return root;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pci-preflights-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("declares exactly the two preflights, with the destructive one FIRST", () => {
    expect(PREFLIGHTS.map((p) => p.name)).toEqual([
      "assertDisposableTestDb",
      "assertConsoleDepsInstalled",
    ]);
    // Not decoration: if the deps guard ran first, a run pointed at a real database would abort on
    // "install apps/web" and the reader would fix the wrong thing while the DB risk stayed unstated.
    expect(PREFLIGHTS.findIndex((p) => p.destructive)).toBe(0);
  });

  it("runs both, in order, on a clean env and a real-looking tree", () => {
    expect(runPreflights({}, goodRoot())).toEqual([
      "assertDisposableTestDb",
      "assertConsoleDepsInstalled",
    ]);
    expect(preflightsExecuted()).toEqual([
      "assertDisposableTestDb",
      "assertConsoleDepsInstalled",
    ]);
  });

  it("aborts on the DESTRUCTIVE guard first when BOTH would fail", () => {
    // Both preflights are unsatisfiable here: a live-looking DB name AND an uninstalled Console. The
    // message must be the data-loss one, and the deps guard must never have been reached. This is the
    // ordering witness — a swap of the two entries reddens it.
    expect(() =>
      runPreflights({ DATABASE_URL: "postgres://pci:pci@localhost:5432/pci" }, root),
    ).toThrow(/Refusing to run the test suite against database "pci"/);
    expect(preflightsExecuted()).toEqual(["assertDisposableTestDb"]);
  });

  it("the DEFAULT EXPORT — the function vitest actually calls — runs both of them", () => {
    // POISON THE WITNESS FIRST, or this cell cannot fail: `preflightsExecuted()` is last-run state,
    // so a setup() that ran nothing would still report whatever a sibling cell left behind. After
    // this the witness reads ["assertDisposableTestDb"] only.
    expect(() =>
      runPreflights({ DATABASE_URL: "postgres://pci:pci@localhost:5432/pci" }, root),
    ).toThrow();
    expect(preflightsExecuted()).toEqual(["assertDisposableTestDb"]);

    // Now drive it exactly as vitest does — no arguments, real process.env, real repo root, both of
    // which pass in any run that got as far as loading this file.
    setup();
    expect(preflightsExecuted()).toEqual([
      "assertDisposableTestDb",
      "assertConsoleDepsInstalled",
    ]);
  });

  it("reads the REAL process.env, not the GlobalSetupContext vitest hands it", () => {
    // The trap this pins, measured on vitest 3.2.6 by logging `arguments` inside setup(): vitest
    // calls the default export with exactly ONE argument, a context object ({ provide, config }, or
    // the whole TestProject). Give setup() a defaulted `env` parameter and that object arrives as the
    // env — DATABASE_URL reads undefined, assertDisposableTestDb returns null, and the destructive
    // guard is silently disarmed on every real run while every other cell here stays green. So: point
    // the REAL env at a live-looking database, call setup() the way vitest does, require the abort.
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://pci:pci@localhost:5432/pci";
    try {
      expect(() =>
        (setup as unknown as (ctx: unknown) => void)({ provide: () => {}, config: {} }),
      ).toThrow(/Refusing to run the test suite against database "pci"/);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });
});
