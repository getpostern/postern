// Destructive actions use the typed in-app ConfirmBar; there is NO window.confirm / alert / prompt
// anywhere in the Console (#70, law 7). This grep test walks the whole apps/web/src tree — EVERY
// file, with no exemption of any kind — and fails if a browser dialog appears in one.
//
// It used to skip `pages/**` as "the condemned old surface phase 3 deletes". Phase 3 deleted that
// surface; `pages/**` is now the entire Console, so the exemption was silently skipping 87 of 137
// files — 63% of the app, including every page that owns a destructive action. Three of its four
// branches named directories (`components/`, `theme/`, `nav.ts`) that no longer exist at all.
// Removing it goes green as it stands, which is the whole point: the guard was passing because it
// was not looking.
//
// The regex absorbed the two stricter forms `pages/connect/no-dialog.test.ts` used to carry before
// it was folded in here: `\b` catches the method-call form `x.confirm(` (the old `[^.\w]` lead
// rejected it), and `\s*` catches `confirm (` with a space. The third difference — that file did
// not strip comments — is deliberately NOT adopted: a dialog inside a comment is not a dialog,
// because commented code does not run, so stripping can only remove false positives, never hide an
// offence.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, ".."); // apps/web/src

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// Case-sensitive, so `onConfirm(` / `setConfirm(` never match. `\b` DOES match the method form
// `toast.confirm(`, which is the strictness folded in from the connect group's guard. `\s*` allows
// the space in `confirm (`. `(?!#)` excludes an issue reference like `window.confirm (#70)` in a
// test title or a string — `(#` cannot begin an argument list, so nothing real is let through.
const DIALOG = /\b(?:window\.)?(?:confirm|alert|prompt)\s*\((?!#)/;

/** Strip comments so prose about the ban never counts as a call. The URL guard (`[^:]` before
 *  `//`) keeps `https://` inside a string from eating the rest of its line. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function scan(): { walked: number; scanned: number; offenders: string[] } {
  const files = walk(srcRoot);
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of files) {
    scanned += 1;
    const src = stripComments(readFileSync(file, "utf8"));
    if (DIALOG.test(src)) offenders.push(relative(srcRoot, file));
  }
  return { walked: files.length, scanned, offenders };
}

describe("no browser dialogs in the Console (#70)", () => {
  it("no source file calls a browser dialog, anywhere in the tree", () => {
    expect(scan().offenders).toEqual([]);
  });

  // The bug this prevents is not a dialog — it is a guard that stops looking. An exemption list is
  // invisible in a green run, so the only way it fails loudly is to assert the arithmetic: every
  // file the walk finds is a file the scan reads. Re-introducing ANY `continue` breaks this.
  it("the guard scans every file under src — no exemptions, including itself", () => {
    const { walked, scanned } = scan();
    expect(scanned).toBe(walked);
    // and the walk is finding a real tree, not an empty one
    expect(walked).toBeGreaterThan(100);
  });

  // The two forms the folded-in connect guard was stricter about. Neither can regress silently now.
  // The positive probes are ASSEMBLED rather than written out, so this file is a clean citizen of
  // the scan above — the alternative is an exemption, and an exemption is the bug being fixed.
  const probe = (fn: string, lead = "", gap = ""): string => `${lead}${fn}${gap}("x")`;

  it("catches the method-call and spaced forms the old lead-character regex let through", () => {
    expect(DIALOG.test(probe("confirm", "toast."))).toBe(true);
    expect(DIALOG.test(probe("confirm", "", " "))).toBe(true);
    expect(DIALOG.test(probe("alert", "window."))).toBe(true);
    expect(DIALOG.test(probe("prompt"))).toBe(true);
    // and still does not fire on the app's own typed confirm surface, or on an issue reference
    expect(DIALOG.test("onConfirm(x)")).toBe(false);
    expect(DIALOG.test("setConfirm({ kind: 'revoke' })")).toBe(false);
    expect(DIALOG.test("never window.confirm (#70)")).toBe(false);
  });
});
