// The six botanical specimens — the SECOND tier of build-notes §11.3, the one pass 1 never ported.
//
// PORTED, NEVER REDRAWN. get_jsx({format:"inline-styles"}) from the app file
// 01KY3S7JMA16R0QZVSX084WWDD, page 1-0. Each sector names TWO nodes — the Gatehouse card variant and
// the sector-lens hero — because the design draws the specimen at two surface sizes:
//   finance  card 3OP-0 · hero IE-0  (17 elements)
//   mail     card 3Q7-0 · hero XF-0  (9 elements)
//   calendar card 3R9-0 · hero 12V-0 (34 elements)
//   contacts card 3T0-0 · hero 190-0 (23 elements)
//   health   card 3UG-0 · hero S1-0  (7 elements)
//   home     card 3VF-0 · hero 1EU-0 (8 elements)
//
// Within a sector the two nodes carry IDENTICAL path data on an identical viewBox and differ only in
// rendered box, so one drawing serves both sizes — a specimen is scaled, never re-laid-out.
//
// THE PORT SOURCE IS THE APP FILE, NOT THE LANDING LAW PLATE (operator ruling, 2026-07-25). The law
// plate's §II drawings (`2I9-0`/`2IU-0`/`3U2-0`/`3X7-0`/`3UD-0`/`2O6-0`, 158–196px) remain canonical
// for what each drawing IS; the app file is canonical for how it appears on a SURFACE, and four of
// the six are deliberately reduced for the 48px card — the law plate's calendar carries 100 elements
// and reads as a busy smudge shrunk to card size, which is the defect HANDOFF §5 recorded and the app
// file already solved (34 elements here).
//
// Colours are LITERAL HEXES, not tokens — accepted illustrations stay byte-faithful (build-notes §0,
// §9.2). The specimens' green is #40794C, which is deliberately NOT --sector-calendar; re-tokenising
// an accepted illustration is how a drawing drifts.
//
// THE RULE THIS COMPONENT EXISTS TO ENFORCE (build-notes §11.3): two tiers, and they are DIFFERENT
// DRAWINGS, not one drawing at two sizes. <SectorChip> is a silhouette authored for 15px and is used
// wherever a sector is named inside running content; <SectorSpecimen> is the botanical drawing with
// stem, leaves and a Latin binomial and is used wherever the sector IS the subject — the Gatehouse
// sector cards and the six sector-lens heroes. Pass 1 scaled the chip onto both and shipped a
// stemless coin-stack where the design has a plant (build-notes §19.1); `specimens.test.tsx` is the
// gate that was missing, and `SectorChipSize` makes the substitution a compile error.

import styles from "./SectorSpecimen.module.css";
import type { Sector } from "./SectorChip";

/**
 * The two sizes the design draws, and the ONLY two. `card` = the Gatehouse sector card (48px tall);
 * `hero` = the sector-lens masthead (64–69px tall). Widths differ per sector because each drawing has
 * its own aspect — a specimen is scaled, never re-laid-out.
 */
export type SectorSpecimenSize = "card" | "hero";

interface Box {
  width: number;
  height: number;
}

interface SpecimenSpec {
  /** The drawing's own viewBox. Calendar's has a non-zero origin — that is the ported value. */
  viewBox: string;
  card: Box;
  hero: Box;
  Drawing: () => JSX.Element;
}

/** finance — Cumulus nummorum: a stem with two leaves, the coin stack, and a flowering bud. */
function FinanceSpecimen() {
  return (
    <>
      <path d="M 108 272 C 107 258 108 248 108 236" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M 104 258 C 92 250 80 251 71 259 C 82 264 96 265 104 258 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 112 246 C 124 238 136 239 144 247 C 134 252 120 253 112 246 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 79 232 A 28 9 0 0 0 135 232 L 135 224.5 A 28 9 0 0 0 79 224.5 Z" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="107" cy="224.5" rx="28" ry="9" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M 82 219 A 28 9 0 0 0 138 219 L 138 211.5 A 28 9 0 0 0 82 211.5 Z" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="110" cy="211.5" rx="28" ry="9" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M 79 206 A 28 9 0 0 0 135 206 L 135 198.5 A 28 9 0 0 0 79 198.5 Z" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="107" cy="198.5" rx="28" ry="9" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M 82 193 A 28 9 0 0 0 138 193 L 138 185.5 A 28 9 0 0 0 82 185.5 Z" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="110" cy="185.5" rx="28" ry="9" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M 79 180 A 28 9 0 0 0 135 180 L 135 172.5 A 28 9 0 0 0 79 172.5 Z" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="107" cy="172.5" rx="28" ry="9" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.4" />
      <ellipse cx="110" cy="172.5" rx="21" ry="6.6" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.1" />
      <ellipse cx="110" cy="172.5" rx="11.5" ry="3.6" fill="none" stroke="#E7A42A" strokeWidth="1.6" />
      <path d="M 110 164 C 110 144 116 122 126 106" fill="none" stroke="#40794C" strokeWidth="1.8" />
      <circle cx="128" cy="101" r="5.5" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.2" />
    </>
  );
}

/** mail — Epistola volans: the tilted envelope on a leafed stem, with a bud above it. */
function MailSpecimen() {
  return (
    <>
      <path d="M80 212 C82 168 78 130 82 96 C84 80 86 70 88 62" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M80 150 C68 144 56 146 47 154 C58 159 71 158 80 150 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M83 116 C94 110 106 112 114 120 C103 125 91 124 83 116 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.4" />
      <rect x="52" y="18" width="74" height="50" rx="6" transform="rotate(-6 52 18)" fill="#7B559E" stroke="#2A2118" strokeWidth="1.6" />
      <path d="M54 24 L88 52 L122 16" fill="none" stroke="#2A2118" strokeWidth="1.5" />
      <path d="M52 62 L76 40" fill="none" stroke="#2A2118" strokeWidth="1.1" />
      <path d="M124 56 L100 36" fill="none" stroke="#2A2118" strokeWidth="1.1" />
      <path d="M58 17 C62 10 69 6 76 6" fill="none" stroke="#40794C" strokeWidth="1.8" />
      <circle cx="79" cy="7" r="4.5" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.1" />
    </>
  );
}

/** calendar — Discus mensis: the month disc of florets on a leafed stem. The `18` is part of the
 *  DRAWING (the disc's marked day), not a rendered date: it is set dressing on an accepted
 *  illustration, the same category as the coin stack's face, and it is ported verbatim. */
function CalendarSpecimen() {
  return (
    <>
      <path d="M 140 272 C 137 240 140 214 140 184" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M 139 244 C 117.1 234.5 88.2 247.4 76 258 C 91.5 262.4 123.1 261.9 139 244 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 139 244 Q 107.1 249.4 78.5 257.4" fill="none" stroke="#2A2118" strokeWidth="0.9" />
      <path d="M 140 216 C 156.6 233.4 188.5 232.9 204 228 C 191.3 217.8 161.8 205.8 140 216 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 140 216 Q 171.7 223.7 201.4 227.5" fill="none" stroke="#2A2118" strokeWidth="0.9" />
      <circle cx="140" cy="112" r="64" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.6" />
      <circle cx="140" cy="112" r="53" fill="none" stroke="#2A2118" strokeWidth="0.8" />
      <ellipse cx="110.4" cy="80.4" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="125.2" cy="80.4" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="140.0" cy="80.4" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="154.8" cy="80.4" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="169.6" cy="80.4" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="110.4" cy="96.2" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="125.2" cy="96.2" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="140.0" cy="96.2" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="154.8" cy="96.2" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="169.6" cy="96.2" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="95.6" cy="112.0" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="110.4" cy="112.0" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="125.2" cy="112.0" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="140.0" cy="112.0" rx="6.4" ry="8.4" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.3" />
      <text x="140" y="115.5" textAnchor="middle" fontFamily="Courier Prime, monospace" fontSize="8" fontWeight="700" fill="#2A2118">
        18
      </text>
      <ellipse cx="154.8" cy="112.0" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="169.6" cy="112.0" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="184.4" cy="112.0" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="110.4" cy="127.8" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="125.2" cy="127.8" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="140.0" cy="127.8" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="154.8" cy="127.8" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="169.6" cy="127.8" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="125.2" cy="143.6" rx="4.3" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="140.0" cy="143.6" rx="4.55" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <ellipse cx="154.8" cy="143.6" rx="4.8" ry="5.9" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <path d="M 128 172 C 132 166 138 163 140 162 C 142 163 148 166 152 172" fill="none" stroke="#40794C" strokeWidth="1.8" />
    </>
  );
}

/** contacts — Myosotis amicorum: three forget-me-not clusters on a branching stem. */
function ContactsSpecimen() {
  return (
    <>
      <path d="M 122 272 C 118 230 122 190 118 150 C 116 128 120 108 128 92" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M 119 168 C 104 148 92 122 94 98" fill="none" stroke="#40794C" strokeWidth="1.8" />
      <path d="M 120 140 C 138 124 158 116 172 118" fill="none" stroke="#40794C" strokeWidth="1.8" />
      <path d="M 121 236 C 99.3 227.5 70.3 239.9 58 250 C 73.4 253.9 104.9 252.9 121 236 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 119 200 C 134.4 216.9 165.0 217.9 180 214 C 168.2 204.0 140.2 191.5 119 200 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <circle cx="94.0" cy="77.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="104.0" cy="84.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="100.2" cy="96.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="87.8" cy="96.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="84.0" cy="84.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="94" cy="88" r="3.8" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="130.0" cy="71.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="140.0" cy="78.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="136.2" cy="90.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="123.8" cy="90.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="120.0" cy="78.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="130" cy="82" r="3.8" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="154.0" cy="35.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="164.0" cy="42.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="160.2" cy="54.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="147.8" cy="54.5" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="144.0" cy="42.8" r="7.2" fill="#5877C0" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="154" cy="46" r="3.8" fill="#E7A42A" stroke="#2A2118" strokeWidth="1.2" />
    </>
  );
}

/** health — Lamprocapnos salutis: the arching stem of four bleeding-heart blooms. */
function HealthSpecimen() {
  return (
    <>
      <path d="M 40 212 C 38 160 42 110 58 84 C 74 58 110 52 160 58" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M 42 172 C 30 164 20 166 12 174 C 22 179 34 179 42 172 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 44 140 C 56 132 68 133 76 141 C 66 146 52 147 44 140 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.3" />
      <path transform="translate(78 104) scale(1.1)" d="M 0 10 C -10 3 -10 -8 -5 -8 C -1.6 -8 0 -5 0 -3 C 0 -5 1.6 -8 5 -8 C 10 -8 10 3 0 10 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.27" />
      <path transform="translate(104 100) scale(1.1)" d="M 0 10 C -10 3 -10 -8 -5 -8 C -1.6 -8 0 -5 0 -3 C 0 -5 1.6 -8 5 -8 C 10 -8 10 3 0 10 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.27" />
      <path transform="translate(130 98) scale(1.1)" d="M 0 10 C -10 3 -10 -8 -5 -8 C -1.6 -8 0 -5 0 -3 C 0 -5 1.6 -8 5 -8 C 10 -8 10 3 0 10 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.27" />
      <path transform="translate(156 100) scale(1.1)" d="M 0 10 C -10 3 -10 -8 -5 -8 C -1.6 -8 0 -5 0 -3 C 0 -5 1.6 -8 5 -8 C 10 -8 10 3 0 10 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.27" />
    </>
  );
}

/** home — Domus lanterna: the birdhouse blooming at the top of a leafed stem. */
function HomeSpecimen() {
  return (
    <>
      <path d="M50 218 C58 176 70 140 90 108 C102 88 116 74 128 66" fill="none" stroke="#40794C" strokeWidth="2.2" />
      <path d="M64 172 C52 166 40 168 32 176 C44 181 56 180 64 172 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M86 128 C98 122 110 124 118 132 C106 137 94 136 86 128 Z" fill="#40794C" stroke="#2A2118" strokeWidth="1.4" />
      <path d="M128 66 C126 58 122 52 116 48" fill="none" stroke="#40794C" strokeWidth="1.6" />
      <path d="M116 48 L96 28 L76 48 L76 88 L116 88 Z" fill="#D26A8B" stroke="#2A2118" strokeWidth="1.6" />
      <path d="M70 50 L96 22 L122 50" fill="none" stroke="#2A2118" strokeWidth="1.8" />
      <rect x="90" y="64" width="13" height="24" rx="5" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.2" />
      <circle cx="96" cy="40" r="4" fill="#E7A42A" stroke="#2A2118" />
    </>
  );
}

/**
 * Per-sector viewBox + the two rendered boxes, every value read off the named nodes with `get_jsx`
 * / `get_node_info`. The boxes are NOT square and NOT uniform: each drawing keeps its own aspect,
 * which is why a single `size` number would be wrong here and the size is a named tier instead.
 */
const SPECIMEN: Record<Sector, SpecimenSpec> = {
  finance: {
    viewBox: "0 0 220 280",
    card: { width: 38, height: 48 },
    hero: { width: 54, height: 69 },
    Drawing: FinanceSpecimen,
  },
  mail: {
    viewBox: "0 0 160 220",
    card: { width: 36, height: 48 },
    hero: { width: 47, height: 64 },
    Drawing: MailSpecimen,
  },
  calendar: {
    viewBox: "66 40 148 220",
    card: { width: 36, height: 48 },
    hero: { width: 48, height: 64 },
    Drawing: CalendarSpecimen,
  },
  contacts: {
    viewBox: "0 0 240 280",
    card: { width: 40, height: 48 },
    hero: { width: 52, height: 64 },
    Drawing: ContactsSpecimen,
  },
  health: {
    viewBox: "0 0 180 220",
    card: { width: 39, height: 48 },
    hero: { width: 52, height: 66 },
    Drawing: HealthSpecimen,
  },
  home: {
    viewBox: "0 0 160 225",
    card: { width: 35, height: 48 },
    hero: { width: 46, height: 64 },
    Drawing: HomeSpecimen,
  },
};

/**
 * A sector's full botanical specimen, at one of the two sizes the design draws.
 *
 * Always `aria-hidden`: a specimen only ever appears where the sector's name is already set beside
 * it — the Gatehouse card's head text and the lens hero's title — so announcing the drawing too is
 * noise. Deciding it here means no page can get it wrong (the same contract `<SectorChip>` and
 * `<InstitutionMark>` keep).
 */
export function SectorSpecimen({
  sector,
  size = "card",
}: {
  sector: Sector;
  size?: SectorSpecimenSize;
}): JSX.Element {
  const spec = SPECIMEN[sector];
  const box = spec[size];

  return (
    <svg
      className={styles.specimen}
      width={box.width}
      height={box.height}
      viewBox={spec.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      <spec.Drawing />
    </svg>
  );
}
