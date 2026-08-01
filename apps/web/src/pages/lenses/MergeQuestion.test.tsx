// Confirm-a-merge (build-notes §12.3): do NOT ask a question without showing the evidence to answer
// it. Both candidate rows must render with their served fields; the confirm is an offer that fires a
// handler; a missing pair shows "nothing to confirm", never a fabricated question.

import "../../api/test-dom";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { MergeQuestion } from "./MergeQuestion";

afterEach(cleanup);

const sides = [
  { providerLabel: "via Plaid", name: "Chase Sapphire Checking", detail: "USD · ••••8830" },
  { providerLabel: "via SimpleFIN", name: "CHASE CHECKING", detail: "USD · no last-4 published" },
] as const;

describe("MergeQuestion — the evidence and the answer", () => {
  it("shows BOTH candidate rows with their served detail (the evidence)", () => {
    render(<MergeQuestion sides={[sides[0], sides[1]]} onConfirm={vi.fn()} onKeepSeparate={vi.fn()} />);
    expect(screen.getByText("via Plaid")).not.toBeNull();
    expect(screen.getByText("via SimpleFIN")).not.toBeNull();
    expect(screen.getByText("Chase Sapphire Checking")).not.toBeNull();
    expect(screen.getByText("USD · no last-4 published")).not.toBeNull();
    expect(screen.getByText(/Is this the same account/)).not.toBeNull();
  });

  it("confirm and keep-separate fire their handlers", () => {
    const onConfirm = vi.fn();
    const onKeep = vi.fn();
    render(<MergeQuestion sides={[sides[0], sides[1]]} onConfirm={onConfirm} onKeepSeparate={onKeep} />);
    fireEvent.click(screen.getByRole("button", { name: /the same account/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Keep them separate/i }));
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("a busy confirm is disabled (no double-submit of an irreversible-feeling action)", () => {
    render(<MergeQuestion sides={[sides[0], sides[1]]} onConfirm={vi.fn()} onKeepSeparate={vi.fn()} busy />);
    const btn = screen.getByRole("button", { name: /Merging/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("no matching pair asks nothing — it says there is nothing to confirm", () => {
    render(<MergeQuestion sides={null} onConfirm={vi.fn()} onKeepSeparate={vi.fn()} />);
    expect(screen.getByText(/Nothing to confirm/)).not.toBeNull();
    expect(screen.queryByText(/Is this the same account/)).toBeNull();
  });
});
