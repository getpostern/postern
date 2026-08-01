import "../../api/test-dom";
import { readFileSync } from "node:fs";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AddASource } from "./AddASource";
import { PROVIDERS } from "./catalog";
import { conn, renderAt } from "./testutil";

const routes = [{ pattern: "/connect", element: <AddASource /> }];

beforeEach(() => {
  vi.spyOn(api, "healthz").mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Add a source (1WR-0)", () => {
  it("renders every group header and all nine provider cards", async () => {
    vi.spyOn(api, "listConnectors").mockResolvedValue([]);
    renderAt("/connect", routes);

    for (const header of ["Paste a token", "Sign in with the provider", "Hosted link", "On your device"]) {
      expect(screen.getByText(header)).toBeTruthy();
    }
    for (const name of ["iCloud", "Gmail", "SimpleFIN", "Home Assistant", "Microsoft", "Google", "Whoop", "Plaid", "Apple Health"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // No card should claim "connected" when nothing is connected.
    expect(screen.queryByText("connected")).toBeNull();
  });

  it("is CONNECTION-AWARE (#55): a source with a live connection shows a connected marker", async () => {
    vi.spyOn(api, "listConnectors").mockResolvedValue([conn({ provider: "apple", status: "active" })]);
    renderAt("/connect", routes);

    // The marker is data-driven, so it appears only after the connectors query resolves.
    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());
  });

  it("does not mark a REVOKED connection as connected", async () => {
    vi.spyOn(api, "listConnectors").mockResolvedValue([conn({ provider: "apple", status: "revoked" })]);
    renderAt("/connect", routes);
    // Let the query settle, then assert no card shows connected.
    await waitFor(() => expect(api.listConnectors).toHaveBeenCalled());
    expect(screen.queryByText("connected")).toBeNull();
  });
});

// #95 §1 / build-notes §17.2 — the last surface in the Console that drew a sector as an anonymous
// colour square. A user learns "sector = specimen + name" on every other surface, then meets a
// legend-less 6px dot at the moment they are choosing what to connect.
//
// TWO DIRECTIONS, deliberately. "A <SectorChip> renders" and "the dots are gone" are different
// claims: the defect that shipped was ADDITIVE-compatible — a card could carry both — and a test that
// only looks for the chip would bless that. So each `it` below pins one direction, and the CSS scan
// pins the third way it regresses (the rules coming back without the markup, or with the markup under
// a new class name).
describe("the Add-a-source card names each sector with its specimen, never a bare colour dot", () => {
  /** The chip's native box. `ProviderTile` uses 24/26-unit boxes, so this matches chips only. */
  const CHIP_BOX = 'svg[viewBox="0 0 14 14"]';

  function cardFor(name: string): HTMLElement {
    const card = screen.getByText(name).closest("a");
    expect(card).not.toBeNull();
    return card as HTMLElement;
  }

  it("draws exactly one specimen per sector on every card, beside the mono name-run", () => {
    vi.spyOn(api, "listConnectors").mockResolvedValue([]);
    renderAt("/connect", routes);

    // Nine cards, fourteen sector fan-outs — a real population, so an empty scan cannot pass.
    expect(PROVIDERS).toHaveLength(9);
    let total = 0;
    for (const def of PROVIDERS) {
      const card = cardFor(def.name);
      expect(card.querySelectorAll(CHIP_BOX)).toHaveLength(def.sectors.length);
      // The name-run stays: the specimens are the identity, the words are the legend.
      expect(card.textContent).toContain(def.cardSectorRun);
      total += def.sectors.length;
    }
    expect(total).toBeGreaterThan(10);
  });

  it("renders NO [data-sector] colour swatch anywhere on the page", () => {
    // The exact old markup: `<span className={styles.dot} data-sector={s} aria-hidden />`. Asserting
    // the chip appeared would not have caught a card that kept the dot as well.
    vi.spyOn(api, "listConnectors").mockResolvedValue([]);
    const { container } = renderAt("/connect", routes);
    expect(container.querySelectorAll("[data-sector]")).toHaveLength(0);
  });

  it("the sector inks no longer reach connect.module.css at all", () => {
    // The `--sector-*` tokens entered this stylesheet for one reason: painting those dots. The
    // specimens carry their own literal hexes inside the vector (SectorChip.tsx header), so a
    // `--sector-` reference reappearing here means a bare-ink swatch has come back — under whatever
    // class name. Read from disk because a CSS Module gives the test only mangled class names.
    const css = readFileSync(new URL("./connect.module.css", import.meta.url), "utf8");
    expect(css.length).toBeGreaterThan(1000); // not an empty read scoring a free pass
    expect(css).not.toMatch(/--sector-/);
    expect(css).not.toMatch(/\[data-sector/);
  });

  it("uses the SHARED SectorChip, at a size its own union allows", () => {
    // Not a new local mark, and not the compile-error size. §17.2 rules the compact 13px variant;
    // `SectorChipSize` is `15 | 16 | … | 20` and lives in src/marks/, so this surface renders 15 and
    // the residual is reported rather than closed by widening someone else's guard.
    const src = readFileSync(new URL("./AddASource.tsx", import.meta.url), "utf8");
    expect(src).toContain(`<${"SectorChip"} key={s} sector={s} size={15} />`);
  });
});
