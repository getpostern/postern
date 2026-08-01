// COVERAGE — the sector's `query()` counts, one figure per REGISTRY object. Figures are service
// truth from `useSectorCoverage` (dedup-correct — NOT a sum of per-connection cached_count, which
// triple-counts a merged finance account); an undefined figure is LOADING and the frozen
// <CoverageStrip> renders a <Skeleton>, never an em-dash at hero size (#60).

import { SectionRule } from "../../shell";
import { CoverageStrip } from "../../kit";
import type { Sector } from "../../api/types";
import { SECTOR_COVERAGE, footprintGloss } from "./lensmeta";
import band from "./band.module.css";

export function CoverageBand({
  sector,
  counts,
}: {
  sector: Sector;
  /** Keyed by REGISTRY object; `undefined` while any object is still loading (a partial total is
   *  never shown as a whole). */
  counts: Record<string, number> | undefined;
}): JSX.Element {
  const objects = SECTOR_COVERAGE[sector];
  const items = objects.map((o) => ({
    label: o.label,
    // undefined => the strip shows a Skeleton; a real count => the number.
    value: counts ? (counts[o.object] ?? 0) : undefined,
    sub: o.sub ? o.sub : undefined,
  }));

  return (
    <section className={band.band}>
      <SectionRule label="Coverage" gloss={footprintGloss(sector)} />
      <CoverageStrip items={items} />
    </section>
  );
}
