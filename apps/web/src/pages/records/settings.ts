// Settings' pure logic — the provider-app row descriptors and the not-served captions. Kept out of
// the component so the degradation contract (what is served vs. what the design draws ahead of the
// API) is stated in one honest place and unit-testable.

import type { PlaidEnv } from "../../api/client";
import { restartCell, type ReachEvidence } from "../../api/exposure";
import type { BridgeProblem, ExposureStatus } from "../../api/types";

/** The four BYO provider apps, in the order `33V-0` lists them. `microsoft`/`google`/`whoop` use the
 *  OAuth-app routes; `plaid` uses the Plaid-app routes — both served today. */
export type ProviderAppId = "microsoft" | "google" | "whoop" | "plaid";

export const PROVIDER_APPS: { id: ProviderAppId; name: string }[] = [
  { id: "microsoft", name: "Microsoft" },
  { id: "google", name: "Google" },
  { id: "whoop", name: "Whoop" },
  { id: "plaid", name: "Plaid" },
];

/**
 * The mono client-type sub-line under each provider name. For the three OAuth providers it is fixed
 * by the provider's client type (Microsoft public/PKCE, Google/Whoop confidential); Plaid's carries
 * the served `env`. These are facts about the provider's OAuth model, not invented data.
 */
export function providerKindLine(id: ProviderAppId, plaidEnv?: PlaidEnv): string {
  switch (id) {
    case "microsoft":
      return "public client · PKCE · no secret";
    case "google":
      return "confidential · client id + secret";
    case "whoop":
      return "confidential · offline scope";
    case "plaid":
      return `${plaidEnv ?? "production"} · client id + secret`;
  }
}

/**
 * The Settings rows the DESIGN draws but the operator-loopback API does NOT serve. Each renders in
 * its drawn shape with this reason beside it (degradation contract clause 2) — never a fabricated
 * "On"/"2 days ago". Listed here so the honesty is auditable in one place and the surface flips by
 * deleting a branch when the wire lands.
 */
export const NOT_SERVED = {
  /** Apple Health ingest URL is minted PER Apple-Health connection (`mintIngestSecret`), not a gate
   *  setting — showing one here would require re-minting (rotating the secret). */
  appleHealthIngest:
    "Managed on the Apple Health connection — minting it here would rotate the secret.",
  /** No REST surface reports backup age; backup is `scripts/backup.sh` on the box (ADR 0011 / 9C). */
  backupStatus: "Backup runs on the box — its status isn’t served to the Console.",
  /** TAILNET-SERVE state ONLY — and the scope of this caption shrank when `/api/exposure` landed.
   *  It used to cover "whether MCP_PUBLIC_URL is set" as well; that half is now SERVED (the public
   *  address row and the OAuth-bridge row both read `useExposure()` and state the truth). What
   *  remains genuinely unknowable is whether `tailscale serve` is armed: Postern issues no
   *  `tailscale` command and holds no tailnet identity (ADR 0035 §D9), so it cannot see that flag.
   *  Do not re-widen this caption onto a row whose state the gateway now reports. */
  remoteAccess: "Set on the box — the Console isn’t told the live state.",
  /**
   * FUNNEL REACHABILITY — the other half of the same unknowable, on the row below (#118).
   *
   * This is NOT a re-widening of `remoteAccess`. The public row's own state — configured, serving,
   * the address, the restart gap — is fully served and stated by `publishState()`. What is not
   * served, and cannot be, is whether anything on the internet can actually get to that address:
   * Tailscale Funnel is armed on the box with a `tailscale` command Postern never runs, holding a
   * tailnet identity it does not have (ADR 0035 §D9). The row therefore says so, in the same
   * degraded register as the tailnet row above it, rather than letting an operator read a saved
   * address as an open door. **Never turn this into a status word** — "open"/"closed" would be a
   * synthesised claim about a subsystem Postern cannot see, which is the exact defect the caption
   * exists to prevent.
   */
  funnelReach:
    "Reaching that address from the internet is arranged outside Postern — Tailscale Funnel, on the box. Postern runs no Tailscale command, so it cannot tell you whether Funnel is open.",
  // There is no `appearanceNight` key. Night is not an unserved VALUE, which is what this object is
  // for — it is an undesigned MODE (§17.0), so Settings draws no appearance control at all rather
  // than degrading one. Adding a caption here again would be the first step back to a disabled
  // toggle advertising a world that does not exist.
} as const;

// ── Remote access · the public-exposure row (ADR 0035 §D1/§D2) ──────────────────────────────────
//
// This state is SERVED, so none of it belongs in NOT_SERVED above. It lives here — pure, out of the
// component — because two rows in the same panel read it (the public address row and OAuth bridge)
// and a second derivation is how those two start disagreeing about whether the gate is on the
// internet.

/**
 * **The row's subject is the address, not the mechanism** (#118).
 *
 * It shipped as *"Public · Tailscale Funnel"* with an **"Enable"** button, and the operator's first
 * question reading a fresh deploy was *"what does the enable button do?"* — because it does nothing
 * to Tailscale. It validates a URL, records consent, writes a row and asks for a restart. Postern
 * issues no `tailscale` command and holds no tailnet identity (ADR 0035 §D9), so Funnel is a
 * prerequisite the user satisfies elsewhere — it belongs beside MagicDNS and the certificates in
 * `TAILSCALE_NOTE`, not in the title of a row that claims to control it.
 *
 * What the row DOES control is where this gateway answers, and the title now says that.
 */
export const PUBLIC_ADDRESS_ROW_TITLE = "Public · the address this gate answers on";

/**
 * The row's primary control, and **the label its own success message may not retract** (#118).
 *
 * "Enable…" promised a state change that the very next toast — *"Saved — restart the gateway to
 * start publishing."* — admitted had not happened. Setting the address is what the click actually
 * achieves, so that is what it says; the toast then reports exactly that, and the two agree.
 *
 * Exported because the tests LOCATE the control by it. `SettingsPage.test.tsx` carries a cell that
 * asserts this control is ABSENT on an env-published gate; with the label duplicated as a literal
 * there, the next rename would leave that assertion passing against a button that no longer exists
 * under that name — a guard that cannot fail, on the exposure surface of all places.
 */
export const SET_ADDRESS_ACTION = "Set the address…";

/**
 * Served, and served as an ABSENCE: this gateway is running no MCP edge, so it has no address to
 * hand an agent at all. Distinct from "not served" — the gateway answered, and the answer is none.
 *
 * **Only render this when the gateway ANSWERED.** On `isError` the answer is unknown and the
 * surface renders `EXPOSURE_UNANSWERED` instead: this sentence ends in an instruction to go change
 * the box, and issuing that because a fetch failed is spec §Decision 7's named defect.
 */
export const NO_MCP_ENDPOINT =
  "This gateway isn’t running an MCP edge, so it has no address to hand an agent. Set MCP_HTTP_PORT on the box and restart it.";

/**
 * Why the exposure setting cannot be used right now — **the CAUSE, and nothing about what the
 * internet can currently reach.**
 *
 * These strings each used to end in "…so it is publishing nothing" / "Nothing of yours is on the
 * internet". That was a lie in exactly the state where the truth matters most. `problem` is a
 * REQUEST-TIME fact about the store (`resolveBridgeConfig()`); `serving` is a BOOT-TIME fact about
 * the edge (`mountedBridgeConfig()`), and the two are INDEPENDENT (spec §Decision 6): a Postgres
 * restart under a gateway that mounted a DB-sourced bridge at boot yields `db_unreadable` **with a
 * live public edge still answering strangers**.
 *
 * So the Record says only why the setting is stuck; `publishState` composes the state sentence in
 * front of it, and there are two of those because there are two states.
 */
export const EXPOSURE_PROBLEM: Record<BridgeProblem, string> = {
  db_unreadable:
    "This setting can’t be changed until this gateway can read its own store again — it isn’t answering.",
  db_invalid:
    "The address stored for this gate isn’t one this build can use, so this setting can’t be applied. Stop publishing to clear it, then save a new one.",
  env_invalid:
    "MCP_PUBLIC_URL is set on the box to an address this gateway refuses, so this setting can’t be applied. Unset it there and this setting takes over.",
};

/** The state half of a problem sentence when this process mounted NOTHING — then, and only then,
 *  "nothing is published" is a true statement about the internet. */
export const EXPOSURE_PROBLEM_NOT_SERVING =
  "Nothing of yours is on the internet — this gateway mounted no public edge when it started.";

/**
 * The state half when the edge IS serving. Stated FIRST, because it is the fact a reader needs
 * before any explanation of why the setting is stuck.
 *
 * It read *"answering **the internet** at this address"* until #120. That phrasing asserted routing
 * — that a stranger can get here — which is Funnel's business and unknowable to Postern (§Decision
 * 5); the same over-claim `EXPOSURE_SERVING_HERE` was written to end. What survives is the stronger
 * half and the one Postern can prove: it is answering, and it keeps answering **strangers** until it
 * restarts. Nothing about the danger of this state is softened — the U4 cells that pin it assert
 * this constant by reference, so its wording moves without their assertions going deaf.
 */
export const EXPOSURE_PROBLEM_WHILE_SERVING =
  "This gateway is still answering strangers on this address right now — it mounted it when it started, and it keeps answering until it restarts.";

/**
 * The published state's sentence — **what this gateway KNOWS, and nothing past it** (#120).
 *
 * It shipped as *"Reachable from the public internet at this address right now."* — an assertion
 * about ROUTING, sitting roughly thirty words below this row's own admission that Postern cannot
 * tell whether Funnel is open. Both cannot be true, and the confident one was the wrong one:
 * Postern issues no `tailscale` command (ADR 0035 §D9), so whether a stranger can *get* here is
 * simply not a fact it holds. Two subsystems, two facts, and the row was borrowing the authority of
 * the one it owns to make a claim about the one it does not.
 *
 * So the split, which is the same `serving`-vs-`problem` split U4 already landed:
 *   · **this process is answering on this address** — fact, from `mountedBridgeConfig()`. Here.
 *   · **the internet can get to it** — asserted NOWHERE. The nearest honest thing is evidence that
 *     something already did, and that is `REACH_NOTE`, one line below, stated only as far as the
 *     evidence goes.
 */
export const EXPOSURE_SERVING_HERE =
  "This gateway is answering on this address right now — it mounted it when it started, and it keeps answering until it restarts.";

/**
 * The gate is published by the BOX, not by this setting (spec §Decision 5).
 *
 * Exposure has two storage states (row / no row) and the product needs three, so on a box whose
 * `MCP_PUBLIC_URL` is set there is no way to express *off* — which is what production runs. What
 * shipped drew **Stop publishing** enabled there; the DELETE removed a row that did not exist, env
 * still won, and the Console reported "Stopped". Nothing stopped. So the control is drawn DISABLED
 * with this reason, never enabled-then-failing, and the reason NAMES the variable: a control that
 * is unavailable without saying why is indistinguishable from a broken one.
 */
export const EXPOSURE_ENV_SOURCED =
  "The box publishes this gateway: MCP_PUBLIC_URL is set in its environment, and the box wins over anything saved here. This setting can’t change that — unset MCP_PUBLIC_URL on the box and restart it to hand control to the Console.";

/** The status-dot tone for the public-address row. `attention` is reserved for the one state that
 *  is neither on nor off: the gate is answering the internet and the operator has asked it to stop. */
export type PublishTone = "ok" | "idle" | "attention";

export interface PublishState {
  /** The status-chip word. **Never a live word unless the edge is actually serving.** */
  word: string;
  tone: PublishTone;
  /** The PUBLIC address to show — `serving` first, then `configured`. Deliberately never falls back
   *  to the local endpoint: a loopback address rendered under the public-address row would read as a
   *  published one. null = there is no public address to show. */
  address: string | null;
  /** What that address IS. A saved-but-not-yet-live address labelled "Published at" would be the
   *  whole defect in two words, so the label moves with the state instead of being a constant. */
  addressLabel: string;
  /** The one sentence explaining any gap between what is saved and what is served. */
  sentence: string | null;
  canEnable: boolean;
  canStop: boolean;
  /**
   * Non-null ⇒ **draw the Stop control, DISABLED, and show this reason.** Set only for a gate
   * published by the box's `MCP_PUBLIC_URL` (§Decision 5), where a delete cannot achieve what the
   * caller asked for. It is a separate field from `canStop` on purpose: `canStop === false` also
   * covers "there is nothing to stop", which draws Enable instead, and collapsing the two is how
   * the row came to offer an operation the gateway refuses.
   */
  stopBlocked: string | null;
  /** When the consent behind `configured` was recorded, ISO, as served. null when unknown or when
   *  nothing is configured. Rendered through the one clock (`api/format.ts`), never re-derived. */
  consentedAt: string | null;
  /** Show the published-routes disclosure — i.e. there is something a stranger can reach, or is
   *  about to be able to. */
  showDisclosure: boolean;
}

/**
 * The public-address row, from one served status.
 *
 * The rule that decides every branch: **`serving` is what the internet can reach; `configured` is
 * only an intention.** The gateway reads its address once at boot, so a save and a stop are both
 * promises about the next restart — and of the two, "stopped but still reachable" is the one that
 * can hurt someone. It gets its own word, its own tone and its own sentence, and it keeps the
 * address on screen: hiding it the moment `configured` goes null would be the Console telling a
 * user they are private while a stranger is still being answered.
 *
 * Two corollaries, each the subject of a review finding, and each an ordering rule in the body:
 *   1. **`problem` may never be answered before `serving`** (§Decision 6). They are a request-time
 *      fact and a boot-time fact about different subsystems, so `problem != null` says nothing
 *      whatever about what the internet can reach.
 *   2. **An env-sourced gate can be described but not changed** (§Decision 5), so Stop is drawn
 *      disabled with its reason rather than enabled and refused.
 */
export function publishState(s: ExposureStatus): PublishState {
  const serving = s.serving?.publicUrl ?? null;
  const configured = s.configured?.publicUrl ?? null;
  const consentedAt = s.configured?.consentedAt ?? null;

  // ── §Decision 6: `serving` wins the safety question, and it is answered FIRST ─────────────────
  //
  // What shipped tested `s.problem` before it had looked at `s.serving`, and returned
  // `address: null, showDisclosure: false` — so a gateway that mounted a DB-sourced bridge at boot
  // and then lost its store rendered "so it is publishing nothing. Nothing of yours is on the
  // internet" two lines above the bridge row's "On — published at …", with "what a stranger can
  // reach" SUPPRESSED exactly when it was true. `problem` is request-time, `serving` is boot-time;
  // one cannot speak for the other. While the edge is mounted this row says the gateway IS
  // reachable and shows the disclosure, and the problem is reported as *the setting is stuck*.
  if (s.problem != null) {
    return serving != null
      ? {
          word: "still reachable",
          tone: "attention",
          address: serving,
          addressLabel: "Still serving",
          sentence: `${EXPOSURE_PROBLEM_WHILE_SERVING} ${EXPOSURE_PROBLEM[s.problem]}`,
          canEnable: false,
          // DELETE is the documented way out of a stored address this build cannot parse; the other
          // two problems leave nothing this setting can act on.
          canStop: s.problem === "db_invalid",
          stopBlocked: null,
          consentedAt,
          showDisclosure: true,
        }
      : {
          word: "unavailable",
          tone: "idle",
          address: null,
          addressLabel: "Published at",
          sentence: `${EXPOSURE_PROBLEM_NOT_SERVING} ${EXPOSURE_PROBLEM[s.problem]}`,
          canEnable: false,
          canStop: s.problem === "db_invalid",
          stopBlocked: null,
          consentedAt,
          showDisclosure: false,
        };
  }

  const cell = restartCell(s);

  const base: PublishState = ((): PublishState => {
    switch (cell) {
      case "none":
        return configured == null
          ? {
              word: "off",
              tone: "idle",
              address: null,
              addressLabel: "Published at",
              sentence: null,
              canEnable: true,
              canStop: false,
              stopBlocked: null,
              consentedAt,
              showDisclosure: false,
            }
          : {
              word: "published",
              tone: "ok",
              address: serving,
              addressLabel: "Published at",
              sentence: EXPOSURE_SERVING_HERE,
              canEnable: false,
              canStop: true,
              stopBlocked: null,
              consentedAt,
              showDisclosure: true,
            };
      case "saved_not_live":
        return {
          word: "restart to apply",
          tone: "idle",
          address: configured,
          addressLabel: "Saved address",
          sentence:
            "Saved, and not published yet. This gateway starts serving this address the next time it restarts — until then nothing of yours is on the internet.",
          canEnable: false,
          canStop: true,
          stopBlocked: null,
          consentedAt,
          showDisclosure: true,
        };
      case "cleared_still_live":
        return {
          word: "still reachable",
          tone: "attention",
          address: serving,
          addressLabel: "Still serving",
          sentence:
            "Stopped — and not private yet. This gateway is still serving this address to the internet, and will keep answering strangers until you restart it.",
          // Nothing left to stop; publishing again is the only move from here.
          canEnable: true,
          canStop: false,
          stopBlocked: null,
          consentedAt,
          showDisclosure: true,
        };
      case "changed_not_live":
        return {
          word: "restart to apply",
          tone: "attention",
          address: serving,
          addressLabel: "Still serving",
          sentence: `Still serving this address. The one you saved — ${configured} — takes effect the next time this gateway restarts.`,
          canEnable: false,
          canStop: true,
          stopBlocked: null,
          consentedAt,
          showDisclosure: true,
        };
    }
  })();

  // ── §Decision 5: an ENV-SOURCED gate is published by the box, and this setting cannot change it ─
  //
  // Applied as an overlay rather than a fifth cell, because it is orthogonal to all four: whatever
  // the restart situation, if the effective source is the environment then Stop cannot achieve what
  // it claims. Drawn disabled with the reason, never enabled-then-failing — the gateway now refuses
  // that DELETE with a named 409, and an enabled button whose only outcome is a refusal is the
  // defect, not the refusal.
  if (s.configured?.source !== "env") return base;
  return {
    ...base,
    canEnable: false,
    canStop: false,
    stopBlocked: EXPOSURE_ENV_SOURCED,
    sentence: base.sentence == null ? EXPOSURE_ENV_SOURCED : `${base.sentence} ${EXPOSURE_ENV_SOURCED}`,
  };
}

/** The OAuth-bridge row's line. Reads `serving` and nothing else, from the SAME status object the
 *  row above reads — the bridge is on when this process mounted it, not when a row was saved. */
export function bridgeLine(s: ExposureStatus): string {
  return s.serving != null
    ? `On — published at ${s.serving.publicUrl}`
    : "Off — this edge is bearer-only.";
}

// ── What has actually reached this address (#119) ───────────────────────────────────────────────
//
// The other half of the #120 split. `EXPOSURE_SERVING_HERE` states what this process is doing;
// these state what has arrived — the only evidence Postern holds about the way in, and never more
// than evidence. `reachEvidence()` in `api/exposure.ts` decides WHICH; this decides how it reads.

/**
 * One sentence per evidence class. `unknown` is null on purpose: **there is no sentence for "we
 * cannot say"**, because a row that fills silence with a hedge teaches a reader to skim the line
 * that matters. It simply is not drawn.
 *
 * The negative is written as a DIAGNOSIS, not a failure (spec §Decision 4) — it names where the
 * break is (upstream of Postern) and what to look at, because a user reading it has a hosted client
 * telling them "couldn't reach" and nothing else to go on. And it admits its own blind spot in the
 * last clause: an in-memory record on a freshly restarted gateway is empty for an innocent reason,
 * and a diagnosis that cannot be wrong is not a diagnosis.
 */
export const REACH_NOTE: Record<ReachEvidence, string | null> = {
  unknown: null,
  reached_here:
    "Traffic has reached this gateway at this address since it started, so the way in is open. This is a record of the current run — it starts empty again after a restart.",
  reached_elsewhere:
    "This gateway has been reached since it started, but never at this address — something is arriving under a different name. Check that what is saved here is the hostname your Funnel actually publishes.",
  nothing_yet:
    "Nothing has reached this gateway at this address since it started. If a hosted client says it cannot connect, the break is upstream of here — the Funnel, the hostname or the port — because nothing arrived for this gate to refuse. A gateway that has only just restarted has had nothing to record yet.",
};

// ── The setup Postern cannot perform, written so a stranger can follow it (#119) ─────────────────
//
// A first-time user met a text field and no path to filling it: the address they must type does not
// exist until five things are true elsewhere, and Postern can see none of them. `TAILSCALE_NOTE`
// (in `SettingsPage.tsx`) says WHAT Postern will not do; this says what to do instead, in order.
//
// It is reference matter beside a plain row, never a callout and never a nudge (ADR 0035 §D2) — and
// it deliberately duplicates the runbook rather than linking to it, because the Console has no way
// to open a repository document and a user who cannot leave this page still has to finish the job.

/** The placeholder hostname family the plates use — a SHAPE, never anyone's real machine. */
export const PUBLIC_HOST_PLACEHOLDER = "your-mac.tailnet.ts.net";
export const PUBLIC_URL_PLACEHOLDER = `https://${PUBLIC_HOST_PLACEHOLDER}`;

/**
 * What this field wants, said BEFORE the paste rather than only in the refusal afterwards (#126).
 *
 * The most natural thing to type here is the `/mcp` URL — it is what the connect-an-agent surfaces
 * hand out and what a user hands an agent, and it is the wrong value: every endpoint this gateway publishes is
 * served at the root, so a path was carried into the discovery documents and advertised endpoints
 * that answered nothing, with every indicator on this page still green. The gateway now refuses it,
 * and the refusal names the origin to save — but a field that only corrects you after the fact is a
 * worse field than one that says what it wants.
 *
 * It names the trap rather than only the rule: "a bare origin" is not a phrase a first-time user
 * matches against the URL in their clipboard.
 */
export const PUBLIC_URL_SHAPE_NOTE =
  "The origin only — the scheme and the hostname, with nothing after it. Not the /mcp address you hand an agent: this gateway builds that one itself, and it refuses an address carrying a path.";

export const SETUP_HEADING = "Before this address answers";

/**
 * The mark on the two prerequisites that live somewhere Postern cannot see or reach.
 *
 * Typographic, not pictorial: the icon source of truth is the locked-assets plate, and a mark that
 * is not on it is not approved. Small caps in the register the panel's own labels already use.
 */
export const TAILSCALE_CONSOLE_MARK = "in Tailscale’s admin console";

export interface SetupStep {
  /** The instruction, in plain words. */
  text: string;
  /** The command this step is, if it is one. null when the step is a switch rather than a command. */
  code: string | null;
  /** Draw `TAILSCALE_CONSOLE_MARK` beside it — see `SETUP_SILENT_PAIR` for why exactly two carry it. */
  inTailscaleConsole: boolean;
}

/**
 * The five, in the order they must happen (runbook `remote-access.md` § *The irreducible setup*).
 *
 * **Two of them are marked and three are not, and the asymmetry is the point.** MagicDNS and the
 * HTTPS certificates are tailnet-wide switches: invisible to the gateway, required by Funnel, and —
 * the part that costs people an evening — silent when missing. The port simply never answers and no
 * log anywhere names the cause. The `funnel` node attribute is the kind one: the CLI refuses out
 * loud and hands you the link. Marking all five would flatten exactly the distinction a first-time
 * user needs, so the mark means *"nothing will tell you if this is wrong"*, not *"Tailscale owns it"*.
 */
export const TAILSCALE_SETUP_STEPS: readonly SetupStep[] = [
  { text: "A Tailscale account — the free personal plan covers a household.", code: null, inTailscaleConsole: false },
  { text: "This machine signed into it, on the box:", code: "tailscale up", inTailscaleConsole: false },
  { text: "MagicDNS, on.", code: null, inTailscaleConsole: true },
  { text: "HTTPS certificates, on.", code: null, inTailscaleConsole: true },
  {
    text: "The funnel node attribute for this machine, scoped to its own tag in your tailnet policy.",
    code: null,
    inTailscaleConsole: false,
  },
];

/** Why two of the five are marked — the sentence that earns the mark rather than decorating it. */
export const SETUP_SILENT_PAIR =
  "The two marked switches are tailnet-wide, and Funnel does not work without both. Neither failure announces itself: the port simply never answers, and nothing in this gateway’s log will say why — which is what the mark is for. Step five is the kind one; the command below refuses out loud and hands you the link.";

export const SETUP_HOSTNAME_LABEL = "Where the hostname comes from";
export const SETUP_HOSTNAME_CODE = "tailscale status";
export const SETUP_HOSTNAME = `Run that on the box, or read the name in Tailscale’s admin console. It looks like ${PUBLIC_HOST_PLACEHOLDER} — and your gate’s address is https:// and that name, with nothing after it.`;

export const SETUP_COMMAND_LABEL = "Then publish the port";

/**
 * The one Funnel command, pointed at the port this gateway's MCP edge is actually on.
 *
 * The port is SERVED (`localMcpPort()` reads it off `localEndpoint`), never a build-time guess —
 * getting it wrong is not a typo here, it is publishing the wrong server. When it is unknown the
 * command prints a named placeholder rather than a plausible number: a command a user pastes must
 * be right or visibly incomplete, never confidently approximate.
 */
export function funnelCommand(port: string | null): string {
  return `tailscale funnel --bg --https=443 http://127.0.0.1:${port ?? "<your MCP edge’s port>"}`;
}

/** `--bg` is not decoration — the runbook's own warning, at the place the command is copied. */
export const SETUP_COMMAND_NOTE =
  "Run it on the box, once. Keep the --bg: without it the command holds the configuration in the foreground and never gives you a prompt back, and a Ctrl-C is then the only thing between you and a configuration you never read.";

/**
 * Why 443 and not one of the other two Funnel ports — the lesson that cost this project a debugging
 * session (#47) and the only reason there is one right answer instead of three.
 */
export const SETUP_WHY_443 =
  "Why 443, and not another port: Funnel opens exactly three — 443, 8443 and 10000 — and hosted clients reach out on 443 only. One number satisfies both. A Funnel on either of the others is reset before a request ever leaves the vendor’s network, so the client reports that it could not connect and your logs show nothing at all, because nothing arrived.";
