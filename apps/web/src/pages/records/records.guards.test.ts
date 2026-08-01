// The source-scan guards the records group owns:
//   #72 — the dead ⌘K command box is GONE, not hidden: the new shell simply never draws it (it lived
//         only in the old dark-SaaS `components/Shell.tsx`, which phase 3 deletes). Verified by
//         scanning the NEW shell + this group's pages for the glyph. Nothing else covers this law.
//   the focus ring survives the ledger's decision toggle — a clipping container is a stylesheet
//         fact, so it is asserted against the stylesheet (jsdom has no cascade and no layout, and
//         a screenshot may never source a value).
//   `aria-pressed` never rides an unconditionally disabled control — a TREE-WIDE scan, because the
//         pattern reached two page groups independently and a per-page test would have caught
//         neither before it shipped.
//
// The #70 no-browser-dialog block that used to live here is GONE, not moved: it was a byte-level
// duplicate of the kit's guard, and its own header stated the gap it closed — that the kit guard
// skipped ALL of `pages/**`. The kit guard no longer skips anything, so this directory is covered
// by it directly and a second copy could only drift.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/src/pages/records
const srcRoot = join(here, "..", ".."); // apps/web/src
const shellDir = join(srcRoot, "shell");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#72 — the ⌘K box is gone from the new shell (and never in records)", () => {
  it("no command-palette glyph in the RENDERED code of the new shell or records", () => {
    const offenders: string[] = [];
    for (const file of [...walk(shellDir), ...walk(here)]) {
      if (file.endsWith("records.guards.test.ts")) continue; // names the glyph in prose
      // Strip comments so a doc line ABOUT the removed box (like this file's own) never trips it —
      // the point is that nothing DRAWS it.
      const src = stripComments(readFileSync(file, "utf8"));
      if (src.includes("⌘K") || src.includes("⌘ K")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the decision toggle does not clip its segments' focus ring", () => {
  const ledgerCss = readFileSync(join(here, "LedgerPage.module.css"), "utf8");
  const baseCss = readFileSync(join(srcRoot, "styles", "base.css"), "utf8");

  it("`.toggle` expands its clip box out to where the one global ring ends", () => {
    // `overflow: clip` clips at the padding edge and an outline never joins scrollable overflow, so
    // a segment flush against that edge had its whole ring cut away — All/Admitted/Denied were
    // keyboard-reachable and invisibly focused. Read the ring's reach from base.css rather than
    // hard-coding 5, so changing the ring cannot silently outgrow the clip margin.
    //
    // It must be `overflow-clip-margin`, NOT padding. The segments are drawn flush to the border so
    // the radius crops them; padding floats `.segActive`'s fill inside with square corners and cuts
    // `.segDivider` short — re-drawing artboard 2WI-0 to buy a ring. `overflow-clip-margin` expands
    // the clip region and moves nothing, and is valid here precisely because this box clips with
    // `clip` rather than `auto`. Rejected at review 2026-07-25; asserted so it cannot come back.
    const width = Number(/:focus-visible\s*\{[^}]*outline:\s*(\d+)px/.exec(baseCss)![1]);
    const offset = Number(/:focus-visible\s*\{[^}]*outline-offset:\s*(\d+)px/.exec(baseCss)![1]);

    const block = /\.toggle\s*\{([^}]*)\}/.exec(ledgerCss)![1];
    expect(block).toMatch(/overflow:\s*clip/);
    expect(Number(/overflow-clip-margin:\s*(\d+)px/.exec(block)![1])).toBeGreaterThanOrEqual(
      width + offset,
    );
    expect(block).not.toMatch(/(^|[^-])padding:/);
  });

  it("does not re-declare the ring locally instead", () => {
    // base.css: a component that re-declares the one ring is drift; one that removes it is a defect.
    expect(ledgerCss).not.toMatch(/outline\s*:/);
  });
});

describe("a toggle that can never be toggled is not a toggle", () => {
  // Settings drew Light / Night / System, with Night and System `disabled` and all three carrying
  // `aria-pressed`. A screen reader announced three toggle buttons in a group where two could not
  // be pressed and the third had no onClick — a value display wearing a toggle's clothes. Agent
  // detail had the same shape and was fixed by dropping the toggle semantics for `aria-current`
  // (AgentDetailPage.tsx); Settings' was fixed by deleting the control, because the mode it named
  // was never designed (build-notes §17.0). The law is tree-wide so the pattern cannot reappear on
  // a third surface.
  //
  // What is flagged is the STATICALLY always-disabled case — a bare `disabled` or `disabled={true}`
  // — beside `aria-pressed`. A genuine toggle passed `disabled={someExpression}` (SectorToggle, the
  // cadence Chip) is correct ARIA and stays: the promise it makes to assistive tech is one the DOM
  // keeps as soon as the expression is false.
  const srcFiles = walk(srcRoot).filter((f) => /\.tsx$/.test(f));

  /** Attributes of every JSX opening tag in `src`, as one flat string per element. */
  function openingTags(src: string): string[] {
    // `[^<>]` cannot cross a `>` — and the commonest attribute value in this codebase is an arrow
    // function, so `<button onClick={() => setMode("night")} aria-pressed disabled>` was truncated
    // at the arrow's own `>` and everything after it was invisible to the scan. The guard was green
    // against the most realistic shape of the very bug it exists to catch. Neutralise the arrow
    // before matching. Caught at review 2026-07-25.
    const noArrows = src.replace(/=>/g, "=");
    return [...noArrows.matchAll(/<[A-Za-z][^<>]*?\/?>/g)].map((m) => m[0]);
  }

  /** The offending tags in one source string — shared by the tree scan and the vacuity probe. */
  function offendingTags(src: string): string[] {
    return openingTags(stripComments(src)).filter((tag) => {
      if (!/\baria-pressed\b/.test(tag)) return false;
      // A VALUELESS `disabled` attribute (or an explicit `{true}`) — never `disabled={expr}`.
      // The leading-whitespace and trailing `\s / >` anchors are what keep `disabled={disabled}`
      // out: its inner identifier is preceded by `{`, and its outer attribute is followed by `=`.
      return /\sdisabled(?=[\s/>])/.test(tag) || /\sdisabled\s*=\s*\{true\}/.test(tag);
    });
  }

  it("no element carries `aria-pressed` and an unconditional `disabled` together", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      if (file.endsWith("records.guards.test.ts")) continue;
      for (const tag of offendingTags(readFileSync(file, "utf8"))) {
        offenders.push(`${file}: ${tag.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("and the law is not vacuous — synthetic offenders ARE caught, in every realistic shape", () => {
    // A regex guard that matches nothing passes forever, and asserting "the scan sees SOME
    // aria-pressed element" is not enough: the four real ones happen to carry no arrow function
    // ahead of the attribute, so that weaker probe stayed green while the arrow bug made the
    // `disabled` half unenforceable. Feed it the actual shapes instead.
    expect(offendingTags(`<button type="button" aria-pressed disabled>x</button>`)).toHaveLength(1);
    expect(offendingTags(`<button aria-pressed={false} disabled={true}>x</button>`)).toHaveLength(1);
    // the shape the old regex silently dropped — an arrow function before the banned pair
    expect(
      offendingTags(`<button onClick={() => setMode("night")} aria-pressed disabled>x</button>`),
    ).toHaveLength(1);
    // and the multi-line form the codebase actually writes
    expect(
      offendingTags(`<button\n  onClick={() => setMode("night")}\n  aria-pressed\n  disabled\n>x</button>`),
    ).toHaveLength(1);

    // A genuine toggle that is CONDITIONALLY disabled is correct ARIA and must NOT be flagged.
    expect(offendingTags(`<button aria-pressed={on} disabled={busy}>x</button>`)).toEqual([]);
    expect(offendingTags(`<button aria-pressed={on} disabled={disabled}>x</button>`)).toEqual([]);

    // and the scanner really is reading the tree, not an empty list
    const withPressed = srcFiles.filter((f) =>
      openingTags(stripComments(readFileSync(f, "utf8"))).some((t) => /\baria-pressed\b/.test(t)),
    );
    expect(withPressed.length).toBeGreaterThan(2);
  });
});

describe("a composite widget role brings its keyboard model with it", () => {
  // Erase's scope picker declared `role="radiogroup"`/`role="radio"` and then behaved like three
  // ordinary buttons: three tab stops, no arrow keys. A role is a promise to assistive tech about
  // how the thing works, and a promise the DOM does not keep is worse than no role — the user is
  // told to press an arrow key and nothing happens. Any file in this group that claims a composite
  // role must also carry the roving tabindex and the key handler that make it true.
  it("every radio/tab role in pages/records ships a roving tabindex and arrow keys", () => {
    const offenders: string[] = [];
    for (const file of walk(here)) {
      if (!/\.tsx$/.test(file)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (!/role="(?:radio|tab)"/.test(src)) continue;
      const hasRoving = /tabIndex=\{/.test(src);
      const hasArrows = /"Arrow(?:Left|Right|Up|Down)"/.test(src);
      if (!hasRoving || !hasArrows) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // and the law is not vacuous — this group really does declare one
    const declaring = walk(here).filter(
      (f) => /\.tsx$/.test(f) && /role="(?:radio|tab)"/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(declaring.length).toBeGreaterThan(0);
  });
});
