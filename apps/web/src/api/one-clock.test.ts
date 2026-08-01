// A regression guard, not a style check.
//
// The Console had THREE relative-time implementations that disagreed (`pages/overview/helpers.ts`
// `relativeTime`, `pages/connections/helpers.ts` `relTime`, `pages/inspector/format.tsx`
// `relativeTime`) — so the same connection read "4m ago" on one surface and "just now" on the next.
// `api/format.ts` is now the one clock.
//
// Phase 3 has deleted the old pages, so the allow-list is now EMPTY: `api/format.ts` is the only
// relative-time implementation in the app, and a SECOND one anywhere in `apps/web/src` fails the
// build. (The list was the three pre-revamp copies — overview/helpers, connections/helpers,
// inspector/format — each of which died with its page group.)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url)); // apps/web/src

/** Empty since phase 3 — the three pre-revamp copies were deleted with their page groups. */
const LEGACY_CLOCKS: string[] = [];

/** The one clock. */
const CANONICAL = "api/format.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * What a relative-time implementation looks like, matched on its OUTPUT rather than its arithmetic
 * (the four copies divide differently — `Math.floor(s / 60)`, `Math.round(abs / 60_000)`, `m / 60`
 * — so pinning the arithmetic misses three of them and gives false confidence).
 *
 * A relative-time renderer is the thing that MINTS the string "… ago". Anything that only *shows*
 * one gets it from the one clock.
 */
function mintsRelativeTime(source: string): boolean {
  // Comments are stripped first: prose about relative time ("retrying · since 5m ago") is not an
  // implementation of it, and counting it would make the guard cry wolf on documentation.
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // The rendered suffix, in a string or template literal: `${x} ago`, "2m ago", ' ago'.
  const rendersAgo = /(\}|\w)\s?ago["'`]/.test(src) || /["'`]\s?ago["'`]/.test(src);
  // …combined with a duration bucket, so a lone copy string is not a false positive.
  const bucketsDuration =
    /\b(60_?000|3_?600_?000|86_?400_?000)\b/.test(src) ||
    /\/\s*(60|3600|86_?400)\b/.test(src);
  return rendersAgo && bucketsDuration;
}

describe("there is exactly ONE relative-time implementation (the rest are the phase-3 graveyard)", () => {
  const files = walk(SRC)
    .map((f) => relative(SRC, f).replaceAll("\\", "/"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  const withClock = files.filter((f) => mintsRelativeTime(readFileSync(join(SRC, f), "utf8")));

  it("the detector is not vacuous — it finds the canonical clock (a regex matching nothing would pass everything)", () => {
    expect(withClock).toContain(CANONICAL);
    // and every named legacy survivor, while any remain (empty since phase 3).
    for (const legacy of LEGACY_CLOCKS) expect(withClock).toContain(legacy);
  });

  it("the canonical clock is api/format.ts", () => {
    expect(withClock).toContain(CANONICAL);
  });

  it("no clock exists outside the canonical one and the named legacy survivors", () => {
    const unexpected = withClock.filter((f) => f !== CANONICAL && !LEGACY_CLOCKS.includes(f));
    expect(unexpected).toEqual([]);
  });

  it("nothing under api/ carries a second clock", () => {
    const inApi = withClock.filter((f) => f.startsWith("api/"));
    expect(inApi).toEqual([CANONICAL]);
  });

  it("exactly four exist today — one canonical plus the three condemned", () => {
    // The number only goes DOWN. Phase 3 deletes the page groups; drop each entry from
    // LEGACY_CLOCKS as it goes, rather than leaving a dead allowance behind.
    expect(withClock.length).toBe(1 + LEGACY_CLOCKS.length);
  });
});

describe("no native destructive dialogs anywhere in the app (#70)", () => {
  // The typed in-app ConfirmBar is the only destructive confirm. `window.confirm` cannot be styled,
  // cannot state a blast radius, and cannot offer export-first. The kit lands in 1c-B; the ban is
  // enforced from here so it is already true when the kit arrives.
  const files = walk(SRC)
    .map((f) => relative(SRC, f).replaceAll("\\", "/"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("api/** is free of window.confirm / alert / prompt", () => {
    const offenders = files
      .filter((f) => f.startsWith("api/"))
      .filter((f) => /\bwindow\.(confirm|alert|prompt)\s*\(/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
