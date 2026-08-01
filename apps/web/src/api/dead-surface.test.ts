// The REST client is a FROZEN surface, which is exactly how it accumulates methods nobody calls.
// Four did: `plaidLinkToken` / `plaidExchange` (superseded by the hosted-link flow), `oauthStart`
// (superseded by `oauthAuthorizationUrl`), and `unconfirmDedupMerge` (no UI ever offered
// reverse-a-merge). Each still typechecked, still had a route, and still read as part of the
// contract — dead code that costs nothing to keep and everything to trust.
//
// So the sweep is a test, not a one-off audit: the next unused method is caught the day it lands
// rather than found by the next reader. This scans SOURCE rather than importing, because a call
// site is a textual fact about the tree and there is no computed `api[name]` access anywhere in
// the Console (verified: `grep -rnE '\b(styles|shared|s)\['` and its api equivalent return zero).

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, ".."); // apps/web/src
const CLIENT = join(HERE, "client.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments are prose about the surface, not use of it — `oauthStart` was NAMED in three doc
 *  comments while having zero callers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every method declared on `interface RestClient`, in declaration order. */
function restClientMethods(): string[] {
  const src = readFileSync(CLIENT, "utf8");
  const iface = /export interface RestClient \{([\s\S]*?)\n\}/.exec(src);
  expect(iface).not.toBeNull();
  return [...stripComments(iface![1]).matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
}

const isTest = (f: string): boolean => /\.test\.(ts|tsx)$/.test(f);

/** Files that could hold a call site: the whole tree except the client's own declaration. */
function consumers(opts: { includeTests: boolean }): string[] {
  return walk(SRC_ROOT).filter((f) => f !== CLIENT && (opts.includeTests || !isTest(f)));
}

function withoutCallSite(methods: string[], files: string[]): string[] {
  const sources = files.map((f) => stripComments(readFileSync(f, "utf8")));
  return methods.filter((m) => {
    const call = new RegExp(`\\.${m}\\s*\\(`);
    return !sources.some((s) => call.test(s));
  });
}

// Methods with a REAL route and no PRODUCTION caller yet. Each is a designed state with a named owner,
// NOT dead code — and each has to be deleted from this list the day a page wires it up, because the
// failure is the reminder.
//
//   describeContext — the seam LANDED (commit 8529bd3 serves it at `/api/operator/context`) and the
//     client is repointed, but NOTHING renders it yet. Its natural surface is the Gatehouse or
//     Settings ("what an agent sees when it looks at this gate"), which is outside the page groups
//     that wired its two siblings. That is the whole of why it is still here.
//
// THREE ENTRIES WERE REMOVED 2026-07-26 because the reminder fired and it was right — this test failed
// the moment their surfaces landed, which is exactly what it exists to do. Each was verified by call
// site before deletion rather than by assuming the unit that claimed it had finished:
//   getSchema  — `pages/inspector/InspectorPage.tsx:170` (the schema disclosure that replaced the
//                struck-through, permanently-disabled "View schema" control, #82)
//   fetchLive  — `pages/inspector/RecordDrillPage.tsx:58` (the per-record live drill, #57)
//   auditPage  — `pages/records/LedgerPage.tsx:117` (the ledger's keyset walk, #61)
//
// `listActions` is deliberately NOT here: it has production callers, and after the catalog shape fix
// (#58) they are compile-checked against the served envelope rather than reading `.length` off it.
const AWAITING_A_UI = ["describeContext"];

describe("the Console's REST surface carries no dead methods", () => {
  it("the REST client exposes no method without a call site", () => {
    const methods = restClientMethods();
    // A regex that silently matched nothing would make every assertion below vacuously true.
    expect(methods.length).toBeGreaterThan(30);
    expect(new Set(methods).size).toBe(methods.length);

    expect(withoutCallSite(methods, consumers({ includeTests: true }))).toEqual([]);
  });

  it("the only methods no PRODUCTION file calls are the ones awaiting a UI, exactly", () => {
    const orphans = withoutCallSite(restClientMethods(), consumers({ includeTests: false }));
    expect([...orphans].sort()).toEqual([...AWAITING_A_UI].sort());
  });

  it("scans the whole tree, so a new page cannot hide a call site from it", () => {
    const files = consumers({ includeTests: true });
    expect(files.length).toBeGreaterThan(100);
    // and the client itself is the ONE excluded file — its declarations are not call sites
    expect(files.map((f) => relative(SRC_ROOT, f))).not.toContain(join("api", "client.ts"));
  });
});
