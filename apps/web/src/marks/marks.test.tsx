// The asset vault's whole-surface guarantees.
//
// Every mark renders real geometry; nothing reaches a third-party origin; the dimmed state is the
// law's 0.38 and not an approximation; and accessibility is decided by the component rather than
// left to the page. Rendering is `renderToStaticMarkup` — the same pattern the existing Console
// tests use — because these are pure vectors with no effects and no network.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { NavMark, PosternMark } from "./NavMark";
import type { GateMark } from "./NavMark";
import { SectorChip } from "./SectorChip";
import type { Sector } from "./SectorChip";
import { SectorSpecimen } from "./SectorSpecimen";
import { ProviderTile } from "./ProviderTile";
import type { ProviderId } from "./ProviderTile";
import { InstitutionMark } from "./InstitutionMark";

const GATE_MARKS: GateMark[] = ["gatehouse", "sources", "agents", "ledger", "settings"];
const SECTORS: Sector[] = ["finance", "mail", "calendar", "contacts", "health", "home"];
const PROVIDERS: ProviderId[] = [
  "apple",
  "gmail",
  "google",
  "microsoft",
  "homeassistant",
  "plaid",
  "simplefin",
  "whoop",
  "apple_health",
];

/** Every mark in the vault, rendered once, so a whole-surface rule can be asserted over all of them.
 *  `<SectorSpecimen>` is in here at BOTH sizes so the no-origin / no-xmlns / no-tab-order sweeps
 *  cover the drawings pass 2 added, not only the ones pass 1 shipped. */
const EVERY_MARK: Array<[string, string]> = [
  ...GATE_MARKS.map((m): [string, string] => [`NavMark:${m}`, renderToStaticMarkup(<NavMark mark={m} />)]),
  ["PosternMark", renderToStaticMarkup(<PosternMark />)],
  ["PosternMark:lockup", renderToStaticMarkup(<PosternMark lockup />)],
  ...SECTORS.map((s): [string, string] => [`SectorChip:${s}`, renderToStaticMarkup(<SectorChip sector={s} />)]),
  ...SECTORS.map((s): [string, string] => [
    `SectorChip:${s}:label`,
    renderToStaticMarkup(<SectorChip sector={s} label />),
  ]),
  ...SECTORS.map((s): [string, string] => [
    `SectorSpecimen:${s}:card`,
    renderToStaticMarkup(<SectorSpecimen sector={s} />),
  ]),
  ...SECTORS.map((s): [string, string] => [
    `SectorSpecimen:${s}:hero`,
    renderToStaticMarkup(<SectorSpecimen sector={s} size="hero" />),
  ]),
  ...PROVIDERS.map((p): [string, string] => [
    `ProviderTile:${p}`,
    renderToStaticMarkup(<ProviderTile provider={p} />),
  ]),
  // EVERY ported institution vector, not just Chase (#107 §3 brought 15 more across from the plate).
  // The whole point of this array is that a whole-surface rule is asserted over all of them, so a
  // sweep that saw one of sixteen was checking 6% of the institution marks in the vault.
  ...(
    [
      "Chase",
      "Bank of America",
      "HSBC",
      "Barclays",
      "Deutsche Bank",
      "Revolut",
      "Monzo",
      "Starling Bank",
      "N26",
      "Wise",
      "PayPal",
      "Cash App",
      "Zelle",
      "Mastercard",
      "Robinhood",
      "Binance",
    ] as const
  ).map((i): [string, string] => [
    `InstitutionMark:${i}`,
    renderToStaticMarkup(<InstitutionMark institution={i} />),
  ]),
  // Both wordmarks resolve to their brand-coloured monogram tile at every size now that the crafted
  // logotypes are gone; kept at 40 so the sweep still covers a scaled tile.
  ["InstitutionMark:amex:40", renderToStaticMarkup(<InstitutionMark institution="American Express" size={40} />)],
  ["InstitutionMark:discover:40", renderToStaticMarkup(<InstitutionMark institution="Discover" size={40} />)],
  ["InstitutionMark:fidelity", renderToStaticMarkup(<InstitutionMark institution="Fidelity" />)],
  ["InstitutionMark:unknown", renderToStaticMarkup(<InstitutionMark institution="Somewhere Savings" />)],
];

describe("every mark renders real geometry", () => {
  it.each(GATE_MARKS)("NavMark %s draws an svg with paths", (mark) => {
    const markup = renderToStaticMarkup(<NavMark mark={mark} />);
    expect(markup).toMatch(/^<svg/);
    expect(markup).toMatch(/<(path|circle|ellipse|rect|line)\b/);
  });

  it.each(SECTORS)("SectorChip %s draws an svg with geometry on the 14-unit viewBox", (sector) => {
    const markup = renderToStaticMarkup(<SectorChip sector={sector} />);
    expect(markup).toContain('viewBox="0 0 14 14"');
    expect(markup).toMatch(/<(path|circle|ellipse|rect)\b/);
  });

  it.each(PROVIDERS)("ProviderTile %s draws an svg with geometry", (provider) => {
    const markup = renderToStaticMarkup(<ProviderTile provider={provider} />);
    expect(markup).toMatch(/^<svg/);
    expect(markup).toMatch(/<(path|circle|rect|g)\b/);
  });

  it.each(SECTORS)("SectorSpecimen %s draws a STEMMED plant, not a scaled chip", (sector) => {
    // The specimen's own viewBox is never the chip's 14-unit box, and every drawing carries the fern
    // green #40794C — the stem-and-leaf ink the 15px silhouette has none of (build-notes §11.3).
    const markup = renderToStaticMarkup(<SectorSpecimen sector={sector} />);
    expect(markup).toMatch(/^<svg/);
    expect(markup).not.toContain('viewBox="0 0 14 14"');
    expect(markup).toContain("#40794C");
    expect(markup).toMatch(/<(path|circle|ellipse|rect)\b/);
  });

  it("PosternMark draws the door, and the lockup adds the wordmark", () => {
    expect(renderToStaticMarkup(<PosternMark />)).toMatch(/^<svg/);
    const lockup = renderToStaticMarkup(<PosternMark lockup />);
    expect(lockup).toContain("Postern");
    expect(lockup).toContain("The Console");
  });
});

describe("the marks are the CANONICAL ones, not the drift they replaced", () => {
  // build-notes §9.1. Each assertion below names a specific wrong mark that shipped once.
  it("the door's seam is AMBER #E7A42A, never poppy", () => {
    for (const markup of [
      renderToStaticMarkup(<PosternMark />),
      renderToStaticMarkup(<NavMark mark="gatehouse" />),
    ]) {
      expect(markup).toContain("#E7A42A");
      expect(markup).not.toContain("#B83E15");
    }
  });

  it("Agents is the pollinator — four eyespots and a body — not a key", () => {
    const markup = renderToStaticMarkup(<NavMark mark="agents" />);
    // The wing inks: cornflower above, coral below. A key has neither.
    expect(markup).toContain("#5877C0");
    expect(markup).toContain("#E9795E");
    // Four cream eyespots (two carry cream fills, two are drawn cream-on-ink).
    expect(markup).toContain("#F5EDDA");
    expect(markup).toContain("<ellipse");
  });

  it("Settings is the VDO gauge — a dial, a needle and an amber set-mark — not a castle", () => {
    const markup = renderToStaticMarkup(<NavMark mark="settings" />);
    expect(markup).toContain('r="7.3"');
    expect(markup).toContain("M12 12 L14.9 8.8");
    expect(markup).toContain("#E7A42A");
  });

  it("Sources is the posy — three coloured heads on stems in a pot — not an arch and a dot", () => {
    const markup = renderToStaticMarkup(<NavMark mark="sources" />);
    expect(markup).toContain("#E7A42A");
    expect(markup).toContain("#E9795E");
    expect(markup).toContain("#5877C0");
    expect(markup).toContain("M9.9 17.5 L14.1 17.5 L13.7 20 L10.3 20 Z");
  });

  it("The ledger is a clasped book with a poppy wax seal", () => {
    const markup = renderToStaticMarkup(<NavMark mark="ledger" />);
    expect(markup).toContain("#B83E15");
    expect(markup).toContain("M17.5 6 L19 6.5 L19 18 L17.5 18.5");
  });
});

describe("no third-party origin — ever", () => {
  it.each(EVERY_MARK)("%s reaches no origin at all", (_name, markup) => {
    expect(markup).not.toContain("http");
    expect(markup).not.toContain("//");
    expect(markup).not.toContain("href");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("url(");
  });

  it("no source file in the vault names an external host", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir)) {
      if (!/\.(tsx?|css)$/.test(file) || file.endsWith(".test.tsx")) continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      // Comments cite Paper file IDs, never URLs. A `//` here would be a JS line comment, so match
      // the shapes that actually fetch instead.
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
      expect(source).not.toMatch(/<image\b/);
      expect(source).not.toMatch(/\bxlinkHref\b/);
    }
  });
});

describe("the dimmed 'off / not yet' state is exactly 0.38", () => {
  it("applies the dimmed class to a standalone chip and to a labelled one", () => {
    const standalone = renderToStaticMarkup(<SectorChip sector="finance" dimmed />);
    const labelled = renderToStaticMarkup(<SectorChip sector="finance" dimmed label />);
    expect(standalone).toContain("dimmed");
    expect(labelled).toContain("dimmed");
    expect(renderToStaticMarkup(<SectorChip sector="finance" />)).not.toContain("dimmed");
  });

  it("declares opacity 0.38 for that class — the law's value, not an approximation", () => {
    const css = readFileSync(new URL("./SectorChip.module.css", import.meta.url), "utf8");
    const rule = css.match(/\.dimmed\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/opacity:\s*0\.38\s*;/);
  });

  it("keeps the specimen identifiable — the drawing is not removed, only dimmed", () => {
    const dimmed = renderToStaticMarkup(<SectorChip sector="finance" dimmed />);
    expect(dimmed).toContain("#E7A42A");
    expect(dimmed).toContain("<ellipse");
  });

  it("moves the label to faded ink when dimmed, so the label carries the state", () => {
    const on = renderToStaticMarkup(<SectorChip sector="mail" label />);
    const off = renderToStaticMarkup(<SectorChip sector="mail" label dimmed />);
    expect(on).not.toContain("labelDimmed");
    expect(off).toContain("labelDimmed");
  });
});

describe("accessibility belongs to the component, not to the page", () => {
  it("a nav mark is aria-hidden — it always sits beside its own name", () => {
    for (const mark of GATE_MARKS) {
      expect(renderToStaticMarkup(<NavMark mark={mark} />)).toContain('aria-hidden="true"');
    }
  });

  it("a labelled sector chip is aria-hidden and the visible name does the identifying", () => {
    const markup = renderToStaticMarkup(<SectorChip sector="calendar" label />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Calendar");
    expect(markup).not.toContain('role="img"');
  });

  it("a standalone sector chip carries role=img and an accessible name", () => {
    const markup = renderToStaticMarkup(<SectorChip sector="calendar" />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Calendar"');
    expect(markup).not.toContain("aria-hidden");
  });

  it("the standalone Postern mark is named; inside the lockup the words name it instead", () => {
    const standalone = renderToStaticMarkup(<PosternMark />);
    expect(standalone).toContain('role="img"');
    expect(standalone).toContain('aria-label="Postern"');

    const lockup = renderToStaticMarkup(<PosternMark lockup />);
    expect(lockup).toContain('aria-hidden="true"');
    expect(lockup).not.toContain('role="img"');
  });

  it("provider marks carry role=img and their own name", () => {
    expect(renderToStaticMarkup(<ProviderTile provider="apple_health" />)).toContain(
      'aria-label="Apple Health"',
    );
    expect(renderToStaticMarkup(<ProviderTile provider="homeassistant" />)).toContain(
      'aria-label="Home Assistant"',
    );
  });

  it("a specimen is aria-hidden — it only ever appears beside its sector's name", () => {
    // Both surfaces that render one (the Gatehouse card head, the lens hero title) already set the
    // sector name and its binomial in text, so announcing the drawing as well is noise.
    for (const sector of SECTORS) {
      for (const markup of [
        renderToStaticMarkup(<SectorSpecimen sector={sector} />),
        renderToStaticMarkup(<SectorSpecimen sector={sector} size="hero" />),
      ]) {
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).not.toContain('role="img"');
      }
    }
  });

  it("never puts a mark in the tab order", () => {
    for (const [, markup] of EVERY_MARK) {
      expect(markup).not.toContain("tabindex");
      expect(markup).not.toContain('tabIndex="0"');
    }
  });
});

describe("sizing — size scales a vector, it never re-lays-out one", () => {
  it("line nav marks are 17×17 natively and stay square at any size", () => {
    expect(renderToStaticMarkup(<NavMark mark="sources" />)).toContain('width="17" height="17"');
    expect(renderToStaticMarkup(<NavMark mark="ledger" size={34} />)).toContain('width="34" height="34"');
  });

  it("the pollinator is 19×14 natively — wider than tall — and keeps that aspect", () => {
    expect(renderToStaticMarkup(<NavMark mark="agents" />)).toContain('width="19" height="14"');
    expect(renderToStaticMarkup(<NavMark mark="agents" size={34} />)).toContain('width="38" height="28"');
  });

  it("the identity door is 22×28 at brand scale and square-boxed at nav scale", () => {
    expect(renderToStaticMarkup(<PosternMark />)).toContain('width="22" height="28"');
    // The nav item uses the SAME 32×40 viewBox at 17, where preserveAspectRatio centres it in the
    // 17px icon lane (build-notes §10.4).
    const nav = renderToStaticMarkup(<NavMark mark="gatehouse" />);
    expect(nav).toContain('width="17" height="17"');
    expect(nav).toContain('viewBox="0 0 32 40"');
  });

  it("chips are 15×15 natively", () => {
    expect(renderToStaticMarkup(<SectorChip sector="home" />)).toContain('width="15" height="15"');
    expect(renderToStaticMarkup(<SectorChip sector="home" size={20} />)).toContain('width="20" height="20"');
    // There is deliberately no assertion here that a chip renders at hero size. The old one
    // (`size={30}`) BLESSED the substitution build-notes §19.1 post-mortems, and 30 is now a compile
    // error under `SectorChipSize` — 20 is the documented ceiling. `specimens.test.tsx` owns the
    // call-site scan that catches the half a type cannot.
  });

  it("institution marks are 22×22 natively", () => {
    expect(renderToStaticMarkup(<InstitutionMark institution="Chase" />)).toContain('width="22" height="22"');
  });

  it("provider marks keep each kit vector's own aspect", () => {
    // apple is square in the kit; microsoft is 24×26.
    expect(renderToStaticMarkup(<ProviderTile provider="apple" />)).toContain('width="24" height="24"');
    expect(renderToStaticMarkup(<ProviderTile provider="microsoft" />)).toContain('width="24" height="26"');
    expect(renderToStaticMarkup(<ProviderTile provider="microsoft" size={48} />)).toContain(
      'width="48" height="52"',
    );
  });
});

describe("colour discipline — brand colour encodes SOURCE", () => {
  // The companion rule ("agent marks are single ink") had exactly one subject, `<AgentMark>`, which
  // was deleted 2026-07-25 as an unreachable plate asset (console-specimens §5). The rule itself is
  // unchanged and still recorded in build-notes §0; it has nothing left in this vault to assert
  // against, and re-porting the four marks from ER1-0/ER4-0/ERJ-0/EP3-0 re-arms it.
  it("provider marks may carry brand colour", () => {
    expect(renderToStaticMarkup(<ProviderTile provider="simplefin" />)).toContain("#0088CC");
    expect(renderToStaticMarkup(<ProviderTile provider="homeassistant" />)).toContain("#6FA8D8");
  });

  it("a sector specimen carries only the illustration inks — never a sector token, never a brand hex", () => {
    // The specimens' green is #40794C, which is deliberately NOT --sector-calendar. Re-tokenising an
    // accepted illustration is how a drawing drifts (build-notes §0, §9.2), so the whole palette is
    // pinned: the five illustration inks plus the six sector-identity hues the drawings themselves
    // use. A `var(--` anywhere in a specimen is the drift this catches.
    const PALETTE = new Set([
      "#2A2118", "#F5EDDA", "#40794C", "#E7A42A", "#E9795E",
      "#7B559E", "#5877C0", "#D26A8B",
    ]);
    for (const sector of SECTORS) {
      const markup = renderToStaticMarkup(<SectorSpecimen sector={sector} />);
      const hexes = markup.match(/#[0-9A-Fa-f]{6}/g) ?? [];
      expect(hexes.length).toBeGreaterThan(0);
      for (const hex of hexes) expect(PALETTE.has(hex.toUpperCase())).toBe(true);
      expect(markup).not.toContain("var(--");
    }
  });
});
