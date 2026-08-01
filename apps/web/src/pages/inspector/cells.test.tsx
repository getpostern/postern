// The inspector's derivations, pinned against the REAL wire shape. The headline is #59: the home
// state cell must map Home Assistant's actual availability vocabulary (online / unavailable /
// unknown), NOT the phantom "available" the old cell tested for — a fixture built with "available"
// hides the bug, so every home assertion here uses "online".

import "../../api/test-dom"; // jsdom global before React/testing-library load
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeColumns,
  homeStateDisplay,
  mailFlags,
  renderCell,
  rowProvenance,
  sourceCell,
} from "./cells";
import { formatMoney } from "./money";
import { recordSubtitle } from "./record";
import { objectDefByKey, SECTORS, type ColumnDef } from "./registry";
import type { Row } from "../../api/types";

afterEach(cleanup);

// #100 item 3 — the list sent Balance / Amount / Value through `formatNum` ("-87.32": ASCII hyphen,
// no currency) while the drill one click away rendered the same fact as "−$87.32" with a true
// U+2212. Two renderings of one fact. These pin the SHAPE of the string, not merely that something
// rendered — "renders something" is the assertion that let the two drift apart in the first place.
describe("#100 item 3 — one money rendering, list and drill", () => {
  it("a negative amount renders a true minus sign, never an ASCII hyphen", () => {
    const s = formatMoney("-87.32", "USD");
    expect(s).toBe("−$87.32");
    // Explicit: `toLocaleString`'s own negative formatting emits U+002D. Asserting the absence of
    // the ASCII hyphen is the only assertion that catches it slipping back in — the two characters
    // are visually near-identical and every "renders something" check passes either way.
    expect(s).not.toContain("-"); // U+002D HYPHEN-MINUS
    expect(s).toContain("−"); // U+2212 MINUS SIGN
  });

  it("a non-USD currency is rendered as served, never dressed as dollars", () => {
    const s = formatMoney("42", "EUR");
    expect(s).toBe("EUR 42.00");
    expect(s).not.toContain("$");
  });

  it("a row with no currency shows the number with no symbol at all", () => {
    // Real shape: SimpleFIN cash holdings serve `currency: null` (src/core/schema.ts finance.holding).
    const s = formatMoney("42", null);
    expect(s).toBe("42.00");
    expect(s).not.toContain("$");
    expect(s).not.toContain("EUR");
    expect(formatMoney("42", "")).toBe("42.00");
  });

  it("an absent amount is a dash and a non-numeric amount is echoed verbatim", () => {
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney("", "USD")).toBe("—");
    expect(formatMoney("n/a", "USD")).toBe("n/a");
  });

  it("the money cell reads the row's own currency, not the column's", () => {
    const col: ColumnDef = { field: "amount", header: "Amount", kind: "money" };
    const row: Row = { amount: "-6.5", currency: "GBP" };
    render(<>{renderCell(col, row)}</>);
    expect(screen.getByText("−GBP 6.50")).toBeTruthy();
  });

  it("a share quantity is still a plain number, not money", () => {
    // Asserted against the REGISTRY, not a hand-built ColumnDef: a column def written inside the
    // test can never notice `financeHolding.quantity` being flipped to `money` along with the rest
    // of the right-aligned lane, which is the actual mutation in play. 12.5 SHARES dressed as
    // "$12.50" is a new lie, not a fix.
    const holding = objectDefByKey("finance.holding")!.object;
    const kindOf = (field: string) => holding.columns.find((c) => c.field === field)?.kind;
    expect(kindOf("quantity")).toBe("num");
    expect(kindOf("market_value")).toBe("money");

    const col = holding.columns.find((c) => c.field === "quantity")!;
    const row: Row = { quantity: "12.5", currency: "USD" };
    render(<>{renderCell(col, row)}</>);
    expect(screen.getByText("12.5").textContent).not.toContain("$");
  });

  it("exactly the three currency-bearing finance columns are money", () => {
    // The whole registry, so a future column cannot quietly join or leave the money lane. `money`
    // reads `row.currency`, which is a REGISTRY scalar on finance objects ONLY — a `money` cell on
    // a health or mail column would render a currency the wire never carries.
    const moneyColumns = Object.values(SECTORS).flatMap((s) =>
      s.objects.flatMap((o) =>
        o.columns.filter((c) => c.kind === "money").map((c) => `${o.key}.${c.field}`),
      ),
    );
    expect(moneyColumns.sort()).toEqual([
      "finance.account.current_balance",
      "finance.holding.market_value",
      "finance.transaction.amount",
    ]);
  });

  it("the drill and the list agree on one money rendering", () => {
    // The whole point of hoisting `money()` out of record.ts: if the drill keeps a private copy,
    // these two strings drift again and no other test in this file would notice.
    const listCell = formatMoney("-6.5", "USD");
    const drill = recordSubtitle(
      "finance.transaction",
      { amount: "-6.5", currency: "USD", posted_at: null },
      null,
    );
    expect(listCell).toBe("−$6.50");
    expect(drill.startsWith(listCell)).toBe(true);
  });
});

describe("#59 — home state cell maps the REAL availability vocabulary", () => {
  it("a reachable entity reports availability 'online' (not 'available') and its value is shown", () => {
    // This is the exact shape src/connectors/homeassistant.ts produces: raw state that is neither
    // 'unavailable' nor 'unknown' → availability 'online'. The OLD cell treated online ≠ available as
    // an error and hid the value; this asserts it does not.
    const d = homeStateDisplay("online", 62, "bpm");
    expect(d.tone).toBe("ok");
    expect(d.text).toBe("62 bpm");
  });

  it("a string state on an online entity renders verbatim, quiet", () => {
    expect(homeStateDisplay("online", "on", null)).toEqual({ text: "on", tone: "ok" });
    expect(homeStateDisplay("online", "locked", null)).toEqual({ text: "locked", tone: "ok" });
  });

  it("error is reserved for a genuinely unavailable entity", () => {
    expect(homeStateDisplay("unavailable", "unavailable", null).tone).toBe("error");
  });

  it("'unknown' is reachable-but-stateless — calm (idle), never error", () => {
    const d = homeStateDisplay("unknown", "unknown", null);
    expect(d.tone).toBe("idle");
    expect(d.text).toBe("unknown");
  });

  it("state 0 and falsey-but-real values are shown, not treated as empty", () => {
    expect(homeStateDisplay("online", 0, "W").text).toBe("0 W");
  });

  it("renders the value with an ok tone (not a hidden error pill) for a real online row", () => {
    const col: ColumnDef = { field: "state", header: "State", kind: "state" };
    const row: Row = { availability: "online", state: 21.5, unit: "°C" };
    render(<>{renderCell(col, row)}</>);
    const el = screen.getByText("21.5 °C");
    expect(el.getAttribute("data-state-tone")).toBe("ok");
  });
});

// #65 / #122 — the operator's most-repeated complaint: *"still no source on contacts."* Three
// providers feed calendar and contacts on a real box and the LIST showed identical rows. `__provenance`
// is served on every row now; these pin the FOUR answers apart, because the whole defect class here is
// one answer wearing another's words.
describe("__source — the four provenance answers, none of them interchangeable (#65/#122)", () => {
  /** A served row with provenance, as `POST /api/data/:sector` sends it. */
  const withProv = (p: unknown, rest: Row = {}): Row => ({ __provenance: p, ...rest });

  it("a provider row names its provider, through the ONE shared humanisation", () => {
    const s = sourceCell(withProv({ connection_id: "c-1", provider: "google", merged: false }));
    expect(s).toEqual({ text: "Google", kind: "provider" });
    // `api/format`'s brand table, not a second one in this file: the slug `apple` is iCloud to a
    // person (ADR 0030) and `home_assistant` is two words. A local map would agree at first and drift.
    expect(sourceCell(withProv({ connection_id: "c", provider: "apple", merged: false })).text).toBe("iCloud");
    expect(sourceCell(withProv({ connection_id: "c", provider: "simplefin", merged: false })).text).toBe("SimpleFIN");
    expect(sourceCell(withProv({ connection_id: "c", provider: "home_assistant", merged: false })).text).toBe(
      "Home Assistant",
    );
  });

  it("the three providers that made this a bug render as three DIFFERENT cells", () => {
    // The defect, stated as a test: same sector, three connections, one indistinguishable list.
    const cells = ["google", "microsoft", "apple"].map(
      (provider) => sourceCell(withProv({ connection_id: `c-${provider}`, provider, merged: false })).text,
    );
    expect(new Set(cells).size).toBe(3);
    expect(cells).toEqual(["Google", "Microsoft", "iCloud"]);
  });

  it("a merged synthetic is the union marker — it never names an anchor member", () => {
    // connection_id and provider are BOTH null ON PURPOSE: the row stands for more than one
    // connection, so naming one of them would be a half-truth.
    const s = sourceCell(withProv({ connection_id: null, provider: null, merged: true }));
    expect(s).toEqual({ text: "union", kind: "union" });
  });

  it("an unresolvable connection reads 'unknown source' — never a provider guessed from the row", () => {
    const row = withProv(
      { connection_id: "c-gone", provider: null, merged: false },
      // Row content that a guesser would happily mine for a provider name.
      { merchant: "Google Store", source_object_id: "gmail_abc", from_name: "Microsoft" },
    );
    const s = sourceCell(row);
    expect(s).toEqual({ text: "unknown source", kind: "unknown" });
    expect(s.text).not.toMatch(/google|microsoft|gmail/i);
  });

  it("`__provenance` ABSENT is a fact about the wire, and never means 'unknown'", () => {
    // A gateway older than #65/#122 sends no such key. "not served" and "unknown source" are different
    // claims and this Console may not resolve one into the other (api/notserved.test.ts).
    const s = sourceCell({ id: "r1", subject: "hello" });
    expect(s).toEqual({ text: "not served", kind: "unserved" });
    expect(s.text).not.toContain("unknown");
  });

  it("on an older gateway finance keeps the reserved-namespace union derivation it always had", () => {
    // No capability is lost by the upgrade: `union:%` is a reserved `source_object_id` namespace
    // (CLAUDE.md / ADR 0021), so the pre-provenance derivation is still honest when nothing is served.
    expect(sourceCell({ source_object_id: "union:abc" })).toEqual({ text: "union", kind: "union" });
    expect(sourceCell({ source_object_id: "plaid_1", shadowed_by_id: "win-1" })).toEqual({
      text: "shadowed",
      kind: "provider",
    });
  });

  it("a shadowed row keeps BOTH facts — which provider, and that it sits behind a merge", () => {
    // finance's opt-in reveal exists to say WHICH providers a merge swallowed, so the provider name
    // must appear; the shadow marker is the reveal's premise and must not be dropped for it.
    const s = sourceCell(
      withProv({ connection_id: "c-1", provider: "plaid", merged: false }, { shadowed_by_id: "win-1" }),
    );
    expect(s.text).toContain("Plaid");
    expect(s.text).toContain("shadowed");
  });

  it("provenance WINS over the soid derivation — the served fact beats the inferred one", () => {
    // A synthetic winner carries a `union:` soid AND merged:true, so this pair agrees. The assertion
    // that matters is the disagreeing one: a provider row whose soid happens to start with "union"
    // is what the derivation gets wrong and the served answer gets right.
    const s = sourceCell(
      withProv({ connection_id: "c-1", provider: "microsoft", merged: false }, { source_object_id: "union:abc" }),
    );
    expect(s).toEqual({ text: "Microsoft", kind: "provider" });
  });

  it("a malformed __provenance is treated as NOT SERVED, never as a partial answer", () => {
    // `merged` is the discriminator. Defaulting a missing one to `false` would turn a shape mismatch
    // into the confident claim "this row is not merged".
    for (const bad of [null, "google", 7, [], {}, { provider: "google" }, { merged: "yes" }]) {
      expect(sourceCell({ __provenance: bad }).kind).toBe("unserved");
      expect(rowProvenance({ __provenance: bad })).toBeNull();
    }
  });

  it("the cell renders the answer AND tags its kind, so a surface cannot repaint one as another", () => {
    const col: ColumnDef = { field: "__source", header: "Source", kind: "source" };
    render(<>{renderCell(col, { __provenance: { connection_id: null, provider: null, merged: true } })}</>);
    expect(screen.getByText("union").getAttribute("data-source-kind")).toBe("union");
    cleanup();
    render(<>{renderCell(col, { __provenance: { connection_id: "c", provider: "whoop", merged: false } })}</>);
    expect(screen.getByText("WHOOP").getAttribute("data-source-kind")).toBe("provider");
  });
});

// The complaint was about a LIST, so the column has to exist on the objects whose sectors have more
// than one source — not only on finance, where it started.
describe("__source is on every multi-source object, in one shared lane (#122)", () => {
  it("calendar, contacts and mail all carry a Source column", () => {
    for (const key of ["calendar", "contacts", "mail"]) {
      const object = objectDefByKey(key)!.object;
      expect(object.columns.map((c) => c.field), `${key} has no Source column`).toContain("__source");
    }
  });

  it("every Source column is the SAME lane — one object, not five hand-copied widths", () => {
    const sourceCols = Object.values(SECTORS).flatMap((s) =>
      s.objects.flatMap((o) => o.columns.filter((c) => c.field === "__source")),
    );
    // Six sectors' worth, so a new object cannot quietly ship a Source column with its own geometry.
    expect(sourceCols.length).toBeGreaterThanOrEqual(8);
    for (const c of sourceCols) {
      expect(c.header).toBe("Source");
      expect(c.width).toBe("130px"); // the Finance artboard's own Source lane (6I9-0 / 6ML-0)
      expect(c.kind).toBe("source");
    }
  });

  it("no table shows two columns headed Source — health.sample keeps its REGISTRY one", () => {
    // health_samples has a REAL `source` scalar holding the producing provider's token. Two "Source"
    // headers in one table would answer the same question twice, and the REGISTRY column is the better
    // of the two because it is sortable.
    for (const s of Object.values(SECTORS)) {
      for (const o of s.objects) {
        const headers = o.columns.filter((c) => c.header === "Source");
        expect(headers.length, `${o.key} has ${headers.length} Source columns`).toBeLessThanOrEqual(1);
      }
    }
    const sample = objectDefByKey("health.sample")!.object;
    expect(sample.columns.map((c) => c.field)).toContain("source");
    expect(sample.columns.map((c) => c.field)).not.toContain("__source");
  });
});

describe("mail __flags — derived only from served booleans (no invented 'flagged')", () => {
  it("unread from is_read:false", () => {
    expect(mailFlags({ is_read: false })).toBe("unread");
  });
  it("attachment from has_attachments:true", () => {
    expect(mailFlags({ is_read: true, has_attachments: true })).toBe("attachment");
  });
  it("both compose", () => {
    expect(mailFlags({ is_read: false, has_attachments: true })).toBe("unread · attachment");
  });
  it("a read, attachment-less message shows a dash, not a claim", () => {
    expect(mailFlags({ is_read: true, has_attachments: false })).toBe("—");
  });
});

describe("#83 — data-aware columns reflect what was actually cached", () => {
  const cols: ColumnDef[] = [
    { field: "display_name", header: "Name", kind: "text" },
    { field: "primary_email", header: "Email", kind: "muted" },
    { field: "primary_phone", header: "Phone", kind: "mono" },
    { field: "company", header: "Org", kind: "muted" },
  ];

  it("a column empty across every loaded row is dropped (real iCloud contacts are name+phone only)", () => {
    // The iCloud shape: name + phone present, email + org absent on every row.
    const rows: Row[] = [
      { display_name: "Priya", primary_email: null, primary_phone: "+1 415 0142", company: "" },
      { display_name: "Sam", primary_email: "", primary_phone: "+1 628 7781", company: null },
    ];
    const { visible } = analyzeColumns(cols, rows);
    expect(visible.map((c) => c.field)).toEqual(["display_name", "primary_phone"]);
  });

  it("the headline column is never dropped, even when empty", () => {
    const rows: Row[] = [{ display_name: null, primary_email: "a@b.c", primary_phone: null, company: null }];
    const { visible } = analyzeColumns(cols, rows);
    expect(visible[0].field).toBe("display_name");
  });

  it("a sparse (present-but-rare) column stays visible but is flagged sparse", () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      display_name: `p${i}`,
      primary_email: i === 0 ? "only@one.com" : null,
      primary_phone: "x",
      company: "Acme",
    }));
    const { visible, sparse } = analyzeColumns(cols, rows);
    expect(visible.map((c) => c.field)).toContain("primary_email");
    expect(sparse.has("primary_email")).toBe(true);
  });

  it("__source is exempt from hiding — provenance is a synthetic key, not a row field", () => {
    const financeCols: ColumnDef[] = [
      { field: "merchant", header: "Merchant", kind: "text" },
      { field: "__source", header: "Source", kind: "source" },
    ];
    // The value lives under `__provenance`, so `row["__source"]` is ALWAYS empty — a data-aware rule
    // reading the field name would drop the provenance column on every table, every time.
    const rows: Row[] = [
      { merchant: "X", __provenance: { connection_id: "c", provider: "plaid", merged: false } },
    ];
    const { visible } = analyzeColumns(financeCols, rows);
    expect(visible.map((c) => c.field)).toContain("__source");
  });

  it("no rows → every column stays (nothing has been contradicted yet)", () => {
    const { visible } = analyzeColumns(cols, []);
    expect(visible).toHaveLength(cols.length);
  });
});
