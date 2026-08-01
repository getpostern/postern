// The six sector CHIPS — the 15px silhouettes, tier one of build-notes §11.3. The other tier is the
// full botanical drawing and it is a different component, `SectorSpecimen`; the two are not one
// drawing at two sizes, and the loose phrase "specimen chip" for what lives here is retired.
//
// PORTED, NEVER REDRAWN. get_jsx({format:"inline-styles"}) from the app file
// 01KY3S7JMA16R0QZVSX084WWDD, page 1-0:
//   finance 9OG-0 · mail 9HT-0 · calendar 9I3-0 · contacts 9OO-0 · health 9ZV-0 · home 9IM-0
// Each is a 15×15 SVG on a `0 0 14 14` viewBox. Colours are LITERAL HEXES, not tokens — these are
// accepted illustrations (build-notes §0, §11.2). Note the specimens' green is #40794C, which is
// deliberately NOT --sector-calendar; keep the vectors byte-faithful rather than re-tokenised.
//
// Health is the one specimen authored rather than scaled (build-notes §10.5 / §11.2): a single
// bleeding-heart bloom, because a first attempt at three small hearts read as a smudge at 15px. It
// is on the law's plate (landing file section II·b `sector-chips-15`), so it is not an invention
// here — it is a port like the other five.
//
// THE RULE THIS COMPONENT ENFORCES — one of TWO TIERS, not a universal (build-notes §11.3, as
// corrected 2026-07-24). The chip is the sector's identity wherever a sector is NAMED INSIDE RUNNING
// CONTENT: the sidebar, passage rows, the Agents register, the ledger's Sector column, grant
// toggles, connect footers, list cells. Wherever the sector IS THE SUBJECT — the Gatehouse sector
// cards and the six sector-lens heroes — the surface renders <SectorSpecimen>, the botanical drawing
// with stem, leaves and a Latin binomial.
//
// The earlier header here claimed the chip was used "EVERYWHERE a sector is named … no exceptions
// left anywhere in the design". That wording is SUPERSEDED, and it was load-bearing: §19.1 names it
// as one of the three things that had to line up for pass 1 to scale this 15px silhouette onto the
// cards and heroes and ship a stemless coin-stack where the design has a plant. `SectorChipSize`
// below is the mechanical half of the correction.

import styles from "./SectorChip.module.css";

export type Sector = "finance" | "mail" | "calendar" | "contacts" | "health" | "home";

/**
 * Chips are authored for 15px. 20 is the documented ceiling (build-notes §11.3); above it the
 * drawing has no stem and no leaves and is not a small specimen — it is a bare coin-stack where the
 * design has a plant. A card or a hero uses <SectorSpecimen>.
 *
 * The union makes the substitution a COMPILE error rather than a plausible render, and it does so
 * WITHOUT throwing: there is no <ErrorBoundary> anywhere in apps/web (main.tsx is StrictMode >
 * QueryClientProvider > ToastProvider > App), so a runtime throw in a mark would white-screen the
 * whole Console instead of failing at the author. `npm run typecheck` is both a repo gate and a Stop
 * hook, so the failure lands where the mistake is made. `specimens.test.tsx` scans the call sites,
 * which is the half that actually regressed.
 */
export type SectorChipSize = 15 | 16 | 17 | 18 | 19 | 20;

/** Chip-scale native box (the viewBox is 14 units wide; the drawn box is 15px). */
const CHIP_BASE = 15;

/** The display name that sits beside the chip, and its accessible name when it stands alone. */
const SECTOR_NAME: Record<Sector, string> = {
  finance: "Finance",
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
  health: "Health",
  home: "Home",
};

/** finance — the stacked coins, capped by a lighter top face. */
function FinanceSpecimen() {
  return (
    <>
      <ellipse cx="7" cy="10.6" rx="4.7" ry="1.9" fill="#E7A42A" stroke="#2A2118" strokeWidth="0.8" />
      <ellipse cx="7.1" cy="8.1" rx="4.7" ry="1.9" fill="#E7A42A" stroke="#2A2118" strokeWidth="0.8" />
      <ellipse cx="6.9" cy="5.6" rx="4.7" ry="1.9" fill="#E7A42A" stroke="#2A2118" strokeWidth="0.8" />
      <ellipse cx="6.9" cy="4.9" rx="3.1" ry="1" fill="#F2C879" stroke="#2A2118" strokeWidth="0.8" />
    </>
  );
}

/** mail — the tilted envelope with its cream flap. */
function MailSpecimen() {
  return (
    <>
      <rect x="1.4" y="3.6" width="11.2" height="7.6" rx="0.9" transform="rotate(-2 7 7)" fill="#7B559E" stroke="#26201A" strokeWidth="0.85" />
      <path d="M2.2 4.6 L7 8.2 L11.8 4.5" transform="rotate(-2 7 7)" fill="none" stroke="#F5EDDA" strokeWidth="0.95" strokeLinecap="round" />
    </>
  );
}

/** calendar — the globe-thistle disc. */
function CalendarSpecimen() {
  return (
    <>
      <circle cx="7" cy="7" r="6.1" fill="#EFE6CF" stroke="#40794C" />
      <circle cx="4.4" cy="4.4" r="0.95" fill="#40794C" />
      <circle cx="7.0" cy="4.4" r="0.95" fill="#40794C" />
      <circle cx="9.6" cy="4.4" r="0.95" fill="#40794C" />
      <circle cx="4.4" cy="7.0" r="0.95" fill="#40794C" />
      <circle cx="9.6" cy="7.0" r="0.95" fill="#40794C" />
      <circle cx="4.4" cy="9.6" r="0.95" fill="#40794C" />
      <circle cx="7.0" cy="9.6" r="0.95" fill="#40794C" />
      <circle cx="9.6" cy="9.6" r="0.95" fill="#40794C" />
      <circle cx="7" cy="7" r="1.25" fill="#E7A42A" stroke="#26201A" strokeWidth="0.4" />
    </>
  );
}

/** contacts — forget-me-not, three five-petal clusters on stems. */
function ContactsSpecimen() {
  return (
    <>
      <path d="M7 13 Q6.6 9.5 6.4 7.4 M7 13 Q9 10 10 6.4 M7 13 Q4.4 10.4 3.8 7.6" fill="none" stroke="#40794C" strokeWidth="0.8" />
      <circle cx="4.00" cy="2.57" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="5.93" cy="3.98" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="5.19" cy="6.23" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="2.81" cy="6.23" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="2.07" cy="3.98" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="4.0" cy="4.6" r="0.84" fill="#E7A42A" />
      <circle cx="9.80" cy="1.97" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="11.73" cy="3.38" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="10.99" cy="5.63" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="8.61" cy="5.63" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="7.87" cy="3.38" r="1.24" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="9.8" cy="4.0" r="0.84" fill="#E7A42A" />
      <circle cx="6.80" cy="6.25" r="1.01" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="8.37" cy="7.39" r="1.01" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="7.77" cy="9.23" r="1.01" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="5.83" cy="9.23" r="1.01" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="5.23" cy="7.39" r="1.01" fill="#5877C0" stroke="#26201A" strokeWidth="0.5" />
      <circle cx="6.8" cy="7.9" r="0.68" fill="#E7A42A" />
    </>
  );
}

/** health — the bleeding-heart bloom. Inner cream petal is drawn FIRST so it sits behind. */
function HealthSpecimen() {
  return (
    <>
      <path d="M6.3 8.5 L6.3 12.2 Q7 13.3 7.7 12.2 L7.7 8.5 Z" fill="#F5EDDA" stroke="#26201A" strokeWidth="0.5" strokeLinejoin="round" />
      <path d="M7 10.3 C2.4 6.9 4.0 2.9 7 5.5 C10.0 2.9 11.6 6.9 7 10.3 Z" fill="#E9795E" stroke="#26201A" strokeWidth="0.6" strokeLinejoin="round" />
    </>
  );
}

/** home — the birdhouse. */
function HomeSpecimen() {
  return (
    <>
      <path d="M2.6 6.6 L7 2.6 L11.4 6.6 L11.4 12.4 L2.6 12.4 Z" transform="rotate(2 7 7)" fill="#D26A8B" stroke="#26201A" strokeWidth="0.9" strokeLinejoin="round" />
      <rect x="5.9" y="8.6" width="2.2" height="3.8" transform="rotate(2 7 7)" fill="#F5EDDA" stroke="#26201A" strokeWidth="0.55" />
    </>
  );
}

const SPECIMEN: Record<Sector, () => JSX.Element> = {
  finance: FinanceSpecimen,
  mail: MailSpecimen,
  calendar: CalendarSpecimen,
  contacts: ContactsSpecimen,
  health: HealthSpecimen,
  home: HomeSpecimen,
};

/**
 * A sector chip: the 15px silhouette, optionally with the sector's name beside it. Use it wherever a
 * sector is NAMED INSIDE RUNNING CONTENT; where the sector is the subject, use <SectorSpecimen>.
 *
 * `dimmed` is the shared "off / not yet" state — `opacity: 0.38` (build-notes §11.3). It is used
 * both by an ungranted grant toggle and by first-run's WAITING row: *present in the vocabulary,
 * absent from your setup*. The specimen stays identifiable on purpose; the border (owned by the
 * caller's toggle shell) and the label carry the state.
 *
 * Accessibility is decided here so no page can get it wrong: with `label` the name is visible, so
 * the drawing is `aria-hidden` and the words identify the sector; standing alone the chip is a
 * `role="img"` with its own accessible name.
 */
export function SectorChip({
  sector,
  size = CHIP_BASE,
  dimmed = false,
  label = false,
}: {
  sector: Sector;
  size?: SectorChipSize;
  dimmed?: boolean;
  label?: boolean;
}): JSX.Element {
  const Specimen = SPECIMEN[sector];
  const name = SECTOR_NAME[sector];

  const drawing = (
    <svg
      className={styles.mark}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      {...(label ? { "aria-hidden": true as const } : { role: "img", "aria-label": name })}
      focusable="false"
    >
      <Specimen />
    </svg>
  );

  if (!label) {
    return dimmed ? <span className={styles.dimmed}>{drawing}</span> : drawing;
  }

  return (
    <span className={dimmed ? `${styles.chip} ${styles.dimmed}` : styles.chip}>
      {drawing}
      <span className={dimmed ? `${styles.label} ${styles.labelDimmed}` : styles.label}>{name}</span>
    </span>
  );
}
