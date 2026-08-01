// THE regression guard for #65 and #91 — the two surfaces, one input, one pair of numbers.
//
// Both issues are the same bug shipping twice: the Gatehouse said "Eleven sources connected" (a
// CONNECTION count wearing the provider noun) while the Sources page, one click away, said "7
// providers · 11 connections". Neither surface was internally inconsistent, which is why every test
// either had passed — the defect only exists BETWEEN them. So this file renders the same fixture
// through both sentence builders and compares what they say.
//
// The fixture is deliberately LOPSIDED — three providers, five credentials, seven connections, plus a
// revoked row — because the numbers coinciding is exactly what hid this: the Gatehouse's own fixture
// gave every connector `credentialId: "cred_fixture"` and one connection per provider.
//
// MUTATIONS this file catches (each verified red):
//  · `verdictLead` naming `counts.connections` in the sources slot
//  · `sourcesSummary` tallying credentials, or groups, instead of providers
//  · either surface filtering revoked rows differently from the other
//  · a SECOND number-word speller, or a second distinct-provider tally, appearing anywhere

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveConnectors, numberWord, sourceCounts } from "./grain";
import { connectorsOf, groupConnectors, sourcesSummary } from "./model";
import { verdictLead } from "../gatehouse/helpers";
import type { ConnectorStatus } from "../../api/types";

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    credentialId: "cred-1",
    provider: "apple",
    sector: "mail",
    status: "active",
    last_synced_at: null,
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    ...over,
  };
}

/** Three providers · five credentials · seven live connections · one revoked row. */
const SERVED: ConnectorStatus[] = [
  conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
  conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
  conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
  conn({ connectionId: "p-1", provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
  conn({ connectionId: "p-2", provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
  conn({ connectionId: "p-3", provider: "plaid", sector: "finance", credentialId: "plaid-c" }),
  conn({ connectionId: "w-1", provider: "whoop", sector: "health", credentialId: "whoop-1" }),
  conn({ connectionId: "g-dead", provider: "gmail", sector: "mail", credentialId: "g-1", status: "revoked" }),
];

/** What the Gatehouse masthead's sub-line leads with, over the served list. */
function gatehouseLead(cs: ConnectorStatus[]): string {
  return verdictLead(sourceCounts(liveConnectors(cs)));
}

/** What the Sources masthead's sentence leads with, over the same served list. */
function sourcesSentence(cs: ConnectorStatus[]): string {
  return sourcesSummary(groupConnectors(liveConnectors(cs))).sentence;
}

describe("the Gatehouse and Sources name the same two numbers on the same input (#65 / #91)", () => {
  it("both sentences carry both grains, and the two grains differ", () => {
    const gate = gatehouseLead(SERVED);
    const sources = sourcesSentence(SERVED);

    const g = /^(\S+) sources? · (\S+) connections?$/.exec(gate);
    const s = /^(\S+) connections? behind (\S+) providers?,/.exec(sources);
    // Not optional chaining: if either sentence stops naming both grains, that IS the regression.
    expect(g, `gatehouse lead did not name both grains: ${gate}`).not.toBeNull();
    expect(s, `sources sentence did not name both grains: ${sources}`).not.toBeNull();

    const gateSources = g![1].toLowerCase();
    const gateConnections = g![2].toLowerCase();
    const sourcesConnections = s![1].toLowerCase();
    const sourcesProviders = s![2].toLowerCase();

    // THE cross-surface assertion: the Gatehouse's "sources" is the Sources page's "providers", and
    // the two connection counts are one number. Compared surface-to-surface, not each to a literal —
    // two independent literals is how both surfaces can be wrong and both cells still green.
    expect(gateSources).toBe(sourcesProviders);
    expect(gateConnections).toBe(sourcesConnections);

    // …and they are the SERVED tally, spelled — so agreeing on a wrong number cannot pass either.
    const counts = sourceCounts(liveConnectors(SERVED));
    expect(gateSources).toBe(numberWord(counts.sources));
    expect(gateConnections).toBe(numberWord(counts.connections));

    // The fixture's whole point: if these were equal, every assertion above would survive a grain swap.
    expect(counts.sources).not.toBe(counts.connections);
    expect(counts.sources).toBe(3);
    expect(counts.connections).toBe(7);
  });

  it("the revoked row is out of BOTH counts, not one", () => {
    // Sharing a tally is worthless while each surface picks its own input. One `liveConnectors`, and
    // this cell dies the moment either surface stops calling it.
    expect(gatehouseLead(SERVED)).toBe("Three sources · seven connections");
    expect(sourcesSentence(SERVED).startsWith("Seven connections behind three providers")).toBe(true);
    // Gmail is the revoked one — neither surface may count it as a fourth source.
    expect(gatehouseLead(SERVED)).not.toContain("four");
  });

  it("grouping is a PARTITION of the served rows, so the page's path cannot lose one", () => {
    // The Sources page tallies through its groups; the Gatehouse tallies the flat list. That only
    // stays one number while grouping keeps every row exactly once.
    const live = liveConnectors(SERVED);
    const grouped = connectorsOf(groupConnectors(live));
    expect(grouped).toHaveLength(live.length);
    expect(new Set(grouped.map((c) => c.connectionId))).toEqual(
      new Set(live.map((c) => c.connectionId)),
    );
    expect(sourceCounts(grouped)).toEqual(sourceCounts(live));
  });
});

// ── there is ONE tally and ONE speller in the app ─────────────────────────────
//
// Same shape as `api/one-clock.test.ts`, for the same reason: three implementations that agree today
// is the mechanism, not the symptom. #65 was patched on one surface and came back as #91 on another.

const SRC = fileURLToPath(new URL("../..", import.meta.url)); // apps/web/src

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments first: prose ABOUT a tally is not a tally, and counting it makes a guard cry wolf on its
 *  own documentation. */
function code(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = walk(SRC)
  .map((f) => relative(SRC, f).replaceAll("\\", "/"))
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

/** The one grain module (its final home is `api/grain.ts` — see its header). */
const CANONICAL = "pages/sources/grain.ts";

/**
 * The distinct-provider tally that survives outside the grain module: `lensmeta.providerCount`, the
 * third of the three copies #91 names. It is a SECTOR-scoped count of the same grain, and it is still
 * here because `pages/lenses/` was outside the file set of the unit that closed #91 — collapsing it
 * is `sourceCounts(sectorConnectors).sources` and the deletion of one function.
 *
 * Deleting this entry is the last step of #91. Adding a fourth is the defect.
 */
const RESIDUAL_TALLIES = ["pages/lenses/lensmeta.ts"];

describe("one tally, one speller", () => {
  it("nothing but the grain module (and the named residual) counts distinct providers", () => {
    // A distinct-provider COUNT specifically: `[...new Set(...provider)]` used as a NAME list (the
    // lens's institution run) is not a second answer to "how many sources", so the guard does not
    // fire on it.
    const tallies = FILES.filter((f) => /new Set\([^;]*\.provider\b[^;]*\)\.size/.test(code(f)));
    // Deliberately a SUBSET check rather than exact equality: collapsing the residual is the last step
    // of #91, and that step must not have to touch this cell to go green. What may never happen is a
    // FOURTH tally, and that is what this asserts.
    expect(tallies.filter((f) => f !== CANONICAL && !RESIDUAL_TALLIES.includes(f))).toEqual([]);
    // …and the canonical one is still here: without this, deleting `sourceCounts` outright would pass.
    expect(tallies).toContain(CANONICAL);
  });

  it("there is exactly ONE number-word speller", () => {
    // Two of them disagreed above nine — the Gatehouse spelled to ninety-nine, the Sources view-model
    // to nine — which is how one masthead clause came to read "24 connections behind seven providers".
    const spellers = FILES.filter((f) => /"zero"\s*,\s*"one"/.test(code(f)));
    expect(spellers).toEqual([CANONICAL]);
  });
});
