// Exposure derivations — the ONE place the Console turns an `ExposureStatus` into something a
// surface renders. Five screens read this state (Settings, Connect-hosted, the recipes, Mint, the
// Gatehouse card); five copies of "which address do I show?" is how two of them end up disagreeing.
//
// The honesty rule these functions exist to keep (ADR 0035 §D1, spec §Decision 2): the gateway reads
// its public address ONCE, at boot. So `configured` (what the next boot will use) and `serving`
// (what this process actually mounted) are DIFFERENT FACTS, and the dangerous direction is
// cleared-but-still-live — a user who has clicked *Stop publishing* must never believe they are
// private while the edge is still answering the internet. Nothing here may collapse the two.
//
// And nothing here invents a value. Every function returns null / "none" rather than a plausible
// fallback: a degraded affordance is drawn disabled with its reason, never filled in.

import type { BridgeRouteAuth, ExposureStatus } from "./types";

/**
 * **The gateway did not ANSWER.** The one sentence every surface uses for `useQuery().isError`.
 *
 * *"The gateway did not answer"* and *"the gateway answered: nothing"* are different facts with
 * different remedies, and collapsing them is how five of the six exposure surfaces came to render a
 * failed fetch as `"This gateway isn't running an MCP edge… Set MCP_HTTP_PORT on the box and
 * restart it."` — an instruction to go change a working box because a request failed. **Never
 * render a failed read as a fact about the box** (spec §Decision 7).
 *
 * So this sentence says only what is known: the request failed. It names no environment variable,
 * asks for no restart, and makes no claim about how the gate is configured — because a dropped
 * request carries no information about any of that. It is deliberately ONE constant: five
 * paraphrases is how one of them quietly grows an instruction again.
 */
export const EXPOSURE_UNANSWERED =
  "This gateway didn’t answer with its exposure state — the request failed, which says nothing about how the gate is configured. Reload to try again.";

/**
 * The MCP endpoint a public address implies: its origin plus the one path the edge serves.
 *
 * The gateway guarantees a validated public address is a bare origin — no path, no trailing slash
 * (#126, `validatePublicUrl`) — so the append is exact, and parsing first is only armour: a value
 * this function cannot read is handed through UNCHANGED for the caller's classifier to name, never
 * "corrected" into a plausible address, and never allowed to throw (no ErrorBoundary above any of
 * the five screens).
 */
function publicMcpEndpoint(publicUrl: string): string {
  try {
    const origin = new URL(publicUrl).origin;
    // `origin` is the literal string "null" for a non-http(s) scheme — appending to it would
    // manufacture an address out of garbage.
    return origin === "null" ? publicUrl : `${origin}/mcp`;
  } catch {
    return publicUrl;
  }
}

/**
 * The address a surface should show and hand out — **the endpoint an agent connects to, which is
 * never the bare origin.** The gate's saved address is an origin (`https://host`, #126); the MCP
 * edge answers only at `/mcp` on it, and the root 404s. Handing out the origin was #131: the
 * Console told every hosted-client user to paste an address claude.ai could authenticate against
 * and then fail on. The local fallback already carries `/mcp` as served; the public branches get it
 * appended here, in the ONE derivation, so no surface re-decides which shape it holds.
 *
 * Order is load-bearing: **what is actually served beats what is merely configured**, and the local
 * endpoint is the fallback. Showing `configured` while a different address is live would hand an
 * agent a URL that answers nothing — the mirror image of the safety rule above.
 *
 * Returns null when the gateway serves no address at all. That is a real state (nothing published,
 * no MCP edge) and the caller must render it as an absence, never as a placeholder URL.
 */
export function displayEndpoint(s: ExposureStatus | undefined): string | null {
  if (!s) return null;
  const pub = s.serving?.publicUrl ?? s.configured?.publicUrl;
  if (pub != null) return publicMcpEndpoint(pub);
  return s.localEndpoint ?? null;
}

/**
 * Which of the four restart situations this gate is in. Each gets its OWN sentence on screen —
 * collapsing any two is how "stop publishing" comes to read as "you are private now".
 *
 *   · `none`               — configured and serving agree (both off, or both the same live address)
 *   · `saved_not_live`     — an address is saved and nothing is published yet
 *   · `cleared_still_live` — **the dangerous one**: publishing was stopped and the edge is STILL
 *                            answering the internet until the gateway restarts
 *   · `changed_not_live`   — one address is live and a different one is saved
 *
 * Derived from `configured`/`serving` rather than from the served `restartRequired` boolean: the
 * boolean is a summary of exactly this comparison, and a boolean cannot tell the four apart.
 * `undefined` (still loading) is `none` — a surface that has not heard yet says nothing.
 */
export type RestartCell = "none" | "saved_not_live" | "cleared_still_live" | "changed_not_live";

export function restartCell(s: ExposureStatus | undefined): RestartCell {
  const configured = s?.configured?.publicUrl ?? null;
  const serving = s?.serving?.publicUrl ?? null;
  if (configured === serving) return "none";
  if (serving === null) return "saved_not_live";
  if (configured === null) return "cleared_still_live";
  return "changed_not_live";
}

/**
 * What this gateway can EVIDENCE about traffic arriving at the address it was given (#119, #120).
 *
 * Postern holds two different facts and the Settings row used to blur them into one sentence:
 *
 *   · **what this process is serving** — known precisely; `mountedBridgeConfig()` is fact;
 *   · **whether the internet can reach it** — genuinely unknown, because that is Tailscale Funnel's
 *     job and Postern never touches it (ADR 0035 §D9).
 *
 * This is neither. It is the one honest fact in between — *something reached us here, or nothing
 * has* — read off the `Host` of requests the public edge actually served. It never becomes a claim
 * about routing: "nothing has arrived" is not "the internet cannot get here", and "something
 * arrived" is not "the door is guaranteed open". It is a record, and it is dated by the process.
 *
 *   · `unknown`           — say nothing at all
 *   · `reached_here`      — traffic has arrived at the configured address since boot
 *   · `reached_elsewhere` — traffic has arrived, but never at the configured address
 *   · `nothing_yet`       — nothing has reached this gateway at all since it started
 *
 * **`nothing_yet` is the valuable one** (spec §Decision 4). It tells a user whose hosted client says
 * *"couldn't reach"* that the break is upstream of Postern — a diagnosis that existed nowhere in
 * this product before, and whose absence is exactly why #47 cost a debugging session.
 */
export type ReachEvidence = "unknown" | "reached_here" | "reached_elsewhere" | "nothing_yet";

/**
 * `unknown` is returned in three distinct situations, and each is a deliberate refusal to speak:
 *
 *  1. **Nothing is both configured and serving.** There is no address the question is about.
 *  2. **`configured` and `serving` disagree** (any restart cell but `none`). "Nothing has reached
 *     the address you saved" is then trivially true — of course nothing has, this process is not
 *     answering on it — and the row already carries a sentence about that gap. Reporting it as
 *     evidence would manufacture an alarm out of a restart.
 *  3. **The gateway does not report the field** (`undefined`). "Not served" is a fact about the
 *     wire; a gateway that says nothing must never be rendered as one answering "nothing arrived"
 *     (`api/notserved.test.ts`). `null` — *served, and the answer is none* — is the opposite case
 *     and is the whole point of the feature.
 */
export function reachEvidence(s: ExposureStatus | undefined): ReachEvidence {
  if (s?.configured == null || s.serving == null) return "unknown";
  if (restartCell(s) !== "none") return "unknown";
  const observed = s.observedAtConfiguredAddress;
  if (observed === undefined) return "unknown";
  if (observed === null) return "nothing_yet";
  return observed ? "reached_here" : "reached_elsewhere";
}

/**
 * The port this gateway's MCP edge listens on — the one number the Funnel command needs.
 *
 * Read from the SERVED `localEndpoint`, never guessed: the MCP edge is a separate server on its own
 * port, and a build-time constant for it was wrong the moment the port moved (the same defect
 * `LocalEndpointCard` was rebuilt to end). Returns null when there is no endpoint or it cannot be
 * parsed — the instructions then print a placeholder rather than a number nobody verified.
 *
 * Parsed inside a `try`: `new URL` throws on malformed input, `apps/web` has no ErrorBoundary, and a
 * bad endpoint must degrade one line of a shell command rather than white-screen Settings.
 */
export function localMcpPort(s: ExposureStatus | undefined): string | null {
  const endpoint = s?.localEndpoint;
  if (endpoint == null) return null;
  try {
    const port = new URL(endpoint).port;
    return port === "" ? null : port;
  } catch {
    return null;
  }
}

/**
 * The expiry the mint form STARTS on: 90 days once this gate is published, else Never (today's
 * default). Surfacing the edge-hardening rule (a key handed to a cloud client must carry an expiry)
 * where the key is actually minted.
 *
 * **The Console never BLOCKS a never-expiring key.** The gateway's own rule at the bridge is the
 * only gate; this is a default and a sentence, so the two agree instead of becoming two rules.
 */
export function defaultExpiryDays(s: ExposureStatus | undefined): number | null {
  return s?.configured != null ? 90 : null;
}

/**
 * One plain sentence per auth class, for the "what a stranger can reach" disclosure.
 *
 * An EXHAUSTIVE switch on purpose: a new `BridgeRouteAuth` becomes a COMPILE ERROR here rather than
 * a silently unexplained row in a disclosure about what the internet can reach. That is deliberately
 * a compile-time constraint and not a runtime throw — `apps/web` has no ErrorBoundary, so a throw on
 * an unknown class would white-screen Settings instead of degrading one row.
 */
export function routeSentence(auth: BridgeRouteAuth): string {
  switch (auth) {
    case "open_no_user_data":
      return "Anyone can fetch it. It carries no data about you — it only says where to sign in.";
    case "open_write":
      return "Anyone can call it, and it writes a row: it is how a hosted client introduces itself before it has any credential.";
    case "code_gated":
      return "Needs a valid one-time code from a sign-in you just completed. No code, no answer.";
    case "key_login":
      return "The sign-in itself. It only accepts an agent key you minted here.";
    case "bearer_gated":
      return "Your data. Nothing gets through without a live agent key.";
  }
}
