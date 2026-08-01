// The gate that was missing (build-notes §19.2·3).
//
// §11.3's two tiers — a 15px chip inside running content, the full botanical specimen where the
// sector IS the subject — were prose only. Pass 1 scaled the chip onto the Gatehouse cards and all
// six lens heroes, and the suite let it through: `marks.test.tsx` actively BLESSED scaling a chip
// past its ceiling — a chip rendered at 30 was an assertion — and nothing anywhere said a card or a
// hero must render a specimen. A rule with no test is a rule the next implementer can be talked out
// of, so each `it` below names the defect it prevents. (That blessing is described here rather than
// quoted as markup: the source scan at the bottom of this file reads this file too.)
//
// Two halves, deliberately: `SectorChipSize` makes an oversized chip a COMPILE error, and the source
// scan at the bottom catches the CALL SITE — which is the half that actually regressed, and the half
// a type cannot see once someone widens it back.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SectorSpecimen } from "./SectorSpecimen";
import type { Sector } from "./SectorChip";
import { SectorCard } from "../pages/gatehouse/SectorCard";
import { LensMasthead } from "../pages/lenses/LensMasthead";

const SECTORS: Sector[] = ["finance", "mail", "calendar", "contacts", "health", "home"];

/** The chip's native box. Its appearance on a card or a hero is the defect this file exists for. */
const CHIP_VIEWBOX = 'viewBox="0 0 14 14"';

/**
 * The twelve ported boxes — read off the app file's own nodes with `get_jsx`/`get_node_info`, never
 * off a screenshot. Card node · hero node per sector:
 *   finance 3OP-0/IE-0 · mail 3Q7-0/XF-0 · calendar 3R9-0/12V-0 · contacts 3T0-0/190-0 ·
 *   health 3UG-0/S1-0 · home 3VF-0/1EU-0
 */
const SPECIMEN_BOX: Record<
  Sector,
  { viewBox: string; card: [number, number]; hero: [number, number]; latin: string }
> = {
  finance: { viewBox: "0 0 220 280", card: [38, 48], hero: [54, 69], latin: "Cumulus nummorum" },
  mail: { viewBox: "0 0 160 220", card: [36, 48], hero: [47, 64], latin: "Epistola volans" },
  calendar: { viewBox: "66 40 148 220", card: [36, 48], hero: [48, 64], latin: "Discus mensis" },
  contacts: { viewBox: "0 0 240 280", card: [40, 48], hero: [52, 64], latin: "Myosotis amicorum" },
  health: { viewBox: "0 0 180 220", card: [39, 48], hero: [52, 66], latin: "Lamprocapnos salutis" },
  home: { viewBox: "0 0 160 225", card: [35, 48], hero: [46, 64], latin: "Domus lanterna" },
};

/** A card render with no DOM and no network: `renderToStaticMarkup` never mounts, so no query ever
 *  fires and the coverage figure sits in its <Skeleton> — which is exactly the state to assert the
 *  drawing in, since a mark must not depend on data arriving. `StaticRouter` is the SSR-safe router
 *  (`MemoryRouter` warns about useLayoutEffect on the server and buries the run in noise). */
function renderCard(sector: Sector): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StaticRouter location="/">
        <SectorCard sector={sector} connectors={[]} readByAgents={0} />
      </StaticRouter>
    </QueryClientProvider>,
  );
}

function renderHero(sector: Sector): string {
  return renderToStaticMarkup(
    <LensMasthead
      sector={sector}
      verdict="Nothing is connected here yet."
      lastSyncedLabel="never"
      transportCaption=""
      onSyncNow={() => {}}
      syncing={false}
    />,
  );
}

describe("the two tiers are real, not prose", () => {
  it.each(SECTORS)(
    "the Gatehouse sector card renders a specimen, never a scaled chip — %s",
    (sector) => {
      const markup = renderCard(sector);
      expect(markup).toContain(`viewBox="${SPECIMEN_BOX[sector].viewBox}"`);
      expect(markup).not.toContain(CHIP_VIEWBOX);
    },
  );

  it.each(SECTORS)("the sector-lens hero renders a specimen, never a scaled chip — %s", (sector) => {
    const markup = renderHero(sector);
    expect(markup).toContain(`viewBox="${SPECIMEN_BOX[sector].viewBox}"`);
    expect(markup).not.toContain(CHIP_VIEWBOX);
  });

  it("both SectorLens branches reach the hero through <LensMasthead>, so neither can drift", () => {
    // The lens renders its masthead from TWO branches — the zero-connection empty state and the
    // normal one. Pass 1's substitution lived in the shared component, so it hit both; a fix applied
    // to one branch only would leave the empty-sector hero wearing a scaled chip. Assert the shared
    // component is still the ONLY hero renderer rather than re-booting the whole page twice.
    const lens = readFileSync(new URL("../pages/lenses/SectorLens.tsx", import.meta.url), "utf8");
    const callSites = lens.match(/<LensMasthead\b/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    expect(lens).not.toContain("SectorChip");
  });

  it("the sector-lens hero names the specimen with its Latin binomial", () => {
    // The binomial was genuinely absent from the code — LensMasthead recorded it as a permanent gap
    // in a comment and shipped without it. It is half of what makes a hero a specimen plate.
    for (const sector of SECTORS) {
      expect(renderHero(sector)).toContain(SPECIMEN_BOX[sector].latin);
    }
  });

  it("every specimen keeps its own aspect ratio at both sizes", () => {
    // A specimen is SCALED, never re-laid-out, and the six drawings are not the same shape: forcing
    // them into one square box (the shape a `size={n}` number invites) squashes four of the six.
    for (const sector of SECTORS) {
      const { card, hero } = SPECIMEN_BOX[sector];
      expect(renderToStaticMarkup(<SectorSpecimen sector={sector} />)).toContain(
        `width="${card[0]}" height="${card[1]}"`,
      );
      expect(renderToStaticMarkup(<SectorSpecimen sector={sector} size="hero" />)).toContain(
        `width="${hero[0]}" height="${hero[1]}"`,
      );
      expect(card[0]).not.toBe(card[1]);
      expect(hero[0]).not.toBe(hero[1]);
    }
  });
});

/** Every `.ts`/`.tsx` file under `apps/web/src`, as [repo-relative-ish path, source]. */
function everySourceFile(): Array<[string, string]> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out: Array<[string, string]> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (/\.tsx?$/.test(entry.name)) out.push([rel, readFileSync(abs, "utf8")]);
    }
  };
  walk(root, "");
  return out;
}

describe("no source file scales a SectorChip past the documented ceiling", () => {
  it("finds no <SectorChip size={N}> with N above 20, anywhere under apps/web/src", () => {
    // The literal defect: `SectorCard.tsx` shipped `size={40}` and `LensMasthead.tsx` shipped 44.
    // The needle is assembled at runtime so this file cannot match itself and score a false pass.
    const needle = `<${"SectorChip"}`;
    const offenders: string[] = [];

    for (const [path, source] of everySourceFile()) {
      let from = source.indexOf(needle);
      while (from !== -1) {
        const close = source.indexOf(">", from);
        const tag = source.slice(from, close === -1 ? source.length : close);
        const size = tag.match(/\bsize=\{\s*(\d+)\s*\}/);
        if (size && Number(size[1]) > 20) offenders.push(`${path}: size={${size[1]}}`);
        from = source.indexOf(needle, from + needle.length);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("scans a real population, so an empty result means 'clean', not 'found nothing to read'", () => {
    const files = everySourceFile();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(([, source]) => source.includes(`<${"SectorChip"}`))).toBe(true);
  });
});
