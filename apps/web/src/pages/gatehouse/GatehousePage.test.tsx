// The Gatehouse glance verdict — behaviour a static render can't show.
//
// These pin the findings the page owns: #63 (no grants table — grants are ONE clause), #60 (counts
// are query() truth with a Skeleton, never a bare em-dash), the exceptions-first verdict SENTENCE,
// the attention band's DEGRADED button (reconnect_kind not served → "Manage this connection →", never
// the guessed/imperative "Reconnect"), and the last-seen degradation — where the rule is now that an
// UNSERVED passage prints nothing at all (#106 §2a), a served-but-never-used key still prints "never",
// and neither may be reduced from the capped audit feed (the #16.6 lie a fixture would otherwise hide).

import "../../api/test-dom"; // jsdom global before React / testing-library load
import { readFileSync } from "node:fs";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import { Gatehouse } from "./GatehousePage";
import { sourceGroupHref } from "../sources/model";
import type {
  Agent,
  AuditRow,
  ConnectorStatus,
  ExposureStatus,
  Freshness,
  QueryResult,
} from "../../api/types";

/** The gate's own MCP address, as the GATEWAY reports it. Deliberately not the old baked-in :8788
 *  constant, so a re-introduced build-time guess cannot accidentally agree with the fixture. */
const SERVED_ENDPOINT = "http://localhost:9191/mcp";
const PUBLIC_URL = "https://gate.example.ts.net/mcp";

function exposureStatus(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: SERVED_ENDPOINT,
    publishedRoutes: [],
    problem: null,
    ...over,
  };
}

const fresh = (state: Freshness["state"], over: Partial<Freshness> = {}): Freshness => ({
  state,
  last_heard_at: "2026-07-21T12:00:00Z",
  next_expected_at: null,
  stream_state: null,
  error: null,
  ...over,
});

/**
 * A served connector row.
 *
 * `credentialId` DERIVES FROM `connectionId` by default, and that is load-bearing (#91): the fixture
 * used to hardcode `credentialId: "cred_fixture"` on every row, so a SimpleFIN connection and a WHOOP
 * connection came out of it sharing one credential — a shape the wire cannot produce (a credential has
 * exactly one provider) and which folds two different sources into one. Any cell that means "one
 * credential fanned across sectors" now has to say so, by passing a shared `credentialId` on purpose.
 */
function conn(over: Partial<ConnectorStatus> & { freshness?: Freshness }): ConnectorStatus {
  const connectionId = over.connectionId ?? "c1";
  return {
    connectionId,
    provider: "simplefin",
    sector: "finance",
    status: "active",
    last_synced_at: "2026-07-21T12:00:00Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "ok", expires_at: null },
    credentialId: `cred-${connectionId}`,
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    freshness: fresh("ok"),
    ...over,
  };
}

function agent(over: Partial<Agent>): Agent {
  return {
    agentId: "myclaw",
    sectors: ["finance", "mail"],
    created_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    // Served on the wire and, until #100 item 4, read by NO Gatehouse surface: four of them
    // filtered on `!revoked_at` alone and counted a spent key as a live reader.
    expires_at: null,
    ...over,
  };
}

function auditRow(over: Partial<AuditRow>): AuditRow {
  return {
    id: "a1",
    agent_id: "myclaw",
    tool: "query",
    sector: "mail",
    decision: "allow",
    deny_reason: null,
    args: { folder: "inbox", limit: 50 },
    result_count: 50,
    outcome: "ok",
    request_id: "r1",
    created_at: "2026-07-21T12:00:00Z",
    ...over,
  };
}

/** Every coverage query answers a count aggregate — the service-truth figure (#60). */
function coverageResult(): QueryResult {
  return {
    sector: "x",
    object: "x",
    aggregate: { fn: "count" },
    count: 1,
    groups: [{ group: {}, value: 100 }],
  };
}

function mockApi(opts: {
  connectors?: ConnectorStatus[];
  agents?: Agent[];
  audit?: AuditRow[];
  exposure?: ExposureStatus;
}) {
  vi.spyOn(api, "listConnectors").mockResolvedValue(opts.connectors ?? []);
  vi.spyOn(api, "listAgents").mockResolvedValue(opts.agents ?? []);
  vi.spyOn(api, "audit").mockResolvedValue(opts.audit ?? []);
  vi.spyOn(api, "queryData").mockResolvedValue(coverageResult());
  vi.spyOn(api, "getExposure").mockResolvedValue(opts.exposure ?? exposureStatus());
}

function renderGatehouse() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Gatehouse />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("healthy glance", () => {
  beforeEach(() => {
    mockApi({
      connectors: [conn({})],
      agents: [agent({ agentId: "myclaw" }), agent({ agentId: "claude-ai" })],
    });
  });

  it("renders the quiet verdict", async () => {
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);
  });

  it("shows grants as ONE clause link, and renders NO grants table (#63)", async () => {
    renderGatehouse();
    // The agents clause is a single link to the register — not a second editable table.
    const link = await screen.findByRole("link", { name: /two agents hold keys/i });
    expect(link.getAttribute("href")).toBe("/agents");
    // A glance surface never draws a table (LedgerTable is role="table"); there is no grants table.
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("never renders a bare em-dash at figure size (#60)", async () => {
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);
    await waitFor(() => {
      // coverage figures resolved to real counts, so no lone em-dash placeholder survives
      expect(screen.queryByText("—")).toBeNull();
    });
    expect(await screen.findAllByText(/records/)).not.toHaveLength(0);
  });
});

describe("exceptions-first verdict", () => {
  it("one source down changes the SENTENCE, and the band degrades the button (no 'Reconnect')", async () => {
    mockApi({
      connectors: [
        conn({
          connectionId: "down",
          provider: "whoop",
          sector: "health",
          status: "error",
          freshness: fresh("error", {
            error: { message: "Authentication expired", since: "2026-07-21T08:00:00Z" },
          }),
        }),
      ],
      agents: [agent({ agentId: "myclaw" })],
    });
    renderGatehouse();

    // The headline carries no grain noun (operator ruling, #91) — "but one …" is the h1's own words,
    // and the "but" is what scopes this to the headline rather than the sub-line's twin clause.
    await screen.findByText(/but one needs your attention/i);
    // DEGRADED: reconnect_kind not served → the banner points to Manage, never guesses custody.
    const manage = await screen.findByRole("button", { name: /manage this connection/i });
    expect(manage).toBeTruthy();
    // The imperative "Reconnect" pill/word is banned and, here, would be a guessed custody flow.
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it("multiple down spells the count", async () => {
    mockApi({
      connectors: [
        conn({ connectionId: "a", status: "error", freshness: fresh("error", { error: { message: "x", since: null } }) }),
        conn({ connectionId: "b", sector: "health", provider: "whoop", freshness: fresh("unreachable") }),
      ],
    });
    renderGatehouse();
    await screen.findByText(/but two need your attention/i);
  });
});

// ── #91 — the verdict names TWO grains, and the port kept one ──────────────────
//
// The verdict spelled the CONNECTION count under the provider noun — "N sources connected" with
// `total = live.length` — while /sources one click away printed both grains, "P providers ·
// N connections", from the same data.
// It is not cosmetic: a connection count wearing the word "sources" makes a revoke's blast radius
// invisible, which is the whole reason the Sources page states both numbers.
//
// The fixture is LOPSIDED on purpose — three providers, five credentials, seven connections. Every
// earlier fixture here had one connection per provider and one shared `credentialId`, so the three
// numbers coincided and no assertion could tell them apart.
const LOPSIDED = () => [
  // one iCloud credential fanned across three sectors — three connections, ONE source
  conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
  conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
  conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
  // three Plaid Items, each its OWN credential (one bank = one connection) — still ONE source
  conn({ connectionId: "p-1", provider: "plaid", sector: "finance" }),
  conn({ connectionId: "p-2", provider: "plaid", sector: "finance" }),
  conn({ connectionId: "p-3", provider: "plaid", sector: "finance" }),
  conn({ connectionId: "w-1", provider: "whoop", sector: "health" }),
];

describe("the verdict sub-line names both grains (#91)", () => {
  it("the fixture cannot mint one credential spanning two providers", () => {
    // The mechanical trap #91 names, and the reason `conn()` derives `credentialId` from the
    // connection: the helper hardcoded `credentialId: "cred_fixture"` on every row, so a SimpleFIN row
    // and a WHOOP row came out of it sharing ONE credential — a shape the wire cannot produce
    // (`provider_credentials` carries exactly one provider per row) and which anything grouping by
    // credential reads as one source. A fixture that models an impossible gate cannot falsify a count.
    //
    // MUTATION: put a constant `credentialId` back in `conn()` → red.
    const rows = [
      ...LOPSIDED(),
      conn({ connectionId: "s1", provider: "simplefin", sector: "finance" }),
      conn({ connectionId: "w2", provider: "whoop", sector: "health" }),
    ];
    const providerOf = new Map<string, string>();
    for (const c of rows) {
      const seen = providerOf.get(c.credentialId);
      expect(seen === undefined || seen === c.provider).toBe(true);
      providerOf.set(c.credentialId, c.provider);
    }
    // …and the fixture really does hold repeats to catch: one credential across three sectors.
    expect(new Set(rows.map((c) => c.credentialId)).size).toBeLessThan(rows.length);
  });

  it("leads with the sources count and the connections count, never one for the other", async () => {
    // MUTATION: `verdictLead` → `counts.connections` in the sources slot, and the lead reads "Seven
    // sources · seven connections" → red. Revert to `live.length` with the word "sources" → red.
    mockApi({ connectors: LOPSIDED(), agents: [agent({ agentId: "myclaw" })] });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const body = document.body.textContent ?? "";
    expect(body).toContain("Three sources · seven connections");
    // the defect, in its exact shipped words
    expect(body).not.toMatch(/sources connected/);
    expect(body).not.toMatch(/Seven sources/);
  });

  it("states the two totals and a bare attention count — no subtraction across grains", async () => {
    // `flowing = total - attentionCount` is DELETED, not repaired (#91): the design never subtracts,
    // and the invented "N of M sources flowing" phrasing goes negative the moment the leading number
    // becomes provider-grain (three sources, four broken connections → "minus one of three").
    //
    // MUTATION: reintroduce the subtraction and either the "of" phrasing appears (red) or, with four
    // of the seven broken, the lead loses its two-grain shape (red).
    const cs = LOPSIDED().map((c, i) =>
      i < 4
        ? { ...c, status: "error" as const, freshness: fresh("error", { error: { message: "x", since: null } }) }
        : c,
    );
    mockApi({ connectors: cs, agents: [agent({ agentId: "myclaw" })] });
    renderGatehouse();
    await screen.findByText(/but four need your attention/i);

    const body = document.body.textContent ?? "";
    expect(body).toContain("Three sources · seven connections · four need your attention");
    expect(body).not.toMatch(/flowing ·/);
    expect(body).not.toMatch(/ of (three|seven|four) /);
    // and no negative number reached the page
    expect(body).not.toMatch(/-\d|minus/);
  });

  it("agrees with the Sources page, which is the whole point", async () => {
    // The two surfaces read ONE tally (`grain.sourceCounts`); `grain.parity.test.ts` compares the two
    // sentences directly. What this cell adds is the WIRING: the page passes the served list to that
    // tally, rather than a count it made itself. A revoked row is in neither surface's numbers.
    mockApi({
      connectors: [
        ...LOPSIDED(),
        conn({ connectionId: "g-dead", provider: "gmail", sector: "mail", status: "revoked" }),
      ],
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const body = document.body.textContent ?? "";
    // still three sources / seven connections — the revoked Gmail row is gone, not a fourth source
    expect(body).toContain("Three sources · seven connections");
    expect(body).not.toContain("Four sources");
  });
});

describe("first run", () => {
  it("welcomes when nothing is connected", async () => {
    mockApi({ connectors: [] });
    renderGatehouse();
    await screen.findByText(/your gate is new/i);
    expect(screen.getByText(/add your first source/i)).toBeTruthy();
  });

  it("the three first-run captions are not one repeated sentence shape", async () => {
    // They were three byte-identical `clause — clause` slots, each taking its dash in the same
    // syntactic position. Parallel slots with identical grammar read as a template rather than as
    // writing, and it is the single clearest AI-writing tell there is (§18.2). Assert the SHAPE, not
    // the wording: no caption may share the others' punctuation skeleton.
    mockApi({ connectors: [] });
    renderGatehouse();
    await screen.findByText(/your gate is new/i);

    const captions = ["Connect a source", "Postern keeps it", "Any agent reads it"].map((title) => {
      const step = screen.getByText(title).parentElement!;
      // the caption is the step's last child; the title and the numeral precede it
      return step.textContent!.slice(step.textContent!.indexOf(title) + title.length);
    });
    expect(captions).toHaveLength(3);
    // every caption is distinct prose…
    expect(new Set(captions).size).toBe(3);
    // …and the template itself is gone: all three joined their two clauses with an em dash in the
    // same syntactic position, which is the tell. An em dash is not banned in the Console — §18.2 is
    // explicit that the finding is about density and monotony, never the mark — so this asserts the
    // repetition, not the character: not one of the three may still be a `clause — clause` slot.
    expect(captions.filter((c) => c.includes("—"))).toHaveLength(0);
    // and they do not all collapse back onto one punctuation shape
    const skeletons = captions.map((c) => c.replace(/[^—.,;:]/g, ""));
    expect(new Set(skeletons).size).toBeGreaterThan(1);
  });
});

describe("two affirmative badges that never tracked state (§17.1 / §18.2)", () => {
  it("draws no sector-ink dot and no seal badge on a healthy gate", async () => {
    // The sector dot sat in the canonical status position in the sector's OWN ink — and two sector
    // inks ARE state inks (`--sector-finance` is `--state-attention`), so a healthy gate showed an
    // amber dot on Finance beside a masthead reading that nothing needs attention. The proof it was
    // noise: the needs-attention board carried the same six dots, unchanged. The gate-address seal
    // was the same defect found by a different lens — a poppy disc with a white check, byte-identical
    // 200px from a red "Authentication expired" band. Neither had a test, which is how both shipped.
    mockApi({ connectors: [conn({})], agents: [agent({ agentId: "myclaw" })] });
    const { container } = renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    // no element carries a bare sector ink as a status mark
    expect(container.querySelector("[data-sector]")).toBeNull();
    // and no seal-filled disc survives in the gate-address card
    const sealDiscs = [...container.querySelectorAll("circle")].filter((c) =>
      (c.getAttribute("fill") ?? "").includes("--color-seal"),
    );
    expect(sealDiscs).toEqual([]);
  });
});

// #106 §2a — an UNSERVED passage renders as ABSENCE. It used to print "passage not yet served" on the
// home page, once per key-holding agent: our word for our wire, standing where a fact was owed. The
// three answers are still three (build-notes §16.6) — what changed is that the third one says nothing
// out loud, because nothing is what we know.
describe("who came through — the passage cell's three answers (#89 / #106 §2a)", () => {
  it("an UNSERVED passage prints nothing at all — no sentence, and still never 'never'", async () => {
    mockApi({
      connectors: [conn({})],
      // last_seen_at is UNDEFINED on the wire → the gateway did not tell us.
      agents: [agent({ agentId: "quietclaw", sectors: ["finance"] })],
    });
    const { container } = renderGatehouse();

    // the agent is present (from the register — complete): hiding a value is not hiding the agent
    await screen.findByText("quietclaw");
    // no narration of the wire, in any of the words this Console has used for it
    expect(container.textContent).not.toMatch(/not yet served|not served|passage not/i);
    // and the false-"never" the audit-feed reduction would produce must not appear either
    expect(screen.queryByText(/^never$/i)).toBeNull();
    // WHERE, not just WHAT: the row carries the agent and nothing beside it. An implementation that
    // rendered an empty cell (or a "—") would pass every assertion above and still print furniture.
    const row = screen.getByText("quietclaw").parentElement!;
    expect(row.childElementCount).toBe(1);
  });

  it("a SERVED-but-never-used key still prints 'never' — the arm that must not be hidden with it", async () => {
    mockApi({
      connectors: [conn({})],
      agents: [agent({ agentId: "freshclaw", sectors: ["finance"], last_seen_at: null })],
    });
    renderGatehouse();
    await screen.findByText("freshclaw");
    // `null` is a served fact about this key, not a gap in the wire, and it is the whole reason the
    // unserved arm cannot simply be folded into "never".
    expect(screen.getByText("never")).toBeTruthy();
  });

  it("a real instant prints as a relative time", async () => {
    mockApi({
      connectors: [conn({})],
      agents: [
        agent({
          agentId: "busyclaw",
          sectors: ["finance"],
          last_seen_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        }),
      ],
    });
    renderGatehouse();
    await screen.findByText("busyclaw");
    expect(screen.getByText("2h ago")).toBeTruthy();
  });
});

describe("sector cards carry the provider's mark", () => {
  // The Home card rendered a NAMELESS source row: `PROVIDER_MARK` was keyed on `homeassistant`
  // while the gateway serves `home_assistant`, so `providerMark()` answered null and the one
  // provider whose sector can ACT was the only one with no mark. Assert the served spelling.
  it("the Home sector card renders a provider mark", async () => {
    mockApi({
      connectors: [
        conn({ connectionId: "ha1", provider: "home_assistant", sector: "home", policy_mode: "push" }),
      ],
    });
    renderGatehouse();
    expect(await screen.findByRole("img", { name: "Home Assistant" })).toBeTruthy();
  });

  it("an unknown provider still renders no mark rather than a guessed one", async () => {
    mockApi({ connectors: [conn({ connectionId: "n1", provider: "notion", sector: "mail" })] });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);
    expect(screen.queryByRole("img", { name: "Home Assistant" })).toBeNull();
  });
});

describe("recent passage — decision is exceptions-only", () => {
  it("renders a deny inline, and an allow carries no decision ink", async () => {
    mockApi({
      connectors: [conn({})],
      audit: [
        auditRow({ id: "ok1", tool: "query", decision: "allow" }),
        auditRow({ id: "no1", tool: "invoke_action", sector: "home", decision: "deny", deny_reason: "not granted" }),
      ],
    });
    renderGatehouse();

    await screen.findByText("invoke_action");
    // the deny renders inline
    expect(screen.getByText(/·\s*denied/i)).toBeTruthy();
    // exactly one denied marker — the allow row does not get one
    expect(screen.getAllByText(/·\s*denied/i)).toHaveLength(1);
  });

  // #106 §4 — the glance printed `{ sector: null }` for a Console export, with exactly that spacing.
  it("prints no empty-keyed args, and still prints the ones that carry a value", async () => {
    mockApi({
      connectors: [conn({})],
      audit: [
        auditRow({ id: "exp1", agent_id: null, tool: "export", sector: null, args: { sector: null } }),
        auditRow({ id: "q1", tool: "query", sector: "mail", args: { sector: null, limit: 50 } }),
      ],
    });
    const { container } = renderGatehouse();

    await screen.findByText("export");
    // the key with nothing in it is gone, in either rendering's spacing
    expect(container.textContent).not.toMatch(/sector["']?\s*:\s*null/i);
    // …and the argument that says something survives. Without this half, dropping the cell entirely
    // would pass the assertion above.
    expect(screen.getByText('{ limit: 50 }')).toBeTruthy();
    // The export row's args reduce to nothing, so that row draws NO args cell at all — a glance row is
    // prose, not a table, and it already omits the cell when there are no args (the em-dash belongs to
    // the ledger's fixed columns). The row still carries who and what.
    const exportRow = screen.getByText("export").parentElement!;
    expect(exportRow.textContent).toContain("operator");
    expect(exportRow.textContent).not.toContain("—");
  });

  it("shows decision ink for an allowed-but-errored passage row", async () => {
    // The glance filtered on `decision === "deny"` and so missed the THIRD state (#78): a call
    // admitted at the door that then failed doing the work. That is the lie #78 names, fixed on the
    // ledger and left standing here — on the one page whose whole job is to let you falsify the
    // all-clear. Both surfaces now read the same `decisionState`.
    mockApi({
      connectors: [conn({})],
      audit: [
        auditRow({ id: "ok1", tool: "query", decision: "allow", outcome: "ok" }),
        auditRow({ id: "err1", tool: "fetch_live", sector: "calendar", decision: "allow", outcome: "error" }),
      ],
    });
    renderGatehouse();

    await screen.findByText("fetch_live");
    const errored = screen.getByText(/·\s*errored/i);
    expect(errored).toBeTruthy();
    // ...and in the FAILURE ink, not the refusal one. Asserting only the word let the first fix
    // paint an errored call poppy — the Gatehouse saying "denied" in colour while the ledger two
    // clicks away said "errored", which is the exact distinction #78 exists to draw. The class
    // names carry the two inks (RecentPassage.module.css); jsdom has no cascade, so the class is
    // the assertable fact and a screenshot may never source a value.
    expect(errored.className).toMatch(/errored/);
    expect(errored.className).not.toMatch(/denied/);
    // and the admitted row is still silent — exceptions-only did not become everything-gets-a-word
    expect(screen.getAllByText(/·\s*(errored|denied)/i)).toHaveLength(1);
  });
});

// ── #100 items 4, 8, 10 — the Gatehouse under conditions the fixtures never produced ────────────
//
// One expired key, fourteen banks behind one provider name, and a sector nobody can read. All three
// were invisible to the old fixtures: every agent was unexpired, every sector had one connection,
// and no test ever read a sector card's agents clause.

/** The card for a sector, located by its LATIN name (unique per sector, and not a value any other
 *  surface prints). SectorCard's markup is `card > head > headText > latin`. */
function sectorCard(latin: string): HTMLElement {
  const card = screen.getByText(latin).parentElement!.parentElement!.parentElement!;
  // Guard the walk: if the markup moves, this fails loudly instead of silently scoping to <body>.
  expect(card.tagName).toBe("DIV");
  return card as HTMLElement;
}
const FINANCE = "Cumulus nummorum";
const MAIL = "Epistola volans";

const PAST = "2026-07-01T00:00:00Z"; // long expired relative to any real `Date.now()`
const FUTURE = "2099-01-01T00:00:00Z";

describe("#100 item 4 — an expired key is not a key-holder", () => {
  it("an expired key is neither counted nor named on the Gatehouse", async () => {
    mockApi({
      connectors: [conn({})],
      agents: [
        agent({ agentId: "liveclaw", expires_at: FUTURE }),
        agent({ agentId: "spentclaw", expires_at: PAST }),
      ],
    });
    const { container } = renderGatehouse();

    // The masthead clause counts ONE, not two: `!revoked_at` alone says two.
    expect(await screen.findByRole("link", { name: /one agent holds keys/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /two agents hold keys/i })).toBeNull();
    // …and "Who came through" does not name it either. Asserting both at once is deliberate: the
    // half-fix here is repairing the count and forgetting the list, or the reverse.
    await screen.findByText("liveclaw");
    expect(container.textContent).not.toContain("spentclaw");
  });

  it("a sector card counts only unexpired grants", async () => {
    // The expired key holds a `finance` grant. `GatehousePage.tsx:105` (the masthead count) and
    // `:188` (the per-sector count) are two different call sites; this one pins the second.
    mockApi({
      connectors: [conn({})],
      agents: [agent({ agentId: "spentclaw", sectors: ["finance"], expires_at: PAST })],
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);
    expect(within(sectorCard(FINANCE)).getByText(/no agents hold keys here/)).toBeTruthy();
  });
});

describe("a sector card's provider row carries no connection count (operator, 2026-07-26)", () => {
  // "Plaid 2 connections ... looks sloppy and breaks uniformity on the home page." The count rendered
  // ONLY when a provider had more than one connection, so exactly one row on one card grew a middle
  // element every other row lacked, crowding the freshness clause beside it.
  //
  // THE FIXTURE IS THE POINT: three Plaid Items in finance, each its own credential. A single-connection
  // fixture cannot fail this — the old code rendered nothing at n === 1, which is exactly why the
  // asymmetry was invisible until a real box had two banks.
  it("a provider with THREE connections shows no count, and the row keeps its two elements", async () => {
    mockApi({ connectors: LOPSIDED() });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const card = sectorCard(FINANCE);
    // The words, in either grammatical form the old code could produce.
    expect(within(card).queryByText(/\d+\s+connections?\b/)).toBeNull();
    // …and no bare digit survives beside the provider name either, so an unlabelled "3" or a "—"
    // placeholder in that slot also fails rather than passing as "the words are gone".
    expect(within(card).queryByText(/^\s*\d+\s*$/)).toBeNull();
  });

  it("the verdict line still names both grains, so the count is not lost — only moved (#91)", async () => {
    mockApi({ connectors: LOPSIDED() });
    renderGatehouse();
    // Removing a fact from a glance card is only honest if the page still states it somewhere.
    expect(await screen.findByText(/connections/)).toBeTruthy();
  });
});

describe("#100 item 10 — one phrase per zero-agents concept", () => {
  it("a sector with no readers says 'no agents hold keys here', never 'read by 0 agents'", async () => {
    mockApi({
      connectors: [conn({})],
      agents: [agent({ agentId: "myclaw", sectors: ["mail"] })],
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    expect(within(sectorCard(FINANCE)).getByText(/no agents hold keys here/)).toBeTruthy();
    // the un-English computed string is gone from the whole page, not just from this card
    expect(screen.queryByText(/read by 0 agents/)).toBeNull();
    // and the positive form still reads correctly one card over
    expect(within(sectorCard(MAIL)).getByText(/read by 1 agent$/)).toBeTruthy();
  });
});

describe("#100 item 8 — the sector card is grouped and capped", () => {
  it("fourteen Plaid banks render as ONE Plaid row (and no count — operator, 2026-07-26)", async () => {
    // Each Plaid Item is its own credential, so one bank = one connection: fourteen banks is the
    // ordinary case for a real user, and it used to draw fourteen rows all reading "Plaid".
    mockApi({
      connectors: Array.from({ length: 14 }, (_, i) =>
        conn({ connectionId: `plaid-${i}`, provider: "plaid", sector: "finance" }),
      ),
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const card = within(sectorCard(FINANCE));
    // The GROUPING is what this cell has always guarded and it still bites: without it the card draws
    // fourteen rows all reading "Plaid".
    expect(card.getAllByText("Plaid")).toHaveLength(1);
    // The count that used to sit here is GONE by operator ruling — it rendered only above one
    // connection, so it gave a single row on a single card a middle element no other row had.
    expect(card.queryByText("14 connections")).toBeNull();
  });

  it("no provider shows a connection count, single or grouped", async () => {
    mockApi({ connectors: [conn({ connectionId: "p1", provider: "plaid", sector: "finance" })] });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const card = within(sectorCard(FINANCE));
    expect(card.getAllByText("Plaid")).toHaveLength(1);
    // "1 connections" (a wrong plural) and "1 connection" (noise on a glance card) are both wrong.
    expect(card.queryByText(/1 connections?/)).toBeNull();
  });

  it("more providers than the card holds are reported, not silently dropped", async () => {
    mockApi({
      connectors: ["plaid", "simplefin", "teller", "yodlee"].map((p, i) =>
        conn({ connectionId: `c${i}`, provider: p, sector: "finance", credentialId: `cred-${p}` }),
      ),
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    const card = within(sectorCard(FINANCE));
    const more = card.getByText(/and 1 more/);
    // Rebound by #112. This asserted the bare `/sources` — the defect, not the contract: a link
    // about the sources this card could not show landed at the top of a page listing everything.
    // The target now carries the group the FIRST hidden provider lands in, derived from that
    // connection through the same function /sources renders its ids from.
    //
    // MUTATION: hardcode `to="/sources"` back in SectorCard and this goes red.
    const href = more.closest("a")!.getAttribute("href")!;
    expect(href).not.toBe("/sources");
    // Worst-first ordering keeps the broken source visible, so the hidden group is the LAST
    // alphabetically among the healthy ones — "yodlee" here (plaid · simplefin · teller shown).
    expect(href).toBe(
      sourceGroupHref({ provider: "yodlee", credentialId: "cred-yodlee", connectionId: "c3" }),
    );
  });
});

describe("the gate's address on home (ADR 0035 §D2 — home is a verdict, not a dashboard)", () => {
  // MUTATION: re-introduce a module constant for the address → RED. The MCP edge is a separate
  // server on its own port; the Console is in no position to guess it, and the old constant was a
  // flat lie whenever the port moved or the edge was not running.
  it("the gate address on home comes from the gateway", async () => {
    mockApi({ connectors: [conn({})] });
    renderGatehouse();
    expect(await screen.findByText(SERVED_ENDPOINT)).toBeTruthy();
  });

  // ── #125: the address is right, the CLAIM about it was not ────────────────────────────────────
  //
  // The caption read "Point any agent here — swap the harness, keep the context." — true of a harness
  // on the gate's own machine and FALSE of the two paths a person most often wants: an agent on
  // another machine cannot route to a loopback URL at all, and claude.ai / ChatGPT arrive through the
  // OAuth bridge on :443 (#47). So the most trust-sensitive sentence on home offered the NARROWEST of
  // three addresses as the universal one.
  //
  // MUTATION: restore "Point any agent here — swap the harness, keep the context." as the caption →
  // RED (the universal-claim assertion, and every named case below).
  it("the address is captioned with the one agent it serves, never as universal (#125)", async () => {
    mockApi({ connectors: [conn({})] });
    renderGatehouse();
    await screen.findByText(SERVED_ENDPOINT);

    const body = document.body.textContent ?? "";
    // Nothing on home offers this address to agents in general.
    expect(body).not.toMatch(/\b(any|every)\s+agent\b/i);
    // It names the case it does serve …
    expect(body).toMatch(/on the same machine as this gate/);
    // … and says plainly that the other two cannot use it, naming the hosted clients by name.
    expect(body).toMatch(/can’t reach this address/);
    expect(body).toMatch(/claude\.ai and ChatGPT/);
  });

  // The second half of the fix: the other two paths have to be REACHABLE from here. Connect-an-agent
  // (on Agents & keys) already picks a real recipe per target and carries the :443 caveat, so home
  // points at it instead of growing a second, less honest copy.
  //
  // MUTATION: turn the pointer into plain text (drop the <Link>) → RED. A named surface a person
  // cannot click is a dead end, which is the state #125 was filed from.
  it("home points at the surface that owns the other two connection paths (#125)", async () => {
    mockApi({ connectors: [conn({})] });
    renderGatehouse();
    await screen.findByText(SERVED_ENDPOINT);

    const link = screen.getByRole("link", { name: /agents & keys/i });
    expect(link.getAttribute("href")).toBe("/agents");
  });

  // Two inline links to /agents now sit on this one page — the agents clause in the verdict sentence
  // and this pointer — so the treatment has to be ONE treatment, or home grows two looks for the same
  // destination. Reused declaration for declaration rather than re-derived.
  //
  // MUTATION: change any declaration under `.link` in GateAddress.module.css → RED.
  it("the pointer reuses the Gatehouse's one inline-link treatment (#125)", () => {
    /** Every declaration of a rule and its `:hover`, order-free. */
    const treatment = (path: string, selector: string): string[] =>
      [
        ...cssRules(path).matchAll(new RegExp(`\\${selector}(?::hover)?\\s*\\{([^}]*)\\}`, "g")),
      ]
        .flatMap((m) => m[1]!.split(";"))
        .map((d) => d.trim())
        .filter((d) => d !== "")
        .sort();

    const pointer = treatment("./GateAddress.module.css", ".link");
    expect(pointer).not.toHaveLength(0);
    expect(pointer).toEqual(treatment("./GatehousePage.module.css", ".agentsLink"));
  });

  // Pointing is the WHOLE allowance (ADR 0035 §D2 — exposure is never a nudge). Naming the hosted
  // path may not drag its address or its setup onto a verdict surface.
  //
  // MUTATION: put the public/tailnet address, or the ":443" caveat, into the caption → RED.
  it("naming the other two paths moves no address and no setup onto home (#125)", async () => {
    mockApi({
      connectors: [conn({})],
      // A gate that IS published: the caption still says nothing about the public side.
      exposure: exposureStatus({
        configured: { publicUrl: PUBLIC_URL, source: "db", consentedAt: null },
        serving: { publicUrl: PUBLIC_URL },
      }),
    });
    renderGatehouse();
    await screen.findByText(SERVED_ENDPOINT);

    const body = document.body.textContent ?? "";
    expect(body).not.toContain(PUBLIC_URL);
    // `\b443\b`, not `:443` — the first shape of this cell matched only the colon form and stayed
    // green on "a public https address on port 443", which is exactly the setup detail it exists to
    // keep off home. Mutation-verified after widening.
    expect(body).not.toMatch(/ts\.net|tailnet|tailscale|\b443\b|oauth|funnel|MCP_HTTP_PORT/i);
    // Exactly one URL on the page — the served local one. A second would be a second recipe.
    expect(body.split(SERVED_ENDPOINT).length - 1).toBe(1);
    expect(body.split(/https?:\/\//).length - 1).toBe(1);
  });

  // The caption is a claim ABOUT the string above it, so it lives inside the served branch. Under
  // either absence there is no string to make a claim about — and no recipe to fetch either, since
  // Connect-an-agent renders the same absence from the same read.
  //
  // MUTATION: hoist the caption back out of the served branch (render it unconditionally) → RED in
  // both cells below: "can't reach this address" appears with no address on screen, and home invites
  // the reader to a recipe page that has nothing to give.
  it("a gate serving no endpoint makes no claim about an address it does not have (#125)", async () => {
    mockApi({ connectors: [conn({})], exposure: exposureStatus({ localEndpoint: null }) });
    renderGatehouse();
    await screen.findByText(/no address to hand an agent/);

    expect(document.body.textContent ?? "").not.toMatch(/this address|same machine as this gate/);
    expect(screen.queryByRole("link", { name: /agents & keys/i })).toBeNull();
  });

  it("a gateway that did not answer makes no claim about an address either (#125)", async () => {
    mockApi({ connectors: [conn({})] });
    vi.mocked(api.getExposure).mockRejectedValue(new Error("Failed to fetch"));
    renderGatehouse();
    await screen.findByText(EXPOSURE_UNANSWERED);

    expect(document.body.textContent ?? "").not.toMatch(/this address|same machine as this gate/);
    expect(screen.queryByRole("link", { name: /agents & keys/i })).toBeNull();
  });

  // MUTATION: put a publish/enable affordance, or the public URL, on the Gatehouse → RED.
  // Exposure is never a default, never a nudge and never a side effect (§D2), and home is a verdict
  // (soul.md §11 / build-notes §6): the exposure story lives on Settings → Remote access.
  it("home does not grow an exposure control", async () => {
    mockApi({
      connectors: [conn({})],
      // Even on a gate that IS published, home stays silent about it.
      exposure: exposureStatus({
        configured: { publicUrl: PUBLIC_URL, source: "db", consentedAt: null },
        serving: { publicUrl: PUBLIC_URL },
      }),
    });
    renderGatehouse();
    await screen.findByText(SERVED_ENDPOINT);

    const body = document.body.textContent ?? "";
    expect(body).not.toContain(PUBLIC_URL);
    expect(body).not.toMatch(/Funnel|Publish|publishing|Remote access/);
    for (const name of [/enable/i, /publish/i, /stop publishing/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  // MUTATION: fall back to a literal address when `localEndpoint` is null → RED.
  it("a gateway with no MCP edge shows no address rather than a plausible one", async () => {
    mockApi({ connectors: [conn({})], exposure: exposureStatus({ localEndpoint: null }) });
    renderGatehouse();
    expect(await screen.findByText(/no address to hand an agent/)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/\/mcp\b/);
  });

  // ── §Decision 7: a failed read is never a verdict about the gate ──────────────────────────────
  //
  // MUTATION: drop the `failed` branch in GateAddress (revert to `exposure.data?.localEndpoint ??
  // null`) → RED. Home is a VERDICT, and "This gate isn't serving an MCP endpoint" is a verdict
  // this card has no standing to deliver about a gateway it never reached.
  it("a gateway that did not answer is not reported as a gate serving no endpoint", async () => {
    mockApi({ connectors: [conn({})] });
    vi.mocked(api.getExposure).mockRejectedValue(new Error("Failed to fetch"));
    renderGatehouse();

    expect(await screen.findByText(EXPOSURE_UNANSWERED)).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/isn’t serving an MCP endpoint/);
    expect(body).not.toMatch(/no address to hand an agent/);
    expect(body).not.toMatch(/\/mcp\b/);
  });
});

// ── #107 §1 — the sector cards were inert ──────────────────────────────────────
//
// Operator, walking the live Console: "Sectors are not clickable on the home page. They should be."
// The destination already existed and was already routed — the nav rail was the ONLY thing in the
// Console that reached `/sectors/:sector`. The card is additive here: nothing it could already do was
// taken away, which is what the last three cells guard — including the one capability the FIRST shape
// of this fix silently removed (see "keeps every string below the head SELECTABLE").

/** A module stylesheet with its comments stripped: prose ABOUT a rule is not the rule, and counting
 *  it would make these cells fail on their own documentation. */
const cssRules = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("a sector card opens its sector (#107 §1)", () => {
  /** Every sector card on the register, by the latin name only its own card prints. */
  const SECTORS = [
    ["mail", "Mail", "Epistola volans"],
    ["calendar", "Calendar", "Discus mensis"],
    ["contacts", "Contacts", "Myosotis amicorum"],
    ["finance", "Finance", "Cumulus nummorum"],
    ["health", "Health", "Lamprocapnos salutis"],
    ["home", "Home", "Domus lanterna"],
  ] as const;

  it("the card's head is a link to the sector lens, named by its own text", async () => {
    // MUTATION: turn the head back into a plain <div> and this goes red for every sector.
    // "Reachable by keyboard" is not a separate mechanism to test: an <a href> is in the tab order
    // and Enter activates it natively. What a test CAN falsify is that it is a real anchor with a
    // real href — the two ways this gets rebuilt wrong are a div with an onClick (no tab stop, no
    // Enter, no middle-click) and a role="link" with no href (announced, unusable).
    mockApi({ connectors: [conn({ provider: "simplefin", sector: "finance" })] });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    for (const [sector, name, latin] of SECTORS) {
      const card = sectorCard(latin);
      // Located by ROLE + the card's own words: the name comes from the link's TEXT, so an
      // `aria-label` is not needed and is not wanted (the overlay shape needed one because it had no
      // text of its own — an invented name is weaker than the sector's, and drifts from it).
      const link = within(card).getByRole("link", { name: new RegExp(name) });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(`/sectors/${sector}`);
      expect(link.getAttribute("aria-label")).toBeNull();
      // …and what it wraps is the head: the sector name and its binomial, both inside the anchor.
      expect(link.contains(within(card).getByText(name))).toBe(true);
      expect(link.contains(within(card).getByText(latin))).toBe(true);
    }
  });

  it("keeps every string below the head SELECTABLE — no anchor covers the card (#107 §1)", async () => {
    // THE REGRESSION THIS CELL EXISTS FOR, and why the first shape of #107 §1 was a BLOCK. A
    // stretched `position:absolute; inset:0` anchor over the card left `getByRole("link")`, its name
    // and its href all correct — geometry and stacking are invisible to those — while taking the
    // card's text away from the mouse: an <a> is draggable, so mouse-down-and-drag starts a link drag
    // instead of a selection, and a right-click answers with the link context menu. So the sector
    // name, the binomial, every provider row and its freshness word, the coverage figure and "read by
    // N agents" all stopped being selectable, which the plain-div card allowed. Two reviewers proved
    // it independently — and proved the guard was absent: deleting `position:absolute`/`inset:0` left
    // every cell in this file green, as did deleting the rule that raised the two inner links above
    // the overlay (which re-created the unclickable escapes that rule existed to prevent).
    //
    // jsdom has no layout, so the property is asserted where it is DECIDED: in the DOM (nothing below
    // the head is inside an anchor) and in the stylesheet (this module positions, stacks and
    // stretches nothing at all).
    mockApi({
      connectors: [conn({ provider: "simplefin", sector: "finance" })],
      agents: [agent({ agentId: "myclaw", sectors: ["finance"] })],
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);
    // the coverage figure is a <Skeleton> until the query() aggregate lands (#60) — wait for the
    // real number, or this cell would assert selectability of a placeholder
    await screen.findAllByText(/records/);

    const card = sectorCard(FINANCE);
    const head = within(card).getByRole("link", { name: /Finance/ });
    // MUTATION: wrap the whole card in the <Link> and the first assertion goes red; re-add a
    // stretched overlay anchor and the stylesheet assertions go red.
    for (const el of [
      within(card).getByText("SimpleFIN"), // a provider row
      within(card).getByText(/read by 1 agent/), // the foot's grants clause
      within(card).getByText(/records/), // the coverage figure
    ]) {
      expect(head.contains(el)).toBe(false);
      expect(el.closest("a")).toBeNull();
    }
    const css = cssRules("./SectorCard.module.css");
    expect(css).not.toMatch(/position\s*:/);
    expect(css).not.toMatch(/\binset\s*:/);
    // An inner link that has to be RAISED is the signature of something covering it. Nothing does.
    expect(css).not.toMatch(/z-index/);
  });

  it("produces NO nested anchor, in either state that already had a link inside the card", async () => {
    // The hard constraint on this fix. A card holds a link in two states — the zero-state "add one →"
    // and the overflow "and N more →" — and an <a> inside an <a> is invalid markup that browsers
    // repair by splitting the outer element, which breaks the card-wide affordance in exactly the
    // place a test that only checked the happy card would not look. Both states are rendered here.
    mockApi({
      connectors: ["plaid", "simplefin", "teller", "yodlee"].map((p, i) =>
        conn({ connectionId: `c${i}`, provider: p, sector: "finance", credentialId: `cred-${p}` }),
      ),
    });
    const { container } = renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    // finance has the overflow link; the other five sectors are empty and hold the zero-state link.
    expect(container.querySelector("a a")).toBeNull();
    expect(screen.getByText(/and 1 more/).closest("a")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: /No source connected/i }).length).toBeGreaterThan(0);
  });

  it("keeps both inner links working — the card gained an affordance and lost none", async () => {
    mockApi({
      connectors: ["plaid", "simplefin", "teller", "yodlee"].map((p, i) =>
        conn({ connectionId: `c${i}`, provider: p, sector: "finance", credentialId: `cred-${p}` }),
      ),
    });
    renderGatehouse();
    await screen.findByText(/everything is flowing/i);

    // the zero-state escape still reaches the connect flow …
    expect(
      screen.getAllByRole("link", { name: /No source connected/i })[0].getAttribute("href"),
    ).toBe("/connect");
    // … and the overflow still reaches its group on Sources (#112), not the card's own destination.
    const more = screen.getByText(/and 1 more/).closest("a")!;
    expect(more.getAttribute("href")).toMatch(/^\/sources#/);
    expect(more.getAttribute("href")).not.toMatch(/^\/sectors\//);
  });

  it("states its hover in a treatment this file already uses, and inherits the one focus ring", () => {
    // jsdom applies no stylesheet, so the affordances are checked where they live. The hover value is
    // REUSED, not invented: `color: var(--color-seal)` is exactly what `.noSource:hover` and
    // `.moreSources:hover` in this same file already give a link, so the head marks the thing that is
    // actually clickable rather than responding across a region that is not. build-notes §8 records
    // hover/focus/active as deliberately settled in code, because Paper draws one state per element —
    // there was no plate value to read.
    //
    // MUTATION: drop `.head:hover .name` and the first assertion goes red; re-declare the focus ring
    // here and the last two do.
    const css = cssRules("./SectorCard.module.css");
    expect(css).toMatch(/\.head:hover\s+\.name\s*\{[^}]*color:\s*var\(--color-seal\)/);
    // the same declaration the file's other two links already use — not a lookalike
    expect(css).toMatch(/\.noSource:hover\s*\{[^}]*color:\s*var\(--color-seal\)/);
    // a component that re-declares the global ring is drift (base.css says so in as many words)
    expect(css).not.toContain(":focus-visible");
    expect(css).not.toContain("outline");
  });
});
