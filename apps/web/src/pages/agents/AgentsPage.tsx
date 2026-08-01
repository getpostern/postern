// Agents & keys — the register (Paper 2IG-0). The grant register as a paper ledger
// (№ · agent·key · granted sectors · Passage · key actions) + Connect-an-agent (ConnectRecipes).
//
// What is honest here, and why:
//   - Passage is SERVED now (#89): `last_seen_at` is an aggregate over the WHOLE ledger. It is never
//     reduced from the capped audit feed — that reduction renders a quiet agent as "never", which is
//     false rather than approximate and looks right in every fixture. See helpers.passageDisplay.
//     It is also a LOWER BOUND (audit is fire-and-forget and droppable, by invariant), so the column
//     carries one footnote saying so and no cell claims certainty it does not have.
//   - The drawn cell (Paper 2IG-0) has a second line reading "142 calls today". There is no call
//     count on the wire — `/api/audit` is capped and serves no total — so that line stays absent
//     rather than becoming a count of whatever the last page happened to hold.
//   - There is no recoverable key material and no per-agent bridge flag on the wire, so the agent·key
//     sub-line shows only served facts (the expiry phrase); the "key_9f2a···" mock is not fabricated.
//   - Revoke/Rotate/Remove are real mutations. Remove is revoked-only (server-gated, #24). Reveal of a
//     new key on Rotate happens on /agents/new — a plaintext key never reaches a URL.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAgents, useInvalidateAgents } from "../../api/hooks";
import { ago } from "../../api/format";
import type { Agent } from "../../api/types";
import { Masthead, SectionRule } from "../../shell";
import { LedgerTable, ZeroState, ConfirmBar, useToast, type LedgerColumn } from "../../kit";
import { GrantChip } from "./SectorToggle";
import { ConnectRecipes } from "./ConnectRecipes";
import { ConfirmOverlay } from "./ConfirmOverlay";
import {
  PASSAGE_LOWER_BOUND_NOTE,
  PASSAGE_NOT_REPORTED,
  REMOVE_BLAST_RADIUS,
  REVOKE_BLAST_RADIUS,
  agentStatusOf,
  errMsg,
  expiryPhrase,
  expiryPresetFor,
  grantSummary,
  passageDisplay,
} from "./helpers";
import styles from "./AgentsPage.module.css";

interface AgentRow extends Agent {
  _n: number;
}

/** The `state` passed to /agents/new to preload a rotate/re-mint. Kept out of the URL. */
export interface MintPreset {
  agentId: string;
  sectors: string[];
  expiresInDays: number | null;
  lock: boolean;
  rotate: boolean;
}

/**
 * The Passage cell — served (#89), and worded for exactly what the value is.
 *
 * Three answers, three sentences:
 *   a string  → when the ledger last recorded this key coming through (any sector, allowed or denied).
 *   `null`    → the gateway reported, and has nothing recorded for this key. "nothing recorded" and
 *               NOT "never used": audit is droppable, so absence of a line is not proof of absence of
 *               a call, and the footnote under the register says which way that can be wrong.
 *   absent    → the gateway did not report the field at all. A fact about the gateway, never about
 *               the key, and never allowed to collapse into the `null` sentence (#58).
 */
function PassageCell({ agent }: { agent: Agent }): JSX.Element {
  const p = passageDisplay(agent);
  if (p.kind === "at") {
    return <span className={styles.passageAt}>{ago(p.iso)}</span>;
  }
  return (
    <span className={styles.passageNS}>
      {p.kind === "never" ? "nothing recorded" : PASSAGE_NOT_REPORTED}
    </span>
  );
}

/** The "Granted sectors" cell — "every sector" / "no sectors" / recap chips. */
function GrantedCell({ sectors }: { sectors: string[] }): JSX.Element {
  const s = grantSummary(sectors);
  if (s.kind === "all") return <span className={styles.grantEvery}>every sector</span>;
  if (s.kind === "none") return <span className={styles.grantNone}>no sectors</span>;
  return (
    <span className={styles.grantChips}>
      {s.sectors.map((sec) => (
        <GrantChip key={sec} sector={sec} />
      ))}
    </span>
  );
}

type Confirm =
  | { kind: "revoke"; agent: Agent }
  | { kind: "remove"; agent: Agent }
  | null;

export function AgentsPage(): JSX.Element {
  const navigate = useNavigate();
  const invalidate = useInvalidateAgents();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useAgents();
  const [confirm, setConfirm] = useState<Confirm>(null);

  const agents = useMemo(() => data ?? [], [data]);
  const rows: AgentRow[] = useMemo(() => agents.map((a, i) => ({ ...a, _n: i + 1 })), [agents]);
  const activeCount = useMemo(() => agents.filter((a) => agentStatusOf(a) === "active").length, [agents]);

  const revokeMut = useMutation({
    mutationFn: (agentId: string) => api.revokeAgent(agentId),
    onSuccess: (res) => {
      invalidate();
      setConfirm(null);
      toast.show({ message: `${res.agentId} revoked — every token derived from it died too.` });
    },
    onError: (e) => toast.show({ message: `Revoke failed — ${errMsg(e)}`, tone: "error" }),
  });

  const removeMut = useMutation({
    mutationFn: (agentId: string) => api.deleteAgent(agentId),
    onSuccess: (_res, agentId) => {
      invalidate();
      setConfirm(null);
      toast.show({ message: `${agentId} removed — its entries in the ledger are kept.` });
    },
    onError: (e) => toast.show({ message: `Remove failed — ${errMsg(e)}`, tone: "error" }),
  });

  const goMint = () => navigate("/agents/new");

  const goRotate = (a: Agent) => {
    const preset: MintPreset = {
      agentId: a.agentId,
      sectors: a.sectors,
      expiresInDays: expiryPresetFor(a.expires_at),
      lock: true,
      rotate: true,
    };
    navigate("/agents/new", { state: { preset } });
  };

  const goReMint = (a: Agent) => {
    const preset: MintPreset = {
      agentId: a.agentId,
      sectors: a.sectors,
      expiresInDays: null,
      lock: true,
      rotate: false,
    };
    navigate("/agents/new", { state: { preset } });
  };

  const columns: LedgerColumn<AgentRow>[] = [
    {
      field: "_n",
      header: "№",
      width: "44px",
      render: (r) => <span className={styles.ordinal}>{String(r._n).padStart(3, "0")}</span>,
    },
    {
      field: "agentId",
      header: "Agent · key",
      width: "220px",
      render: (r) => (
        <span className={styles.agentCell}>
          <Link className={styles.agentName} to={`/agents/${encodeURIComponent(r.agentId)}`}>
            {r.agentId}
          </Link>
          <span className={styles.agentSub}>{expiryPhrase(r.expires_at)}</span>
        </span>
      ),
    },
    {
      field: "sectors",
      header: "Granted sectors",
      render: (r) => <GrantedCell sectors={r.sectors} />,
    },
    {
      field: "passage",
      header: "Passage",
      width: "150px",
      render: (r) => <PassageCell agent={r} />,
    },
    {
      field: "actions",
      header: "Key",
      width: "150px",
      align: "right",
      render: (r) => {
        const status = agentStatusOf(r);
        if (status === "revoked") {
          return (
            <span className={styles.actions}>
              <button type="button" className={styles.actionBtn} onClick={() => goReMint(r)}>
                Re-mint
              </button>
              <span className={styles.actionSep} aria-hidden="true">·</span>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => setConfirm({ kind: "remove", agent: r })}
              >
                Remove
              </button>
            </span>
          );
        }
        return (
          <span className={styles.actions}>
            <button type="button" className={styles.actionBtn} onClick={() => goRotate(r)}>
              Rotate
            </button>
            <span className={styles.actionSep} aria-hidden="true">·</span>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => setConfirm({ kind: "revoke", agent: r })}
            >
              Revoke
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className={styles.page}>
      <Masthead
        kicker="The gate"
        verdict="Agents & keys"
        // #106: "domain-level" is this repo's name for the invariant, and to a reader "domain" is a
        // website. The blast radius it was there to state is unchanged and still said in full — a
        // granted sector is read AND act, everywhere in that sector — with the part that matters most
        // spelled out: there is nothing narrower on offer.
        sub="Who holds a key to your gate, and which sectors it opens. Granting a sector grants read and act across every provider in it — there is nothing narrower to grant. Revoke kills a key and everything derived from it, at once."
        right={
          <div className={styles.mintCol}>
            <button type="button" className={styles.mintBtn} onClick={goMint}>
              Mint a key
            </button>
            <div className={styles.activeCount}>
              {activeCount} active {activeCount === 1 ? "key" : "keys"}
            </div>
          </div>
        }
      />

      <section className={styles.register} aria-label="The register">
        <SectionRule label="The register" gloss="six sectors · read and act · nothing granted by default" />
        {isError ? (
          <div className={styles.loadError}>
            <p>Couldn't load the register — {errMsg(error)}</p>
            <button type="button" className={styles.retryBtn} onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <LedgerTable<AgentRow>
            columns={columns}
            rows={rows}
            rowKey={(r) => r.agentId}
            loading={isLoading}
            empty={
              <ZeroState
                kind="unconnected"
                headline="No keys issued yet"
                // #106: "scoped bearer key", "default-deny" and "harness" are three of ours in one
                // sentence, on the screen a first-run reader meets before they own anything. Same
                // three facts — the key is the credential, sectors are granted one by one and nothing
                // starts granted, and any agent can use it.
                reason="An agent reaches your gate with a key you mint here. Nothing is granted until you pick it: choose whole sectors, then paste the key into your agent."
                action={{ label: "Mint a key", onAct: goMint }}
              />
            }
          />
        )}
        {/* The Passage column's one caveat, printed once under the column rather than in every cell —
            the same sentence the detail page prints beside the same value. Not shown on the zero state:
            there is no column to qualify yet. */}
        {!isError && rows.length > 0 ? (
          <p className={styles.passageNote}>{PASSAGE_LOWER_BOUND_NOTE}</p>
        ) : null}
      </section>

      <ConnectRecipes />

      {confirm ? (
        <ConfirmOverlay
          title={`${confirm.kind === "revoke" ? "Revoke" : "Remove"} ${confirm.agent.agentId}`}
          onCancel={() => setConfirm(null)}
        >
          {confirm.kind === "revoke" ? (
            <ConfirmBar
              verb="Revoke the key"
              consequence={<>Revoke {confirm.agent.agentId}?</>}
              blastRadius={REVOKE_BLAST_RADIUS}
              busy={revokeMut.isPending}
              onConfirm={() => revokeMut.mutate(confirm.agent.agentId)}
              onCancel={() => setConfirm(null)}
            />
          ) : (
            <ConfirmBar
              verb="Remove the agent"
              consequence={<>Remove the revoked agent {confirm.agent.agentId}?</>}
              blastRadius={REMOVE_BLAST_RADIUS}
              busy={removeMut.isPending}
              onConfirm={() => removeMut.mutate(confirm.agent.agentId)}
              onCancel={() => setConfirm(null)}
            />
          )}
        </ConfirmOverlay>
      ) : null}
    </div>
  );
}
