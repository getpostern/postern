// LedgerTable accessibility is a REQUIREMENT, not a later pass (#69). These assertions pin it:
// the container is role="table" so cell/columnheader structure survives; a sortable header is a
// real <button> and its role="columnheader" carries aria-sort (invalid on the button itself); a
// drill row is a keyboard-activatable role="row" (tabIndex 0, Enter/Space) — never a click-only
// <div>, and never role="button" (which would flatten the cells into one name for a screen reader).

import "../api/test-dom"; // jsdom global before React/testing-library load
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerTable, type LedgerColumn } from "./LedgerTable";

interface Row {
  id: string;
  agent: string;
  tool: string;
}

const columns: LedgerColumn<Row>[] = [
  { field: "agent", header: "Agent", render: (r) => r.agent, width: "120px", sortable: true },
  { field: "tool", header: "Tool", render: (r) => r.tool },
];

const rows: Row[] = [{ id: "r1", agent: "myclaw", tool: "query" }];

afterEach(cleanup);

describe("LedgerTable — structural accessibility", () => {
  it("a sortable header is a <button> with aria-sort, and clicking it sorts", () => {
    const onSort = vi.fn();
    render(
      <LedgerTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onSort={onSort}
        sort={{ field: "agent", dir: "asc" }}
      />,
    );

    // The container exposes a table structure to assistive tech.
    expect(screen.getByRole("table")).not.toBeNull();

    // The sort control is a real button; aria-sort is carried by its columnheader, not the button.
    const header = screen.getByRole("button", { name: /Agent/ });
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("aria-sort")).toBeNull();
    expect(screen.getByRole("columnheader", { name: /Agent/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );

    fireEvent.click(header);
    expect(onSort).toHaveBeenCalledWith("agent");
  });

  it("a non-active sortable header reports aria-sort=none on its columnheader", () => {
    render(
      <LedgerTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onSort={vi.fn()}
        sort={{ field: "tool", dir: "desc" }}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Agent/ }).getAttribute("aria-sort")).toBe(
      "none",
    );
  });

  it("a drill row is a keyboard-activatable role=row (tabbable, Enter and Space), not a button", () => {
    const onOpen = vi.fn();
    render(<LedgerTable columns={columns} rows={rows} rowKey={(r) => r.id} onOpen={onOpen} />);

    // The cell text's nearest row is the drill target — role="row" preserves the cell structure
    // that role="button" would flatten.
    const row = screen.getByText("myclaw").closest('[role="row"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("tabindex")).toBe("0");
    // It is NOT a button — that role would collapse the cells into one accessible name.
    expect(row!.getAttribute("role")).toBe("row");

    fireEvent.keyDown(row!, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row!, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(row!);
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
  });

  it("a non-drill table exposes no interactive rows or buttons (nothing is falsely interactive)", () => {
    render(<LedgerTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    // No onSort -> no buttons at all; no onOpen -> the body row is a plain, non-tabbable row.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const row = screen.getByText("myclaw").closest('[role="row"]');
    expect(row!.getAttribute("tabindex")).toBeNull();
  });
});

// A focus ring is not a DOM fact, so it is asserted where it is decided: the stylesheet. jsdom has
// no layout and no cascade, and a screenshot would be reading a value off a picture (design law).
describe("LedgerTable — the focus ring survives the scroll container", () => {
  const moduleCss = readFileSync(
    fileURLToPath(new URL("./LedgerTable.module.css", import.meta.url)),
    "utf8",
  );
  const baseCss = readFileSync(
    fileURLToPath(new URL("../styles/base.css", import.meta.url)),
    "utf8",
  );

  /** The ring's outer reach in px: `outline-width + outline-offset`, read from the ONE global
   *  declaration so this test tracks base.css instead of hard-coding 5. */
  function ringReachPx(): number {
    const width = /:focus-visible\s*\{[^}]*outline:\s*(\d+)px/.exec(baseCss);
    const offset = /:focus-visible\s*\{[^}]*outline-offset:\s*(\d+)px/.exec(baseCss);
    expect(width).not.toBeNull();
    expect(offset).not.toBeNull();
    return Number(width![1]) + Number(offset![1]);
  }

  it("a focused row's ring is not clipped by the scroll container", () => {
    // `.scroll` sets overflow-x, which per CSS Overflow 3 makes the block axis clip too, and an
    // outline never joins scrollable overflow — so with no room the sort button's ring and the
    // drill row's ring were both clipped to nothing. The padding must reach at least as far as the
    // ring does.
    //
    // And it must be OUTSET. `overflow-clip-margin` would move nothing, but it applies only to
    // `overflow: clip`, never to `auto` — so the room has to come from padding, and under
    // `box-sizing: border-box` bare padding narrows `.head`'s full-width border-bottom by twice the
    // ring's reach on all eight LedgerTable surfaces. The equal negative margin and the widened
    // `width` put the content box back exactly where artboard 2QU-0 draws it. Caught at review
    // 2026-07-25; asserted together so a later edit cannot drop the compensation and silently
    // re-narrow every ledger rule in the Console.
    const scroll = /\.scroll\s*\{([^}]*)\}/.exec(moduleCss);
    expect(scroll).not.toBeNull();
    const block = scroll![1];
    expect(block).toMatch(/overflow-x:\s*auto/);
    const pad = /(?:^|[^-])padding:\s*(\d+)px/.exec(block);
    expect(pad).not.toBeNull();
    const padPx = Number(pad![1]);
    expect(padPx).toBeGreaterThanOrEqual(ringReachPx());

    const margin = /(?:^|[^-])margin:\s*-(\d+)px/.exec(block);
    expect(margin).not.toBeNull();
    expect(Number(margin![1])).toBe(padPx);
    expect(block).toMatch(new RegExp(`width:\\s*calc\\(100% \\+ ${padPx * 2}px\\)`));
  });

  it("does not re-declare the one global ring to work around the clipping", () => {
    // base.css: "a component that re-declares this ring is drift; a component that removes it is a
    // defect." Padding the clip box is the fix; a local outline is the shortcut that causes drift.
    expect(moduleCss).not.toMatch(/outline\s*:/);
  });
});
