// The gate-address card — the masthead's right block. Ported from `1Y-0`.
//
// The MCP endpoint is the one the GATEWAY reports (`/api/exposure` → `localEndpoint`) — never
// invented, and no longer a build-time constant that went stale the moment the MCP port moved. It is
// copied verbatim via the kit's <Copyable> (the load-bearing interaction; a browser dialog is
// banned). The endpoint is NOT a secret, so this card needs no security treatment (it is exactly what
// you hand to an agent).
//
// **The caption names WHICH agent this address serves, and it is one of three (#125).** The plate
// drew the card under a *tailnet* address and captioned it "Point any agent here" — true of the thing
// it was drawn around. The port then bound the card to `localEndpoint`, on purpose (see below), and
// the caption did not follow: a loopback URL is the NARROWEST of the three ways an agent connects,
// and the universal claim was false for the two a person is most likely to want. An agent on another
// machine cannot route to loopback at all, and claude.ai / ChatGPT come in through the OAuth bridge
// on `:443` — a different flow with a load-bearing port caveat (#47). Connect-an-agent (Agents &
// keys) already chooses a real recipe per target and carries that caveat, so this card names its own
// case and points there for the other two. Pointing is the WHOLE allowance: no second copy of the
// recipes, and nothing here that configures anything.
//
// **This card shows the LOCAL endpoint and never the public one, on purpose.** Home is a verdict,
// not a dashboard (soul.md §11, build-notes §6): the exposure story lives on Settings → Remote
// access, and putting a public address — or any enable affordance — here would make the Gatehouse a
// place where you configure things. ADR 0035 §D2 is explicit that exposure is never a nudge.
//
// The poppy seal-check that used to sit opposite the label is GONE (§18.2). Its own comment called
// it decoration, and it was byte-identical on the needs-attention board 200px from a red
// "Authentication expired" band — the same defect class as the sector-ink dots (§17.1), found by a
// different lens. In this palette any poppy mark in that position reads as state, so de-checking or
// recolouring it would not have rescued it.

import { Link } from "react-router-dom";
import { Copyable, Skeleton } from "../../kit";
import { useExposure } from "../../api/hooks";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import styles from "./GateAddress.module.css";

/** Served, and served as an absence — this gateway runs no MCP edge, so it has no address at all.
 *  A verdict about the GATE, so it may only be rendered when the gateway actually answered. */
const NO_ENDPOINT = "This gate isn’t serving an MCP endpoint — there is no address to hand an agent.";

export function GateAddress(): JSX.Element {
  const exposure = useExposure();
  // Three outcomes, not two (§Decision 7). Home is a verdict, and "this gate isn't serving an MCP
  // endpoint" is a verdict about the gate — one this card has no standing to deliver when the read
  // itself failed. That case says what actually happened instead.
  const failed = exposure.isError || (!exposure.isPending && exposure.data == null);
  const endpoint = exposure.data?.localEndpoint ?? null;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.label}>Your gate's address</span>
      </div>
      {exposure.isPending ? (
        <Skeleton width="100%" />
      ) : failed ? (
        <p className={styles.caption}>{EXPOSURE_UNANSWERED}</p>
      ) : endpoint != null ? (
        <>
          <Copyable value={endpoint} mono />
          {/* The caption belongs to the ADDRESS, not to the card: it says what THIS string is good
              for, and it sends you to the recipes for the other two targets. With no address there is
              no "here" to point an agent at and no recipe to fetch either (Connect-an-agent renders
              the same absence), so the two negative branches above end at their own sentence rather
              than trailing a claim about a string that is not on screen. */}
          <p className={styles.caption}>
            For an agent running on the same machine as this gate — swap the harness, keep the
            context. An agent anywhere else, including claude.ai and ChatGPT, can’t reach this
            address;{" "}
            <Link to="/agents" className={styles.link}>
              Agents &amp; keys
            </Link>{" "}
            has the recipe for each.
          </p>
        </>
      ) : (
        <p className={styles.caption}>{NO_ENDPOINT}</p>
      )}
    </div>
  );
}
