// assertVaultOpens() — the fail-closed vault boot gate itself (#97).
//
// WHY THIS FILE IS SEPARATE FROM bootstrap.test.ts. The gate's body is four lines and three spec
// decisions ride on them: the VaultKeyError must PROPAGATE (fail closed), the un-acknowledged-key
// banner must be emitted, and it must go to STDERR because stdout is the MCP protocol channel.
// Pinning all three needs a FRESH module per case — assertVaultOpens memoizes its promise, so one
// module instance can only ever demonstrate one outcome. `vi.resetModules()` is the only way to get
// that, and doing it inside bootstrap.test.ts would fork src/db.ts into two Pool instances (the
// already-captured bootstrap holding one, later `await import("./db.js")` calls getting the other),
// leaving a live pool that afterAll never ends. So the gate lives here, hermetically: db, audit,
// rest and the secrets barrel are all mocked, and this file opens no socket, DB or vault.
//
// The review that forced this file existing at all: replacing the gate's body with
// `void assertVaultKey; void vaultBackupNotice;` — a complete no-op — left the ENTIRE DB-backed
// suite green. index.boot.test.ts mocks ./bootstrap.js wholesale, so it pins index.ts's `await`
// and never the real gate; bootstrap.test.ts never calls it. Nothing tested this. Now these do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted so the two seams keep a STABLE identity across vi.resetModules() — the mock factory below
// is re-invoked on every reset, and inline vi.fn()s would be replaced each time.
const vault = vi.hoisted(() => ({
  assertVaultKey: vi.fn(async (): Promise<void> => {}),
  vaultBackupNotice: vi.fn((): string | null => null),
}));

// bootstrap.ts imports exactly { open, assertVaultKey, vaultBackupNotice } from the secrets barrel.
vi.mock("./secrets/index.js", () => ({
  open: vi.fn(),
  assertVaultKey: vault.assertVaultKey,
  vaultBackupNotice: vault.vaultBackupNotice,
}));
// No database, no audit writer, no REST app: the gate touches none of them, and mocking them keeps
// every re-import in this file free of real handles.
vi.mock("./db.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  awaitDbReady: vi.fn(async () => {}),
  closePool: vi.fn(async () => {}),
}));
vi.mock("./audit/index.js", () => ({ audit: vi.fn() }));
vi.mock("./rest/index.js", () => ({ createRestApp: vi.fn(() => (() => {}) as unknown) }));

// The real error class — the gate must propagate THIS, not some stand-in.
const { VaultKeyError } = await import("./secrets/verify.js");

/** A bootstrap module with a virgin memo, so each case observes the gate's FIRST invocation. */
async function freshGate(): Promise<() => Promise<void>> {
  vi.resetModules();
  const { assertVaultOpens } = await import("./bootstrap.js");
  return assertVaultOpens;
}

/** Silence + record one std stream. Mocked (not pass-through) so a banner never reaches the report. */
function spyOnWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, "write").mockImplementation(() => true);
}
let stderrSpy: ReturnType<typeof spyOnWrite>;
let stdoutSpy: ReturnType<typeof spyOnWrite>;

beforeEach(() => {
  vault.assertVaultKey.mockReset();
  vault.assertVaultKey.mockImplementation(async () => {});
  vault.vaultBackupNotice.mockReset();
  vault.vaultBackupNotice.mockImplementation(() => null);
  stderrSpy = spyOnWrite(process.stderr);
  stdoutSpy = spyOnWrite(process.stdout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertVaultOpens: fail closed (#97)", () => {
  it("propagates the VaultKeyError — a vault the resolved key cannot open refuses the boot", async () => {
    // The mutation: a gate body that swallows (try/catch, `.catch(() => {})`) or never calls
    // assertVaultKey at all. main()'s catch is what turns this into "refusing to start" + exit 1,
    // so the rejection has to leave this function untouched.
    const boom = new VaultKeyError("vault key check FAILED: 12 sealed secret(s) …");
    vault.assertVaultKey.mockRejectedValue(boom);
    const assertVaultOpens = await freshGate();

    await expect(assertVaultOpens()).rejects.toBe(boom);
    expect(vault.assertVaultKey).toHaveBeenCalledTimes(1);
  });

  it("never prints the backup banner after a failure — the refusal is the only output", async () => {
    // A gate that emitted the notice BEFORE (or regardless of) the check would hand the operator a
    // reassuring "your key is here" banner on the exact boot where the key is wrong.
    vault.assertVaultKey.mockRejectedValue(new VaultKeyError("nope"));
    vault.vaultBackupNotice.mockReturnValue("BANNER");
    const assertVaultOpens = await freshGate();

    await expect(assertVaultOpens()).rejects.toBeInstanceOf(VaultKeyError);
    expect(vault.vaultBackupNotice).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("memoizes the rejection — a second call neither re-scans nor re-throws something new", async () => {
    const boom = new VaultKeyError("nope");
    vault.assertVaultKey.mockRejectedValue(boom);
    const assertVaultOpens = await freshGate();

    const first = assertVaultOpens();
    const second = assertVaultOpens();
    await expect(first).rejects.toBe(boom);
    await expect(second).rejects.toBe(boom);
    expect(vault.assertVaultKey).toHaveBeenCalledTimes(1); // one DB scan per process, rejection included
  });
});

describe("assertVaultOpens: the un-acknowledged-key banner (#97)", () => {
  it("emits the banner on STDERR, and writes nothing at all to stdout", async () => {
    // Two mutations, both proved green before this test existed: deleting the emission entirely, and
    // switching it to process.stdout.write. stdout is the MCP stdio protocol channel (src/index.ts) —
    // one stray byte there corrupts every local agent session, and no other test in the repo notices.
    const banner = "[pci-gateway] your vault key at /app/.pci/master.key is NOT backed up";
    vault.vaultBackupNotice.mockReturnValue(banner);
    const assertVaultOpens = await freshGate();

    await assertVaultOpens();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(banner + "\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("checks the vault BEFORE emitting anything — the banner is never the first thing that happens", async () => {
    const order: string[] = [];
    vault.assertVaultKey.mockImplementation(async () => void order.push("verify"));
    vault.vaultBackupNotice.mockImplementation(() => {
      order.push("notice");
      return "BANNER";
    });
    const assertVaultOpens = await freshGate();

    await assertVaultOpens();
    expect(order).toEqual(["verify", "notice"]);
  });

  it("stays silent when there is nothing to say — an acknowledged or env-managed key prints nothing", async () => {
    // The mutation: a hardcoded banner, or `process.stderr.write(String(notice) + "\n")` which would
    // print the literal "null" on every boot of an env-managed key.
    vault.vaultBackupNotice.mockReturnValue(null);
    const assertVaultOpens = await freshGate();

    await assertVaultOpens();

    expect(vault.vaultBackupNotice).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("memoizes success — a second call re-scans nothing and re-prints nothing", async () => {
    vault.vaultBackupNotice.mockReturnValue("BANNER");
    const assertVaultOpens = await freshGate();

    await assertVaultOpens();
    await assertVaultOpens();

    expect(vault.assertVaultKey).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
