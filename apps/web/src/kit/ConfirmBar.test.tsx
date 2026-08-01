// ConfirmBar gates the destructive seal (#70, #74) — the two guards are REAL, not decorative:
// with requireTyped the token must match, and with exportFirst the export must be TAKEN first
// (build-notes §4 "export-first is enforced"; the #17 data-loss lesson). Both must clear together.

import "../api/test-dom"; // jsdom global before React/testing-library load
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmBar } from "./ConfirmBar";

afterEach(cleanup);

const seal = () => screen.getByRole("button", { name: /^(Erase everything|Working…)$/ });

describe("ConfirmBar — the destructive gate", () => {
  it("export-first is ENFORCED: the seal stays disabled until the export is taken", () => {
    const onExport = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmBar
        verb="Erase everything"
        consequence="All cached data goes."
        exportFirst={{ label: "Export everything", onExport }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // Before export: disabled, and clicking does nothing.
    expect((seal() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(seal());
    expect(onConfirm).not.toHaveBeenCalled();

    // Take the export → the gate clears and the seal enables.
    fireEvent.click(screen.getByRole("button", { name: "Export everything" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect((seal() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(seal());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("both guards compose: exportFirst AND requireTyped must clear before the seal enables", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmBar
        verb="Erase everything"
        consequence="All cached data goes."
        requireTyped="ERASE"
        exportFirst={{ label: "Export everything", onExport: () => {} }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // Type the token but don't export yet → still gated.
    fireEvent.change(screen.getByPlaceholderText("ERASE"), { target: { value: "ERASE" } });
    expect((seal() as HTMLButtonElement).disabled).toBe(true);
    // Export → both guards clear.
    fireEvent.click(screen.getByRole("button", { name: "Export everything" }));
    expect((seal() as HTMLButtonElement).disabled).toBe(false);
  });

  it("a wrong typed token keeps the seal disabled even after export", () => {
    render(
      <ConfirmBar
        verb="Erase everything"
        consequence="All cached data goes."
        requireTyped="ERASE"
        exportFirst={{ label: "Export everything", onExport: () => {} }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export everything" }));
    fireEvent.change(screen.getByPlaceholderText("ERASE"), { target: { value: "erase" } }); // wrong case
    expect((seal() as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── #134: revealing the bar brings it into view ─────────────────────────────────────────────────
//
// Every ConfirmBar mounts in response to an operator act, and several hosts render it as the LAST
// child of a long page — below the fold on a multi-source gateway, the operator clicked Remove and
// saw nothing happen (live, 2026-07-30). The fix lives HERE so both reveal sites (SourcesPage
// remove, ConnectionDetail disconnect/revoke) and every future host inherit it.
describe("ConfirmBar — reveal brings it into view (#134)", () => {
  /** Spy `scrollIntoView` on Element.prototype for the duration of `body` — the SourcesPage #112
   *  pattern: jsdom has no layout, so the method does not exist there; stubbing lets the test
   *  assert the CALL (the bar asked to be seen) without a scroll position jsdom cannot have. */
  function withScrollSpy<T>(body: (calls: Element[]) => T): T {
    const calls: Element[] = [];
    const proto = window.Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = "scrollIntoView" in proto;
    proto.scrollIntoView = function spy(this: Element): void {
      calls.push(this);
    };
    try {
      return body(calls);
    } finally {
      if (!had) delete proto.scrollIntoView;
    }
  }

  it("scrolls itself into view on mount — ONCE, not on every re-render", () => {
    // MUTATION: delete the mount effect in ConfirmBar.tsx → zero calls, red. Move it to run on
    // every render (drop the empty deps) → two-plus calls after typing, red.
    withScrollSpy((calls) => {
      render(
        <ConfirmBar
          verb="Remove it"
          consequence="It goes."
          requireTyped="REMOVE"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(calls).toHaveLength(1);
      // …and the element that asked is the bar itself (it contains the typed-confirm affordance).
      expect(calls[0].textContent).toContain("Type REMOVE to confirm");
      // A re-render (typing the token) must never yank the viewport again.
      fireEvent.change(screen.getByPlaceholderText("REMOVE"), { target: { value: "REM" } });
      expect(calls).toHaveLength(1);
    });
  });

  it("mounts safely where scrollIntoView does not exist (bare jsdom — the guard itself)", () => {
    // No spy installed: jsdom's Element has no scrollIntoView, so this render IS the guard's test.
    render(<ConfirmBar verb="Remove it" consequence="It goes." onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
  });
});
