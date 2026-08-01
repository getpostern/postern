// Agent detail (Paper 5US-0) — edit grants and the key's deadline in place, the key row, and a
// recent-passage mini-ledger.
//
// The honest edges:
//   - GRANTS toggle the SAME <SectorToggle> as Mint; a change patches immediately and applies at the
//     agent's NEXT session (grants resolve once per session), so the copy never implies in-flight
//     revocation. The sectors patch sends NO expiry key — see the toggle handler.
//   - EXPIRY is a live control now (#80): `patchAgent` takes a tri-state `expiresInDays`, so all three
//     meanings are reachable — leave it alone (absent), move it (a number), or never expire (null).
//   - PASSAGE is served (#89): `last_seen_at` is an aggregate over the WHOLE ledger, never reduced
//     from the capped audit feed. It is a LOWER BOUND (audit is fire-and-forget and droppable), so the
//     copy says "recorded" and the caveat is printed once, beside the value.
//   - RECENT PASSAGE is the ledger surface filtered to this agent (`useAudit({agent})`) — actual
//     recent calls with their own real timestamps. That is served and is NOT a last-seen derivation.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAgents, useAudit, useInvalidateAgents } from "../../api/hooks";
import { ago } from "../../api/format";
import { SECTORS, isSector, type Agent, type AuditRow, type Sector } from "../../api/types";
import { SectionRule } from "../../shell";
import { ConfirmBar, ZeroState, useToast } from "../../kit";
import { SectorToggle, GrantChip } from "./SectorToggle";
import { ReadActNote } from "./ReadActNote";
import { ConfirmOverlay } from "./ConfirmOverlay";
import type { MintPreset } from "./AgentsPage";
import {
  EXPIRY_OPTIONS,
  PASSAGE_LOWER_BOUND_NOTE,
  PASSAGE_NOT_REPORTED,
  REMOVE_BLAST_RADIUS,
  REVOKE_BLAST_RADIUS,
  SECTOR_TITLE,
  agentStatusOf,
  errMsg,
  expiryPhrase,
  expiryPresetFor,
  expirySelection,
  isExpiryChipOn,
  passageDisplay,
  sectorReads,
} from "./helpers";
import styles from "./AgentDetailPage.module.css";

/**
 * The KEY row's passage readout. Served (#89) — and worded for what the value actually is: the last
 * call the ledger WROTE DOWN, any sector, allowed or denied.
 *
 * "last seen", not "last used": a denied attempt is passage too, and the number is a lower bound
 * rather than a measurement. A served `null` is "no passage recorded" — never "idle", which would be a
 * claim about the agent instead of a fact about the ledger. An ABSENT field takes the shared
 * `PASSAGE_NOT_REPORTED` sentence, which this page used to phrase for itself as "this gateway doesn't
 * record passage per key" — a claim about what the gateway does, from evidence that only says what it
 * sent (#106). Two pages, one sentence, so they cannot drift again.
 */
function LastSeen({ agent }: { agent: Agent }): JSX.Element {
  const p = passageDisplay(agent);
  if (p.kind === "at") return <span className={styles.lastUsed}>last seen {ago(p.iso)}</span>;
  return (
    <span className={styles.lastUsedNS}>
      {p.kind === "never" ? "no passage recorded" : PASSAGE_NOT_REPORTED}
    </span>
  );
}

/** Which of this key's grants it has actually reached (served per-sector `last_read_at`). Absent
 *  field → nothing is drawn: an empty list would read as "it has used none of them". */
function GrantsReached({ agent }: { agent: Agent }): JSX.Element | null {
  const reads = sectorReads(agent);
  if (!reads || (reads.read.length === 0 && reads.unread.length === 0)) return null;
  const names = (list: Sector[]) => list.map((s) => SECTOR_TITLE[s]).join(", ");
  return (
    <p className={styles.reached}>
      {reads.read.length > 0 ? (
        <>Last read — {reads.read.map((r) => `${SECTOR_TITLE[r.sector]} ${ago(r.iso)}`).join(", ")}. </>
      ) : null}
      {reads.unread.length > 0 ? <>Nothing recorded yet in {names(reads.unread)}.</> : null}
    </p>
  );
}

/** One mini-ledger row (Paper 5US-0). Served from `useAudit({agent})`; the timestamp is the call's
 *  own `created_at`, an actual event — not a last-seen. */
function PassageRow({ row }: { row: AuditRow }): JSX.Element {
  const sector = row.sector && isSector(row.sector) ? row.sector : null;
  const denied = row.decision === "deny";
  const outcome = denied
    ? `denied${row.deny_reason ? ` — ${row.deny_reason}` : ""}`
    : row.outcome ?? "ok";
  return (
    <div className={styles.passageRow}>
      <span className={styles.passageLead}>
        <span className={styles.passageTool}>{row.tool}</span>
        {sector ? <GrantChip sector={sector} /> : null}
      </span>
      <span className={denied ? styles.passageDenied : styles.passageOutcome}>{outcome}</span>
      <span className={styles.passageTime}>{ago(row.created_at)}</span>
    </div>
  );
}

type Confirm = { kind: "revoke" } | { kind: "remove" } | null;

export function AgentDetailPage(): JSX.Element {
  const { agentId = "" } = useParams();
  const navigate = useNavigate();
  const invalidate = useInvalidateAgents();
  const toast = useToast();

  const { data: agents, isLoading } = useAgents();
  const agent = useMemo(() => (agents ?? []).find((a) => a.agentId === agentId), [agents, agentId]);
  const passage = useAudit({ agent: agentId, limit: 6 });

  const [sectors, setSectors] = useState<Sector[]>([]);
  const [seeded, setSeeded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  // Seed the editable grant set once per agent (never clobber an in-flight optimistic toggle).
  useEffect(() => {
    if (agent && seeded !== agent.agentId) {
      setSectors(agent.sectors.filter((s): s is Sector => isSector(s)));
      setSeeded(agent.agentId);
    }
  }, [agent, seeded]);

  const status = agent ? agentStatusOf(agent) : "active";
  const revoked = status === "revoked";

  const patchMut = useMutation({
    // The SECTORS-ONLY form. It must never grow an `expiresInDays` key: to this route `null` means
    // "never expires", so a sectors edit that sent one would silently clear the key's deadline, answer
    // 200, and look right (`api/served-seams.test.ts`). Absent is the only way to say "leave it".
    mutationFn: (next: Sector[]) => api.patchAgent(agentId, next),
    onMutate: (next: Sector[]) => {
      const prev = sectors;
      setSectors(next);
      return { prev };
    },
    onError: (e, _next, ctx) => {
      if (ctx) setSectors(ctx.prev);
      toast.show({ message: `Grant change failed — ${errMsg(e)}`, tone: "error" });
    },
    onSuccess: () => {
      invalidate();
      toast.show({ message: `Grants updated — they apply at ${agentId}'s next session.` });
    },
  });

  /**
   * The in-place EXPIRY edit (#80). Sends `expiresInDays` and nothing else — an expiry edit must not
   * carry a sectors array read for the render, or it would overwrite a grant changed in another tab
   * with whatever this screen happened to be showing.
   *
   * Deliberately NOT optimistic. The readout is derived from the served `expires_at`, so a refused or
   * failed edit leaves a true deadline on screen instead of a hopeful one — and this is the mutation
   * the gateway is most likely to refuse (a dead key: see `expiryEditable`).
   */
  const expiryMut = useMutation({
    mutationFn: (days: number | null) => api.patchAgent(agentId, { expiresInDays: days }),
    onSuccess: (_res, days) => {
      invalidate();
      toast.show({
        message:
          days === null
            ? `${agentId} never expires now — the key itself is unchanged.`
            : `${agentId} expires in ${days} days — the key itself is unchanged.`,
      });
    },
    // The gateway's own sentence, verbatim: it names the state that refused the edit and what to do
    // instead. Paraphrasing it here would give the operator a second, less accurate answer.
    onError: (e) => toast.show({ message: `Deadline unchanged — ${errMsg(e)}`, tone: "error" }),
  });

  const revokeMut = useMutation({
    mutationFn: () => api.revokeAgent(agentId),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      toast.show({ message: `${agentId} revoked — every token derived from it died too.` });
      navigate("/agents");
    },
    onError: (e) => toast.show({ message: `Revoke failed — ${errMsg(e)}`, tone: "error" }),
  });

  const removeMut = useMutation({
    mutationFn: () => api.deleteAgent(agentId),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      toast.show({ message: `${agentId} removed — its entries in the ledger are kept.` });
      navigate("/agents");
    },
    onError: (e) => toast.show({ message: `Remove failed — ${errMsg(e)}`, tone: "error" }),
  });

  const toggle = (s: Sector) => {
    const set = new Set(sectors);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    patchMut.mutate(SECTORS.filter((x) => set.has(x)));
  };

  const goRotate = () => {
    if (!agent) return;
    const preset: MintPreset = {
      agentId: agent.agentId,
      sectors: agent.sectors,
      expiresInDays: expiryPresetFor(agent.expires_at),
      lock: true,
      rotate: !revoked,
    };
    navigate("/agents/new", { state: { preset } });
  };

  // ── Not found / loading ──
  if (!agent) {
    return (
      <div className={styles.page}>
        <Link className={styles.back} to="/agents">
          ← Agents &amp; keys
        </Link>
        {isLoading ? (
          <p className={styles.loading}>Loading…</p>
        ) : (
          <ZeroState
            kind="unconnected"
            headline="No such agent"
            reason={`No key named "${agentId}" is on the register. It may have been removed.`}
            action={{ label: "Back to the register", onAct: () => navigate("/agents") }}
          />
        )}
      </div>
    );
  }

  // The expiry control's two facts: where the served deadline sits, and whether the gateway will
  // accept a move at all. An expiry edit is REFUSED on a dead key — moving the deadline of a revoked
  // or lapsed grant would hand the ORIGINAL secret its access back (`resolveBearer` re-reads the row
  // per request), and every bridge refresh token derived from it with it. Rotation is the only way
  // back from dead, so the chips stay drawn-and-disabled with that sentence rather than inviting a
  // click the gateway will answer 400. Verified against `src/rest/admin.ts` `patchAgent`, whose guard
  // is a clause in the UPDATE's own WHERE (both revoked and past-deadline).
  const expirySel = expirySelection(agent.expires_at);
  const expiryEditable = status === "active";

  return (
    <div className={styles.page}>
      <Link className={styles.back} to="/agents">
        ← Agents &amp; keys
      </Link>

      {/* Header — kicker AGENT · name · mono sub (served facts only). */}
      <header className={styles.header}>
        <div className={styles.kicker}>Agent</div>
        <h1 className={styles.name}>{agent.agentId}</h1>
        <div className={styles.headerSub}>
          {/* "bearer over Streamable HTTP" is MCP's own vocabulary, not this repo's, and it is what a
              reader will type into their client's config two clicks away (Connect an agent). Kept. */}
          {expiryPhrase(agent.expires_at)} · bearer over Streamable HTTP
          {revoked ? " · revoked" : ""}
        </div>
      </header>

      {/* GRANTS — editable, one <SectorToggle>. */}
      <section className={styles.section} aria-label="Grants">
        <SectionRule label="Grants" />
        <div className={styles.toggleGrid} role="group" aria-label="Granted sectors">
          {SECTORS.map((s) => (
            <SectorToggle
              key={s}
              sector={s}
              granted={sectors.includes(s)}
              onToggle={toggle}
              disabled={revoked}
            />
          ))}
        </div>
        {/* The third case is not decoration: a LAPSED key can still have its grants edited (the gateway
            allows a sectors-only patch on a dead grant, deliberately), but it has no next session to
            apply them in — so the live-key sentence would promise something rotation is the only route
            to. Status is already computed for the expiry control; this is the same fact, said once. */}
        {/* #106: "Domain-level —" was the invariant's name, not the reader's. The rest of the sentence
            already says the thing it was labelling, so the label was pure jargon overhead. */}
        <p className={styles.hint}>
          Each granted sector covers read and act across every provider in it.{" "}
          {status === "revoked"
            ? "This key is revoked; its grants can no longer change."
            : status === "expired"
              ? "Tap to toggle — but this key has lapsed, so nothing reaches your gate with it until you rotate it."
              : "Tap to toggle; the change applies at the agent's next session."}
        </p>
        <GrantsReached agent={agent} />
        <ReadActNote granted={sectors} />
      </section>

      {/* KEY — the fingerprint, the served passage readout, the in-place expiry edit, the actions. */}
      <section className={styles.section} aria-label="Key">
        <SectionRule label="Key" />
        <div className={styles.keyRow}>
          <span className={styles.keyFingerprint}>stored as sha-256 — the key itself is shown only once</span>
          <LastSeen agent={agent} />
          <span className={styles.keySpacer} />
          {revoked ? (
            <>
              <button type="button" className={styles.keyBtn} onClick={goRotate}>
                Re-mint
              </button>
              <button
                type="button"
                className={styles.keyBtnSeal}
                onClick={() => setConfirm({ kind: "remove" })}
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.keyBtn} onClick={goRotate}>
                Rotate
              </button>
              <button
                type="button"
                className={styles.keyBtnSeal}
                onClick={() => setConfirm({ kind: "revoke" })}
              >
                Revoke
              </button>
            </>
          )}
        </div>

        {/* The caveat that qualifies the readout above it — printed once, beside the value, in the same
            words the register uses. Audit is fire-and-forget by invariant, so this is a floor rather
            than a measurement, and the direction is the safe one for a revoke decision. */}
        <p className={styles.hint}>{PASSAGE_LOWER_BOUND_NOTE}</p>

        {/* #80 in-place expiry edit — LIVE. `patchAgent`'s `expiresInDays` is tri-state, so all three
            meanings are reachable from here: Never sends explicit `null`, a preset sends the number,
            and leaving this control alone sends nothing at all.

            `aria-pressed` is back, and legitimately: these were `aria-current`-only while they were a
            value display wearing a toggle's clothes (a control that could never be pressed). They are
            now single-select toggles that can be, which is what `aria-pressed` describes — the same
            control, same markup, as the Mint form's expiry row.

            THE 50% DIM (see the module CSS): it applies through `:disabled` only, i.e. only while the
            gateway will genuinely not accept a move (a dead key, or an edit in flight). On an inactive
            control that dim is WCAG-exempt; as the permanent styling of a READ-OUT it would have been
            an unexempted contrast failure. Making these live is what settles that — do not "fix" the
            dim, and do not re-disable the row to display a value. */}
        <div className={styles.expiryBlock}>
          <span className={styles.expiryLabel}>Expiry</span>
          {/* The reason is wired to the CONTROL, not just printed under it: a `disabled` button is not
              focusable, so a screen-reader user who never lands on a chip would otherwise never hear
              why it cannot be moved. Describing the group carries the sentence with the affordance. */}
          <div
            className={styles.expiryRow}
            role="group"
            aria-label="Expiry"
            aria-describedby="agent-expiry-note"
          >
            {EXPIRY_OPTIONS.map((opt) => {
              const on = isExpiryChipOn(expirySel, opt.days);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={styles.expiryChip}
                  data-on={on || undefined}
                  aria-pressed={on}
                  disabled={!expiryEditable || expiryMut.isPending}
                  onClick={() => expiryMut.mutate(opt.days)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className={styles.hint} id="agent-expiry-note">
            {expiryMut.isPending
              ? "Moving the deadline…"
              : status === "revoked"
                ? "This key is revoked, so its deadline is fixed where it stopped — moving it would let the old key back in. Rotate to mint a fresh key with a new deadline."
                : status === "expired"
                  ? "This key has already lapsed, and moving the deadline would let the old key back in — so Postern refuses it. Rotate to mint a fresh key with a new deadline."
                  : expirySel.kind === "custom"
                    ? `This key lapses in ${expirySel.days} days, which isn’t one of the presets. Picking one replaces that deadline. The key itself doesn’t change, so nothing has to be re-pasted — but the agent’s current session ends, and its next one uses the same key.`
                    : "Set when this key lapses. The key itself doesn’t change, so nothing has to be re-pasted — but the agent’s current session ends, and its next one uses the same key."}
          </p>
        </div>
      </section>

      {/* RECENT PASSAGE — the ledger filtered to this agent (served). */}
      <section className={styles.section} aria-label="Recent passage">
        <SectionRule label="Recent passage" />
        {passage.isLoading ? (
          <p className={styles.loading}>Reading the ledger…</p>
        ) : (passage.data ?? []).length === 0 ? (
          <p className={styles.hint}>No calls recorded for {agent.agentId} in the reachable ledger window.</p>
        ) : (
          <div className={styles.passageList}>
            {(passage.data ?? []).map((row) => (
              <PassageRow key={row.id} row={row} />
            ))}
          </div>
        )}
        <Link className={styles.ledgerLink} to={`/ledger?agent=${encodeURIComponent(agent.agentId)}`}>
          See all of {agent.agentId}'s calls in the ledger →
        </Link>
      </section>

      {confirm ? (
        <ConfirmOverlay
          title={`${confirm.kind === "revoke" ? "Revoke" : "Remove"} ${agent.agentId}`}
          onCancel={() => setConfirm(null)}
        >
          {confirm.kind === "revoke" ? (
            <ConfirmBar
              verb="Revoke the key"
              consequence={<>Revoke {agent.agentId}?</>}
              blastRadius={REVOKE_BLAST_RADIUS}
              busy={revokeMut.isPending}
              onConfirm={() => revokeMut.mutate()}
              onCancel={() => setConfirm(null)}
            />
          ) : (
            <ConfirmBar
              verb="Remove the agent"
              consequence={<>Remove the revoked agent {agent.agentId}?</>}
              blastRadius={REMOVE_BLAST_RADIUS}
              busy={removeMut.isPending}
              onConfirm={() => removeMut.mutate()}
              onCancel={() => setConfirm(null)}
            />
          )}
        </ConfirmOverlay>
      ) : null}
    </div>
  );
}
