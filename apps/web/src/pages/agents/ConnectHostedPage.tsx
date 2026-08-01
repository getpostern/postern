// Connect a hosted client — the OAuth-bridge walkthrough (Paper 5XS-0, #53).
//
// TWO hosted clients, not one. ChatGPT connects through this same bridge and was witnessed doing it
// 2026-08-01 (an `oauth_bridge_clients` row plus served queries in the prod ledger); the page had
// been speaking as though claude.ai were the only one, which tells a ChatGPT user the path isn't for
// them. The claude.ai step is settled copy and is EXTENDED, never rewritten.
//
// ChatGPT's own labels are in flux and the copy anchors on what the person clicks: the rail item is
// **Plugins**, ChatGPT's banner says connectors are now called Apps, and the URL fragment still says
// Connectors. Three names, one page — so the step names the page you click and parenthesizes the
// drift rather than picking a winner that will rot.
//
// Two load-bearing truths the copy must carry (build-notes §3.2):
//   - The bridge is ON exactly when this gate is published — no separate flag. Unpublished = the
//     edge is byte-identical to static-bearer-only (ADR 0035 §D2). Step 1 says exactly that, and it
//     points at Settings → Remote access, because needing to edit a file on the box IS the gap this
//     page was written around.
//   - The :443 reachability caveat: hosted clients (claude.ai/ChatGPT) egress on port 443 ONLY (#47),
//     so the public URL must be Funnel-served on 443 — or the client hits a silent TCP reset. That
//     sentence stays, verbatim.
//
// The bridge status is now READ, not guessed. It used to be genuinely unserved — there was no
// bridge-status route — so this card stated the CONDITION with an idle dot and admitted the gap.
// `/api/exposure` serves it, so the card states the truth, including the two states an operator will
// otherwise misread: saved-but-not-yet-restarted, and stopped-but-still-serving.
//
// #101: the page used to offer a Copy button for the configured endpoint unconditionally — under the
// shipped quickstart that was a loopback address Anthropic's cloud can never reach. Handing it out is
// the "well-formed but wrong" failure. So the endpoint is CLASSIFIED first, and Copy is offered only
// for the one shape a hosted client can actually use (https, port 443). Every other shape follows the
// #27 degradation pattern the Apple Health ingest flow already uses (pages/connect/ConnectProvider):
// show the operator-supplied PATTERN, non-copyable, and say why Postern cannot fill it in.
// `classifyCloudTarget` and `reasonFor` below are #101's mutation-proved logic and are UNCHANGED;
// only the SOURCE of the string they judge has moved from a build-time constant to the served value.
//
// #131: the value this card hands out is the MCP ENDPOINT — the published origin plus `/mcp` — never
// the bare origin. The gate's saved address and the address you hand an agent differ by exactly that
// suffix (#126 owns the save side), and showing the origin here sent every hosted client to a root
// that 404s while OAuth succeeded around it. The derivation lives in `api/exposure.ts`
// (`displayEndpoint`), the one place display addresses come from — never re-appended here.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useExposure } from "../../api/hooks";
import { EXPOSURE_UNANSWERED, displayEndpoint, restartCell } from "../../api/exposure";
import type { ExposureStatus } from "../../api/types";
import { Skeleton, useToast } from "../../kit";
import { SubHead } from "./SubHead";
import styles from "./ConnectHostedPage.module.css";
// The row title is imported, never retyped: this step is a NAVIGATION POINTER, and a pointer that
// names a row by a stale literal sends a first-run user hunting. Found at merge by the #118 review —
// neither child owned this file, so neither could have caught it (the spec's owned-files list is the
// real defect). The test below asserts the imported constant, so the next rename fails loudly here.
import { PUBLIC_ADDRESS_ROW_TITLE } from "../records/settings";
// The guides URL is DERIVED, never typed here (#136). `remote-access` is a published guide with no
// catalog entry, so it goes through the general form of the same one derivation — a second origin
// written in this group is invisible on the day the site renames a page, which is the whole defect
// #136 removed.
import { REMOTE_ACCESS_GUIDE_SLUG, guideUrlForSlug } from "../connect/catalog";

// Step 3 carries the KEEP-THE-KEY sentence, and it is placed there on purpose. The reveal screen's
// Copy puts the agent key on the clipboard; this page's Copy then replaces it with the URL. The
// operator hit exactly that in the witnessed run — pasted the URL into the key box and got "That
// agent key was not accepted" — because the sign-in asks for the key LATER, in another app, and the
// key is shown once. So the warning sits beside the button that overwrites it.
// Step 1 NAMED the path and left the reader to go find it. A person mid-connect should be one click
// from the switch, and one click from the walkthrough that explains the Tailscale + Funnel half
// Postern does not own — so the step carries both: the Console's own Remote-access screen, and the
// remote-access field guide on the public site. The guide is the ONLY external anchor on this page,
// for the same reason it is the only one on a connect screen: a link is a promise about where it
// goes, and the public site is the one destination this repo can keep in step.
const STEPS: ReactNode[] = [
  <>
    {`Publish your gate — Settings → Remote access → ${PUBLIC_ADDRESS_ROW_TITLE}. Off by default; stdio and pasted keys need no exposure at all.`}
    <span className={styles.stepLinks}>
      <Link className={styles.stepLink} to="/settings">
        Open Remote access →
      </Link>
      {/* `_blank` because the reader is mid-connect; `noopener noreferrer` because a `_blank` tab is
          handed `window.opener` and a Referer otherwise. The URL carries no parameters, ever. */}
      <a
        className={styles.stepLink}
        href={guideUrlForSlug(REMOTE_ACCESS_GUIDE_SLUG)}
        target="_blank"
        rel="noopener noreferrer"
      >
        The full remote-access field guide, at getpostern.com →
      </a>
    </span>
  </>,
  "In claude.ai, open Settings → Connectors → Add custom connector. In ChatGPT, turn on Settings → Plugins → Developer mode, then use “+” on the Plugins page → New Plugin (ChatGPT also calls these Apps, and its URL still says Connectors — same place).",
  "Paste the endpoint shown here — your public address plus /mcp — pick OAuth if the client asks how to authenticate, then sign in and paste an agent key once. The client holds a rotating token from then on. Save that key somewhere safe before you copy the endpoint: copying here replaces it on your clipboard, and a key is shown only once.",
];

/** Can a hosted (cloud) MCP client reach this endpoint? A fact about the string, never a claim about
 *  the world — Postern cannot confirm that a well-shaped address is actually served publicly. */
export type CloudTarget =
  | { kind: "usable"; url: string }
  | { kind: "loopback"; url: string }
  | { kind: "insecure"; url: string }
  | { kind: "wrong-port"; url: string; port: string }
  | { kind: "unreadable"; url: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * Classify the served endpoint. Order is load-bearing: a gateway with no published address falls
 * back to its local `http://localhost:<port>/mcp`, which is loopback AND http AND off-443, and
 * `loopback` is the useful message. MUST NOT THROW — the Console has no ErrorBoundary, so an
 * unguarded `new URL()` on an address the gateway could not resolve would white-screen the page.
 *
 * No private-range (192.168/10.x) heuristic: it would misfire on tailnet-style hosts, and the copy
 * already refuses to claim reachability.
 */
export function classifyCloudTarget(endpoint: string): CloudTarget {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return { kind: "unreadable", url: endpoint };
  }
  // WHATWG keeps the brackets on an IPv6 hostname, so `[::1]` is what `new URL` reports.
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) {
    return { kind: "loopback", url: endpoint };
  }
  if (u.protocol !== "https:") return { kind: "insecure", url: endpoint };
  // `u.port` is "" when the port is the scheme default, so an explicit `:443` reads as usable too.
  if (u.port !== "" && u.port !== "443") return { kind: "wrong-port", url: endpoint, port: u.port };
  return { kind: "usable", url: endpoint };
}

/** The operator-supplied host, in the plate's placeholder family — never a real hostname, and with
 *  no port suffix, because 443 is the whole subject of this page. */
const PUBLIC_URL_PATTERN = "https://your-mac.tailnet.ts.net/mcp";

/** Appended to every unreachable reason: the #27 sentence, in this page's terms. */
const NOT_FILLED_IN = "Postern isn't told that address, so it can't fill it in for you.";

const USABLE_NOTE =
  "Your gate's public address plus /mcp — the endpoint a hosted client actually connects to. It's an https address on 443, so a hosted client can reach it — Postern can't confirm it is actually served publicly. If claude.ai or ChatGPT says it can't connect, fix the address, wait five minutes, and try once: a hosted client remembers a failed check for a few minutes.";

/** The reason line for a target a hosted client cannot reach. Typed to EXCLUDE `usable`, so the
 *  compiler — not a comment — guarantees the reachable branch never renders a refusal. */
function reasonFor(target: Exclude<CloudTarget, { kind: "usable" }>): string {
  switch (target.kind) {
    case "loopback":
      // "a loopback address" was immediately followed by its own gloss, so the word was carrying
      // nothing the next four words did not (#106). The classification is unchanged — only the noun.
      return `Postern is configured with ${target.url} — an address only this machine can use. A hosted client connects from its own cloud and can never reach it. ${NOT_FILLED_IN}`;
    case "insecure":
      return `Postern is configured with ${target.url} — plain http. Hosted clients require https. ${NOT_FILLED_IN}`;
    case "wrong-port":
      return `Postern is configured with ${target.url} — port ${target.port}. Hosted clients egress on port 443 only; on any other port the connection is reset with nothing you'll see. ${NOT_FILLED_IN}`;
    case "unreadable":
      return `Postern is configured with ${target.url}, which isn't an address it can read — so it can't tell whether a hosted client could reach it. ${NOT_FILLED_IN}`;
  }
}

/**
 * What the card says about the bridge — READ from `/api/exposure`, never guessed and never derived
 * from an env var this page cannot see.
 *
 * The two states an operator will otherwise misread each get their own sentence: an address saved
 * but not yet restarted into (the bridge is genuinely OFF), and publishing stopped while the process
 * keeps serving (the bridge is genuinely ON). Collapsing either into a plain on/off is how someone
 * concludes they are private while claude.ai is still being answered.
 *
 * **`serving` is answered before `problem`** (spec §Decision 6). They are independent facts about
 * different subsystems — `problem` is request-time and about the store, `serving` is boot-time and
 * about the edge — so a store fault under a gateway that mounted a DB-sourced bridge yields
 * `db_unreadable` with claude.ai still being answered. This card used to say "Bridge is off …
 * Nothing is published" directly above a live Copy button for the address it was publishing.
 *
 * `failed` is the third outcome, distinct from both: the gateway did not answer at all, which is a
 * fact about the request and never a fact about the bridge.
 */
function bridgeStatus(
  s: ExposureStatus | undefined,
  failed = false,
): {
  tone: "ok" | "idle";
  text: string;
  hint: string | null;
} {
  if (failed) {
    return {
      tone: "idle",
      text: "This gateway didn’t answer with its bridge status",
      hint: EXPOSURE_UNANSWERED,
    };
  }
  if (s == null) {
    return { tone: "idle", text: "Reading this gate's bridge status…", hint: null };
  }
  const cell = restartCell(s);
  if (s.serving != null) {
    return {
      tone: "ok",
      text: `Bridge is on — published at ${s.serving.publicUrl}`,
      hint:
        s.problem != null
          ? "This gateway can't read its own exposure setting, so it can't be changed right now — the address above is still being served."
          : cell === "cleared_still_live"
            ? "You've stopped publishing, and this gateway keeps serving that address until it restarts."
            : cell === "changed_not_live"
              ? "A different address is saved; it takes effect the next time this gateway restarts."
              : null,
    };
  }
  // Below here `serving` is null, so "nothing is published" is a statement this page can make.
  if (s.problem != null) {
    return {
      tone: "idle",
      text: "Bridge is off — this gateway couldn't read its own exposure setting",
      hint: "Nothing is published. Settings → Remote access says why.",
    };
  }
  if (s.configured != null) {
    return {
      tone: "idle",
      text: "Bridge is off — an address is saved but not published yet",
      hint: "Restart the gateway to start publishing at that address.",
    };
  }
  return {
    tone: "idle",
    text: "Bridge is off — agents can only reach this gate with a pasted key",
    hint: "Publish your gate in Settings → Remote access to turn it on.",
  };
}

export function ConnectHostedPage({ endpoint }: { endpoint?: string } = {}): JSX.Element {
  const toast = useToast();
  const exposure = useExposure();
  // The gateway reports its own address; the prop is the caller/test override.
  //
  // THREE absences, and they are DIFFERENT facts, so they get different branches rather than all
  // falling into `unreadable`: the gateway has not answered yet (`pending`), the gateway did not
  // answer at all (`failed` — the request errored), and the gateway has answered that it serves no
  // address at all (`noAddress` — nothing published AND no MCP edge).
  //
  // `failed` is the branch that was missing. `exposure.data` is undefined on an error too, so the
  // page took the pending branch and sat on "Reading this gate's bridge status…" forever, while the
  // address block claimed the box runs no MCP edge. A failed request says nothing about the box
  // (§Decision 7). Routing `noAddress` through `classifyCloudTarget("")` would in turn render
  // "Postern is configured with , which isn't an address it can read", which reads as a parse
  // failure rather than the truth. No branch may fall back to a literal address, and none may throw
  // — there is no ErrorBoundary above this page. `classifyCloudTarget` and `reasonFor` are untouched.
  const pending = endpoint === undefined && exposure.isPending;
  const failed = endpoint === undefined && !pending && (exposure.isError || exposure.data == null);
  const resolved = endpoint ?? displayEndpoint(exposure.data);
  const noAddress = !pending && !failed && resolved == null;
  const url = resolved ?? "";
  const target = classifyCloudTarget(url);
  const status = bridgeStatus(pending || failed ? undefined : exposure.data, failed);

  const copy = () =>
    void navigator?.clipboard?.writeText?.(url).then(
      () => toast.show({ message: "Endpoint copied" }),
      () => toast.show({ message: "Couldn't copy — select and copy manually.", tone: "error" }),
    );

  return (
    <div className={styles.page}>
      <SubHead
        kicker="Connect a hosted agent"
        verdict="Connect claude.ai or ChatGPT"
        sub="Strict hosted clients sign in through the built-in OAuth bridge instead of holding a pasted key. Three steps."
      />

      <div className={styles.body}>
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
            <li key={i} className={styles.step}>
              <span className={styles.stepNum} aria-hidden="true">
                {i + 1}
              </span>
              <span className={styles.stepBody}>{step}</span>
            </li>
          ))}
          <li className={styles.note}>
            The bridge mints short-lived tokens that open the same grants as the key you pasted. Revoke
            the key and every one of them dies at once. Stop publishing and the sign-in disappears —
            nothing else about this gate changes.
          </li>
        </ol>

        <aside className={styles.card}>
          {/* Served: the bridge's state is read from the gateway, not inferred from a flag the
              Console cannot see. */}
          <div className={styles.statusRow}>
            <span className={styles.statusDot} data-tone={status.tone} aria-hidden="true" />
            <span className={styles.statusText}>{status.text}</span>
          </div>
          {status.hint != null ? <div className={styles.statusHint}>{status.hint}</div> : null}

          <div className={styles.divider} aria-hidden="true" />

          {pending ? (
            // Never a fallback address while the gateway has not answered yet.
            <div className={styles.pasteBlock}>
              <div className={styles.pasteLabel}>Your gateway's public URL</div>
              <Skeleton width="70%" />
            </div>
          ) : failed ? (
            // The gateway did not answer. No address, and — deliberately — no operator-supplied
            // PATTERN either: showing the shape to fill in implies the box needs changing, and
            // nothing here is known about the box.
            <div className={styles.pasteBlock}>
              <div className={styles.pasteLabel}>Your gateway's public URL</div>
              <p className={styles.targetNote}>{EXPOSURE_UNANSWERED}</p>
            </div>
          ) : noAddress ? (
            <div className={styles.pasteBlock}>
              <div className={styles.pasteLabel}>Your gateway's public URL</div>
              <code className={styles.pattern}>{PUBLIC_URL_PATTERN}</code>
              <p className={styles.targetNote}>
                This gateway isn’t serving MCP and has published nothing, so it has no address at
                all yet. {NOT_FILLED_IN}
              </p>
            </div>
          ) : target.kind === "usable" ? (
            <div className={styles.pasteBlock}>
              <div className={styles.pasteLabel}>Paste this into claude.ai or ChatGPT</div>
              <div className={styles.pasteRow}>
                <span className={styles.pasteValue}>{target.url}</span>
                <button type="button" className={styles.copyBtn} onClick={copy}>
                  Copy
                </button>
              </div>
              <p className={styles.targetNote}>{USABLE_NOTE}</p>
            </div>
          ) : (
            // Unreachable from the cloud: NO copy button and NO "paste this" label anywhere — the
            // pattern the operator has to supply, and the reason Postern can't supply it.
            <div className={styles.pasteBlock}>
              <div className={styles.pasteLabel}>Your gateway's public URL</div>
              <code className={styles.pattern}>{PUBLIC_URL_PATTERN}</code>
              <p className={styles.targetNote}>{reasonFor(target)}</p>
            </div>
          )}

          <p className={styles.caveat}>
            Hosted clients reach this from their own cloud, so it must be publicly served (port 443).
            Your tailnet and stdio paths stay private.
          </p>
        </aside>
      </div>
    </div>
  );
}
