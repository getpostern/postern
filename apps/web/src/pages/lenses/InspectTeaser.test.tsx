// The INSPECT teaser after #107 §2 — the column-hint row is DELETED, and the delete has to stay
// deleted.
//
// The defect the operator hit: the teaser printed the sector's column names UNDER the
// "Open the inspector →" link — "the columns of a thing you have not opened yet" — and the names came
// from `INSPECT_COLUMN_HINTS`, a hardcoded compile-time map. The ruling was to delete the row, the
// map and the CSS, not to render the real columns (`get_schema` is bearer-gated, #89).
//
// A test that only asserted "the link renders" would pass with the row back. So this file pins three
// different things, each of which fails on a different way of undoing the delete:
//
//   1. the teaser's ENTIRE text, per sector, is exactly title + sub + link — any re-added furniture,
//      column names or otherwise, breaks the equality;
//   2. the teaser has exactly ONE element child — so an added row or hairline fails even when it
//      carries no text at all (the old `.rule` was an empty aria-hidden div);
//   3. the map is GONE from the module and from the source, and the three CSS classes are gone from
//      the stylesheet — so "unrendered but still there, waiting" is a red run, not a green one.
//
// And the capability the fix must NOT remove — the link to the inspector, per sector — is asserted
// first, because a delete that also deleted the link would satisfy 1–3 and be a worse bug.

import "../../api/test-dom"; // jsdom global before React / testing-library load
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InspectTeaser } from "./InspectTeaser";
import * as lensmeta from "./lensmeta";
import { INSPECT_SUB } from "./lensmeta";
import { SECTORS } from "../../api/types";

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));

function renderTeaser(sector: (typeof SECTORS)[number]) {
  return render(
    <MemoryRouter>
      <InspectTeaser sector={sector} />
    </MemoryRouter>,
  );
}

describe("<InspectTeaser> — the one affordance it owns", () => {
  it("still links to that sector's inspector, for every sector", () => {
    for (const sector of SECTORS) {
      const { container } = renderTeaser(sector);
      const link = container.querySelector("a");
      expect(link, `no inspector link on the ${sector} teaser`).not.toBeNull();
      expect(link!.getAttribute("href")).toBe(`/sectors/${sector}/inspect`);
      expect(link!.textContent).toContain("Open the inspector");
      cleanup();
    }
  });
});

describe("<InspectTeaser> — no column names, in any sector (#107 §2)", () => {
  // The exact copy the band is allowed to carry. Anything else in the DOM is furniture.
  const allowed = `Inspect the records${INSPECT_SUB}Open the inspector →`;

  it("renders exactly the title, the sub and the link — nothing else", () => {
    for (const sector of SECTORS) {
      const { container } = renderTeaser(sector);
      expect(container.textContent, `unexpected text on the ${sector} teaser`).toBe(allowed);
      cleanup();
    }
  });

  it("has exactly one element child, so an EMPTY re-added row or hairline still fails", () => {
    for (const sector of SECTORS) {
      const { container } = renderTeaser(sector);
      const section = container.querySelector("section");
      expect(section).not.toBeNull();
      expect(section!.children.length, `extra child element on the ${sector} teaser`).toBe(1);
      cleanup();
    }
  });

  // The literal strings the deleted map used to print, per sector. Written out here rather than
  // imported, because the point is that there is nothing left to import.
  const deleted: Record<string, string[]> = {
    finance: ["Account", "Name", "Balance", "Source", "Type"],
    mail: ["From", "Subject", "Folder", "Source", "Date"],
    calendar: ["Start", "Title", "End", "Location"],
    contacts: ["Name", "Email", "Phone", "Org"],
    health: ["Time", "Type", "Value", "Unit", "Source"],
    home: ["Entity", "State", "Domain", "Area", "Updated"],
  };

  it("prints none of the column names it used to print", () => {
    // A word-boundary match would NOT bite here and that was this test's own first bug: the hint row
    // rendered the names as adjacent spans with only a CSS gap between them, so `textContent`
    // concatenates to "AccountNameBalanceSourceType" and every name loses its right-hand boundary.
    // Plain CASE-SENSITIVE substring is both simpler and stronger — verified against the band's whole
    // vocabulary: the only column name that appears in the copy at all is "source" (lower-case, in
    // "as the source served it"), and the hint row rendered "Source".
    for (const sector of SECTORS) {
      const { container } = renderTeaser(sector);
      // Small-caps is a CSS text-transform, so the DOM keeps the authored case; check the upper-case
      // form too, so a re-added row cannot hide behind either spelling.
      const text = container.textContent ?? "";
      for (const column of deleted[sector]!) {
        expect(text, `${sector}: "${column}" is back`).not.toContain(column);
        expect(text, `${sector}: "${column}" is back, upper-cased`).not.toContain(column.toUpperCase());
      }
      cleanup();
    }
  });
});

describe("the column-hint map is DELETED, not merely unrendered (#107 §2)", () => {
  it("lensmeta exports no column-hint map", () => {
    expect(Object.keys(lensmeta)).not.toContain("INSPECT_COLUMN_HINTS");
    // The line the teaser DOES still need is untouched — deleting the map must not delete the copy.
    expect(lensmeta.INSPECT_SUB.length).toBeGreaterThan(0);
  });

  it("the identifier appears in no lens source except a comment forbidding it", () => {
    // Comments are stripped: prose explaining the delete is not the map coming back.
    const strip = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const file of ["lensmeta.ts", "InspectTeaser.tsx", "SectorLens.tsx"]) {
      const code = strip(readFileSync(join(here, file), "utf8"));
      expect(code, `${file} still references the deleted map`).not.toContain("INSPECT_COLUMN_HINTS");
    }
  });

  it("the stylesheet carries no rule/colHints/colHint class any more", () => {
    const css = readFileSync(join(here, "InspectTeaser.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      " ",
    );
    for (const cls of [".rule", ".colHints", ".colHint"]) {
      expect(css, `${cls} is still declared`).not.toContain(cls);
    }
    // and the classes the band still needs are all present, so this is not passing on an empty file
    for (const cls of [".teaser", ".top", ".lead", ".title", ".sub", ".open"]) {
      expect(css).toContain(cls);
    }
  });
});
