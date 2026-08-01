// The Console's visual-ground validator (spec `console-ground`; audit findings #68, #81, #69).
//
// Four things are asserted here, each an acceptance criterion of the spec:
//
//   1. TOKEN FIDELITY — every token in `tokens.css` matches Paper's `get_tokens` output for file
//      01KY3S7JMA16R0QZVSX084WWDD verbatim, in the same order, except the three documented
//      normalisations (`--leading-*` percentages -> unitless). PAPER_TOKENS below is that
//      recorded reading, not a re-derivation.
//   2. WCAG AA FOR TEXT (#68) — every text token clears 4.5:1 on every ground, with relative
//      luminance computed properly (sRGB -> linear) and alpha tokens composited over their
//      ground in sRGB space the way CSS does.
//   3. THE INK-ALPHA RULE — `--color-ink-a*` and `--color-rule*` are rules, borders and
//      hairlines. A stylesheet that uses one as a text `color:` fails the suite.
//   4. ZERO THIRD-PARTY ORIGINS (#81, law 3) — `@font-face` sources resolve to committed
//      `/fonts/*.woff2` that exist on disk, and no stylesheet under `apps/web/src` carries a
//      `//` URL to a non-local origin.
//
// WHY SECTOR AND STATE INKS ARE NOT ASSERTED AS TEXT. They are classified NON-TEXT by default
// and asserted only as marks. That is the design's own grammar, not a loophole: a sector chip is
// a *drawing* plus a label set in `--color-ink` (build-notes §11.2), and state colour is a dot
// beside a word, not the word (§14.1a). Measured against paper, calendar/mail/seal clear AA and
// contacts/home/health/finance do not — so treating every ink as text would either fail the build
// on a correct design or push the design toward inks it deliberately does not use for type.
// The classification is pinned below, so a token change that flips one is caught.
//
// WHERE THE DESIGN ITSELF SETS A FAILING INK AS TEXT, we REPORT rather than fix: those four
// nodes are recorded in `docs/design/postern-console/contrast-exceptions.md` for the operator to
// rule on. Changing the design to pass a test is moving the target (program plan §7 law 10), and
// weakening the test to pass the design is the same mistake wearing a different hat.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");
const WEB_ROOT = resolve(HERE, "../..");

const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// Paper's reading, recorded verbatim
// ---------------------------------------------------------------------------

/**
 * `get_tokens({fileId:"01KY3S7JMA16R0QZVSX084WWDD", format:"css"})`, transcribed in Paper's own
 * order. This is the CONTRACT: if Paper and this list ever disagree, Paper wins and this list is
 * corrected — never the other way around.
 */
const PAPER_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["--color-paper", "#F5EDDA"],
  ["--color-paper-raised", "#FDF8EC"],
  ["--color-paper-inset", "#ECE2C8"],
  ["--color-ink", "#2A2118"],
  ["--color-ink-soft", "#2A2118CC"],
  ["--color-faded", "#6E6048"],
  ["--color-rule", "#2A211840"],
  ["--color-rule-strong", "#2A211866"],
  ["--color-seal", "#B83E15"],
  ["--color-seal-deep", "#8F2E10"],
  ["--sector-finance", "#E7A42A"],
  ["--sector-health", "#E9795E"],
  ["--sector-mail", "#7B559E"],
  ["--sector-contacts", "#5877C0"],
  ["--sector-calendar", "#3C7247"],
  ["--sector-home", "#D26A8B"],
  ["--state-ok", "#3C7247"],
  ["--state-attention", "#E7A42A"],
  ["--state-error", "var(--color-seal)"],
  ["--state-idle", "#6E6048"],
  ["--color-ink-a15", "#2A211826"],
  ["--color-ink-a22", "#2A211838"],
  ["--color-ink-a25", "#2A211840"],
  ["--color-ink-a40", "#2A211866"],
  ["--color-card", "#FDF8EC"],
  ["--font-display", '"Cormorant Garamond", serif'],
  ["--font-body", '"EB Garamond", serif'],
  ["--font-sc", '"Cormorant Garamond", serif'],
  ["--font-mono", '"Courier Prime", monospace'],
  ["--font-type", '"Courier Prime", monospace'],
  ["--text-2xs", "10px"],
  ["--text-xs", "11px"],
  ["--text-sm", "13px"],
  ["--text-base", "15px"],
  ["--text-md", "17px"],
  ["--text-lg", "21px"],
  ["--text-xl", "28px"],
  ["--text-2xl", "40px"],
  ["--text-3xl", "56px"],
  ["--weight-regular", "400"],
  ["--weight-medium", "500"],
  ["--weight-semibold", "600"],
  ["--weight-bold", "700"],
  ["--tracking-label", "0.14em"],
  ["--tracking-wide", "0.24em"],
  ["--tracking-tight", "-0.01em"],
  ["--tracking-mono", "0.01em"],
  ["--leading-tight", "110.00000000000001%"],
  ["--leading-snug", "130%"],
  ["--leading-normal", "150%"],
  ["--breakpoint-md", "768px"],
  ["--breakpoint-lg", "1024px"],
  ["--container-content", "1240px"],
  ["--space-1", "4px"],
  ["--space-2", "8px"],
  ["--space-3", "12px"],
  ["--space-4", "16px"],
  ["--space-5", "24px"],
  ["--space-6", "32px"],
  ["--space-7", "48px"],
  ["--space-8", "64px"],
  ["--radius-sm", "2px"],
  ["--radius-md", "4px"],
  ["--radius-lg", "7px"],
];

/**
 * The ONLY permitted departures from Paper. `--leading-*` percentages become unitless ratios so a
 * nested type scale inherits a ratio rather than a computed length; `110.00000000000001%` is a
 * float artifact of Paper's editor, not a design decision. Nothing else may appear in this map.
 */
const NORMALISATIONS: Readonly<Record<string, string>> = {
  "--leading-tight": "1.1",
  "--leading-snug": "1.3",
  "--leading-normal": "1.5",
};

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

/** Strip `/* … *\/` comments so declarations inside prose are never parsed as rules. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Custom-property declarations inside `:root { … }`, in source order. */
export function parseRootTokens(css: string): Array<[string, string]> {
  const body = stripComments(css).match(/:root\s*\{([\s\S]*?)\}/);
  if (!body) return [];
  const out: Array<[string, string]> = [];
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body[1])) !== null) out.push([m[1], m[2].trim()]);
  return out;
}

/**
 * Every `color:` (and `-webkit-text-fill-color:`) value in a stylesheet. The negative lookbehind
 * on a word char or hyphen is what keeps `background-color`, `border-color`, `outline-color` and
 * `caret-color` out — those are marks, and marks are exactly what the ink-alpha tokens are for.
 */
export function textColorValues(css: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w-])(?:-webkit-text-fill-)?color\s*:\s*([^;}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(css))) !== null) out.push(m[1].trim());
  return out;
}

const NON_TEXT_TOKEN = /--color-(?:ink-a\d+|rule(?:-strong)?)\b/;

/** The tokens that may only ever draw a rule, border or hairline — never set type. */
export function nonTextTokensUsedAsColor(css: string): string[] {
  return textColorValues(css).filter((v) => NON_TEXT_TOKEN.test(v));
}

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFilesUnder(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour maths — the WCAG definitions, not an approximation
// ---------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

/** `#RGB`, `#RRGGBB` and `#RRGGBBAA`. Channels 0–255, alpha 0–1. */
export function parseHex(hex: string): Rgba {
  const h = hex.trim().replace(/^#/, "");
  const expand = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expand)) throw new Error(`not a hex colour: ${hex}`);
  return {
    r: parseInt(expand.slice(0, 2), 16),
    g: parseInt(expand.slice(2, 4), 16),
    b: parseInt(expand.slice(4, 6), 16),
    a: expand.length === 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1,
  };
}

/**
 * Source-over compositing in sRGB (gamma-encoded) space — which is what a browser does when it
 * paints translucent text on an opaque ground, and why this must NOT be done in linear space.
 */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG 2.x sRGB -> linear transfer, per channel. */
function toLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio of an ink over a ground, compositing the ink's alpha first. */
export function contrastRatio(inkHex: string, groundHex: string): number {
  const ground = parseHex(groundHex);
  const ink = compositeOver(parseHex(inkHex), ground);
  const [hi, lo] = [relativeLuminance(ink), relativeLuminance(ground)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------

const tokensCss = read(join(HERE, "tokens.css"));
const fontsCss = read(join(HERE, "fonts.css"));
const baseCss = read(join(HERE, "base.css"));
const indexCss = read(join(HERE, "index.css"));
const tokenPairs = parseRootTokens(tokensCss);
const tokens = new Map(tokenPairs);

/** Resolve one level of `var(--x)` indirection — `--state-error` is the only such token. */
function hexOf(name: string): string {
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`missing token ${name}`);
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  return ref ? hexOf(ref[1]) : raw;
}

const GROUNDS = ["--color-paper", "--color-paper-raised", "--color-paper-inset"] as const;
const TEXT_TOKENS = ["--color-ink", "--color-ink-soft", "--color-faded"] as const;
const AA_TEXT = 4.5;

describe("token layer — verbatim from Paper 01KY3S7JMA16R0QZVSX084WWDD", () => {
  it("carries exactly Paper's tokens, in Paper's order", () => {
    expect(tokenPairs.map(([name]) => name)).toEqual(PAPER_TOKENS.map(([name]) => name));
  });

  it("reproduces every value verbatim, except the three documented normalisations", () => {
    const drifted: string[] = [];
    for (const [name, paperValue] of PAPER_TOKENS) {
      const expected = NORMALISATIONS[name] ?? paperValue;
      const actual = tokens.get(name);
      if (actual !== expected) drifted.push(`${name}: expected ${expected}, got ${String(actual)}`);
    }
    expect(drifted).toEqual([]);
  });

  it("normalises only the three --leading-* tokens, and normalises all of them", () => {
    // A guard on the escape hatch itself: nothing may be quietly added to NORMALISATIONS.
    expect(Object.keys(NORMALISATIONS).sort()).toEqual([
      "--leading-normal",
      "--leading-snug",
      "--leading-tight",
    ]);
    for (const name of Object.keys(NORMALISATIONS)) {
      expect(PAPER_TOKENS.find(([n]) => n === name)?.[1]).toMatch(/%$/);
      expect(tokens.get(name)).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it("keeps --state-error as the reference var(--color-seal), not a flattened hex", () => {
    expect(tokens.get("--state-error")).toBe("var(--color-seal)");
    expect(hexOf("--state-error")).toBe(hexOf("--color-seal"));
  });
});

describe("WCAG AA — text tokens on every ground (#68)", () => {
  for (const ink of TEXT_TOKENS) {
    for (const ground of GROUNDS) {
      it(`${ink} on ${ground} clears ${AA_TEXT}:1`, () => {
        const ratio = contrastRatio(hexOf(ink), hexOf(ground));
        expect(round2(ratio)).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }

  it("composites the alpha text token rather than measuring its opaque hex", () => {
    // --color-ink-soft is #2A2118CC. Measured naively (alpha ignored) it would score the same as
    // --color-ink; composited it must be strictly lighter, i.e. a LOWER ratio. If this ever ties,
    // the alpha is being dropped and every alpha assertion above is meaningless.
    const soft = contrastRatio(hexOf("--color-ink-soft"), hexOf("--color-paper"));
    const solid = contrastRatio(hexOf("--color-ink"), hexOf("--color-paper"));
    expect(soft).toBeLessThan(solid);
  });

  it("computes luminance non-linearly (sRGB -> linear), not as a channel average", () => {
    // A mid grey's relative luminance is ~0.216, not 0.5. A naive average-of-channels
    // implementation lands on 0.5 and silently passes tokens that fail in a browser.
    expect(round2(relativeLuminance(parseHex("#808080")))).toBe(0.22);
    // The two WCAG anchors.
    expect(round2(contrastRatio("#000000", "#FFFFFF"))).toBe(21);
    expect(round2(contrastRatio("#FFFFFF", "#FFFFFF"))).toBe(1);
  });
});

describe("sector + state inks — classified NON-TEXT, pinned as marks", () => {
  // Measured against --color-paper. `clearsAA` records which inks WOULD pass as text; the design
  // uses none of them for body type, so this is a classification pin, not a gate. A token edit
  // that flips one of these fails here and is a design conversation, not a silent change.
  const MARKS: ReadonlyArray<readonly [string, boolean]> = [
    ["--sector-calendar", true], // fern
    ["--sector-mail", true], // plum
    ["--color-seal", true], // poppy
    ["--sector-contacts", false], // cornflower
    ["--sector-home", false], // rose
    ["--sector-health", false], // coral
    ["--sector-finance", false], // marigold
    ["--state-ok", true],
    ["--state-error", true],
    ["--state-idle", true],
    ["--state-attention", false],
  ];

  for (const [ink, clearsAA] of MARKS) {
    it(`${ink} on --color-paper ${clearsAA ? "clears" : "does not clear"} ${AA_TEXT}:1`, () => {
      const ratio = contrastRatio(hexOf(ink), hexOf("--color-paper"));
      expect(ratio >= AA_TEXT).toBe(clearsAA);
    });
  }

  it("classifies the ink-alpha and rule tokens as non-text", () => {
    for (const name of ["--color-ink-a15", "--color-ink-a22", "--color-ink-a25", "--color-ink-a40", "--color-rule", "--color-rule-strong"]) {
      expect(NON_TEXT_TOKEN.test(`var(${name})`)).toBe(true);
    }
    for (const name of ["--color-ink", "--color-ink-soft", "--color-faded"]) {
      expect(NON_TEXT_TOKEN.test(`var(${name})`)).toBe(false);
    }
  });
});

// ── the legibility floor for prose (#106 §3) ──────────────────────────────────────────────────────
//
// The operator's words about the Console's notices were "the fonts there are basically unreadable",
// and the diagnosis matters because it routes the fix away from contrast: `--color-faded` on paper
// measures 5.25:1 and passes AA on every ground (asserted above). What was wrong was SIZE and SLANT —
// sentences set in faded italic at 12.5px, which is not a step on the type scale at all: it runs
// 10 · 11 · 13 · 15 · 17 · 21 · 28 · 40 · 56, straight past 12 and 12.5.
//
// The plate is the evidence, read through `find_nodes` on 01KY3S7JMA16R0QZVSX084WWDD, and it is
// specific in a way a blanket rule would not be:
//   · 12.5px exists on 81 nodes — every one of them a VALUE. Pager counts ("Showing 1–25 of 8,825"),
//     record field keys, raw-payload lines, table cells, an address. Not one is prose.
//   · italic ∧ 12.5px: ZERO nodes. italic ∧ 12px: ZERO. italic ∧ 11px: ZERO.
//   · italic ∧ 13px: the Home lens's overflow note (`19P-0` / `1FL-0`) — 13px, italic,
//     `var(--color-faded)`, 16px line-height. So italic faded prose IS a plate treatment; it simply
//     never goes below the smallest body step.
//   · upright body BELOW 13px does exist and is legal: every sector card's "read by 3 agents" clause
//     (`3Q3-0`, `3W9-0`) is `--font-body` at 12px/16px in `--color-faded`. Which is why the rule below
//     bounds ITALIC and not size alone — a flat "no body copy under 13px" would delete a treatment the
//     plate draws twenty-five times, and `pages/gatehouse/SectorCard.module.css .readBy` matches it
//     verbatim. Slant is what the operator could not read; a short upright clause he never mentioned.
//
// Hence the rule below, and its deliberate shape. It binds the BODY font only. A mono cell at 12px is
// a value in a lane of values — the Source column's four variants are read straight off the Finance
// inspector artboard (`6I9-0` / `6ML-0`) at mono 12px/16px, and one of them is italic precisely to say
// "this is not one of the values above" (`pages/inspector/cells.module.css .sourceUnserved`). A rule
// that could not tell a table cell from a paragraph would force that cell either up to 13px, breaking
// a lane the plate draws, or upright, erasing the only signal it has. Prose is what this guards.
describe("the prose legibility floor — no italic body copy below the smallest body step", () => {
  /** Every declaration block in a stylesheet, as `[selector, body]`, comments stripped. */
  function blocks(css: string): [string, string][] {
    return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  }

  const BODY_FLOOR = 13;

  it("finds no italic body-font declaration under 13px in any stylesheet", () => {
    const offenders: string[] = [];
    for (const file of cssFilesUnder(SRC_ROOT)) {
      for (const [selector, body] of blocks(read(file))) {
        if (!/font-style:\s*italic/.test(body)) continue;
        const size = body.match(/font-size:\s*([\d.]+)px/);
        const family = body.match(/font-family:\s*var\((--font-[\w-]+)\)/);
        if (!size || family?.[1] !== "--font-body") continue;
        if (Number(size[1]) < BODY_FLOOR) {
          offenders.push(`${file.slice(WEB_ROOT.length + 1)}: ${selector} — ${size[1]}px italic`);
        }
      }
    }
    // The four this rule was written from: `.degradedReason`, `.liveReason`, `.syncDisabledReason`
    // (all 12.5px italic body) and `WhoCameThrough .passage` (12px italic body, now a mono clock).
    expect(offenders).toEqual([]);
  });

  it("detects the violation it exists to catch, and leaves the plate's own treatments alone", () => {
    // Proving the detector before trusting it — the vacuous version of this test is a parser that
    // matches nothing and reports a clean tree forever.
    const bad = ".a { color: var(--color-faded); font-family: var(--font-body); font-size: 12.5px; font-style: italic; }";
    const okSize = ".a { font-family: var(--font-body); font-size: 13px; font-style: italic; }";
    const okMono = ".a { font-family: var(--font-mono); font-size: 12px; font-style: italic; }";
    const italicOf = (css: string): boolean =>
      blocks(css).some(([, body]) => {
        const size = body.match(/font-size:\s*([\d.]+)px/);
        const family = body.match(/font-family:\s*var\((--font-[\w-]+)\)/);
        return (
          /font-style:\s*italic/.test(body) &&
          !!size &&
          family?.[1] === "--font-body" &&
          Number(size[1]) < BODY_FLOOR
        );
      });
    expect(italicOf(bad)).toBe(true);
    // 13px italic faded prose is the plate's own note treatment (`1FL-0`) and must stay legal.
    expect(italicOf(okSize)).toBe(false);
    // …as must an italic mono CELL, which is a value lane the plate draws at 12px.
    expect(italicOf(okMono)).toBe(false);
  });

  it("keeps 12.5px for values only — no body-font prose is set at a size the scale does not carry", () => {
    // The other half of the same finding: 12.5px is legal (81 plate nodes use it) but only for the
    // dense value lines it was drawn for. `--font-body` at 12.5px is prose at an invented size.
    const offenders: string[] = [];
    for (const file of cssFilesUnder(SRC_ROOT)) {
      for (const [selector, body] of blocks(read(file))) {
        const size = body.match(/font-size:\s*12\.5px/);
        const family = body.match(/font-family:\s*var\((--font-[\w-]+)\)/);
        if (size && family?.[1] === "--font-body") {
          offenders.push(`${file.slice(WEB_ROOT.length + 1)}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the ink-alpha rule — rules and hairlines are never a color: value", () => {
  it("detects the violation it exists to catch", () => {
    // Proving the detector before trusting it: these are the shapes a component would actually
    // write. The suite fails on the first two and stays quiet on the rest.
    expect(nonTextTokensUsedAsColor(".a { color: var(--color-ink-a25); }")).toHaveLength(1);
    expect(nonTextTokensUsedAsColor(".a{color:var(--color-rule-strong)}")).toHaveLength(1);
    expect(nonTextTokensUsedAsColor(".a { border-color: var(--color-ink-a25); }")).toHaveLength(0);
    expect(nonTextTokensUsedAsColor(".a { background-color: var(--color-rule); }")).toHaveLength(0);
    expect(nonTextTokensUsedAsColor(".a { outline-color: var(--color-ink-a40); }")).toHaveLength(0);
    expect(nonTextTokensUsedAsColor(".a { color: var(--color-ink); }")).toHaveLength(0);
    expect(nonTextTokensUsedAsColor("/* color: var(--color-rule) */ .a { color: var(--color-ink); }")).toHaveLength(0);
  });

  it("finds no violation in any stylesheet under apps/web/src", () => {
    const offenders: string[] = [];
    for (const file of cssFilesUnder(SRC_ROOT)) {
      for (const value of nonTextTokensUsedAsColor(read(file))) {
        offenders.push(`${file.slice(WEB_ROOT.length + 1)}: color: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("zero third-party origins (#81, law 3)", () => {
  const stylesheets = cssFilesUnder(SRC_ROOT);

  // The scan is deliberately blunt: ANY scheme-or-protocol-relative reference anywhere in a
  // stylesheet is a violation, not just one inside url(). An earlier, narrower version of this
  // test scanned url() plus a googleapis/gstatic literal, and a review mutation proved that
  // `@import "https://cdn.example.com/evil.css";` — the bare-string form, valid CSS — passed it
  // silently. A guard with a hole is worse than no guard, because it is trusted. Local `data:`
  // URIs carry no `//` and are unaffected.
  const OFF_ORIGIN = /(?:[a-z][a-z0-9+.-]*:)?\/\//i;

  it("finds no off-origin reference in any stylesheet under apps/web/src", () => {
    const offenders: string[] = [];
    for (const file of stylesheets) {
      const css = stripComments(read(file));
      for (const line of css.split("\n")) {
        if (OFF_ORIGIN.test(line)) offenders.push(`${file.slice(WEB_ROOT.length + 1)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches the forms a narrower scan would miss (mutation guard)", () => {
    for (const hostile of [
      '@import "https://cdn.example.com/evil.css";',
      "@import url(//cdn.example.com/evil.css);",
      '@font-face { src: url("https://fonts.gstatic.com/x.woff2") format("woff2"); }',
      ".a { background: url('//evil.example/x.png'); }",
    ]) {
      expect(OFF_ORIGIN.test(stripComments(hostile))).toBe(true);
    }
    for (const fine of ['@import "./tokens.css";', '.a { background: url("/img/x.png"); }', '.a { background: url(data:image/svg+xml,%3Csvg/%3E); }']) {
      expect(OFF_ORIGIN.test(stripComments(fine))).toBe(false);
    }
  });

  // index.html is the file that actually shipped the #81 leak: it preconnected and <link>ed the
  // Google-Fonts CDN, and it survived into dist/. It belongs to no stylesheet, so the CSS scan
  // above could never have caught it — which is exactly why it gets its own assertion.
  it("finds no off-origin reference in apps/web/index.html", () => {
    const html = read(join(WEB_ROOT, "index.html")).replace(/<!--[\s\S]*?-->/g, "");
    const offenders = html.split("\n").filter((l) => OFF_ORIGIN.test(l)).map((l) => l.trim());
    expect(offenders).toEqual([]);
  });

  it("declares six @font-face cuts, all sourced from committed /fonts/*.woff2", () => {
    const srcs = [...fontsCss.matchAll(/src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/g)].map((m) => m[1]);
    expect(srcs).toHaveLength(6);
    for (const src of srcs) {
      expect(src).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
      // The binary is committed, not fetched — assert it is actually on disk.
      expect(statSync(join(WEB_ROOT, "public", src)).size).toBeGreaterThan(0);
    }
    expect(new Set(srcs).size).toBe(6);
  });

  it("declares exactly the three families the token layer names", () => {
    const families = new Set(
      [...fontsCss.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect([...families].sort()).toEqual(["Cormorant Garamond", "Courier Prime", "EB Garamond"]);
    for (const token of ["--font-display", "--font-body", "--font-sc", "--font-mono", "--font-type"]) {
      const declared = tokens.get(token) ?? "";
      const family = declared.match(/^"([^"]+)"/)?.[1] ?? "";
      expect(families.has(family)).toBe(true);
    }
  });

  it("serves every cut with font-display: swap", () => {
    const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(6);
    for (const face of faces) expect(face).toMatch(/font-display:\s*swap/);
  });
});

describe("base stylesheet — the structural a11y this rebuild ships with (#69, #39)", () => {
  it("declares the focus ring exactly once, globally, from the ink token", () => {
    const rings = baseCss.match(/(^|\n)\s*:focus-visible\s*\{/g) ?? [];
    expect(rings).toHaveLength(1);
    expect(baseCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-ink\)/);
    expect(baseCss).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*3px/);
  });

  it("honours prefers-reduced-motion globally, not per-component", () => {
    const block = stripComments(baseCss).match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(block).not.toBeNull();
    // The universal selector is the whole point: a per-component list is what #39 already is.
    expect(block?.[1]).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block?.[1]).toMatch(/animation-duration:[^;]*!important/);
    expect(block?.[1]).toMatch(/transition-duration:[^;]*!important/);
  });

  it("grounds the page on paper and ink with no synthesised cuts", () => {
    expect(baseCss).toMatch(/background:\s*var\(--color-paper\)/);
    expect(baseCss).toMatch(/color:\s*var\(--color-ink\)/);
    expect(baseCss).toMatch(/font-family:\s*var\(--font-body\)/);
    expect(baseCss).toMatch(/font-synthesis:\s*none/);
  });

  // RETARGETED off base.css (#95 item 7). The rule read base.css because base.css declared a
  // `.container` helper — and that helper had ZERO users tree-wide, so the only thing keeping a dead
  // class alive was a test that happened to look at it. The class is deleted; the RULE it guarded is
  // not, and it is now stronger: every stylesheet is read, so the three page shells that genuinely use
  // the token are covered and a module writing `width: var(--container-content)` fails — which it
  // never did while only base.css was inspected.
  //
  // MUTATION 1: change any `max-width: var(--container-content)` to `width:` → RED (offenders).
  // MUTATION 2: delete the token's last use → RED (users empty: the token would be dead, and a dead
  //             layout bound is how a hard-coded 1440 gets in unnoticed).
  it("treats --container-content as a max-width, never a width — in every stylesheet", () => {
    const users: string[] = [];
    const offenders: string[] = [];
    for (const file of cssFilesUnder(SRC_ROOT)) {
      const css = stripComments(read(file));
      if (!css.includes("var(--container-content)")) continue;
      const rel = file.slice(WEB_ROOT.length + 1);
      if (/max-width:\s*var\(--container-content\)/.test(css)) users.push(rel);
      if (/(?<!max-)width:\s*var\(--container-content\)/.test(css)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // Every file that mentions the token uses it as a max-width, and at least one does.
    expect(users).not.toEqual([]);
    // No hard-coded desktop layout may enter the ground (#67).
    expect(baseCss).not.toMatch(/\b1440px\b/);
  });

  it("ships no night variant — the paper ground is the only one that exists", () => {
    for (const css of [tokensCss, baseCss, fontsCss, indexCss]) {
      // Comments stripped: the header of base.css *names* both mechanisms in order to rule
      // them out, and a prose mention must not read as a declaration.
      const rules = stripComments(css);
      expect(rules).not.toMatch(/prefers-color-scheme/);
      expect(rules).not.toMatch(/\[data-theme/);
    }
  });
});

describe("the style entry point", () => {
  it("imports fonts, then tokens, then base — and only local files", () => {
    const imports = [...indexCss.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./fonts.css", "./tokens.css", "./base.css"]);
  });

  it("is the only stylesheet main.tsx pulls in", () => {
    const mainTsx = read(join(SRC_ROOT, "main.tsx"));
    const cssImports = [...mainTsx.matchAll(/import\s+"([^"]+\.css)"/g)].map((m) => m[1]);
    expect(cssImports).toEqual(["./styles/index.css"]);
  });
});
