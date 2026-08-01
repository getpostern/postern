// WHAT AGENTS CAN DO — #58 (the act half) and the last-seen degradation. These pin the exact sins the
// redesign exists to fix: CAN ACT is never blank and never reads "none"; CAN READ never renders a
// not-served last-seen as "never".
//
// #58 ROUND TWO is pinned here too. `GET /api/actions` now serves `{ actions, count, truncated }`, and
// the two ways to get it wrong are opposites:
//   · drop `truncated` → a trimmed, id-sorted PREFIX is presented as the whole surface (a whole
//     trailing domain can be missing), which is the silent-truncation defect already removed once
//     from the MCP surface;
//   · fold an OUTAGE or a NARROWED-EMPTY answer into "read-only" → the original #58 lie, reprinted.

import "../../api/test-dom";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { AgentsBand, type ActCatalog, type ActNarrowing } from "./AgentsBand";

afterEach(cleanup);

/** A narrowing that records nothing — for the arms where no narrowing is expected to be drawn. */
const noNarrow: ActNarrowing = { value: "", onChange: () => {} };

/** Two specs, enough for "a catalog rendered its members" and for a plural count. */
const TWO: ActCatalog = {
  kind: "catalog",
  truncated: false,
  specs: [
    { id: "light.turn_on", description: "dim or colour any light", params: [] },
    { id: "lock.lock", description: "doors & deadbolts", params: [] },
  ],
};

describe("CAN ACT — the block is present, honest, and never 'none' (#58)", () => {
  it("a gateway with no catalog route renders the block in full, in the reader's words", () => {
    const { container } = render(
      <AgentsBand readAgents={[]} narrowing={noNarrow} actions={{ kind: "not-served" }} />,
    );
    // The block exists (shipping it blank is the sin — a silent lane implies "nothing to act on").
    expect(screen.getByText("Can act")).not.toBeNull();
    // It states the limit as a whole sentence, and ends where the person can act.
    expect(
      screen.getByText(/build from before it could list what agents can do here/i),
    ).not.toBeNull();
    expect(container.textContent).toMatch(/update the gate/i);
    // …and NEVER the claim "none".
    expect(screen.queryByText("none")).toBeNull();
    // #106 §2c — and never the wire's own vocabulary, which is what this lane used to print verbatim
    // from `NotServedError.message`. The client still throws exactly that sentence; a person never
    // reads it. MUTATION: render `actions.message` again (or re-add the field) → RED here.
    expect(container.textContent).not.toMatch(/no route|not served|mirror|bearer|list_actions/i);
  });

  it("a served empty catalog (the five read-only sectors) reads read-only, still never 'none'", () => {
    const { container } = render(
      <AgentsBand readAgents={[]} narrowing={noNarrow} actions={{ kind: "readonly" }} />,
    );
    // The whole fact in one sentence: the gate answered, and its list here is empty.
    expect(screen.getByText(/Read-only\. No actions are exposed/)).not.toBeNull();
    expect(screen.queryByText("none")).toBeNull();
    // #106 §2c — the footnote `actions: [ ]` is deleted: the wire's notation as a caption, saying
    // nothing the sentence above had not, in a form only we can read.
    expect(container.textContent).not.toMatch(/actions: ?\[/);
  });

  it("a served catalog (home) lists the actions with a count", () => {
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={TWO} />);
    expect(screen.getByText("2 actions")).not.toBeNull();
    expect(screen.getByText("light.turn_on")).not.toBeNull();
    expect(screen.getByText("dim or colour any light")).not.toBeNull();
  });

  it("a read still IN FLIGHT claims nothing — not read-only, not not-served", () => {
    // The old code defaulted the whole lane to the not-served sentence until the query settled, which
    // was honest while the route did not exist and became a lie the day it landed: every lens's first
    // paint would report "this gateway has no route".
    const { container } = render(
      <AgentsBand readAgents={[]} narrowing={noNarrow} actions={{ kind: "loading" }} />,
    );
    expect(screen.getByText("Can act")).not.toBeNull();
    expect(container.textContent).not.toMatch(/read-only/i);
    expect(container.textContent).not.toMatch(/no actions are exposed/i);
    // Rebound to the not-served arm's NEW sentence (#106 §2c): "not served" is no longer printed by
    // any arm, so a negative on those words could not fail and would be a guard in name only.
    expect(container.textContent).not.toMatch(/build from before/i);
  });

  it("a FAILED read is an outage, not an absent capability, and invents no reason", () => {
    const withMessage = render(
      <AgentsBand
        readAgents={[]}
        narrowing={noNarrow}
        actions={{ kind: "error", message: "gateway unreachable" }}
      />,
    );
    expect(screen.getByText(/could not be read/i)).not.toBeNull();
    expect(screen.getByText("gateway unreachable")).not.toBeNull();
    // The two sentences it must NOT borrow.
    expect(withMessage.container.textContent).not.toMatch(/read-only/i);
    expect(withMessage.container.textContent).not.toMatch(/no route/i);

    // With no served message the lane must be EXACTLY the message-bearing lane minus that message —
    // any invented cause can only ADD text, and that is the shape this repo has shipped before
    // (InspectorPage's fabricated "the gateway did not answer" left 644 tests green).
    const full = withMessage.container.textContent ?? "";
    withMessage.unmount();
    cleanup();
    const noMessage = render(
      <AgentsBand readAgents={[]} narrowing={noNarrow} actions={{ kind: "error", message: null }} />,
    );
    expect(noMessage.container.textContent).toBe(full.replace("gateway unreachable", ""));
  });
});

// The cap cuts an ID-SORTED list, so what came back is a PREFIX and a whole trailing domain can be
// gone (every `switch.*` missing while `light.*` survives). A surface that shows that as the complete
// catalog re-commits a defect this project already removed from the MCP surface once.
describe("CAN ACT — a TRIMMED catalog says so, and offers the narrowing that fixes it (#58)", () => {
  const trimmed: ActCatalog = { ...TWO, truncated: true };

  it("a trimmed catalog never quotes its count as a total", () => {
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={trimmed} />);
    // "2 actions" is a claim about the catalog; "showing 2" is a claim about this response.
    expect(screen.queryByText("2 actions")).toBeNull();
    expect(screen.getByText("showing 2")).not.toBeNull();
  });

  it("a trimmed catalog states that whole groups may be missing", () => {
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={trimmed} />);
    expect(screen.getByText(/whole groups after the last one above may be missing/i)).not.toBeNull();
  });

  it("an UNtrimmed catalog says none of that — the notice is conditional, not furniture", () => {
    // Without this, hardcoding the truncation notice would pass every assertion above.
    const { container } = render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={TWO} />);
    expect(container.textContent).not.toMatch(/may be missing/i);
    expect(container.textContent).not.toMatch(/showing 2/);
    // …and no narrowing control is drawn when nothing was cut and nothing is narrowed.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the narrowing is a REAL control — typing in it reports the value the wire needs", () => {
    // This repo has shipped a button wired to nothing (#100 item 5), so the assertion is on the
    // callback, not on the input existing.
    const onChange = vi.fn();
    render(<AgentsBand readAgents={[]} narrowing={{ value: "", onChange }} actions={trimmed} />);
    const box = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "switch" } });
    expect(onChange).toHaveBeenCalledWith("switch");
  });

  it("its examples come off the WIRE, never from a hardcoded vocabulary", () => {
    // `domain` belongs to whichever connector serves the sector (HA: light/switch/lock). Typing that
    // vocabulary into this sector-generic component would invent an answer for every other connector.
    const withDomains: ActCatalog = {
      kind: "catalog",
      truncated: true,
      specs: [
        { id: "home.valve.open", description: "x", params: [], domain: "valve" },
        { id: "home.vacuum.start", description: "y", params: [], domain: "vacuum" },
      ],
    };
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={withDomains} />);
    const label = screen.getByText(/show one group in full/i).textContent ?? "";
    expect(label).toContain("valve");
    expect(label).toContain("vacuum");
    expect(label).not.toMatch(/light|switch|lock/i);
  });

  it("no served domains → the label offers no example rather than a plausible-looking one", () => {
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={trimmed} />);
    // `trimmed`'s specs carry no `domain`, so there is nothing honest to suggest.
    expect(screen.getByText("Show one group in full")).not.toBeNull();
  });

  it("an ACTIVE narrowing stays clearable even when its answer came back complete", () => {
    // The trap: gate the control on `truncated` alone and a narrowed-to-complete answer strands the
    // person inside the filter with nothing to press.
    const onChange = vi.fn();
    render(<AgentsBand readAgents={[]} narrowing={{ value: "light", onChange }} actions={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /show everything again/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("a narrowing that matched nothing is a fact about the FILTER, never 'read-only'", () => {
    const { container } = render(
      <AgentsBand
        readAgents={[]}
        narrowing={{ value: "nosuch", onChange: () => {} }}
        actions={{ kind: "narrowed-empty", narrow: "nosuch" }}
      />,
    );
    expect(screen.getByText(/nothing here is called/i)).not.toBeNull();
    expect(container.textContent).toContain("nosuch");
    expect(container.textContent).not.toMatch(/read-only/i);
    expect(container.textContent).not.toMatch(/no actions are exposed/i);
    // …and the way out is present.
    expect(screen.getByRole("button", { name: /show everything again/i })).not.toBeNull();
  });
});

describe("CAN READ — last-seen degrades honestly (#89 / #16.6)", () => {
  // #106 §2a — an unserved last-seen prints NOTHING. It used to print "last read not served yet" on
  // every agent row of every one of the six lenses: our word for our wire, where a time was owed.
  it("an unserved last-seen prints nothing at all — no sentence, and still NEVER 'never'", () => {
    const { container } = render(
      <AgentsBand
        readAgents={[{ agentId: "myclaw", lastSeen: undefined, lastSeenLabel: null }]}
        narrowing={noNarrow}
        actions={{ kind: "readonly" }}
      />,
    );
    // the reader is still listed — hiding a value is not hiding the agent
    expect(screen.getByText("myclaw")).not.toBeNull();
    expect(container.textContent).not.toMatch(/not served|last read/i);
    // A quiet agent must not be reported as "never" either.
    expect(container.textContent).not.toMatch(/never/i);
    // WHERE, not just WHAT: the row is the dot and the id, and nothing else. An empty span (or a "—")
    // would satisfy every assertion above while still printing furniture.
    const row = screen.getByText("myclaw").parentElement!;
    expect(row.childElementCount).toBe(2);
  });

  it("a served last-seen renders it relative", () => {
    render(
      <AgentsBand
        readAgents={[{ agentId: "claude-ai", lastSeen: "2026-07-23T09:00:00Z", lastSeenLabel: "36m ago" }]}
        narrowing={noNarrow}
        actions={{ kind: "not-served" }}
      />,
    );
    expect(screen.getByText("read 36m ago")).not.toBeNull();
  });

  it("no granting agents reads as an empty domain, in the ONE sector-scoped phrase (#100 item 10)", () => {
    // The full sentence, not a substring both the old and the new copy satisfy: the finding is that
    // the Console had THREE phrasings of "zero agents here", so an assertion that cannot tell them
    // apart is an assertion that cannot fail.
    render(<AgentsBand readAgents={[]} narrowing={noNarrow} actions={{ kind: "not-served" }} />);
    expect(screen.getByText("No agents hold keys here.")).not.toBeNull();
    expect(screen.queryByText(/holds keys to this domain/)).toBeNull();
  });
});
