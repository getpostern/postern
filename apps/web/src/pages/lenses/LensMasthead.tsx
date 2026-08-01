// The sector-lens masthead — kicker "Sector", the specimen + sector name, the generated verdict
// SENTENCE (exceptions-first, composed by the page — build-notes §14.4), and the right block: the one
// "Last synced" clock, a REAL "Sync now" (a per-connection sync over the sector, #57 — there is no
// second button labelled "Fetch live"), and a served transport caption.
//
// Built on the frozen <Masthead>: kicker → verdict → sub. The hero is one of the two surfaces where
// the sector IS THE SUBJECT, so its title is the full <SectorSpecimen> beside a stack of the display
// name over the sector's Latin binomial — the `Title` frame the six lens artboards all carry
// (`ID-0`/`PT-0` and siblings: flex row, gap 18, then a 2px column of 46px display over 16px/20px
// italic body in faded ink).
//
// THE GAP THIS FILE USED TO RECORD IS CLOSED. The old header said "the artboards' richer hero
// botanical + its Latin binomial are NOT in the mark vault", and the page shipped a 44px <SectorChip>
// anyway — a known gap resolved silently in a comment instead of raised as a blocker, which is the
// one process failure build-notes §19.1 names. Both drawings are now ported (`marks/SectorSpecimen`)
// and the binomial is bound, so nothing here is standing in for anything.
//
// The `SECTOR_META` import below is the FIRST cross-page-group import in `pages/`, and it is
// deliberate: the six binomials are one editorial table and a second copy of them is how two surfaces
// start disagreeing about the same fact. The cleaner home is `marks/` or `api/` — flagged for the
// mother, since hoisting it means editing `gatehouse/helpers.ts`, which this unit does not own.

import { Masthead } from "../../shell";
import { SectorSpecimen } from "../../marks";
import type { Sector } from "../../api/types";
import { SECTOR_META } from "../gatehouse/helpers";
import { SECTOR_NAME } from "./lensmeta";
import styles from "./LensMasthead.module.css";

export function LensMasthead({
  sector,
  verdict,
  lastSyncedLabel,
  transportCaption,
  onSyncNow,
  syncing,
  syncDisabledReason,
}: {
  sector: Sector;
  verdict: string;
  /** The one "last synced" clock, already rendered relative by the page (advances via the page tick). */
  lastSyncedLabel: string;
  /** The served transport descriptor ("polls every 2h" / "push stream"); read/act is NOT served. */
  transportCaption: string;
  onSyncNow: () => void;
  syncing: boolean;
  /** Set = the button is drawn DISABLED with this sentence beside it (degradation contract §2).
   *  Absent/undefined = a live button. */
  syncDisabledReason?: string;
}): JSX.Element {
  // #100 item 5 — an empty sector's "Sync now" was fully enabled and silently did nothing (the
  // page's own guard returns immediately with no connections), sitting beside a working "Connect a
  // source" CTA, so the likeliest first click was the dead one. The degradation contract's answer is
  // the same one the inspector's schema preview already ships: DRAW it, disable it, say why.
  const disabledByReason = syncDisabledReason != null;
  return (
    <Masthead
      kicker="Sector"
      verdict={
        <span className={styles.title}>
          <SectorSpecimen sector={sector} size="hero" />
          <span className={styles.titleText}>
            <span className={styles.name}>{SECTOR_NAME[sector]}</span>
            {/* The binomial is a fixed editorial identity label, like the sector's own name — bound
              * from the ONE table that already holds all six (SECTOR_META), never a second copy. */}
            <span className={styles.latin}>{SECTOR_META[sector].latin}</span>
          </span>
        </span>
      }
      sub={verdict}
      right={
        <div className={styles.right}>
          <div className={styles.clock}>
            <div className={styles.clockLabel}>Last synced</div>
            <div className={styles.clockValue}>{lastSyncedLabel}</div>
          </div>
          <button
            type="button"
            className={disabledByReason ? `${styles.syncBtn} ${styles.syncBtnDead}` : styles.syncBtn}
            onClick={onSyncNow}
            disabled={syncing || disabledByReason}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncDisabledReason ? (
            <div className={styles.syncDisabledReason}>{syncDisabledReason}</div>
          ) : null}
          {transportCaption ? <div className={styles.caption}>{transportCaption}</div> : null}
        </div>
      }
    />
  );
}
