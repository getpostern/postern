// A TYPE-LEVEL test (validated by `tsc --noEmit`, the typecheck gate): `filtered` cannot be
// constructed without the total it filtered from. If the type ever loosened to allow it, the
// expect-error directive below would go unused and typecheck would fail — which is exactly the
// guard build-notes §14.1e wants: a filtered-empty state that cannot quote its total is how an
// empty screen reads as data loss. (This comment deliberately avoids starting a line with the
// directive text, which TypeScript would otherwise parse as a real directive.)

import { describe, expect, it } from "vitest";
import { ZeroState, type ZeroStateKind } from "./ZeroState";

// Legal: filtered WITH its total (null is a valid "not served" total, but the key must be present).
const ok: ZeroStateKind = { kind: "filtered", totalHeld: 2481, freshnessLine: "synced 4m ago" };
const okNull: ZeroStateKind = { kind: "filtered", totalHeld: null, freshnessLine: null };

// @ts-expect-error — `filtered` REQUIRES `totalHeld`; omitting it is a compile error.
const missingTotal: ZeroStateKind = { kind: "filtered", freshnessLine: "x" };

// Legal: unconnected carries an action, never a total.
const unconnected: ZeroStateKind = { kind: "unconnected", action: { label: "Add a source →", onAct: () => {} } };

void ok;
void okNull;
void missingTotal;
void unconnected;

describe("ZeroState types", () => {
  it("exports the component (the type assertions above are the real test, checked by tsc)", () => {
    expect(typeof ZeroState).toBe("function");
  });
});
