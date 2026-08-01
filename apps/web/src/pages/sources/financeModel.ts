// Finance joins for Sources — turning the bank-CARD wire (FinanceBankSummary[], #33) into the Plaid
// group's nested bank rows and SimpleFIN's flat row + institution line.
//
// The join is by CONNECTION ID, never by re-deriving dedup: a bank names its providers[] with each
// one's connectionId, and we match those against the Plaid / SimpleFIN connectors. Zero FE dedup
// logic (build-notes §12.3). A merged card (providers.length > 1) is shown once under Plaid with a
// "also arrives via …" note and appears again only in SimpleFIN's coverage line marked "(merged
// above)", so SimpleFIN's own count still adds up (§12.3).
//
// ⚠️ THE WIRE IS CARD-GRAINED, NOT INSTITUTION-GRAINED (#111). Its rows are canonical institution ×
// last-4 mask × currency, so three Amex cards arrive as three rows all reading `institution: "American
// Express"`. Both surfaces below used to render one thing per ROW: Plaid drew three "American Express"
// rows all linking to the same connection page, and SimpleFIN's coverage line named the bank three
// times and then said "One link carries all 3". Neither is a rendering bug — both are the wire's grain
// taken at face value. So every count and every repeated element here goes through `institutionRun`
// (grain.ts), which folds on the STABLE identifier the dedup engine keys on.

import { ago, count } from "../../api/format";
import { institutionIdentity, institutionRun, type Institution } from "./grain";
import { cadenceCell, providerDisplay, type Cell } from "./model";
import type { ConnectorStatus, FinanceBankProvider, FinanceBankSummary } from "../../api/types";

/** One nested Plaid bank row — ONE PER (connection × institution), not one per served card (#111). */
export interface PlaidBankRow {
  /** The row's identity and its React key: the connection it belongs to plus the institution fold. NOT
   *  a served `bankKey` any more — several cards fold into one row. */
  rowKey: string;
  /** The Plaid connection to Manage / Reconnect. */
  connectionId: string;
  institution: string;
  /**
   * The card's `orgDomain` AS SERVED, for the institution mark — verbatim, never normalised here
   * (`api/types.ts`). REQUIRED-but-nullable rather than optional on purpose: an optional field lets a
   * future row builder forget it, which silently demotes the mark to the weaker display-name path.
   */
  orgDomain: string | null | undefined;
  /**
   * Last-4, shown ONLY when this row folded from a single served card — a connection holding several
   * cards has several masks, and printing one of them would narrow the row to an account it is not.
   * The coverage cell carries the count instead.
   */
  mask: string | null;
  /** "also arrives via SimpleFIN — served as one" when this card is a cross-provider merge. */
  mergedNote: string | null;
  coverage: string;
  /**
   * The CADENCE cell — the schedule this bank's own connector is on, exactly like every other row in
   * that lane, displaced only by a consent LAPSE. A column heading is a promise about every cell
   * beneath it, and this lane used to answer `consent ok` on healthy banks while the same 150px lane
   * on every other row held a real schedule (§18.2).
   */
  cadence: Cell;
  /** The consent LAPSE, else null — neither a healthy nor an as-yet-unknown consent earns a cell
   *  (§14.1a, #95 item 3). This is also the predicate the reconnect affordance hangs off. */
  consent: Cell | null;
  lastHeard: { text: string; alarm: boolean };
  /** true → the row's action is "Reconnect →" (seal), else "Manage →". */
  needsReconnect: boolean;
}

// A local OTHER_PROVIDER_NAME table — `{ simplefin: "SimpleFIN", plaid: "Plaid" }` — sat here and was
// consulted BEFORE `providerDisplay` (#95 item 4). Both entries agreed with the shared path, proven
// mechanically before the fold rather than assumed: that agreement is exactly the argument that
// justified deleting model.ts's PROVIDER_DISPLAY, where the entry was never the defect and the
// DUPLICATE was. The names now come from the one humanisation rule like every other surface's.

/** The provider on a bank routed through one of the given Plaid connections, or null. */
function providerIn(
  bank: FinanceBankSummary,
  byConnection: Map<string, ConnectorStatus>,
): FinanceBankProvider | null {
  return bank.providers.find((p) => byConnection.has(p.connectionId)) ?? null;
}

/**
 * Plaid health → the consent LAPSE, or null when consent has nothing to say.
 *
 * `ok` returns NULL and not a word: a healthy state earns no cell (§14.1a), and the `consent ok` it
 * used to return was rendered through the same component that holds a real schedule everywhere else.
 * The LAPSE predicate is untouched and is load-bearing — `lastHeard.alarm` and `needsReconnect` both
 * hang off `alarm`, and `needsReconnect` is what turns the row's action from *Manage →* into
 * *Reconnect →*. Dropping the derivation with the string would have silently disabled the one
 * affordance that clears the lapse.
 *
 * **`unknown` returns null too, and that is #95 item 3.** Removing `consent ok` from the cadence lane
 * (§18.2 — a column heading is a promise about every cell beneath it) left `unknown` behind, and
 * `unknown` is what a bank reads immediately after it is linked (`item_status` still null) or while its
 * connector is paused. So the defect survived for the very first state a person sees. `unknown` is NOT
 * a lapse — no alarm, no Reconnect — and it is not a schedule either, so it belongs in neither: the
 * row falls through to the cadence its own connector is on ("every 2h · poll", or "paused", which is
 * strictly more use than "consent unknown"), and `lastHeard` already says whether anything has arrived.
 * Behaviour is unchanged: `unknown` produced `alarm: false`, exactly like `null`.
 */
function consentCell(health: FinanceBankSummary["health"]): Cell | null {
  if (health === "ok" || health === "unknown") return null;
  return { text: "consent lapsed", alarm: true };
}

/** Worst-of over the served health words, the server's own ordering (`finance-routes.ts` HEALTH_RANK).
 *  Two cards of one Item normally agree, but a card that merged with SimpleFIN carries that connector's
 *  standing too — so a fold must never let a healthy sibling hide a lapse. */
const HEALTH_RANK: Record<FinanceBankSummary["health"], number> = {
  ok: 0,
  unknown: 1,
  action_required: 2,
  error: 3,
};

/**
 * Build the Plaid group's nested bank rows from the banks that route through a Plaid connection.
 *
 * ONE ROW PER (connection × institution), which is the design's own rule — "a row exists for every
 * connection; an institution that is not a connection is shown as coverage, not as a row" (§12.2), on
 * top of "one bank = one connection" (§12.1 / CLAUDE.md). The wire is card-grained, so an Amex Item
 * holding three cards used to draw three identical "American Express" rows, each with its own
 * "Manage →" pointing at the same connection page — the #111 symptom, in the Plaid lane.
 *
 * The fold is keyed on the connection AND the institution rather than on the connection alone: one
 * Plaid Item is one bank today, and if a gateway ever serves two institutions under one Item this
 * splits them into two honest rows instead of hiding one. It never folds across connections.
 *
 * Takes the CONNECTORS rather than a set of ids because each row inherits its own connector's
 * cadence (#88 draws one rule for the group; the wire is per-row, so we read the row's own value
 * rather than inventing a group one).
 */
export function plaidBankRows(
  banks: FinanceBankSummary[],
  connectors: ConnectorStatus[],
): PlaidBankRow[] {
  const byConnection = new Map(connectors.map((c) => [c.connectionId, c]));

  /** The served cards behind one rendered row, in served order. */
  interface Fold {
    connectionId: string;
    provider: FinanceBankProvider;
    cards: FinanceBankSummary[];
  }
  const folds = new Map<string, Fold>();
  for (const bank of banks) {
    const p = providerIn(bank, byConnection);
    if (!p) continue;
    const rowKey = `${p.connectionId}|${institutionIdentity(bank)}`;
    const existing = folds.get(rowKey);
    if (existing) existing.cards.push(bank);
    else folds.set(rowKey, { connectionId: p.connectionId, provider: p, cards: [bank] });
  }

  const rows: PlaidBankRow[] = [];
  for (const [rowKey, fold] of folds) {
    // Non-null by construction: `providerIn` only matches a connectionId that is a key of this map.
    const connector = byConnection.get(fold.connectionId)!;
    const first = fold.cards[0];

    // The provenance note is a UNION over the folded cards: if any one of them arrives via a second
    // pipe, the row does. Naming each other provider once keeps it readable when two cards merged.
    const otherProviders = [
      ...new Set(
        fold.cards
          .filter((b) => b.dedupGroupId != null)
          .flatMap((b) => b.providers)
          .filter((x) => x.connectionId !== fold.connectionId)
          .map((x) => providerDisplay(x.provider)),
      ),
    ];
    const mergedNote =
      otherProviders.length > 0
        ? `also arrives via ${otherProviders.join(" · ")} — served as one`
        : null;

    const health = fold.cards.reduce(
      (worst, b) => (HEALTH_RANK[b.health] > HEALTH_RANK[worst] ? b.health : worst),
      "ok" as FinanceBankSummary["health"],
    );
    const consent = consentCell(health);
    const accountCount = fold.cards.reduce((n, b) => n + b.accountCount, 0);

    rows.push({
      rowKey,
      connectionId: fold.connectionId,
      institution: first.institution,
      // The first non-null domain among the folded cards. They are one institution by construction, so
      // they agree wherever they are present; taking the first present one keeps the mark on the
      // stable path when only some cards carry a domain.
      orgDomain: fold.cards.find((b) => b.orgDomain != null)?.orgDomain ?? first.orgDomain,
      mask: fold.cards.length === 1 ? first.mask : null,
      mergedNote,
      coverage: `${count(accountCount)} ${accountCount === 1 ? "account" : "accounts"}`,
      // Only an ALARM may displace the schedule. `consent ?? cadenceCell(connector)` was the second
      // half of #95 item 3: it put whatever `consentCell` returned into the cadence lane, so any
      // future non-alarm consent word would land back in a column that promises a schedule. This
      // spelling makes that structurally impossible rather than relying on `consentCell` staying
      // disciplined — the two guards are deliberate, and `financeModel.test.ts` pins both.
      cadence: consent?.alarm ? consent : cadenceCell(connector),
      consent,
      lastHeard: { text: ago(fold.provider.lastSyncedAt), alarm: consent?.alarm ?? false },
      needsReconnect: consent?.alarm ?? false,
    });
  }
  return rows;
}

/** The institutions inside a single SimpleFIN link, plus whether any of them merged with a Plaid
 *  bank ("(merged above)"). SimpleFIN is ONE connector holding N orgs, so these are coverage, not
 *  rows (§12.2). */
export interface SimplefinInstitutions {
  /**
   * One entry per DISTINCT institution in the link, in served order (#111). Was a `names: string[]`
   * pushed once per served card, which is why the coverage line named Amex three times and then said
   * "One link carries all 3" — three cards of one bank counted as three banks. Renamed rather than
   * re-pointed so the old grain cannot be read by mistake at a call site.
   */
  institutions: Institution[];
  anyMerged: boolean;
  /** The ACCOUNT grain, and deliberately still account-grained: this is what the coverage cell says,
   *  and a merged Amex account still counts toward SimpleFIN's own total (§12.3). */
  totalAccounts: number;
}

export function simplefinInstitutions(
  banks: FinanceBankSummary[],
  simplefinConnectionId: string,
): SimplefinInstitutions {
  const mine = banks.filter((b) =>
    b.providers.some((p) => p.connectionId === simplefinConnectionId),
  );
  let anyMerged = false;
  let totalAccounts = 0;
  for (const bank of mine) {
    totalAccounts += bank.accountCount;
    if (bank.dedupGroupId != null && bank.providers.length > 1) anyMerged = true;
  }
  // `institutionRun` also drops the zero-account connector placeholder — otherwise a SimpleFIN link
  // that has cached nothing yet lists "SimpleFIN (connecting…)" as one of its banks.
  return { institutions: institutionRun(mine), anyMerged, totalAccounts };
}
