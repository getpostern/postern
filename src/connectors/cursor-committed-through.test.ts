// Cross-connector safety regression (wave 11c, ADR 0016): incremental mid-stream cursor checkpointing
// is OPT-IN via SyncPolicy.cursorCommittedThrough. Only Microsoft (verified per-page committed-through)
// opts in. Plaid/SimpleFIN/Whoop attach a batch/window-END cursor to EVERY record, so persisting it
// mid-stream would skip the uncommitted records on resume (Plaid: permanent loss) — they MUST stay
// cycle-end-only. This test pins that contract so a future edit can't silently re-introduce the hazard.

import { describe, it, expect } from "vitest";
import { MicrosoftConnector } from "./microsoft.js";
import { PlaidConnector } from "./plaid.js";
import { SimpleFinConnector } from "./simplefin.js";
import { WhoopConnector } from "./whoop.js";

describe("cursorCommittedThrough — opt-in safety flag", () => {
  it("Microsoft opts in (per-page committed-through cursor)", () => {
    expect(new MicrosoftConnector().policy.cursorCommittedThrough).toBe(true);
  });

  it("Plaid does NOT opt in (batch-final opaque cursor on every record → permanent-loss hazard)", () => {
    expect(new PlaidConnector().policy.cursorCommittedThrough).not.toBe(true);
  });

  it("SimpleFIN does NOT opt in (window-end cursor on every record)", () => {
    expect(new SimpleFinConnector().policy.cursorCommittedThrough).not.toBe(true);
  });

  it("Whoop does NOT opt in (overlap-window cursor on every record)", () => {
    expect(new WhoopConnector().policy.cursorCommittedThrough).not.toBe(true);
  });
});
