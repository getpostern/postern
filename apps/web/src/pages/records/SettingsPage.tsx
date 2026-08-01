// Settings — one scrolling hub of independent panels (`2YQ-0`). Operator-loopback only.
//
// Several rows are drawn ahead of the API. Where a value is not served, the affordance renders in its
// drawn shape with a "not served" reason beside it (degradation contract clause 2) — never a
// fabricated "On" or "2 days ago". What IS served: the gate's own address and exposure state
// (`/api/exposure`), the provider-app configured status (oauth/plaid app routes), Export, and the
// Erase route. What is NOT served: the Apple Health ingest URL (minted per connection), backup age,
// and whether `tailscale serve` is armed.
//
// **Remote access is the one panel that publishes something to the internet, and three rules bind
// it** (ADR 0035 §D1/§D2/§D9):
//   1. Exposure is never a default, never a nudge and never a side effect. It is a plain row among
//      the others — no badge, no callout, no "improve your setup" affordance, and nothing on the
//      Gatehouse hints at it. If you are about to make this panel more prominent, don't.
//   2. The gateway reads its public address ONCE, at boot, so a save and a stop are both promises
//      about the NEXT restart. `configured` and `serving` are therefore different facts and this
//      page renders the disagreement. The dangerous direction is *cleared but still live*: a user
//      who clicked Stop publishing must never read this page as "you are private now".
//   3. Postern runs no `tailscale` command and holds no tailnet identity — the account, the machine,
//      MagicDNS/HTTPS certs and the Funnel itself stay the user's job. So the row's SUBJECT is the
//      address this gateway answers on, which is the part Postern owns; Funnel is named where the
//      user acts on it (a prerequisite in `TAILSCALE_NOTE`, and step by step in
//      `RemoteAccessSetup`) and where they might otherwise assume it (`NOT_SERVED.funnelReach`, on
//      the row). Retitling a row to a mechanism this process cannot touch is how the operator came
//      to ask what the button did (#118).
//   4. **Three claims, three different standings, and the row may never trade one for another**
//      (#120). *This process is answering on this address* is FACT (`mountedBridgeConfig()`).
//      *Something has reached us here* is EVIDENCE (`reachEvidence`), dated by the process and
//      never more than evidence. *The internet can get to this address* is UNKNOWABLE and is
//      asserted nowhere — the row shipped saying "Reachable from the public internet at this
//      address right now" thirty words below its own admission that it cannot tell whether Funnel
//      is open. If you are about to write a confident sentence about reachability here, it belongs
//      in one of the first two forms or not at all.
//
// There is no Appearance section, and its absence is a ruling, not an omission (§17.0). No night
// variant has ever been designed — all 47 artboards are light — so the control was not degraded, it
// was drawn for a mode that does not exist. A live one invites an implementer to invent night by
// inversion, which soul.md forbids; a disabled one advertises the mode to the user. Degrading a row
// is for a value the API does not yet serve; there is nothing here to serve.

import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Masthead, SectionRule } from "../../shell";
import { ConfirmBar, Copyable, FieldError, Skeleton, useToast } from "../../kit";
import { api, RestError, type OAuthProvider } from "../../api/client";
import { useExposure, useInvalidateExposure } from "../../api/hooks";
import { EXPOSURE_UNANSWERED, localMcpPort, reachEvidence, routeSentence } from "../../api/exposure";
import { ago } from "../../api/format";
import type { BridgeRouteDescriptor } from "../../api/types";
import { downloadExport } from "./download";
import {
  NOT_SERVED,
  NO_MCP_ENDPOINT,
  PROVIDER_APPS,
  PUBLIC_ADDRESS_ROW_TITLE,
  PUBLIC_URL_PLACEHOLDER,
  PUBLIC_URL_SHAPE_NOTE,
  REACH_NOTE,
  SETUP_COMMAND_LABEL,
  SETUP_COMMAND_NOTE,
  SETUP_HEADING,
  SETUP_HOSTNAME,
  SETUP_HOSTNAME_CODE,
  SETUP_HOSTNAME_LABEL,
  SETUP_SILENT_PAIR,
  SETUP_WHY_443,
  SET_ADDRESS_ACTION,
  TAILSCALE_CONSOLE_MARK,
  TAILSCALE_SETUP_STEPS,
  bridgeLine,
  funnelCommand,
  providerKindLine,
  publishState,
  type ProviderAppId,
} from "./settings";
import styles from "./SettingsPage.module.css";

/**
 * The irreducible setup Postern cannot do for the user (ADR 0035 §D9), stated where they decide.
 *
 * **Funnel is one of "these", in the same breath as the account and the certificates** (#118). It
 * used to arrive in a separate sentence after them — "Then publish the port with Tailscale Funnel
 * on 443" — which reads as a step this flow performs once the others are done. It is not: it is the
 * fourth thing the user does in Tailscale's own console, and the one that actually carries the
 * internet to the gate. Moving it out of the row title (see `PUBLIC_ADDRESS_ROW_TITLE`) is only
 * half the fix; the other half is that it lands HERE, among its peers, and not nowhere.
 */
const TAILSCALE_NOTE =
  "Postern cannot do these for you: create a Tailscale account, sign this machine into it, turn on MagicDNS and HTTPS certificates in Tailscale's own admin console, and publish this port with Funnel on 443. MagicDNS and the certificates are tailnet-wide settings only you can change, and Funnel is what actually carries the internet to your gate. Postern records the address and serves the bridge on it; it runs no Tailscale command and has no tailnet identity of its own.";

/** BYO-app configured status — served today (oauth/plaid app routes). The secret is never returned. */
function useOAuthAppStatus(provider: OAuthProvider) {
  return useQuery({
    queryKey: ["settings", "oauthApp", provider],
    queryFn: () => api.oauthAppStatus(provider),
  });
}
function usePlaidAppStatus() {
  return useQuery({ queryKey: ["settings", "plaidApp"], queryFn: () => api.plaidAppStatus() });
}

/** The status word for a provider app (served): configured / not configured / reading. */
function statusOf(configured: boolean | undefined): { word: string; ok: boolean } {
  if (configured === undefined) return { word: "reading…", ok: false };
  return configured ? { word: "configured", ok: true } : { word: "not configured", ok: false };
}

/**
 * The gate's own MCP address — served, or served as an absence.
 *
 * Never a build-time constant: the MCP edge is a separate server on its own port and the Console is
 * in no position to guess it. A module constant used to live in `api/client.ts` and was wrong the moment the
 * port moved and a flat lie when the MCP edge was not running at all.
 *
 * Three outcomes, not two (§Decision 7): still asking, the gateway did not answer, and the gateway
 * answered. Only the third one may state anything about the box — `NO_MCP_ENDPOINT` ends in "Set
 * MCP_HTTP_PORT on the box and restart it", and issuing that because a fetch failed would tell an
 * operator to go change a machine that is working.
 */
function LocalEndpointCard(): JSX.Element {
  const exposure = useExposure();
  if (exposure.isPending) {
    return (
      <div className={styles.gateCard}>
        <div className={styles.gateCardLabel}>MCP endpoint</div>
        <Skeleton width="80%" />
      </div>
    );
  }
  const failed = exposure.isError || exposure.data == null;
  const endpoint = exposure.data?.localEndpoint ?? null;
  return (
    <div className={styles.gateCard}>
      {!failed && endpoint != null ? (
        <Copyable label="MCP endpoint" value={endpoint} mono />
      ) : (
        <>
          <div className={styles.gateCardLabel}>MCP endpoint</div>
          <div className={styles.notServed}>{failed ? EXPOSURE_UNANSWERED : NO_MCP_ENDPOINT}</div>
        </>
      )}
    </div>
  );
}

/**
 * The setup Postern cannot perform, written so a stranger can follow it (#119).
 *
 * The row shipped with a text field and no path to filling it: the address a user must type does
 * not exist until five things are true in Tailscale, and Postern can see none of them (ADR 0035
 * §D9). `TAILSCALE_NOTE` states the boundary — what this flow will not do for you — and this is its
 * concrete half: the five in order, then where the hostname comes from, then the one command.
 *
 * **Where it is drawn is part of the design.** It appears in exactly two situations: while the user
 * is filling in the field, and when the row has evidence that nothing has arrived — a diagnosis
 * carrying its own remedy, rather than a permanent block of instructions on a row that is working.
 * It is never a badge, a callout or a nudge; remote access is a plain row by law (§D2).
 */
function RemoteAccessSetup({ port }: { port: string | null }): JSX.Element {
  const headingId = useId();
  return (
    <div className={styles.setup}>
      <div className={styles.setupHead} id={headingId}>
        {SETUP_HEADING}
      </div>
      <ol className={styles.setupSteps} aria-labelledby={headingId}>
        {TAILSCALE_SETUP_STEPS.map((step) => (
          <li key={step.text} className={styles.setupStep}>
            {step.text}
            {step.code != null ? <code className={styles.setupCode}>{step.code}</code> : null}
            {step.inTailscaleConsole ? (
              <span className={styles.stepMark}>{TAILSCALE_CONSOLE_MARK}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className={styles.setupNote}>{SETUP_SILENT_PAIR}</p>

      <div className={styles.setupBlock}>
        <div className={styles.setupBlockLabel}>{SETUP_HOSTNAME_LABEL}</div>
        <Copyable value={SETUP_HOSTNAME_CODE} mono />
        <p className={styles.setupNote}>{SETUP_HOSTNAME}</p>
      </div>

      <div className={styles.setupBlock}>
        <div className={styles.setupBlockLabel}>{SETUP_COMMAND_LABEL}</div>
        {/* The port is the SERVED one (`localMcpPort`), never a build-time guess: pointing Funnel at
            the wrong port is not a typo, it is publishing the wrong server. */}
        <Copyable value={funnelCommand(port)} mono />
        <p className={styles.setupNote}>{SETUP_COMMAND_NOTE}</p>
      </div>

      <p className={styles.setupNote}>{SETUP_WHY_443}</p>
    </div>
  );
}

/** The published-route disclosure, rendered FROM THE SERVED ARRAY — never a hardcoded list. A
 *  bridge route that ships without a descriptor must not be able to reach the internet unannounced. */
function PublishedRoutes({ routes }: { routes: BridgeRouteDescriptor[] }): JSX.Element {
  return (
    <div className={styles.disclosure}>
      <div className={styles.disclosureHead}>What a stranger can reach</div>
      <ul className={styles.doorList}>
        {routes.map((r) => (
          <li key={`${r.methods.join(" ")} ${r.path}`} className={styles.door}>
            <code className={styles.doorPath}>
              {r.methods.join(" ")} {r.path}
            </code>
            <span className={styles.doorWhy}>{routeSentence(r.auth)}</span>
          </li>
        ))}
      </ul>
      <p className={styles.disclosureFoot}>
        Your Console, your connections and your keys are on a different port and are never published.
      </p>
    </div>
  );
}

/**
 * Remote access — the tailnet row (still degraded), the public-address row (live), and the bridge row
 * (which reads the SAME status, so the two can never disagree about whether the gate is exposed).
 */
function RemoteAccessSection(): JSX.Element {
  const toast = useToast();
  const exposure = useExposure();
  const invalidateExposure = useInvalidateExposure();
  const urlFieldId = useId();

  const [enabling, setEnabling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const s = exposure.data;
  const state = s ? publishState(s) : null;
  // The gateway did not ANSWER — a different fact from any answer it could have given, and the one
  // this panel must never turn into a claim about the gate (§Decision 7).
  const failed = exposure.isError || (!exposure.isPending && s == null);

  // What has actually arrived here (#119). Read, never computed: `reachEvidence` is the one
  // derivation and `REACH_NOTE` the one wording, so this row cannot start disagreeing with itself
  // about a fact whose whole value is that it is not a guess. `unknown` draws nothing at all.
  const evidence = reachEvidence(s);
  const reachNote = REACH_NOTE[evidence];
  // Evidence that nothing is arriving is the moment the instructions are worth reading, so the
  // diagnosis carries them. Otherwise they appear only while the field is open (§119) — a working
  // gate does not need a permanent wall of setup on its row.
  const showSetup = enabling || evidence === "nothing_yet" || evidence === "reached_elsewhere";

  async function onPublish() {
    const publicUrl = draft.trim();
    if (publicUrl.length === 0) {
      setFormError("Enter the https address your gate is published at.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      // `acknowledged: true` is the recorded consent. The gateway enforces the literal `true`
      // server-side as well, so a bug on this page can never publish a gate without it.
      await api.setExposure({ publicUrl, acknowledged: true });
      invalidateExposure();
      setEnabling(false);
      setDraft("");
      toast.show({ message: "Saved — restart the gateway to start publishing.", tone: "ok" });
    } catch (e) {
      // The gateway is the ONE validator: its refusal is shown verbatim rather than paraphrased.
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    setBusy(true);
    try {
      await api.clearExposure();
      // Reached ONLY on a 2xx. `api.clearExposure` rejects on every non-2xx, so the success toast
      // below is structurally conditional on the operation having actually succeeded — which is the
      // whole point: it used to fire for a DELETE that removed nothing on an env-published gate.
      invalidateExposure();
      setStopping(false);
      toast.show({ message: "Stopped — it stays reachable until the gateway restarts.", tone: "ok" });
    } catch (e) {
      // The gateway REFUSES this with a named 409 when the effective source is the environment: a
      // delete cannot achieve what the caller asked for, so it is not reported as one. Its own
      // words, verbatim — they name the variable and the box, which a paraphrase would lose. The
      // Console re-reads afterwards so the row redraws with `source: "env"` and a disabled Stop.
      const refused = e instanceof RestError && e.status === 409;
      if (refused) {
        setStopping(false);
        invalidateExposure();
      }
      toast.show({
        message: refused ? (e as Error).message : `Couldn't stop — ${(e as Error).message}`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.section}>
      <SectionRule label="Remote access" gloss="tailnet-private by default · public is opt-in" />
      <div className={styles.rows}>
        {/* Row 1 — still genuinely unknowable: Postern issues no `tailscale` command (§D9). */}
        <div className={styles.row}>
          <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
            <div className={styles.rowTitle}>Tailnet · Tailscale serve</div>
            <div className={styles.rowSub}>
              Your own devices reach the gate privately. The admin surface is never on the tailnet.
            </div>
          </div>
          <span className={styles.notServed}>{NOT_SERVED.remoteAccess}</span>
        </div>

        {/* Row 2 — the live control. A plain row among the others, by law (§D2).
            Its subject is the ADDRESS this gateway answers on, which is the only part of remote
            access Postern owns (#118). The mechanism that carries the internet to that address is
            named where the user acts on it: as a prerequisite in `TAILSCALE_NOTE`, and as the
            unknowable below. */}
        <div className={styles.rowGroup}>
          <div className={`${styles.row} ${styles.rowFlush}`}>
            <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
              <div className={styles.rowTitle}>{PUBLIC_ADDRESS_ROW_TITLE}</div>
              <div className={styles.rowSub}>
                Where hosted clients (claude.ai, ChatGPT) reach this gate, on port 443 — the one
                path that leaves your tailnet. Postern records the address and answers on it.
              </div>
              {/* The honest unknown, in the drawn shape the row above already uses: a reason in the
                  "not served" register, never a synthesised status. It sits UNDER the sub-line
                  rather than in the right-hand slot only because that slot carries this row's
                  served state — the register is the same one, deliberately. And it is on the ROW,
                  not in an expansion, because a first-run reader decides here, before opening
                  anything. */}
              <div className={`${styles.notServed} ${styles.rowCaption}`}>
                {NOT_SERVED.funnelReach}
              </div>
            </div>

            {exposure.isPending ? (
              <span className={styles.statusChip}>
                <Skeleton width="110px" height={14} />
              </span>
            ) : failed || state == null ? (
              <span className={styles.notServed}>{EXPOSURE_UNANSWERED}</span>
            ) : (
              <span className={styles.statusChip}>
                <span
                  className={`${styles.statusDot} ${
                    state.tone === "ok"
                      ? styles.dotOk
                      : state.tone === "attention"
                        ? styles.dotAttention
                        : styles.dotIdle
                  }`}
                  aria-hidden="true"
                />
                <span className={styles.statusWord}>{state.word}</span>
              </span>
            )}

            {/* Stop is drawn whenever stopping is the operation this row is ABOUT — including when
                the gateway would refuse it, in which case it is drawn DISABLED with its reason
                (§Decision 5). An enabled control whose only outcome is a refusal is the defect. */}
            {state != null && (state.canStop || state.stopBlocked != null) ? (
              <button
                type="button"
                className={styles.btn}
                disabled={!state.canStop || busy || stopping}
                title={state.stopBlocked ?? undefined}
                onClick={() => {
                  setEnabling(false);
                  setStopping(true);
                }}
              >
                Stop publishing…
              </button>
            ) : (
              <button
                type="button"
                className={styles.btn}
                disabled={!state?.canEnable || enabling}
                onClick={() => {
                  setStopping(false);
                  setEnabling(true);
                }}
              >
                {SET_ADDRESS_ACTION}
              </button>
            )}
          </div>

          {/* The served truth about this gate: the address, and the one sentence that explains any
              gap between what is saved and what is actually being answered. */}
          {state != null && (state.address != null || state.sentence != null) ? (
            <div className={styles.rowPanel}>
              {state.address != null ? (
                <Copyable label={state.addressLabel} value={state.address} mono />
              ) : null}
              {state.sentence != null ? (
                <p className={styles.publishSentence} data-tone={state.tone}>
                  {state.sentence}
                </p>
              ) : null}
              {/* The other half of the #120 split. The sentence above says what this process is
                  DOING — a fact it holds. This says what has actually ARRIVED — the only evidence
                  it holds about the way in. Neither claims the internet can reach this gate, which
                  is Funnel's business and is disclaimed on the row itself. */}
              {reachNote != null ? (
                <p className={styles.observation} data-evidence={evidence}>
                  {reachNote}
                </p>
              ) : null}
              {/* The recorded consent behind the configured address (§Decision 1 puts it on the
                  wire). Rendered through the ONE clock, never re-derived here. `ago` answers
                  "never" for anything it cannot parse, and "consent recorded never" is a sentence
                  worse than no sentence — so that case renders nothing at all. */}
              {state.consentedAt != null && ago(state.consentedAt) !== "never" ? (
                <p className={styles.notServed}>
                  Consent for this address was recorded {ago(state.consentedAt)}.
                </p>
              ) : null}
            </div>
          ) : null}

          {enabling ? (
            <div className={styles.rowPanel}>
              <label className={styles.publishLabel} htmlFor={urlFieldId}>
                Your gate’s public address
              </label>
              <input
                id={urlFieldId}
                className={styles.publishInput}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={PUBLIC_URL_PLACEHOLDER}
                autoComplete="off"
                spellCheck={false}
              />
              {/* The shape, stated before the paste (#126) — it sits in the slot the gateway's own
                  refusal uses, so "what this wants" and "why that was refused" read as one line of
                  the same conversation. Same register as the row's other plain facts: no new colour,
                  no callout (ADR 0035 §D2). */}
              <p className={styles.publishSentence}>{PUBLIC_URL_SHAPE_NOTE}</p>
              {formError != null ? <FieldError kind="shape" message={formError} /> : null}
              <ConfirmBar
                verb="Publish this gate"
                consequence="Publish this gate to the public internet?"
                blastRadius={
                  <span className={styles.consentBlock}>
                    <span className={styles.consentLine}>
                      Anyone on the internet will be able to reach this address. That is the point of
                      publishing it, and it is also the whole of the risk.
                    </span>
                    <span className={styles.consentLine}>
                      Your machine’s name goes into a public certificate ledger the moment tailnet
                      HTTPS issues its certificate. Assume strangers find this address within hours —
                      hiding the name protects nothing.
                    </span>
                    <span className={styles.consentLine}>
                      An agent key is then the only thing between a stranger and your data. Give a
                      hosted client a key that expires.
                    </span>
                  </span>
                }
                onConfirm={() => void onPublish()}
                onCancel={() => {
                  setEnabling(false);
                  setFormError(null);
                }}
                busy={busy}
              />
              <p className={styles.tailscaleNote}>{TAILSCALE_NOTE}</p>
            </div>
          ) : null}

          {/* One instance, two reasons to draw it — see `RemoteAccessSetup`. Rendered outside the
              enable panel so it does not push the consent bar down the page, and so the diagnosis
              case (which has no panel) can reach it without a second copy on screen. */}
          {showSetup ? (
            <div className={styles.rowPanel}>
              <RemoteAccessSetup port={localMcpPort(s)} />
            </div>
          ) : null}

          {stopping ? (
            <div className={styles.rowPanel}>
              <ConfirmBar
                verb="Stop publishing"
                consequence="Stop publishing this gate?"
                blastRadius={
                  <span className={styles.consentBlock}>
                    <span className={styles.consentLine}>
                      The address is removed from this gateway’s settings, and any hosted client
                      connected through it stops working.
                    </span>
                    <span className={styles.consentLine}>
                      It stays reachable on the internet until you restart the gateway — stopping is
                      not instant. After that restart every bridge path answers 404 and the edge is
                      bearer-only again.
                    </span>
                  </span>
                }
                onConfirm={() => void onStop()}
                onCancel={() => setStopping(false)}
                busy={busy}
              />
            </div>
          ) : null}

          {state?.showDisclosure && s != null ? (
            <div className={styles.rowPanel}>
              <PublishedRoutes routes={s.publishedRoutes} />
            </div>
          ) : null}
        </div>

        {/* Row 3 — the bridge. Reads the SAME status object; it is no longer a second source of
            truth, and it says On only when this process actually mounted the bridge. */}
        <div className={`${styles.row} ${styles.rowLast}`}>
          <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
            <div className={styles.rowTitle}>OAuth bridge</div>
            <div className={styles.rowSub}>
              Wraps agent keys for strict hosted clients. It is on exactly when this gate is
              published, and off otherwise — there is no separate switch.
            </div>
          </div>
          {exposure.isPending ? (
            <Skeleton width="180px" height={14} />
          ) : !failed && s != null ? (
            <span className={styles.statusWord}>{bridgeLine(s)}</span>
          ) : (
            <span className={styles.notServed}>{EXPOSURE_UNANSWERED}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const toast = useToast();
  const qc = useQueryClient();

  const ms = useOAuthAppStatus("microsoft");
  const google = useOAuthAppStatus("google");
  const whoop = useOAuthAppStatus("whoop");
  const plaid = usePlaidAppStatus();

  const statusById: Record<ProviderAppId, { configured: boolean | undefined; env?: "sandbox" | "production" }> = {
    microsoft: { configured: ms.data?.configured },
    google: { configured: google.data?.configured },
    whoop: { configured: whoop.data?.configured },
    plaid: { configured: plaid.data?.configured, env: plaid.data?.env },
  };

  const [clearing, setClearing] = useState<ProviderAppId | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      await downloadExport();
      toast.show({ message: "Export downloaded.", tone: "ok" });
    } catch (e) {
      toast.show({ message: `Export failed — ${(e as Error).message}`, tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  async function onClearConfirm(id: ProviderAppId) {
    setClearBusy(true);
    try {
      if (id === "plaid") {
        await api.deletePlaidApp();
        void qc.invalidateQueries({ queryKey: ["settings", "plaidApp"] });
      } else {
        await api.deleteOauthApp(id);
        void qc.invalidateQueries({ queryKey: ["settings", "oauthApp", id] });
      }
      toast.show({ message: `${PROVIDER_APPS.find((p) => p.id === id)?.name} app cleared.`, tone: "ok" });
      setClearing(null);
    } catch (e) {
      toast.show({ message: `Clear failed — ${(e as Error).message}`, tone: "error" });
    } finally {
      setClearBusy(false);
    }
  }

  const clearingName = clearing ? PROVIDER_APPS.find((p) => p.id === clearing)?.name : undefined;

  return (
    <div className={styles.page}>
      <Masthead
        kicker="The gate"
        verdict="Settings"
        sub="The gate itself — its address, the apps it speaks through, and the levers over your own data. All of it operator-only, over loopback."
      />

      {/* ── This gate ──────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionRule label="This gate" gloss="single-tenant · loopback-only" />
        <div className={styles.gateCards}>
          <LocalEndpointCard />
          <div className={styles.gateCard}>
            <div className={styles.gateCardLabel}>Apple Health ingest</div>
            <div className={styles.notServed}>
              {NOT_SERVED.appleHealthIngest}{" "}
              <Link to="/sources" className={styles.linkAction}>
                Open Sources →
              </Link>
            </div>
          </div>
        </div>
        <div className={styles.gateNote}>
          <span className={styles.gateDot} aria-hidden="true" />
          <span className={styles.gateNoteText}>{NOT_SERVED.backupStatus}</span>
          <span className={styles.gateNoteAside}>
            — only the master key and Apple Health are irreplaceable; everything else re-syncs from the
            providers.
          </span>
        </div>
      </div>

      {/* ── Remote access (served: /api/exposure) ──────────────────────── */}
      <RemoteAccessSection />

      {/* ── Provider apps (served) ─────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionRule label="Provider apps" gloss="your own OAuth clients · secrets sealed in the vault" />
        <div className={styles.rows}>
          {PROVIDER_APPS.map((p, i) => {
            const st = statusOf(statusById[p.id].configured);
            const isLast = i === PROVIDER_APPS.length - 1;
            return (
              <div key={p.id} className={isLast ? `${styles.row} ${styles.rowLast}` : styles.row}>
                <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
                  <div className={styles.rowTitle}>{p.name}</div>
                  <div className={styles.rowMono}>{providerKindLine(p.id, statusById[p.id].env)}</div>
                </div>
                <span className={styles.statusChip}>
                  <span
                    className={`${styles.statusDot} ${st.ok ? styles.dotOk : styles.dotIdle}`}
                    aria-hidden="true"
                  />
                  <span className={styles.statusWord}>{st.word}</span>
                </span>
                <span className={styles.rowActions}>
                  <Link to={`/connect/${p.id}`} className={styles.linkAction}>
                    Edit
                  </Link>
                  <span className={styles.actionSep} aria-hidden="true">
                    ·
                  </span>
                  <button
                    type="button"
                    className={styles.linkAction}
                    disabled={!st.ok}
                    onClick={() => setClearing(p.id)}
                  >
                    Clear
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {clearing ? (
          <div className={styles.confirmSlot}>
            <ConfirmBar
              verb={`Clear ${clearingName}`}
              consequence={`Clear ${clearingName}'s configured app?`}
              blastRadius={`Removes the client id and the sealed secret. Connections that use ${clearingName} stop refreshing until you configure the app again.`}
              onConfirm={() => onClearConfirm(clearing)}
              onCancel={() => setClearing(null)}
              busy={clearBusy}
            />
          </div>
        ) : null}
      </div>

      {/* ── Your data ──────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionRule label="Your data" />
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
              <div className={styles.rowTitle}>Export everything</div>
              <div className={styles.rowSub}>
                One JSON bundle of every sector, raw included. Loopback only — there is no import;
                restore is the backup.
              </div>
            </div>
            <button type="button" className={styles.btn} onClick={onExport} disabled={exporting}>
              {exporting ? "Exporting…" : "Export"}
            </button>
          </div>
          <div className={styles.row}>
            <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
              <div className={styles.rowTitle}>Back up now</div>
              <div className={styles.rowSub}>
                The master key plus a pg_dump tarball. {NOT_SERVED.backupStatus}
              </div>
            </div>
            <button type="button" className={styles.btn} disabled>
              Back up
            </button>
          </div>
          <div className={`${styles.row} ${styles.rowLast}`}>
            <div className={`${styles.rowMain} ${styles.rowMainGrow}`}>
              <div className={styles.rowTitle}>Erase data</div>
              <div className={styles.rowSub}>
                Hard-delete by scope — one connection, a sector, or everything. Export-first, typed
                confirmation.
              </div>
            </div>
            <Link to="/settings/erase" className={`${styles.btn} ${styles.btnSeal}`}>
              Erase…
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
