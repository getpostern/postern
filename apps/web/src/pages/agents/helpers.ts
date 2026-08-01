// Agents group — shared, pure, tested helpers. No JSX, no API calls: just the derivations three
// pages agree on, so a status word or a degradation branch is defined once and cannot drift.

import { SECTORS, type Agent, type Sector } from "../../api/types";

/** Whole-day milliseconds. */
const DAY_MS = 86_400_000;

/** The expiry presets on the Mint form + the in-place editor (Paper `5KL-0`): Never, 30/60/90 days. */
export interface ExpiryOption {
  label: string;
  /** Whole days for `createAgent.expiresInDays`; null = never-expiring (the field is omitted). */
  days: number | null;
}
export const EXPIRY_OPTIONS: readonly ExpiryOption[] = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "60 days", days: 60 },
  { label: "90 days", days: 90 },
];

/** A key's lifecycle status. Revoked WINS over expired; expired is computed from the SERVED
 *  `expires_at` vs now (absent/null = never-expiring). Mirrors the shipped AgentsPage rule. */
export function agentStatusOf(a: Agent, nowMs: number = Date.now()): "active" | "revoked" | "expired" {
  if (a.revoked_at) return "revoked";
  if (a.expires_at != null && new Date(a.expires_at).getTime() <= nowMs) return "expired";
  return "active";
}

/**
 * A key that can actually come through the gate RIGHT NOW: not revoked AND not past `expires_at`.
 *
 * The auth layer denies both, so no surface may count or name either as a key-holder (#100 item 4).
 * Four surfaces filtered on `!a.revoked_at` alone — the Gatehouse masthead clause, its sector cards,
 * "Who came through", and the sector lens's CAN-READ lane — so an expired key was counted and named
 * as a live reader on the one page whose whole job is a truthful glance. `agentStatusOf` already
 * computed the truth; this is the predicate those surfaces should have been asking for.
 */
export function isKeyHolder(a: Agent, nowMs: number = Date.now()): boolean {
  return agentStatusOf(a, nowMs) === "active";
}

/** The sub-line expiry phrase for the register + detail (`never expires` / `expires in 60d` /
 *  `expired`). `expires_at` absent or null = never (the default). */
export function expiryPhrase(expiresAt: string | null | undefined, nowMs: number = Date.now()): string {
  if (expiresAt == null) return "never expires";
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return "never expires";
  if (t <= nowMs) return "expired";
  const days = Math.max(1, Math.round((t - nowMs) / DAY_MS));
  return `expires in ${days}d`;
}

/** Which expiry preset a served `expires_at` rounds to, for a Rotate/re-mint preload — so rotating a
 *  90-day key defaults back to 90. Never-expiring → null; anything not near a preset → null (the
 *  operator re-picks) rather than an invented arbitrary number. */
export function expiryPresetFor(expiresAt: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (expiresAt == null) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t) || t <= nowMs) return null;
  const days = Math.round((t - nowMs) / DAY_MS);
  const match = EXPIRY_OPTIONS.find((o) => o.days != null && Math.abs(o.days - days) <= 1);
  return match?.days ?? null;
}

/** Where the SERVED deadline sits relative to the four presets — the READ half of the in-place
 *  editor. Four cases, deliberately not three. */
export type ExpirySelection =
  | { kind: "never" }
  | { kind: "preset"; days: number }
  | { kind: "custom"; days: number }
  | { kind: "expired" };

/**
 * Which expiry chip (if any) the key's current deadline is sitting on.
 *
 * **Why this is not `expiryPresetFor`.** That helper answers a different question — "what should the
 * Rotate form preload?" — and for that purpose it correctly folds *never-expiring* and *no preset is
 * close* into the same `null`: in a blank form both mean "start the operator somewhere sane". On a
 * LIVE control the same fold is a false statement. A key with 200 days left is not near any preset,
 * so the fold would light the **Never** chip — the Console asserting "this key has no deadline" two
 * lines under its own served sub-line reading "expires in 200d". Every custom deadline hits this: the
 * chips offer four lifetimes and `createAgent` accepts any of 1..3650 (a CLI, a curl, a future form).
 *
 * `expired` is its own case because a lapsed key must not light a chip either: the deadline it holds
 * is real, in the past, and no longer offerable — and the control is refused on it anyway.
 */
export function expirySelection(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): ExpirySelection {
  // Absent, null, or unusable all read as "no deadline", which is exactly what `expiryPhrase` says
  // out loud on the same screen. Two renderings of one fact must not disagree.
  if (expiresAt == null) return { kind: "never" };
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return { kind: "never" };
  if (t <= nowMs) return { kind: "expired" };
  const days = Math.max(1, Math.round((t - nowMs) / DAY_MS));
  const match = EXPIRY_OPTIONS.find((o) => o.days != null && Math.abs(o.days - days) <= 1);
  return match?.days != null ? { kind: "preset", days: match.days } : { kind: "custom", days };
}

/** Is THIS chip the one the served deadline sits on? `custom`/`expired` light nothing — no chip may
 *  claim a value the gateway did not serve. */
export function isExpiryChipOn(sel: ExpirySelection, days: number | null): boolean {
  if (sel.kind === "never") return days === null;
  if (sel.kind === "preset") return days === sel.days;
  return false;
}

/** How the register's "Granted sectors" cell + the reveal recap read a grant set:
 *   - `all`  → the italic "every sector" line (all six)
 *   - `none` → the italic "no sectors" line (a default-deny key that was never granted anything)
 *   - `some` → the recap chips for the granted sectors, in canonical SECTORS order. */
export function grantSummary(
  sectors: string[],
): { kind: "all" } | { kind: "none" } | { kind: "some"; sectors: Sector[] } {
  const granted = SECTORS.filter((s) => sectors.includes(s));
  if (granted.length === 0) return { kind: "none" };
  if (granted.length === SECTORS.length) return { kind: "all" };
  return { kind: "some", sectors: granted };
}

/**
 * The passage / last-seen reading (#80 / #89, build-notes §16.6).
 *
 * `Agent.last_seen_at` **is served now** (`listAgents`, commit 8529bd3) as an aggregate over the whole
 * ledger. Three cases, all genuinely different — the distinction is the whole of #58:
 *   - `undefined` → the gateway did not report it at all (it predates the field). Never render "never".
 *   - `null`      → reported, and this key has no recorded passage.
 *   - a string    → the instant of the last recorded call, any sector, allowed or denied.
 *
 * **This helper never reads the audit feed**, and that stays true now that the field is served.
 * Reducing the capped, newest-first `/api/audit` page to a last-seen renders a quiet agent as "never"
 * — false, not approximate, and invisible in every fixture.
 *
 * WHAT THE VALUE IS WORTH, exactly: audit is fire-and-forget and droppable under load (CLAUDE.md
 * invariant), so this is a LOWER BOUND on recency, not a measurement. The error only ever runs one
 * way — a lost line can make a key look quieter than it was, never busier — which is the safe
 * direction for a revoke decision. The COPY at each call site has to carry that: "recorded", not
 * "used"; and absence is "nothing recorded", never "idle".
 */
export function passageDisplay(a: Agent): { kind: "not_served" } | { kind: "never" } | { kind: "at"; iso: string } {
  if (!("last_seen_at" in a) || a.last_seen_at === undefined) return { kind: "not_served" };
  if (a.last_seen_at === null) return { kind: "never" };
  return { kind: "at", iso: a.last_seen_at };
}

/**
 * Which of THIS key's grants it has actually reached, from the served per-sector `last_read_at`
 * (last ALLOWED read per sector) — the half of passage that answers "is this grant earning its keep?"
 *
 * Returns `null` when the gateway did not report the field at all, so a caller renders nothing rather
 * than an empty list that would read as "it has used none of them".
 *
 * Only GRANTED sectors are listed. `last_read_at` can also carry a sector this key no longer holds (it
 * read Mail last week, the grant came off since); that is history about a grant that no longer exists
 * and it does not belong in a line whose subject is the current grant set — the ledger still has it.
 *
 * A granted sector MISSING from the map is a grant with no recorded read — the same lower bound as
 * `last_seen_at`, so it means "nothing recorded", not "never touched".
 */
export function sectorReads(a: Agent): { read: { sector: Sector; iso: string }[]; unread: Sector[] } | null {
  const served = a.last_read_at;
  if (served === undefined) return null;
  const read: { sector: Sector; iso: string }[] = [];
  const unread: Sector[] = [];
  for (const s of SECTORS) {
    if (!a.sectors.includes(s)) continue;
    const iso = served[s];
    if (iso) read.push({ sector: s, iso });
    else unread.push(s);
  }
  return { read, unread };
}

/**
 * The one sentence that qualifies every passage figure the Console prints — the register's column and
 * the detail page's readout both show it, and they show the SAME words on purpose.
 *
 * It exists because the number is honest only with it. `last_seen_at` / `last_read_at` are aggregates
 * over an append-only trail that is written fire-and-forget, off the response path, by invariant — so
 * they are a floor on activity, not a measurement. Saying WHICH WAY that can be wrong is what makes
 * them safe to act on: a lost line can only make a key look quieter, never busier, so revoking on a
 * quiet reading is never a decision made on an overstatement.
 *
 * Written for the person, not for this repo (#106): no "served", no "audit_log", no invariant names.
 */
export const PASSAGE_LOWER_BOUND_NOTE =
  "Passage is what the ledger wrote down. Entries are written after the answer has already gone out, so a busy moment can lose one — a key can read quieter here than it really was, never busier.";

/**
 * What the register and the detail page BOTH say when the gateway did not report passage at all.
 *
 * One constant because they said two different things — "not recorded by this gateway" and "this
 * gateway doesn't record passage per key" — and both were subtly stronger than the truth. The Console
 * knows only that the field was absent from the answer; whether the gateway records passage is not
 * something it can see. That distinction is the whole of #58, so the fix is to say the weaker true
 * thing, not the friendlier vague one: it was not REPORTED.
 *
 * Written to read correctly in both slots: a Passage cell in the register, and the readout beside the
 * key on the detail page where "last seen 1h ago" would otherwise sit.
 */
export const PASSAGE_NOT_REPORTED = "not reported by this gateway";

/**
 * The two destructive blast radii, written ONCE.
 *
 * They were duplicated verbatim in `AgentsPage.tsx` and `AgentDetailPage.tsx` — the same two overlays,
 * reached from two rows — which is the drift shape this page group has already been bitten by twice
 * (two provider-name tables, two sector-label tables). A blast-radius sentence is the worst possible
 * place for two copies to disagree: it is the last thing a person reads before revoking a key.
 *
 * #106 changed the WORDS and not one of the facts, and each one is load-bearing:
 *   - "every rotating bridge token derived from it" → the tokens a hosted client holds. Same set; the
 *     reader has met claude.ai, has never met "the bridge", and "rotating" told them nothing they can
 *     act on. UNDERSTATING this is the danger, so the hosted client is named outright.
 *   - "Its audit history is kept" → "Its entries in the ledger are kept". The Console's own name for
 *     that trail is the Ledger, and it is a page the reader can open.
 *   - "An in-flight session already resolved its grants and may finish" survives in full, because it is
 *     the honest limit on how instant a revoke is (grants resolve once per session). Softening it to
 *     "takes effect immediately" would be the overclaim this sentence exists to refuse.
 */
export const REVOKE_BLAST_RADIUS =
  "The key stops working immediately, and every token a hosted client (claude.ai, ChatGPT) holds through it dies with it. Its entries in the ledger are kept. A session already under way has resolved its grants and may finish; the next one is denied.";

/** The revoked-agent delete. "No access changes" is the whole point — it is already dead. */
export const REMOVE_BLAST_RADIUS =
  "This deletes the grant row. It is already revoked, so no access changes — its entries in the ledger survive the delete.";

/** Any Error → a renderable sentence. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error.";
}

/** Title-case sector name for a toggle label. */
export const SECTOR_TITLE: Record<Sector, string> = {
  finance: "Finance",
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
  health: "Health",
  home: "Home",
};
