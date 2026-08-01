// Shared building blocks for the connect group — the provider tile box, the numbered "at the source"
// steps, and the "creates {sectors}" footer. Marks come from the frozen vault (never redrawn); the
// sector chips in the footer are `<SectorChip>` specimens with the design's lowercase italic label.

import type { Sector } from "../../marks";
import { ProviderTile, SectorChip } from "../../marks";
import { Copyable } from "../../kit";
import { guideUrl, type ProviderDef } from "./catalog";
import type { RedirectUri } from "./connectApi";
import styles from "./connect.module.css";

/** The bordered tile box: the ported ProviderTile centred in a hairline square (the card + masthead). */
export function ProviderTileBox({
  def,
  variant,
}: {
  def: ProviderDef;
  variant: "card" | "masthead";
}): JSX.Element {
  const box = variant === "card" ? styles.cardTile : styles.cxTile;
  const size = variant === "card" ? 24 : 26;
  return (
    <div className={box}>
      <ProviderTile provider={def.tile} size={size} />
    </div>
  );
}

/** The left column: the section header, the numbered steps, and the reassurance footnote. The OAuth
 *  redirect URI is spliced in where a step declares it — the value the GATEWAY reports about itself,
 *  passed in as a prop so this stays purely presentational and computes no address of its own. */
export function StepsColumn({
  def,
  redirectUri,
}: {
  def: ProviderDef;
  redirectUri: RedirectUri;
}): JSX.Element {
  return (
    <div className={styles.steps}>
      <div className={styles.stepsHeader}>{def.stepsHeader}</div>
      {def.steps.map((step, i) => (
        <div key={i} className={styles.step}>
          <div className={styles.stepNum} aria-hidden="true">
            {i + 1}
          </div>
          {/* The design fades the even steps across every connect screen — an emphasis rhythm, not
              an accident (steps 1 & 3 ink, step 2 receding). Faithful, and --color-faded is AA. */}
          <div className={i % 2 === 1 ? `${styles.stepText} ${styles.stepTextFaded}` : styles.stepText}>
            {step.before}
            {/* PENDING renders nothing in the code slot: on loopback it resolves in milliseconds,
                and a placeholder literal would be an invented address — the whole bug class.
                UNAVAILABLE renders the gateway-degradation sentence verbatim in the text lane.
                READY renders the kit Copyable: the guide's rule is "pasted, never hand-typed"
                (#121) — the providers exact-match this string, and one mistyped character is a
                dead consent. Still the ONE gateway-served source; this only adds the Copy. */}
            {step.redirect ? (
              redirectUri.status === "ready" ? (
                <div className={styles.stepRedirectBox}>
                  <Copyable value={redirectUri.uri} mono />
                </div>
              ) : redirectUri.status === "unavailable" ? (
                <> {redirectUri.message}</>
              ) : null
            ) : null}
            {/* The step-grain caution for a wrong turn proven live (G1, #121) — always visible,
                never an error. The `hint` idea (#96 §3), at the step's grain. */}
            {step.warn ? <div className={styles.stepWarn}>{step.warn}</div> : null}
          </div>
        </div>
      ))}
      {/* The provider's field guide on the public site (#136). The steps above are the short path;
          the guide is every console screen, the traps, and what to do when it goes wrong — which is
          what the person stuck on step 2 came for, and until now the Console pointed nowhere.
          Rendered here, in the shared column, so it exists on ALL nine screens — including Apple
          Health, whose right card is an ingest flow rather than a credential form.

          THE FIRST LIVE EXTERNAL ANCHOR IN THE CONNECT FLOW, and deliberately the only one. Every
          other address on these screens (appleid.apple.com, entra.microsoft.com,
          myaccount.google.com/apppasswords…) stays TEXT: those are the providers' own consoles, and
          a link is a promise about where it goes that only our own site lets us keep.

          `_blank` because the reader is mid-connect — following this in place throws away a
          half-filled form and, for a paste screen, a token they cannot get back. `noopener
          noreferrer` because a `_blank` tab is handed `window.opener` and a Referer otherwise; the
          URL itself carries no parameters (guideUrl). */}
      <a className={styles.guideLink} href={guideUrl(def)} target="_blank" rel="noopener noreferrer">
        The full {def.name} field guide, at getpostern.com →
      </a>
      <p className={styles.footnote}>{def.footnote}</p>
    </div>
  );
}

/** The "creates {sectors} — …" footer: one specimen chip per sector the credential fans out to, then
 *  the design's tail sentence. The chip is the ported mark; the lowercase italic label is the page's. */
export function CreatesFooter({ sectors, line }: { sectors: Sector[]; line: string }): JSX.Element {
  return (
    <div className={styles.creates}>
      {sectors.map((s) => (
        <span key={s} className={styles.chipGroup}>
          <SectorChip sector={s} size={15} />
          <span className={styles.chipLabel}>{s}</span>
        </span>
      ))}
      <span className={styles.createsLine}>{line}</span>
    </div>
  );
}
