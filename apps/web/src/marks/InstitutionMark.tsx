// Institution marks — the plate's §VII, in two tiers.
//
// PORTED, NEVER REDRAWN. Source of every vector below: the locked-assets plate, landing file
// 01KXV3PJEGEJW84ERA8Z46GVS8 -> `F69-0` -> `sec-institutions` `H1L-0`, read through the Paper MCP
// (`get_jsx({format:"inline-styles"})`) one `i-*` node at a time. Each is a SINGLE path on the plate's
// 24-unit box, carrying the brand's own hex and the plate's own slight hand-set tilt — copied as-is,
// including the tilt, because the tilt is part of the treatment (the letterpress-off-square feel), not
// noise. The `chase` entry was already in this file and its path is byte-identical to `i-chase` H1U-0,
// which is how the recipe was confirmed before the other fifteen were brought across (#107 §3).
//
// 16 OF THE PLATE'S 24 TIER-1 MARKS ARE HERE, and the eight that are not have three different reasons,
// each recorded where it applies. `institutions.ts` carries the full accounting; the short version:
//
//   FIVE are the WORDMARK logotypes the law names (Wells Fargo, Discover, American Express, Goldman
//   Sachs, Visa). The crafted Amex and Discover vectors were ported once and DELETED 2026-07-25
//   (operator ruling; console-specimens §5): every Console placement is below 32px (SourcesPage 22,
//   SourcesBand 22, ConnectionDetail 24) and the ~32px rule in `institutions.ts` sends a wordmark below
//   that to its monogram tile, so the vectors were unreachable path data implying a coverage the app
//   does not have. At 22px Amex read as a blue smudge and Discover as an orange one. **Amex wearing
//   `AX` on Amex blue is the plate's own prescribed remedy, not a bug — do not "fix" it.** All five
//   survive on the plate (`i-amex` H4E-0, `i-discover` H26-0, `i-wellsfargo` H22-0, `i-visa` H3S-0,
//   `i-goldman` H4J-0), re-portable verbatim the day a surface renders a mark at 32px or larger.
//
//   TWO — Venmo and Coinbase — are the same defect in marks the law's five-name list misses; see the
//   note where they would have gone. ONE — Nubank — is parked on invalid plate path data; same.
//
// Colours are literal hexes: brand vectors and official brand colours, exactly as the law records
// them — including its two deliberate substitutions for legibility on cream, both still brand
// colours: Robinhood's green #00C805 (its lime #CCFF00 is invisible on cream) and Wise's dark forest
// #163300 rather than #9FE870. Nothing here is sampled from an image and NOTHING IS FETCHED. The law
// notes that Plaid/SimpleFIN serve institution logos and that the app *should* eventually prefer them,
// but that is a backend fetch-and-cache change (build-notes §13.3). Hot-linking a provider CDN from
// the browser would leak the Console's activity to Plaid on every render.

import type { CSSProperties } from "react";
import styles from "./InstitutionMark.module.css";
import { resolveInstitutionMark, type CraftedInstitutionId } from "./institutions";

/** The tile's native box; `size` scales it, and the border stays a 1px hairline at every scale. */
const TILE_BASE = 22;

/** One crafted brand mark as the plate carries it. */
interface CraftedPath {
  /** The plate's own tilt, in degrees, about the centre of the 24-unit box. */
  tilt: number;
  d: string;
  /** The brand's official hex, as the law records it. */
  fill: string;
}

/**
 * The vectors, by id. This is a `Record` over the id union `institutions.ts` DERIVES from its
 * `CRAFTED` name map, which makes the half-port impossible: add a name there without a vector here
 * and this object stops compiling. That is the direction that matters — a name reaching an id with no
 * drawing would throw at render time, on a surface, in front of a user.
 */
const CRAFTED_PATH: Record<CraftedInstitutionId, CraftedPath> = {
  // ── US banks & cards ──
  chase: {
    tilt: -1.5,
    fill: "#117ACA",
    d: "M0 15.415c0 .468.38.85.848.85h5.937V.575L0 7.72v7.695m15.416 8.582c.467 0 .846-.38.846-.849v-5.937H.573l7.146 6.785h7.697M24 8.587a.844.844 0 0 0-.847-.846h-5.938V23.43l6.782-7.148L24 8.586M8.585.003a.847.847 0 0 0-.847.847v5.94h15.688L16.282.003H8.585Z",
  },
  boa: {
    tilt: 1.2,
    fill: "#012169",
    d: "M15.194 7.57c.487-.163 1.047-.307 1.534-.451-1.408-.596-3.176-1.227-4.764-1.625-.253.073-1.01.271-1.534.434.541.162 2.328.577 4.764 1.642zm-8.896 6.785c.577.343 1.19.812 1.786 1.209 3.952-3.068 7.85-5.432 12.127-6.767-.596-.307-1.119-.578-1.787-.902-2.562.65-6.947 2.4-12.126 6.46zm-.758-6.46c-2.112.974-4.331 2.31-5.54 3.085.433.199.866.361 1.461.65 2.671-1.805 4.764-2.905 5.594-3.266-.595-.217-1.154-.361-1.515-.47zm8.066.234c-.686-.379-3.068-1.263-4.71-1.642-.487.18-1.173.451-1.642.65.595.162 2.815.758 4.71 1.714.487-.235 1.173-.523 1.642-.722zm-3.374 1.552c-.56-.27-1.173-.523-1.643-.74-1.425.704-3.284 1.769-5.63 3.447.505.27 1.047.595 1.624.92 1.805-1.335 3.627-2.598 5.649-3.627zm1.732 8.825c3.79-3.249 9.113-6.407 12.036-7.544a48.018 48.018 0 00-1.949-1.155c-3.771 1.246-8.174 4.007-12.108 7.129.667.505 1.371 1.028 2.02 1.57zm2.851-.235h-.108l-.18-.27h-.109v.27h-.072v-.596h.27c.055 0 .109 0 .145.036.054.019.072.073.072.127 0 .108-.09.162-.198.162zm-.289-.343c.09 0 .199.018.199-.09 0-.072-.072-.09-.144-.09h-.163v.18zm-.523.036c0-.289.235-.523.541-.523.307 0 .542.234.542.523a.543.543 0 01-.542.542.532.532 0 01-.54-.542m.107 0c0 .235.199.433.451.433a.424.424 0 100-.848c-.27 0-.45.199-.45.415",
  },
  // ── International banks ──
  hsbc: {
    tilt: -0.8,
    fill: "#DB0011",
    d: "m24 12.007-5.996 5.997V5.996L24 12.007zm-5.996-6.01H6.01l5.996 6.01 5.997-6.01zM0 12.006l6.01 5.997V5.996L0 12.007zm6.01 5.997h11.994l-5.997-5.997-5.996 5.997z",
  },
  barclays: {
    tilt: 1.1,
    fill: "#00AEEF",
    d: "M21.043 3.629a3.235 3.235 0 0 0-1.048-.54 3.076 3.076 0 0 0-.937-.144h-.046c-.413.006-1.184.105-1.701.71a1.138 1.138 0 0 0-.226 1.023.9.9 0 0 0 .555.63s.088.032.228.058c-.04.078-.136.214-.136.214-.179.265-.576.612-1.668.612h-.063c-.578-.038-1.056-.189-1.616-.915-.347-.45-.523-1.207-.549-2.452-.022-.624-.107-1.165-.256-1.6-.1-.29-.333-.596-.557-.742a2.55 2.55 0 0 0-.694-.336c-.373-.12-.848-.14-1.204-.146-.462-.01-.717.096-.878.292-.027.033-.032.05-.068.046-.084-.006-.272-.006-.328-.006-.264 0-.498.043-.721.09-.47.1-.761.295-1.019.503-.12.095-.347.365-.399.653a.76.76 0 0 0 .097.578c.14-.148.374-.264.816-.266.493-.002 1.169.224 1.406.608.336.547.27.99.199 1.517-.183 1.347-.68 2.048-1.783 2.203-.191.026-.38.04-.56.04-.776 0-1.34-.248-1.63-.716a.71.71 0 0 1-.088-.168s.087-.021.163-.056c.294-.14.514-.344.594-.661.09-.353.004-.728-.23-1.007-.415-.47-.991-.708-1.713-.708-.4 0-.755.076-.982.14-.908.256-1.633.947-2.214 2.112-.412.824-.7 1.912-.81 3.067-.11 1.13-.056 2.085.019 2.949.124 1.437.363 2.298.708 3.22a15.68 15.68 0 0 0 1.609 3.19c.09-.094.15-.161.308-.318.188-.19.724-.893.876-1.11.19-.27.51-.779.664-1.147l.15.119c.16.127.252.348.249.592-.003.215-.053.464-.184.922a8.703 8.703 0 0 1-.784 1.818c-.189.341-.27.508-.199.584.015.015.038.03.06.026.116 0 .34-.117.585-.304.222-.17.813-.672 1.527-1.675a15.449 15.449 0 0 0 1.452-2.521c.12.046.255.101.317.226a.92.92 0 0 1 .8.563c-.65.539-.379 1.353-.63 1.94-.425.998-1.208 2.115-1.788 2.877-.22.03-.163.197-.186.227.9.792 1.944 1.555 3.007 2.136.725.408 2.203 1.162 3.183 1.424.98-.262 2.458-1.016 3.184-1.424a17.063 17.063 0 0 0 3.003-2.134c-.05-.076-.13-.158-.183-.23-.582-.763-1.365-1.881-1.79-2.875-.25-.59-.563-1.405-.628-1.94-.028-.221-.002-.417.08-.565.033-.098.274-.218.317-.226.405.884.887 1.73 1.452 2.522.715 1.003 1.306 1.506 1.527 1.674.248.191.467.304.586.304a.07.07 0 0 0 .044-.012c.094-.069.017-.234-.183-.594a9.003 9.003 0 0 1-.786-1.822c-.13-.456-.18-.706-.182-.92-.004-.246.088-.466.248-.594l.15-.118c.155.373.5.919.665 1.147.15.216.685.919.876 1.11.156.158.22.222.308.32a15.672 15.672 0 0 0 1.609-3.19c.343-.923.583-1.784.707-3.222.075-.86.128-1.81.02-2.948-.101-1.116-.404-2.264-.81-3.068-.249-.49-.605-1.112-1.171-1.566z",
  },
  deutschebank: {
    tilt: -1.3,
    fill: "#0018A8",
    d: "M3.375 3.375v17.25h17.25V3.375H3.375zM0 0h24v24H0V0zm5.25 18.225 9.15-12.45h4.35L9.6 18.225H5.25z",
  },
  // ── Neobanks ──
  revolut: {
    tilt: 0.9,
    fill: "#191C1F",
    d: "M20.913 6.957C20.913 3.121 17.79 0 13.95 0H2.424v3.861h10.978c1.738 0 3.177 1.365 3.209 3.043.016.84-.2994 1.633-.8878 2.232-.5886.6-1.375.93-2.214.9303H9.232a.2756.276 0 0 0-.2755.275v3.431c0 .0585.18.114.52.161L16.265 24h5.311l-7.273-10.094c3.663-.1838 6.61-3.261 6.61-6.949zM6.894 5.923H2.424V24h4.47z",
  },
  monzo: {
    tilt: -1.1,
    fill: "#14233C",
    d: "M4.244 1.174a.443.443 0 00-.271.13l-3.97 3.97-.001.001c3.884 3.882 8.093 8.092 11.748 11.748v-8.57L4.602 1.305a.443.443 0 00-.358-.131zm15.483 0a.443.443 0 00-.329.13L12.25 8.456v8.568L24 5.275c-1.316-1.322-2.647-2.648-3.97-3.97a.443.443 0 00-.301-.131zM0 5.979l.002 10.955c0 .294.118.577.326.785l4.973 4.976c.28.282.76.083.758-.314V12.037zm23.998.003l-6.06 6.061v10.338c-.004.399.48.6.76.314l4.974-4.976c.208-.208.326-.49.326-.785z",
  },
  starling: {
    tilt: 1.5,
    fill: "#6935D3",
    d: "M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm2.738 3.822h.666v2.724h-.666a4.794 4.794 0 0 0-4.789 4.788V12H7.226v-.666c0-4.142 3.37-7.512 7.512-7.512zM14.05 12h2.723v.666c0 4.142-3.37 7.512-7.512 7.512h-.666v-2.724h.666a4.794 4.794 0 0 0 4.789-4.788z",
  },
  n26: {
    tilt: -1.2,
    fill: "#48AC98",
    d: "M0 3.803v1.195h7.436V3.803H0zM12.69 7.29c-2.034 0-3.038 1.252-3.038 2.684 0 .234.027.468.092.728l1.393.135a3.697 3.697 0 0 1-.09-.793c0-1.072.71-1.586 1.598-1.586.866 0 1.507.485 1.507 1.652 0 1.186-.58 1.995-1.464 2.88-.925.923-2.4 2.027-3.112 2.534v1.092h6.135v-1.195h-4.168c.695-.48 1.69-1.279 2.133-1.72.502-.503 1.931-1.794 1.931-3.636 0-1.903-1.24-2.775-2.918-2.775zm8.34 0c-1.976 0-3.454 1.517-3.454 4.916 0 3.017 1.233 4.508 3.356 4.508 1.754 0 3.068-1.198 3.068-3.172 0-1.542-.823-3.066-2.793-3.066-1.1 0-1.884.51-2.281 1.263 0-1.78.62-3.33 2.094-3.33.937 0 1.309.538 1.507 1.422l1.366-.271c-.321-1.527-1.292-2.27-2.864-2.27zM.075 7.389v9.228h1.33v-6.312c0-.56-.013-.898-.039-1.223h.026c.136.372.298.699.539 1.123l3.732 6.412h1.69V7.39H6.04v6.31c0 .56.013.898.04 1.223h-.028a7.252 7.252 0 0 0-.537-1.123L1.783 7.389H.076zm20.817 4.185c1.114 0 1.744.822 1.744 1.992 0 1.256-.717 2.034-1.701 2.034-1.09 0-1.843-1.001-1.973-2.329.33-1.133 1.063-1.697 1.93-1.697zM0 19.008v1.19h7.436v-1.19H0z",
  },
  // NUBANK IS DELIBERATELY ABSENT and its institution takes the monogram branch. It is a tier-1
  // non-wordmark mark on the plate and its geometry there is correct (`i-nubank` H34-0 renders the
  // "nu" ligature), but the path data the MCP serves for that node is NOT VALID SVG: the second half
  // of the ligature loses its command letters and its final cubic is one argument short
  // ("…2.943-1.252-.3.002.0004.002 0 .542.002.1093.002.164.002 1.544 0 2.99-.8835 3.697-2.256…"),
  // which a browser renders by drawing up to the error and stopping. `institutionPathIsValid` in
  // `institutions.test.tsx` is that judgement made mechanical. The rule for this unit was explicit —
  // a mark that cannot be read EXACTLY off the plate is left to the fallback rather than
  // approximated — so Nubank waits for a re-export of that node, and a Nubank row wears a warm-ink
  // "N" until then. Do not hand-repair the path: repairing it is drawing it.
  // ── Payments & transfer ──
  wise: {
    tilt: -0.9,
    fill: "#163300",
    d: "M6.488 7.469 0 15.05h11.585l1.301-3.576H7.922l3.033-3.507.01-.092L8.993 4.48h8.873l-6.878 18.925h4.706L24 .595H2.543l3.945 6.874Z",
  },
  paypal: {
    tilt: 1.1,
    fill: "#002991",
    d: "M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z",
  },
  cashapp: {
    tilt: -1.4,
    fill: "#00C244",
    d: "M23.59 3.475a5.1 5.1 0 00-3.05-3.05c-1.31-.42-2.5-.42-4.92-.42H8.36c-2.4 0-3.61 0-4.9.4a5.1 5.1 0 00-3.05 3.06C0 4.765 0 5.965 0 8.365v7.27c0 2.41 0 3.6.4 4.9a5.1 5.1 0 003.05 3.05c1.3.41 2.5.41 4.9.41h7.28c2.41 0 3.61 0 4.9-.4a5.1 5.1 0 003.06-3.06c.41-1.3.41-2.5.41-4.9v-7.25c0-2.41 0-3.61-.41-4.91zm-6.17 4.63l-.93.93a.5.5 0 01-.67.01 5 5 0 00-3.22-1.18c-.97 0-1.94.32-1.94 1.21 0 .9 1.04 1.2 2.24 1.65 2.1.7 3.84 1.58 3.84 3.64 0 2.24-1.74 3.78-4.58 3.95l-.26 1.2a.49.49 0 01-.48.39H9.63l-.09-.01a.5.5 0 01-.38-.59l.28-1.27a6.54 6.54 0 01-2.88-1.57v-.01a.48.48 0 010-.68l1-.97a.49.49 0 01.67 0c.91.86 2.13 1.34 3.39 1.32 1.3 0 2.17-.55 2.17-1.42 0-.87-.88-1.1-2.54-1.72-1.76-.63-3.43-1.52-3.43-3.6 0-2.42 2.01-3.6 4.39-3.71l.25-1.23a.48.48 0 01.48-.38h1.78l.1.01c.26.06.43.31.37.57l-.27 1.37c.9.3 1.75.77 2.48 1.39l.02.02c.19.2.19.5 0 .68z",
  },
  zelle: {
    tilt: 0.8,
    fill: "#6D1ED4",
    d: "M13.559 24h-2.841a.483.483 0 0 1-.483-.483v-2.765H5.638a.667.667 0 0 1-.666-.666v-2.234a.67.67 0 0 1 .142-.412l8.139-10.382h-7.25a.667.667 0 0 1-.667-.667V3.914c0-.367.299-.666.666-.666h4.23V.483c0-.266.217-.483.483-.483h2.841c.266 0 .483.217.483.483v2.765h4.323c.367 0 .666.299.666.666v2.137a.67.67 0 0 1-.141.41l-8.19 10.481h7.665c.367 0 .666.299.666.666v2.477a.667.667 0 0 1-.666.667h-4.32v2.765a.483.483 0 0 1-.483.483Z",
  },
  // VENMO AND COINBASE ARE DELIBERATELY ABSENT, and this is the ~32px wordmark rule doing its job on
  // two marks the law's own five-name list misses. Their plate vectors are horizontal LOGOTYPES that
  // spell the brand out in path data — measured off the plate's own paths, Venmo's ink occupies
  // x[0, 24] y[9.73, 14.27] and Coinbase's x[0, 24] y[9.86, 14.14], i.e. 5.3:1 and 5.6:1. The plate's
  // own tier-2 rationale calls exactly that band unreadable at icon size ("US Bank 5:1, Truist 4:1,
  // IBKR 7:1"), and the plate screenshot bears it out: at 22px both read as a smear of blue, the same
  // way Amex and Discover did before their vectors were deleted on 2026-07-25 for being unreachable.
  // Porting them would have re-shipped the exact defect §13.2 was written about.
  //
  // They are NOT in `WORDMARK_INSTITUTIONS` either, because #107's acceptance says that set stays
  // untouched, and because with no vector here the set could not change what renders. Today they
  // resolve to a warm-ink initial, which is what they already did. The durable fixes are a plate
  // correction (add both to §VII's wordmark note) and a tier-2 tile in each brand's own hex — both are
  // plate decisions, not code ones. `institutions.test.tsx` pins the absence so a future port cannot
  // land one without reading this.
  // ── Card networks ──
  mastercard: {
    tilt: -1,
    fill: "#EB001B",
    d: "M11.343 18.031c.058.049.12.098.181.146-1.177.783-2.59 1.238-4.107 1.238C3.32 19.416 0 16.096 0 12c0-4.095 3.32-7.416 7.416-7.416 1.518 0 2.931.456 4.105 1.238-.06.051-.12.098-.165.15C9.6 7.489 8.595 9.688 8.595 12c0 2.311 1.001 4.51 2.748 6.031zm5.241-13.447c-1.52 0-2.931.456-4.105 1.238.06.051.12.098.165.15C14.4 7.489 15.405 9.688 15.405 12c0 2.31-1.001 4.507-2.748 6.031-.058.049-.12.098-.181.146 1.177.783 2.588 1.238 4.107 1.238C20.68 19.416 24 16.096 24 12c0-4.094-3.32-7.416-7.416-7.416zM12 6.174c-.096.075-.189.15-.28.231C10.156 7.764 9.169 9.765 9.169 12c0 2.236.987 4.236 2.551 5.595.09.08.185.158.28.232.096-.074.189-.152.28-.232 1.563-1.359 2.551-3.359 2.551-5.595 0-2.235-.987-4.236-2.551-5.595-.09-.08-.184-.156-.28-.231z",
  },
  // ── Brokerage & crypto ──
  robinhood: {
    tilt: 0.9,
    fill: "#00C805",
    d: "M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852",
  },
  binance: {
    tilt: -1.1,
    fill: "#F0B90B",
    d: "M16.624 13.92l2.717 2.715-7.353 7.353-7.353-7.352 2.717-2.716 4.636 4.66 4.636-4.66zm4.637-4.637L24 12l-2.715 2.716L18.568 12l2.692-2.716zm-9.272.001l2.716 2.691-2.716 2.717v-.001L9.272 12l2.716-2.715zm-9.272-.001L5.409 12l-2.691 2.692L0 12l2.716-2.716zM11.989.0115l7.353 7.329-2.717 2.715-4.636-4.636-4.636 4.66-2.717-2.715 7.353-7.353z",
  },
};

/**
 * An institution mark.
 *
 * Two tiers, one entry point. A crafted brand vector when this vault carries one for the card's
 * institution AND the size clears the ~32px wordmark rule; otherwise a brand-coloured monogram tile —
 * which is the law's own pattern, NOT an error path (build-notes §13). Coverage grows by porting more
 * marks off the plate; it never grows by inventing one.
 *
 * PASS `orgDomain` WHEREVER THE WIRE CARRIES IT. It is the stable identifier the resolution is keyed
 * on (`institutions.ts` rule 1); the display name is the fallback for a card that has none. A call
 * site that drops it silently demotes that row to the weaker path — which is the bug that had most of
 * a real gateway's institutions wearing the neutral tile.
 *
 * Always `aria-hidden`: an institution mark sits beside its institution's name on every surface the
 * design uses it on (Sources' bank rows, the finance lens institution run, the connection masthead,
 * the Plaid attention banner). The name identifies; announcing the mark too is noise.
 */
export function InstitutionMark({
  institution,
  orgDomain,
  size = TILE_BASE,
}: {
  institution: string;
  /**
   * The card's `orgDomain` AS SERVED — verbatim, never pre-normalised by the caller. Three facts, and
   * the mark treats the last two alike on purpose: a string is a domain to key on; `null` is "this
   * gateway has no domain for the card"; `undefined` is "a gateway that predates the field". Neither
   * absence is a domain, and neither may be rendered as one.
   */
  orgDomain?: string | null;
  size?: number;
}): JSX.Element {
  const resolved = resolveInstitutionMark(institution, size, orgDomain);

  if (resolved.kind === "crafted") {
    // Total by construction: `CRAFTED_PATH` is a Record over the same union `resolved.id` is drawn
    // from, so there is no missing-vector branch to fall through.
    const mark = CRAFTED_PATH[resolved.id];
    return (
      <svg
        className={styles.mark}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path transform={`rotate(${mark.tilt} 12 12)`} d={mark.d} fill={mark.fill} />
      </svg>
    );
  }

  // The tile: 22×22, radius 5, ground = the brand's official hex, 1px ink border, cream initials in
  // the display face — 13px for one character, 11px for two (build-notes §13 / the app kit).
  // `size` is a genuinely dynamic value, so it rides in as a custom property and the stylesheet does
  // the arithmetic; nothing else here is inline.
  const scale = size / TILE_BASE;
  return (
    <span
      className={styles.tile}
      style={
        {
          "--institution-mark-size": `${size}px`,
          "--institution-mark-scale": String(scale),
          "--institution-mark-ground": resolved.hex,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className={resolved.initials.length > 1 ? styles.initialsTwo : styles.initialsOne}>
        {resolved.initials}
      </span>
    </span>
  );
}
