// SectorToggle — THE grant control, one component in three places (spec §P2f, build-notes §3.2):
// the Mint form, the Agent-detail editor, and the recap (register "Granted sectors" cell + the
// reveal-once "Opens" row). Default-deny; grants are domain-level and cover read AND act.
//
// Two drawn shapes, one component:
//   mode="toggle" — an interactive <button> (Paper 5KL-0 / 5US-0): ON = sector-ink 1.5px border +
//       full specimen + ink label; OFF = hairline border + 0.38-opacity specimen + faded label.
//       aria-pressed carries the state; the visible label is the accessible name (the chip is
//       decorative, aria-hidden, so a screen reader never announces "Finance Finance").
//   mode="recap" — a non-interactive chip (Paper 2IG-0 granted cell / 5QR-0 Opens): specimen +
//       lowercase italic label, no box. The same specimen, so a grant reads identically everywhere.
//
// The per-sector ink is a data-attr the module CSS keys off (ADR 0031 — no inline colour).

import { SectorChip } from "../../marks";
import { SECTOR_TITLE } from "./helpers";
import type { Sector } from "../../api/types";
import styles from "./SectorToggle.module.css";

/** The interactive toggle used by Mint and Agent-detail. */
export function SectorToggle({
  sector,
  granted,
  onToggle,
  disabled = false,
}: {
  sector: Sector;
  granted: boolean;
  onToggle: (sector: Sector) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.toggle}
      data-sector={sector}
      data-on={granted || undefined}
      aria-pressed={granted}
      disabled={disabled}
      onClick={() => onToggle(sector)}
    >
      <span className={styles.chipSlot} aria-hidden="true">
        <SectorChip sector={sector} dimmed={!granted} size={15} />
      </span>
      <span className={styles.label}>{SECTOR_TITLE[sector]}</span>
    </button>
  );
}

/** The read-only recap chip used by the register cell and the reveal-once "Opens" row — the same
 *  specimen, lowercase italic label. The chip is decorative; the label is the announced text. */
export function GrantChip({ sector }: { sector: Sector }): JSX.Element {
  return (
    <span className={styles.recap}>
      <span className={styles.chipSlot} aria-hidden="true">
        <SectorChip sector={sector} size={15} />
      </span>
      <span className={styles.recapLabel}>{sector}</span>
    </span>
  );
}
