// Connection detail — ONE template, a mode-adaptive middle (build-notes §1). The middle is switched
// on the SERVED sync mode + transport, never on custody (which is not on the wire): poll+unbounded →
// cadence + recency window; poll+Plaid → read-only group cadence + consent; push+stream → live-stream
// controls (no cadence); push+webhook → ingest endpoint + Rotate (no Sync now). Freshness is rendered
// from `freshnessDisplay`, never recomputed. The broken state (§1.5) raises the kit AttentionBanner
// and suppresses the section's own reconnect affordance.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Masthead, SectionRule } from "../../shell";
import { AttentionBanner, ConfirmBar, CoverageStrip, Copyable, Skeleton, useToast } from "../../kit";
import { InstitutionMark, ProviderTile } from "../../marks";
import {
  useConnector,
  useConnectors,
  useFinanceBanks,
  useInvalidateConnectors,
  useInvalidateData,
} from "../../api/hooks";
import { api } from "../../api/client";
import { freshnessDisplay, type FreshnessDisplay, type Tone } from "../../api/freshness";
import { ago, hence } from "../../api/format";
import type { ConnectorDetail, ConnectorStatus, Sector } from "../../api/types";
import {
  cadencePresets,
  coverageNoun,
  effectiveIntervalSec,
  formatInterval,
  isUnhealthy,
  providerDisplay,
  providerTileId,
  SECTOR_LABEL,
} from "./model";
import { liveConnectors } from "./grain";
import { useConnectorCredentials } from "./credentials";
import styles from "./ConnectionDetail.module.css";

/** The reachable ingest host (#27). The Console runs on loopback :8787 and does NOT know the
 *  operator's tailnet serve address (:8443, ADR 0024) — it is deployment config, not served on the
 *  wire — so we take it from a build-time var when present and otherwise degrade to the path + an
 *  honest note that the host is the tailnet address, never the loopback console. */
const INGEST_BASE: string | undefined = import.meta.env.VITE_INGEST_URL;

/** The Home Assistant connector's SERVED provider value (`src/connectors/homeassistant.ts`, passed
 *  through unmodified by `core/lifecycle.ts`). Exported so a test can pin it against the connector
 *  source rather than against a fixture — the fixtures said `homeassistant` too, which is how four
 *  Console branches keyed on the wrong string stayed green while the HA revoke row was invisible on
 *  the real box. */
export const HOME_ASSISTANT_PROVIDER = "home_assistant";

/** True for a Home Assistant connection. Accepts the legacy unhyphenated spelling as well — the
 *  same alias `sources/model.ts` already carries — so no surface can go dark on a near-miss again. */
function isHomeAssistant(provider: string): boolean {
  return provider === HOME_ASSISTANT_PROVIDER || provider === "homeassistant";
}

type MiddleMode = "poll" | "plaid" | "stream" | "webhook";

function middleMode(c: ConnectorDetail): MiddleMode {
  if (c.policy_mode === "push") return c.push_kind === "webhook" ? "webhook" : "stream";
  if (c.provider === "plaid") return "plaid";
  return "poll";
}

// ── the freshness status pill (dot + word + caption), from the ONE derivation ──

const TONE_CLASS: Record<Tone, string> = {
  ok: styles.toneOk,
  attention: styles.toneAttention,
  error: styles.toneError,
  idle: styles.toneIdle,
};

function StatusPill({ d }: { d: FreshnessDisplay }): JSX.Element {
  // Grammar (ADR 0023): there is NO healthy word-badge. `ok` renders the dot + the "Last synced …"
  // caption inline; an exception renders the served word + its caption. The design draws bespoke
  // words (Flowing/Streaming/Receiving) here — reported as a design/grammar conflict; we render the
  // served vocabulary, never a healthy badge.
  const alarm = d.tone === "error" || d.tone === "attention";
  return (
    <div className={styles.status}>
      <div className={styles.statusLine}>
        <span className={`${styles.statusDot} ${TONE_CLASS[d.tone]}`} aria-hidden="true" />
        <span className={`${styles.statusWord} ${alarm ? styles.statusWordAlarm : ""}`}>
          {d.label ?? d.caption ?? "Idle"}
        </span>
      </div>
      {d.label && d.caption ? (
        <div className={`${styles.statusCaption} ${alarm ? styles.statusCaptionAlarm : ""}`}>
          {d.caption}
        </div>
      ) : null}
    </div>
  );
}

// ── chips ──

function Chip({
  label,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.chip} ${selected ? styles.chipOn : ""}`}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

// ── the recency-window presets (the cadence ladder lives in model.ts — #96 §8) ──

const WINDOW_PRESETS = [
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 365, label: "12 months" },
];

// ── the page ──

export function ConnectionDetail(): JSX.Element {
  const { connectionId = "" } = useParams();
  const detailQ = useConnector(connectionId);
  const allQ = useConnectors();
  const banksQ = useFinanceBanks();
  // Siblings are "connections sharing THIS credential" — proven from the detail wire, not the
  // provider string (BLOCK 1). The list wire has no credentialId, so we resolve each connection's
  // credentialId and match. Called before the early returns so it is unconditional (hooks rule).
  const creds = useConnectorCredentials(allQ.data);

  if (detailQ.isError) {
    return (
      <div className={styles.notice}>
        This connection could not be read.{" "}
        {detailQ.error instanceof Error ? detailQ.error.message : ""}
      </div>
    );
  }
  if (detailQ.isLoading || !detailQ.data) {
    return (
      <div className={styles.page}>
        <Skeleton lines={3} height={22} />
        <Skeleton lines={4} height={18} />
      </div>
    );
  }

  const c = detailQ.data;
  // A credential is "shared" only when ANOTHER connector resolves to the SAME credentialId. Plaid
  // Items each have their own credential (§12.1), so a Plaid connection never has siblings here —
  // matching on the id, not the provider, is exactly what makes that true. `creds.credentialIdOf`
  // returns undefined for Plaid and for unresolved details; neither equals a real credentialId.
  // `liveConnectors` first (#96 §5): a REVOKED sibling would overstate the shared-credential blast
  // radius in `sharedCredText` / `revokeDesc` — a false claim on a destructive confirm.
  const siblings = liveConnectors(allQ.data ?? []).filter(
    (x) =>
      x.connectionId !== c.connectionId &&
      creds.credentialIdOf(x.connectionId) === c.credentialId,
  );
  const bank = c.provider === "plaid"
    ? (banksQ.data ?? []).find((b) => b.providers.some((p) => p.connectionId === c.connectionId))
    : undefined;

  return (
    <DetailBody
      c={c}
      siblings={siblings}
      siblingsResolved={creds.resolved}
      institution={bank?.institution ?? null}
      // AS SERVED, verbatim: `undefined` where no card matched or the gateway predates the field,
      // which the mark treats as "no domain" — never as a domain (api/types.ts).
      orgDomain={bank?.orgDomain}
      mask={bank?.mask ?? null}
    />
  );
}

function DetailBody({
  c,
  siblings,
  siblingsResolved,
  institution,
  orgDomain,
  mask,
}: {
  c: ConnectorDetail;
  siblings: ConnectorStatus[];
  siblingsResolved: boolean;
  institution: string | null;
  /** The matched bank card's `orgDomain` as served — the mark's stable key (institutions.ts rule 1). */
  orgDomain: string | null | undefined;
  mask: string | null;
}): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidateConnectors = useInvalidateConnectors();
  const invalidateData = useInvalidateData();
  const d = freshnessDisplay(c);
  // `disconnected` is the SERVED state of a REVOKED connector (core/freshness.ts) — the credential is
  // gone from the vault. It is broken, but it is not "broken and will recover": nothing here resumes
  // on its own, ever. Splitting it out is what stops the banner and the controls contradicting each
  // other (#96 §6).
  const disconnected = d.state === "disconnected";
  const broken = isUnhealthy(d) || disconnected;
  const mode = middleMode(c);
  // "Shared" is a claim about the blast radius, so it must be PROVEN, never assumed while the sibling
  // credentialIds are still resolving. An unresolved sibling set could understate what a revoke
  // removes, so the revoke path stays disabled until every sibling detail has settled.
  const shared = siblingsResolved && siblings.length > 0;
  const sectorLabel = SECTOR_LABEL[c.sector as Sector] ?? c.sector;
  const providerName = providerDisplay(c.provider);
  const title = mode === "plaid" && institution ? `${institution} · ${sectorLabel}` : `${providerName} · ${sectorLabel}`;
  const crumbMid = mode === "plaid" ? "Plaid" : providerName;
  const crumbLast = mode === "plaid" && institution ? institution : sectorLabel;

  const [confirm, setConfirm] = useState<null | "disconnect" | "revoke">(null);
  const [revealSecret, setRevealSecret] = useState<string | null>(null);

  const refresh = (touchData = false) => {
    invalidateConnectors(c.connectionId);
    if (touchData) invalidateData(c.sector);
  };

  const syncMutation = useMutation({
    mutationFn: () => api.syncNow(c.connectionId),
    onSuccess: (r) => {
      refresh(true);
      toast.show(
        r.ok === false || r.error
          ? { tone: "error", message: r.error ?? "Sync could not complete." }
          : { tone: "ok", message: `Synced — ${r.upserted ?? 0} updated.` },
      );
    },
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Sync failed." }),
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      if (c.status === "paused") await api.resume(c.connectionId);
      else await api.pause(c.connectionId);
    },
    onSuccess: () => refresh(),
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Failed." }),
  });

  const intervalMutation = useMutation({
    mutationFn: (sec: number | null) => api.setSyncInterval(c.connectionId, sec),
    onSuccess: () => refresh(),
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Cadence rejected." }),
  });

  const windowMutation = useMutation({
    mutationFn: (days: number | null) => api.setSyncWindow(c.connectionId, days),
    onSuccess: () => refresh(true),
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Window rejected." }),
  });

  const relinkMutation = useMutation({
    mutationFn: () => api.plaidRelink(c.connectionId),
    onSuccess: (r) => {
      window.open(r.hostedLinkUrl, "_blank", "noopener,noreferrer");
      toast.show({ tone: "ok", message: "Opened Plaid's re-approval page in a new tab." });
    },
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Could not start Plaid re-approval." }),
  });

  const rotateMutation = useMutation({
    mutationFn: () => api.mintIngestSecret(c.connectionId),
    onSuccess: (r) => {
      setRevealSecret(r.secret);
      refresh();
      toast.show({ tone: "ok", message: "New ingest secret minted — copy it now; it is shown once." });
    },
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Rotate failed." }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.disconnectConnection(c.connectionId, c.connectionId),
    onSuccess: () => {
      setConfirm(null);
      invalidateConnectors();
      invalidateData(c.sector);
      toast.show({ tone: "ok", message: "Disconnected." });
      navigate("/sources");
    },
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Disconnect failed." }),
  });

  const revokeMutation = useMutation({
    mutationFn: () => api.revokeCredential(c.credentialId),
    onSuccess: () => {
      setConfirm(null);
      invalidateConnectors();
      invalidateData();
      toast.show({ tone: "ok", message: `Revoked the ${providerName} credential.` });
      navigate("/sources");
    },
    onError: (e) => toast.show({ tone: "error", message: e instanceof Error ? e.message : "Revoke failed." }),
  });

  // Third lifecycle row (§1.3): shown when the credential is shared, OR for Home Assistant's
  // re-pasteable token. Plaid / SimpleFIN / Whoop / Apple Health single-sector connections rely on
  // Disconnect (which removes the last credential too).
  // Never for an ALREADY-revoked credential: offering "Revoke" for a credential that is gone is the
  // same no-op-that-looks-like-a-failure as painting the row healthy (#96 §5/§6).
  const showRevokeRow = !disconnected && (shared || isHomeAssistant(c.provider));

  return (
    <div className={styles.page}>
      {/* breadcrumb */}
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link to="/sources" className={styles.crumbLink}>
          Sources
        </Link>
        <span className={styles.crumbSep} aria-hidden="true">→</span>
        <span className={styles.crumbMid}>{crumbMid}</span>
        <span className={styles.crumbSep} aria-hidden="true">→</span>
        <span className={styles.crumbLast}>{crumbLast}</span>
      </nav>

      {/* masthead — the frozen shell primitive, with a mark-led title as its verdict node */}
      <Masthead
        kicker="Connection"
        verdict={
          <span className={styles.titleRow}>
            <span className={styles.markBox}>
              {mode === "plaid" && institution ? (
                <InstitutionMark institution={institution} orgDomain={orgDomain} size={24} />
              ) : (
                <ProviderMark provider={c.provider} />
              )}
            </span>
            <span className={styles.title}>{title}</span>
          </span>
        }
        sub={detailSub(c, mask)}
        right={<StatusPill d={d} />}
      />

      {/* the broken banner (§1.5) — the banner owns the action; the section's copy is suppressed */}
      {broken ? (
        <AttentionBanner
          cause={brokenCause(c, providerName, sectorLabel, disconnected)}
          detail={d.caption || null}
          action={
            // A removed connection's credential is gone from the vault, so Plaid's hosted update
            // flow has nothing to update — offering it would be an action that cannot work.
            c.provider === "plaid" && !disconnected
              ? { label: "Reconnect at Plaid", onAct: () => relinkMutation.mutate() }
              : null
          }
          note={
            disconnected
              ? `Nothing will sync here again. Re-add ${providerName} from Add a source to start a new connection.`
              : c.provider === "plaid"
                ? null
                : // #106: "isn't served to the Console yet" is a fact about our wire, told to someone
                  // who only wants their source working again. The reason survives — Postern cannot
                  // tell which sign-in this source used, so it cannot start the right one — but in
                  // words about the source, and the remedy leads.
                  `Re-add ${providerName} from Add a source. Postern can’t tell which sign-in this source used, so it can’t reconnect it for you.`
          }
        />
      ) : shared ? (
        <div className={styles.sharedCred}>
          <div className={styles.sharedCredBody}>
            <div className={styles.sharedCredLabel}>Shared credential</div>
            <div className={styles.sharedCredText}>{sharedCredText(c, siblings)}</div>
          </div>
        </div>
      ) : null}

      {/* the mode-adaptive middle */}
      {mode === "poll" ? (
        <PollMiddle
          c={c}
          broken={broken}
          disconnected={disconnected}
          onInterval={(sec) => intervalMutation.mutate(sec)}
          onWindow={(days) => windowMutation.mutate(days)}
          onSync={() => syncMutation.mutate()}
          onPause={() => pauseMutation.mutate()}
          busy={syncMutation.isPending || pauseMutation.isPending}
        />
      ) : mode === "plaid" ? (
        <PlaidMiddle
          c={c}
          broken={broken}
          disconnected={disconnected}
          onReconnect={() => relinkMutation.mutate()}
          onSync={() => syncMutation.mutate()}
          onPause={() => pauseMutation.mutate()}
          busy={syncMutation.isPending || pauseMutation.isPending}
        />
      ) : mode === "stream" ? (
        <StreamMiddle
          c={c}
          d={d}
          onResync={() => syncMutation.mutate()}
          onPause={() => pauseMutation.mutate()}
          busy={syncMutation.isPending || pauseMutation.isPending}
        />
      ) : (
        <DeliveryMiddle
          c={c}
          onRotate={() => rotateMutation.mutate()}
          onPause={() => pauseMutation.mutate()}
          revealSecret={revealSecret}
          busy={rotateMutation.isPending || pauseMutation.isPending}
        />
      )}

      {/* coverage strip */}
      <CoverageStrip items={coverageItems(c, d, broken, disconnected)} />

      {/* lifecycle */}
      <div>
        <SectionRule label="Lifecycle" />
        <div className={styles.lifecycle}>
          <div className={styles.lifeRow}>
            <div className={styles.lifeText}>
              <div className={styles.lifeTitle}>Export this connection</div>
              {/* #106: the facts are unchanged — whole-gateway, includes raw, only reachable from
                  this machine — said in the reader's terms rather than as three wire notes. */}
              <div className={styles.lifeDesc}>
                One JSON file of everything Postern has cached, raw records included. It covers your
                whole gate, not just this connection, and only this machine can download it.
              </div>
            </div>
            <button
              type="button"
              className={styles.btnOutline}
              onClick={() => void exportBundle(toast)}
            >
              Export
            </button>
          </div>
          <div className={styles.lifeDivider} aria-hidden="true" />
          <div className={styles.lifeRow}>
            <div className={styles.lifeText}>
              <div className={styles.lifeTitle}>Disconnect {sectorLabel}</div>
              <div className={styles.lifeDesc}>{disconnectDesc(c, siblings, disconnected)}</div>
            </div>
            <button type="button" className={styles.btnDanger} onClick={() => setConfirm("disconnect")}>
              Disconnect
            </button>
          </div>
          {showRevokeRow ? (
            <>
              <div className={styles.lifeDivider} aria-hidden="true" />
              <div className={styles.lifeRow}>
                <div className={styles.lifeText}>
                  <div className={styles.lifeTitle}>{revokeTitle(c, shared)}</div>
                  <div className={styles.lifeDesc}>{revokeDesc(c, siblings)}</div>
                  {!siblingsResolved ? (
                    <div className={styles.disabledReason}>
                      Checking which other connections share this credential before naming what a
                      revoke removes…
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.btnDangerFilled}
                  onClick={() => setConfirm("revoke")}
                  disabled={!siblingsResolved}
                  aria-disabled={siblingsResolved ? undefined : true}
                >
                  {revokeButton(c, siblings)}
                </button>
              </div>
            </>
          ) : null}
          <div className={styles.lifeFooter}>
            Every destructive action confirms with a typed, styled step — never a browser popup.
          </div>
        </div>
      </div>

      {confirm === "disconnect" ? (
        <div className={styles.confirmHost}>
          <ConfirmBar
            verb={`Disconnect ${sectorLabel}`}
            consequence={`Disconnect ${title}`}
            blastRadius={disconnectDesc(c, siblings, disconnected)}
            requireTyped="disconnect"
            busy={disconnectMutation.isPending}
            onConfirm={() => disconnectMutation.mutate()}
            onCancel={() => setConfirm(null)}
          />
        </div>
      ) : null}
      {confirm === "revoke" ? (
        <div className={styles.confirmHost}>
          <ConfirmBar
            verb={revokeButton(c, siblings)}
            consequence={revokeTitle(c, shared)}
            blastRadius={revokeDesc(c, siblings)}
            requireTyped={providerName}
            busy={revokeMutation.isPending}
            onConfirm={() => revokeMutation.mutate()}
            onCancel={() => setConfirm(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── the middles ──

function PollMiddle({
  c,
  broken,
  disconnected,
  onInterval,
  onWindow,
  onSync,
  onPause,
  busy,
}: {
  c: ConnectorDetail;
  broken: boolean;
  disconnected: boolean;
  onInterval: (sec: number) => void;
  onWindow: (days: number) => void;
  onSync: () => void;
  onPause: () => void;
  busy: boolean;
}): JSX.Element {
  const eff = effectiveIntervalSec(c);
  const presets = cadencePresets(c);
  const floorLabel = formatInterval(c.min_interval_sec) ?? null;
  const isMail = c.sector === "mail";
  return (
    <div>
      <SectionRule label="Controls" />
      <div className={styles.middle}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>Poll cadence</div>
          <div className={styles.chips}>
            {presets.map((p) => (
              <Chip
                key={p.sec}
                label={p.label}
                selected={eff === p.sec}
                onSelect={() => onInterval(p.sec)}
              />
            ))}
          </div>
          <div className={styles.gloss}>
            How often Postern re-syncs this connection.
            {floorLabel ? ` Minimum ${floorLabel} — a faster override is clamped to that floor.` : ""}
          </div>
        </div>

        {isMail ? (
          <div className={styles.field}>
            <div className={styles.fieldLabel}>Recency window</div>
            <div className={styles.chips}>
              {WINDOW_PRESETS.map((w) => (
                <Chip
                  key={w.days}
                  label={w.label}
                  selected={c.sync_window_days === w.days}
                  onSelect={() => onWindow(w.days)}
                />
              ))}
            </div>
            <div className={styles.gloss}>
              Envelopes newer than this stay cached; older mail is fetched live on demand.
            </div>
          </div>
        ) : null}

        <StateControls
          broken={broken}
          disconnected={disconnected}
          paused={c.status === "paused"}
          onSync={onSync}
          onPause={onPause}
          busy={busy}
        />
      </div>
    </div>
  );
}

function PlaidMiddle({
  c,
  broken,
  disconnected,
  onReconnect,
  onSync,
  onPause,
  busy,
}: {
  c: ConnectorDetail;
  broken: boolean;
  disconnected: boolean;
  onReconnect: () => void;
  onSync: () => void;
  onPause: () => void;
  busy: boolean;
}): JSX.Element {
  const iv = formatInterval(effectiveIntervalSec(c));
  return (
    <div>
      <SectionRule label="Controls" />
      <div className={styles.middle}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>Poll cadence</div>
          <div className={styles.readonlyCadence}>
            <span className={styles.readonlyValue}>{iv ? `Every ${iv}` : "Shared cadence"}</span>
            <span className={styles.readonlyNote}>— set once, for all Plaid banks</span>
            <Link to="/sources" className={styles.readonlyLink}>
              Change it on the Plaid group →
            </Link>
          </div>
          <div className={styles.gloss}>
            This bank is one of several behind a single Plaid app, and they share one cadence — so a
            bank you add tomorrow can&rsquo;t quietly drift onto a different schedule. Finance is
            read-only: Postern never writes to your bank.
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldLabel}>Consent</div>
          <div className={styles.gloss}>
            Linked through Plaid Link. Plaid consent renews about once a year — if it lapses,
            Reconnect runs Plaid&rsquo;s hosted update flow. No re-paste, no re-link from scratch.
          </div>
          {/* §1.5 rule 1: when the banner is showing it OWNS this action, so it is suppressed here. */}
          {broken ? null : (
            <div className={styles.buttons}>
              <button type="button" className={styles.btnSecondary} onClick={onReconnect}>
                Reconnect at Plaid
              </button>
            </div>
          )}
        </div>

        <StateControls
          broken={broken}
          disconnected={disconnected}
          paused={c.status === "paused"}
          onSync={onSync}
          onPause={onPause}
          busy={busy}
        />
      </div>
    </div>
  );
}

function StreamMiddle({
  c,
  d,
  onResync,
  onPause,
  busy,
}: {
  c: ConnectorDetail;
  d: FreshnessDisplay;
  onResync: () => void;
  onPause: () => void;
  busy: boolean;
}): JSX.Element {
  const connected = (c.freshness?.stream_state ?? null) === "connected" && d.state === "ok";
  return (
    <div>
      <SectionRule label="Live stream" />
      <div className={styles.middle}>
        <div className={styles.field}>
          <div className={styles.bigState}>
            {/* No healthy word-badge (ADR 0023, and this file's own StatusPill rule). A live stream
                already says so twice in the header — the wordless dot and the "Last synced" caption
                — and "Streaming · live" made it three. `Stream down` stays: an exception earns a
                word. The value is still derived from the SERVED `stream_state`, never from a clock
                comparison. (Operator ruling 2026-07-25.) */}
            {connected ? null : <span className={styles.bigStateWord}>Stream down</span>}
            <span className={`${styles.bigStateSub} ${isUnhealthy(d) ? styles.bigStateSubAlarm : ""}`}>
              {d.lastHeardAt ? `last event ${ago(d.lastHeardAt)}` : "no events yet"}
            </span>
          </div>
          <div className={styles.gloss}>
            Postern holds an open connection to your Home Assistant instance — state changes arrive
            the instant they happen. There is no cadence to tune, and no polling.
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldLabel}>State</div>
          <div className={styles.buttons}>
            {/* Reconnect depends on custody, which isn't served (#89) — drawn, disabled with reason. */}
            <button type="button" className={styles.btnSecondary} disabled aria-disabled="true">
              Reconnect
            </button>
            <button type="button" className={styles.btnPrimary} onClick={onResync} disabled={busy}>
              Re-sync snapshot
            </button>
            <button type="button" className={styles.btnSecondary} onClick={onPause} disabled={busy}>
              {c.status === "paused" ? "Resume" : "Pause"}
            </button>
          </div>
          {/* #106: same fact, no wire vocabulary. The control stays drawn-and-disabled with its
              reason (that part of the degradation contract is unchanged) — what changed is that the
              reason is now about the source rather than about what our routes serve. */}
          <div className={styles.disabledReason}>
            Postern can’t tell which sign-in this source used, so it can’t reconnect the stream for
            you. Re-add it from Add a source if the stream stays down.
          </div>
        </div>
      </div>
    </div>
  );
}

function DeliveryMiddle({
  c,
  onRotate,
  onPause,
  revealSecret,
  busy,
}: {
  c: ConnectorDetail;
  onRotate: () => void;
  onPause: () => void;
  revealSecret: string | null;
  busy: boolean;
}): JSX.Element {
  const ingestUrl = INGEST_BASE
    ? `${INGEST_BASE.replace(/\/$/, "")}/api/ingest/${c.connectionId}`
    : `/api/ingest/${c.connectionId}`;
  const hasSecret = c.webhook_secret_set_at != null;
  return (
    <div>
      <SectionRule label="Delivery" />
      <div className={styles.middle}>
        <div className={styles.field}>
          {/* "the Shortcut" used to be the pusher named here; the connect card now leads with the
              Health Auto Export automation (#121), so the sentence names the device's automation —
              whichever app runs it. */}
          <div className={styles.gloss}>
            Delivery is on your device&rsquo;s schedule — its automation posts when it runs, or when
            you run it by hand. Postern can&rsquo;t pull; if the data looks stale, run the automation
            on your phone.
          </div>
        </div>

        <div className={styles.ingestCard}>
          <div>
            <div className={styles.ingestLabel}>Ingest endpoint</div>
            <Copyable value={ingestUrl} mono />
            {!INGEST_BASE ? (
              /* #106: this named an ADR, two of the operator's own port numbers and the word
                 loopback. Worse for a product built for the world, `:8443` and `:8787` are THIS
                 box's ports, not anyone else's. Same sentence the connect screen uses for the same
                 fact, with the plate's placeholder host — so the two ingest surfaces agree. */
              <div className={styles.ingestHostNote}>
                This is the path your gateway serves. Put your remote-access address in front of it —
                the tailnet or public one you set up, e.g.{" "}
                <code>https://your-mac.tailnet.ts.net:8443{ingestUrl}</code>. That
                isn&rsquo;t the Console&rsquo;s own address, and Postern isn&rsquo;t told it, so you
                have to add it yourself.
              </div>
            ) : null}
          </div>
          <div className={styles.ingestDivider} aria-hidden="true" />
          <div>
            <div className={styles.ingestLabel}>Shared secret</div>
            <div className={styles.ingestSecretRow}>
              <span className={styles.ingestSecret}>
                {hasSecret
                  ? `•••••••••••• set ${ago(c.webhook_secret_set_at)}`
                  : "no secret minted yet"}
              </span>
            </div>
            {revealSecret ? (
              <div className={styles.revealBox}>
                <Copyable value={revealSecret} label="New secret — shown once" mono />
              </div>
            ) : null}
          </div>
          <div className={styles.ingestButtons}>
            <button type="button" className={styles.btnPrimary} onClick={onRotate} disabled={busy}>
              {hasSecret ? "Rotate secret" : "Mint secret"}
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldLabel}>State</div>
          <div className={styles.buttons}>
            {/* No "Sync now" — Postern cannot pull a device push (build-notes §1.1). */}
            <button type="button" className={styles.btnSecondary} onClick={onPause} disabled={busy}>
              {c.status === "paused" ? "Resume receiving" : "Pause receiving"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateControls({
  broken,
  disconnected,
  paused,
  onSync,
  onPause,
  busy,
}: {
  broken: boolean;
  /** The credential is GONE from the vault (a revoked connection). Nothing here resumes on its own,
   *  and pausing a revoked connector is a no-op — so both claims have to change (#96 §6). */
  disconnected: boolean;
  paused: boolean;
  onSync: () => void;
  onPause: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <div className={styles.field}>
      <div className={styles.fieldLabel}>State</div>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onSync}
          disabled={busy || broken}
          aria-disabled={broken || undefined}
        >
          Sync now
        </button>
        {/* Both controls stay RENDERED and disabled with their reason beside them (§1.5) — never
            removed. */}
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={onPause}
          disabled={busy || disconnected}
          aria-disabled={disconnected || undefined}
        >
          {paused ? "Resume" : "Pause syncing"}
        </button>
      </div>
      {disconnected ? (
        <div className={styles.disabledReason}>
          This connection was removed — its credential is gone from the vault. Syncing will not
          resume on its own; re-add the source to start a new connection.
        </div>
      ) : broken ? (
        <div className={styles.disabledReason}>
          Syncing is held until the connection is restored — there is nothing to poll for. It resumes
          on its own once the source answers again.
        </div>
      ) : null}
    </div>
  );
}

// ── the provider mark in the masthead box ──

function ProviderMark({ provider }: { provider: string }): JSX.Element | null {
  const id = providerTileId(provider);
  return id ? <ProviderTile provider={id} size={26} /> : null;
}

// ── copy helpers ──

function detailSub(c: ConnectorDetail, mask: string | null): string {
  if (c.policy_mode === "push") {
    // "WebSocket" is the transport's name, not the reader's — the sub-line's job is to say how this
    // connection behaves, and "live stream" is what the section beneath it is called anyway (#106).
    return c.push_kind === "webhook" ? "Device push · on-device" : "Live stream";
  }
  if (c.provider === "plaid") return mask ? `via Plaid · ••••${mask}` : "via Plaid";
  if (c.sector === "mail") return "IMAP envelope sync";
  return `${SECTOR_LABEL[c.sector as Sector] ?? c.sector} sync`;
}

function brokenCause(
  c: ConnectorDetail,
  providerName: string,
  sectorLabel: string,
  disconnected: boolean,
): string {
  // Checked BEFORE the plaid branch: a removed Plaid item is removed, not lapsed — "needs
  // re-approving" would point at a flow whose credential no longer exists.
  if (disconnected) {
    return `${providerName} · ${sectorLabel} was removed — its credential is gone from the vault.`;
  }
  if (c.provider === "plaid") return "This bank needs re-approving.";
  return `${providerName} · ${sectorLabel} needs your attention.`;
}

function sharedCredText(c: ConnectorDetail, siblings: ConnectorStatus[]): string {
  const others = siblings.map((s) => SECTOR_LABEL[s.sector as Sector] ?? s.sector);
  const provider = providerDisplay(c.provider);
  const list = joinList(others);
  return `This ${provider} credential also feeds ${list}. Revoking the credential disconnects all of them; disconnecting just ${SECTOR_LABEL[c.sector as Sector] ?? c.sector} leaves the others flowing.`;
}

function disconnectDesc(
  c: ConnectorDetail,
  siblings: ConnectorStatus[],
  disconnected: boolean,
): string {
  const sectorLabel = SECTOR_LABEL[c.sector as Sector] ?? c.sector;
  // The row STAYS enabled for a removed connection — purging the cached rows and the connector row
  // is still a real effect. Only the promise about the credential changes.
  if (disconnected) {
    return `Removes ${sectorLabel}'s cached data and this connection row. The credential is already gone.`;
  }
  if (c.provider === "plaid") {
    // `/item/remove` is Plaid's route name, which nobody managing their own bank link recognises —
    // the fact that matters is that the link is revoked AT Plaid, not just forgotten here (#106).
    return `Removes ${sectorLabel}'s accounts and this connection, and tells Plaid to revoke the bank link at its end. Your other Plaid banks are untouched.`;
  }
  if (siblings.length > 0) {
    const others = joinList(siblings.map((s) => SECTOR_LABEL[s.sector as Sector] ?? s.sector));
    return `Removes ${sectorLabel}'s cached data and this connection. ${others} keep flowing.`;
  }
  return `Removes ${sectorLabel}'s cached data and this connection. Re-add it anytime.`;
}

function revokeTitle(c: ConnectorDetail, shared: boolean): string {
  if (shared) return `Revoke the ${providerDisplay(c.provider)} credential`;
  if (isHomeAssistant(c.provider)) return "Remove the token";
  return `Remove the ${providerDisplay(c.provider)} credential`;
}

function revokeButton(c: ConnectorDetail, siblings: ConnectorStatus[]): string {
  if (siblings.length > 0) return `Revoke all ${siblings.length + 1}`;
  if (isHomeAssistant(c.provider)) return "Remove token";
  return "Revoke";
}

function revokeDesc(c: ConnectorDetail, siblings: ConnectorStatus[]): string {
  if (siblings.length > 0) {
    const all = joinList(
      [c, ...siblings].map((x) => SECTOR_LABEL[x.sector as Sector] ?? x.sector),
    );
    return `Disconnects ${all} and deletes the shared credential from the vault.`;
  }
  if (isHomeAssistant(c.provider)) {
    return "Deletes the long-lived token from the vault. Home stops immediately.";
  }
  return `Deletes the ${providerDisplay(c.provider)} credential from the vault. This connection stops immediately.`;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function coverageItems(
  c: ConnectorDetail,
  d: FreshnessDisplay,
  broken: boolean,
  disconnected: boolean,
): { label: string; value?: number | string; sub?: string }[] {
  const primary = c.cached_count;
  const nounLabel = coverageNoun(c.sector, primary).replace(/^[\d,]+\s/, "");
  if (c.policy_mode === "push" && c.push_kind === "stream") {
    return [
      { label: `${cap(nounLabel)} cached`, value: primary },
      { label: "Stream", value: "live" },
    ];
  }
  if (c.policy_mode === "push" && c.push_kind === "webhook") {
    return [
      { label: `${cap(nounLabel)} cached`, value: primary },
      { label: "Delivery", value: "push" },
    ];
  }
  // "on hold" promises a resumption; a removed connection has none, so it claims nothing.
  const nextText = disconnected ? "—" : broken ? "on hold" : (() => {
    const h = hence(c.freshness?.next_expected_at ?? c.next_sync_at ?? null);
    return h ? `~${h}` : "—";
  })();
  return [
    { label: `${cap(nounLabel)} cached`, value: primary },
    { label: "Last synced", value: ago(d.lastHeardAt) },
    { label: "Next poll", value: nextText },
  ];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function exportBundle(toast: ReturnType<typeof useToast>): Promise<void> {
  try {
    const bundle = await api.exportBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "postern-export.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.show({ tone: "ok", message: "Export downloaded." });
  } catch (e) {
    toast.show({ tone: "error", message: e instanceof Error ? e.message : "Export failed." });
  }
}
