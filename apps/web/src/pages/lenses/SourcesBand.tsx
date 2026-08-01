// THE SOURCES — the per-connection rows of a sector lens, plus finance's special band (build-notes
// §6 / §12): finance keeps two provider-aggregate rows + a run of institution marks + the dedup note
// and the dedup TRUST flags; every other sector lists one row per connection.
//
// This component is PURE — the page (SectorLens) does every hook read, every SERVED freshness rollup
// (never a re-derivation), and every relative-time render under the page tick, then hands view-models
// here. That keeps the dedup-trust and CAN-ACT behaviour testable without mocking the query stack.

import { Link } from "react-router-dom";
import type { FreshnessDisplay } from "../../api/freshness";
import { InstitutionMark, ProviderTile, type ProviderId } from "../../marks";
import styles from "./SourcesBand.module.css";

/** Served provider → the mark the vault can draw; anything else renders without a tile (never a
 *  crash, never a guessed mark). This was a Set of mark ids tested against the served value, which
 *  silently assumed the two vocabularies are the same string — they are not for Home Assistant,
 *  whose wire value is `home_assistant` (src/connectors/homeassistant.ts) and whose mark id is
 *  `homeassistant`. The membership test therefore failed and the Home lens rendered no tile. A map
 *  translates instead of assuming, and it retires the `as ProviderId` cast that made the mismatch
 *  a type-checked lie. */
const PROVIDER_TILE: Record<string, ProviderId> = {
  apple: "apple",
  gmail: "gmail",
  google: "google",
  microsoft: "microsoft",
  home_assistant: "homeassistant",
  homeassistant: "homeassistant",
  plaid: "plaid",
  simplefin: "simplefin",
  whoop: "whoop",
  apple_health: "apple_health",
};

/** One source row — a single connection, or a finance provider aggregate. All strings are served or
 *  rendered by the page; `freshness` is the SERVED rolled display, `clock` its pre-rendered relative. */
export interface SourceRowVM {
  key: string;
  provider: string;
  name: string;
  sub: string;
  countLabel: string;
  transport: string;
  freshness: FreshnessDisplay;
  clock: string;
  manageTo: string;
}

/** A dedup-trust flag on the finance sources band — the asymmetric outcomes (build-notes §12.3):
 *  `possible` is the only one with an action (confirmable); `unmerged`, `conflict` and `suspended`
 *  are facts. */
export type TrustFlag =
  | { kind: "possible"; institution: string; bankKey: string }
  /** #100 item 7 — the ALIAS GAP the backend already serves as `unmergedDuplicate`: the same last-4
   *  under two disagreeing canonical institutions. It has no action, because the two cards disagree
   *  on the institution, which is exactly why the engine refused to merge them. */
  | { kind: "unmerged"; institution: string; bankKey: string }
  | { kind: "conflict"; institution: string }
  | { kind: "suspended"; institution: string; reason: "currency" | "class" };

/** Finance-only extras rendered beneath the two provider rows. */
export interface FinanceExtras {
  institutions: string[];
  moreCount: number;
  /**
   * Where "and N more →" lands (#112). Required, not defaulted: this link used to be the hardcoded
   * `/sources` — the top of a page listing everything, reached from a link about one provider's
   * institutions — and a default would let the next caller reintroduce that silently.
   *
   * The page derives it (`buildFinanceSources`): the group holding the first hidden bank whose
   * connection this sector serves. Not necessarily the first hidden INSTITUTION — a bank may name no
   * connector in this list, and a deduped bank names several, so a merged bank can resolve through
   * either provider. The band never computes it; it renders what it is handed.
   */
  moreTo: string;
  /** The merged-provenance evidence note ("N account(s) deduped — …, served as one"); null = none.
   *  A merge itself carries NO warning marker (§12.3) — this line is evidence, not an alarm. */
  mergedNote: string | null;
  trustFlags: TrustFlag[];
}

export function SourcesBand({
  glossLabel,
  rows,
  finance,
  note,
}: {
  /** The section-rule right-hand gloss ("2 providers · 15 connections …" / "2 connected · Apple + Microsoft"). */
  glossLabel: string;
  rows: SourceRowVM[];
  /** Present only on the finance lens. */
  finance?: FinanceExtras;
  /** The quiet footprint caption under the rows for a non-finance sector (mail's envelope note, …). */
  note?: string;
}): JSX.Element {
  return (
    <section className={styles.band}>
      <div className={styles.head}>
        <span className={styles.headLabel}>The sources</span>
        <span className={styles.hairline} aria-hidden="true" />
        <span className={styles.headGloss}>{glossLabel}</span>
      </div>

      <div className={styles.rows}>
        {rows.map((r) => (
          <SourceRow key={r.key} row={r} />
        ))}
      </div>

      {finance ? <FinanceBand extras={finance} /> : null}
      {!finance && note ? <p className={styles.footprintNote}>{note}</p> : null}
    </section>
  );
}

function SourceRow({ row }: { row: SourceRowVM }): JSX.Element {
  const tile = PROVIDER_TILE[row.provider];
  return (
    <div className={styles.row}>
      <div className={styles.iconSlot}>
        {tile ? <ProviderTile provider={tile} size={24} /> : null}
      </div>
      <div className={styles.rowLead}>
        <div className={styles.rowName}>{row.name}</div>
        {row.sub ? <div className={styles.rowSub}>{row.sub}</div> : null}
      </div>
      <div className={styles.rowCount}>{row.countLabel}</div>
      <div className={styles.rowTransport}>{row.transport}</div>
      <div className={styles.rowFresh}>
        <RowFreshness display={row.freshness} clock={row.clock} />
      </div>
      <Link className={styles.rowManage} to={row.manageTo}>
        Manage <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

/** The row freshness cell: an exception BADGE (the served word) wins; otherwise a live push stream
 *  reads "streaming" and a poll/webhook connection reads its last-heard clock. All from the SERVED
 *  display — nothing here compares a timestamp. */
function RowFreshness({ display, clock }: { display: FreshnessDisplay; clock: string }): JSX.Element {
  if (display.label != null) {
    return (
      <span className={styles.freshBadge} data-tone={display.tone}>
        {display.label}
      </span>
    );
  }
  if (display.nextLine === "Instant — connected") {
    return <span className={styles.freshClock}>streaming</span>;
  }
  return <span className={styles.freshClock}>{clock}</span>;
}

function FinanceBand({ extras }: { extras: FinanceExtras }): JSX.Element {
  return (
    <>
      {extras.institutions.length > 0 ? (
        <div className={styles.institutions}>
          {extras.institutions.map((name) => (
            <span className={styles.institution} key={name}>
              <InstitutionMark institution={name} size={22} />
              <span className={styles.institutionName}>{name}</span>
            </span>
          ))}
          {extras.moreCount > 0 ? (
            <Link className={styles.instMore} to={extras.moreTo}>
              and {extras.moreCount} more <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      ) : null}

      {extras.mergedNote ? (
        <div className={styles.dedupNote}>
          <span className={styles.dedupDot} aria-hidden="true" />
          <span className={styles.dedupText}>{extras.mergedNote}</span>
        </div>
      ) : null}

      {extras.trustFlags.map((f) => (
        <TrustRow key={flagKey(f)} flag={f} />
      ))}
    </>
  );
}

/** Two un-merged cards ALWAYS carry different canonical institutions but may render the same display
 *  name, so the served `bankKey` is the only collision-free key for them. */
function flagKey(f: TrustFlag): string {
  return f.kind === "possible" || f.kind === "unmerged"
    ? `${f.kind}:${f.bankKey}`
    : `${f.kind}:${f.institution}`;
}

/** One dedup-trust flag. `possible` is marigold with the ONE action (→ confirm-a-merge, joined by
 *  bankKey equality server-side); `conflict`/`suspended` are quiet idle facts with no action. */
function TrustRow({ flag }: { flag: TrustFlag }): JSX.Element {
  if (flag.kind === "possible") {
    return (
      <div className={styles.trustRow}>
        <span className={styles.trustDotAttention} aria-hidden="true" />
        <span className={styles.trustText}>
          {flag.institution} · Possibly the same account
        </span>
        <Link className={styles.trustAction} to={`/sectors/finance/merges/${encodeURIComponent(flag.bankKey)}`}>
          They&rsquo;re the same
        </Link>
      </div>
    );
  }
  if (flag.kind === "unmerged") {
    // IDLE and action-less, deliberately NOT marigold: `possible` is the only confirmable flag, and
    // the attention dot is reserved for the one offer the operator can act on (build-notes §12.3,
    // one voice per surface). There is nothing to confirm here.
    return (
      <div className={styles.trustRow}>
        <span className={styles.trustDotIdle} aria-hidden="true" />
        <span className={styles.trustTextFaded}>
          {flag.institution} · Shares a last-4 with a differently-named institution — likely an alias
          gap; both serve un-merged
        </span>
      </div>
    );
  }
  if (flag.kind === "conflict") {
    return (
      <div className={styles.trustRow}>
        <span className={styles.trustDotIdle} aria-hidden="true" />
        <span className={styles.trustTextFaded}>
          {flag.institution} · Kept apart — the providers report different account kinds
        </span>
      </div>
    );
  }
  return (
    <div className={styles.trustRow}>
      <span className={styles.trustDotIdle} aria-hidden="true" />
      <span className={styles.trustTextFaded}>
        {flag.institution} · Merge held — a {flag.reason} conflict developed; the accounts serve
        separately
      </span>
    </div>
  );
}
