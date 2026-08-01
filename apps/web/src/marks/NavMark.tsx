// The five gate marks + the Postern identity door.
//
// PORTED, NEVER REDRAWN. Every path below came out of Paper via
// get_jsx({format:"inline-styles"}) — app file 01KY3S7JMA16R0QZVSX084WWDD, page 1-0:
//   gatehouse A0F-0 · sources 7GI-0 · agents 7HE-0 · ledger 7GV-0 · settings 7H3-0 · lockup 7GE-0
// They are the locked-assets plate's §V/§VI marks (landing file 01KXV3PJEGEJW84ERA8Z46GVS8 node
// F69-0). Colours are LITERAL HEXES, not tokens: these are brand vectors, and re-tokenising an
// accepted illustration is how a drawing drifts (build-notes §0, §9.2).
//
// The identity amber #E7A42A in the door and the gauge is the IDENTITY amber — it is not
// --sector-finance semantically, even though the value happens to match.
//
// Known drift these replaced (build-notes §9.1) — if a mark here ever matches one of these
// descriptions, the wrong node was ported: a POPPY door seam (canonical is amber), a skeleton KEY
// for Agents (canonical is the pollinator), a CASTLE for Settings (canonical is the VDO gauge), an
// ARCH-AND-DOT for Sources (canonical is the posy).
//
// No `xmlns` attribute is emitted anywhere in this directory. Inline SVG inside HTML needs none, and
// the SVG namespace URI is the one absolute-URL string that would otherwise appear in a mark's
// markup — the "no third-party origin, ever" rule is asserted mechanically in the tests, over both
// the rendered markup and the source files.

import styles from "./NavMark.module.css";

export type GateMark = "gatehouse" | "sources" | "agents" | "ledger" | "settings";

/** The line marks' native lane. The pollinator is measured relative to this baseline. */
const NAV_BASE = 17;

/** Brand-scale door: 22 wide × 28 tall on a 32×40 viewBox. */
const DOOR_ASPECT = 28 / 22;

/** The pollinator's native box (19×14) expressed against the 17px line-mark lane. */
const POLLINATOR_W = 19 / NAV_BASE;
const POLLINATOR_H = 14 / NAV_BASE;

/** The identity door (plate §V) — ink arch + amber seam. Shared by the lockup and the nav item. */
function DoorPaths() {
  return (
    <>
      <path d="M4 38 L4 16 Q4 4 16 4 Q28 4 28 16 L28 38 Z" fill="#2A2118" />
      <path d="M18 38 L18 13 Q18 8.5 22.5 7.6 L22.5 38 Z" fill="#E7A42A" />
    </>
  );
}

/** nav-sources — the posy of specimen heads (NOT an arch and dot). */
function PosyPaths() {
  return (
    <>
      <path d="M12 17.6 C 12 14 12 10.6 12 7.8" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.3 17.6 C 10 14.4 8.7 11.7 7.7 9.6" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.7 17.6 C 14 14.4 15.3 11.9 16.3 9.8" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12.6 C 13.5 12 14.1 10.8 13.9 9.7" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="6.9" r="1.55" fill="#E7A42A" />
      <circle cx="12" cy="6.9" r="0.5" fill="#2A2118" />
      <circle cx="7.3" cy="8.8" r="1.45" fill="#E9795E" />
      <circle cx="7.3" cy="8.8" r="0.45" fill="#2A2118" />
      <circle cx="16.7" cy="9" r="1.45" fill="#5877C0" />
      <circle cx="16.7" cy="9" r="0.45" fill="#2A2118" />
      <path d="M9.9 17.5 L14.1 17.5 L13.7 20 L10.3 20 Z" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

/** The OpenAI blossom, reused inside the pollinator's upper-right eyespot. */
const OPENAI_PETAL =
  "M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1z";

/**
 * nav-agents — the pollinator, Papilio internuntius (NOT a key). Four cream eyespots carry the
 * agent marks: Claude burst · OpenAI blossom · OpenClaw · generic robot.
 */
function PollinatorPaths() {
  return (
    <>
      <g>
        <path d="M 245 158 C 200 96 128 76 104 102 C 80 128 128 176 238 184 Z" fill="#5877C0" stroke="#2A2118" strokeWidth="1.8" />
        <circle cx="163" cy="133" r="28" fill="#D87050" stroke="#2A2118" strokeWidth="1.8" />
        <line x1="164.4" y1="133.4" x2="183.0" y2="138.2" stroke="#F8F8F0" strokeWidth="3.22" strokeLinecap="round" />
        <line x1="164.1" y1="133.9" x2="178.7" y2="146.7" stroke="#F8F8F0" strokeWidth="2.41" strokeLinecap="round" />
        <line x1="163.7" y1="134.2" x2="173.2" y2="150.2" stroke="#F8F8F0" strokeWidth="3.22" strokeLinecap="round" />
        <line x1="163.0" y1="134.4" x2="162.3" y2="153.4" stroke="#F8F8F0" strokeWidth="2.97" strokeLinecap="round" />
        <line x1="162.3" y1="134.2" x2="152.9" y2="150.5" stroke="#F8F8F0" strokeWidth="2.97" strokeLinecap="round" />
        <line x1="161.9" y1="133.8" x2="146.9" y2="144.2" stroke="#F8F8F0" strokeWidth="2.97" strokeLinecap="round" />
        <line x1="161.8" y1="132.2" x2="145.9" y2="121.4" stroke="#F8F8F0" strokeWidth="4.03" strokeLinecap="round" />
        <line x1="163.3" y1="131.6" x2="166.8" y2="113.5" stroke="#F8F8F0" strokeWidth="3.5" strokeLinecap="round" />
        <line x1="164.4" y1="132.8" x2="183.1" y2="130.4" stroke="#F8F8F0" strokeWidth="3.22" strokeLinecap="round" />
      </g>
      <g>
        <path d="M 255 158 C 300 96 372 76 396 102 C 420 128 372 176 262 184 Z" fill="#5877C0" stroke="#2A2118" strokeWidth="1.8" />
        <circle cx="337" cy="133" r="28" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.8" />
        <g transform="translate(337 133) scale(0.024) translate(-1198.2 -1198.2)">
          <g transform="rotate(0 1203 1203)">
            <path d={OPENAI_PETAL} fill="#2A2118" />
          </g>
          <g transform="rotate(120 1203 1203)">
            <path d={OPENAI_PETAL} fill="#2A2118" />
          </g>
          <g transform="rotate(240 1203 1203)">
            <path d={OPENAI_PETAL} fill="#2A2118" />
          </g>
        </g>
      </g>
      <g>
        <path d="M 240 188 C 202 194 168 220 174 248 C 180 274 226 266 252 220 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.8" />
        <circle cx="211" cy="228" r="23" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.8" />
        <circle cx="211" cy="228" r="12" fill="#E04438" />
      </g>
      <g>
        <path d="M 260 188 C 298 194 332 220 326 248 C 320 274 274 266 248 220 Z" fill="#E9795E" stroke="#2A2118" strokeWidth="1.8" />
        <circle cx="289" cy="228" r="23" fill="#F5EDDA" stroke="#2A2118" strokeWidth="1.8" />
        <g transform="translate(289 228) scale(1.191)">
          <rect x="-11" y="-8" width="22" height="16" rx="4" fill="none" stroke="#2A2118" strokeWidth="2.6" />
          <circle cx="-5" cy="-1.5" r="2.6" fill="#2A2118" />
          <circle cx="5" cy="-1.5" r="2.6" fill="#2A2118" />
          <path d="M -4.5 4.2 L 4.5 4.2" fill="#000000" stroke="#2A2118" strokeWidth="2" strokeLinecap="round" />
          <path d="M 0 -8 L 0 -12.5" fill="#000000" stroke="#2A2118" strokeWidth="2" />
          <circle cx="0" cy="-14.2" r="2.1" fill="#2A2118" />
        </g>
      </g>
      <ellipse cx="250" cy="176" rx="5.5" ry="38" fill="#2A2118" />
      <circle cx="250" cy="134" r="6" fill="#2A2118" />
      <path d="M 246 129 C 240 118 234 111 226 105" fill="none" stroke="#2A2118" strokeWidth="1.3" />
      <path d="M 254 129 C 260 118 266 111 274 105" fill="none" stroke="#2A2118" strokeWidth="1.3" />
      <circle cx="225" cy="104" r="2" fill="#2A2118" />
      <circle cx="275" cy="104" r="2" fill="#2A2118" />
    </>
  );
}

/** nav-ledger — the clasped ledger book with its poppy wax seal. */
function LedgerPaths() {
  return (
    <>
      <path d="M6 4.6 Q6 3.5 7.1 3.5 L16.4 3.5 Q17.5 3.5 17.5 4.6 L17.5 18.9 Q17.5 20 16.4 20 L7.1 20 Q6 20 6 18.9 Z" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 3.7 L8.5 19.8" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.5 6 L19 6.5 L19 18 L17.5 18.5" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.5 11.7 L13.9 11.7" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="11.7" r="2.15" fill="#B83E15" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="11.7" r="0.9" fill="none" stroke="#F5EDDA" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

/** nav-settings — the VDO gauge instrument with its amber set-mark (NOT a castle). */
function GaugePaths() {
  return (
    <>
      <circle cx="12" cy="12" r="7.3" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 4.9 L12 6.2" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.99 6.99 L7.9 7.9" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.01 6.99 L16.1 7.9" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.9 12 L6.2 12" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.1 12 L17.8 12" fill="none" stroke="#2A2118" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12 L14.9 8.8" fill="none" stroke="#2A2118" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.05" fill="#2A2118" />
      <circle cx="15.3" cy="8.4" r="0.85" fill="#E7A42A" />
    </>
  );
}

const GATE_VIEWBOX: Record<GateMark, string> = {
  gatehouse: "0 0 32 40",
  sources: "0 0 24 24",
  agents: "95 55 310 230",
  ledger: "0 0 24 24",
  settings: "0 0 24 24",
};

/**
 * A nav/gate mark.
 *
 * Line marks render 17×17. The pollinator renders 19×14 — it is wider than tall by construction, so
 * the nav rail must place every mark in a fixed-width icon slot to keep the text lane aligned
 * (build-notes §9.2). `size` scales the mark proportionally against the 17px lane; it never
 * re-lays-out the vector.
 *
 * Always `aria-hidden`: a nav mark sits beside its own name, and announcing both is noise. This is a
 * component-level decision so no page can get it wrong.
 */
export function NavMark({ mark, size = NAV_BASE }: { mark: GateMark; size?: number }): JSX.Element {
  const isPollinator = mark === "agents";
  const width = isPollinator ? size * POLLINATOR_W : size;
  const height = isPollinator ? size * POLLINATOR_H : size;

  return (
    <svg
      className={styles.mark}
      width={width}
      height={height}
      viewBox={GATE_VIEWBOX[mark]}
      aria-hidden="true"
      focusable="false"
    >
      {mark === "gatehouse" ? <DoorPaths /> : null}
      {mark === "sources" ? <PosyPaths /> : null}
      {mark === "agents" ? <PollinatorPaths /> : null}
      {mark === "ledger" ? <LedgerPaths /> : null}
      {mark === "settings" ? <GaugePaths /> : null}
    </svg>
  );
}

/**
 * The Postern identity door. Brand scale is 22×28 on a 32×40 viewBox; the Gatehouse nav item is the
 * same vector at 17 (where `preserveAspectRatio` centres it in the 17px icon lane — build-notes
 * §10.4, which is why the door appears twice in the sidebar at two scales).
 *
 * `lockup` adds the wordmark, and then the mark is `aria-hidden` because the words identify it.
 * Standing alone it carries `role="img"` and its own accessible name.
 */
export function PosternMark({ size = 22, lockup = false }: { size?: number; lockup?: boolean }): JSX.Element {
  const door = (
    <svg
      className={styles.mark}
      width={size}
      height={size * DOOR_ASPECT}
      viewBox="0 0 32 40"
      {...(lockup ? { "aria-hidden": true as const } : { role: "img", "aria-label": "Postern" })}
      focusable="false"
    >
      <DoorPaths />
    </svg>
  );

  if (!lockup) return door;

  // The wordmark block is the Brand frame of the canonical nav rail (app file, node 3-0), ported
  // value-for-value: kicker above the name, --font-sc 9px / .24em / uppercase over --font-display
  // 21px / -0.01em. The lockup's typography is a fixed brand treatment — `size` scales the door,
  // never the type.
  return (
    <span className={styles.lockup}>
      {door}
      <span className={styles.wordmark}>
        <span className={styles.wordmarkKicker}>The Console</span>
        <span className={styles.wordmarkName}>Postern</span>
      </span>
    </span>
  );
}
