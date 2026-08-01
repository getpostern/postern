// Mint a key (Paper 5KL-0) + the reveal-once STATE (Paper 5QR-0).
//
// Reveal-once is a page STATE, never a route (console-port-plan D5): the minted plaintext lives only
// in component state and is dropped on navigate/refresh — it must not reach a URL, a history entry,
// or a referer. Mint: name → default-DENY sector toggles → expiry preset → Mint. Rotate/Re-mint
// arrive via router `state.preset` (also never the URL): the name locks, sectors + expiry preload.
//
// That state is also the ONLY moment a plaintext key exists, which is why the complete connect
// config is handed over HERE (#139) rather than pointed at: the register's block is keyless by
// design, so pointing a just-minted person there left them to stash the key, navigate away, copy a
// placeholder and splice the secret in by hand. The block is composed from the register's ONE
// derivation with the key already in it — nothing new touches the wire, and nothing is persisted.

import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useExposure, useInvalidateAgents } from "../../api/hooks";
import { EXPOSURE_UNANSWERED, defaultExpiryDays } from "../../api/exposure";
import { SECTORS, type CreateAgentResult, type Sector } from "../../api/types";
import { Skeleton, useToast } from "../../kit";
import { SubHead } from "./SubHead";
import { SectorToggle, GrantChip } from "./SectorToggle";
import { ReadActNote } from "./ReadActNote";
import { EXPIRY_OPTIONS, errMsg, grantSummary } from "./helpers";
// The ONE derivation of the `mcpServers` block shape (#71/#101), imported rather than re-rolled:
// two hand-written JSON shapes for one config is the #111 defect, and this screen's block must be
// the register's block with the bearer filled in — not a lookalike that can drift from it.
import { remoteConfigJson } from "./ConnectRecipes";
import type { MintPreset } from "./AgentsPage";
import styles from "./MintKeyPage.module.css";

export function MintKeyPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const invalidate = useInvalidateAgents();
  const toast = useToast();

  const preset = (location.state as { preset?: MintPreset } | null)?.preset;

  const [name, setName] = useState(preset?.agentId ?? "");
  const [granted, setGranted] = useState<Set<Sector>>(
    () => new Set((preset?.sectors ?? []).filter((s): s is Sector => (SECTORS as readonly string[]).includes(s))),
  );
  const [minted, setMinted] = useState<CreateAgentResult | null>(null);

  // ── The expiry default follows the gate's exposure ────────────────────────────────────────────
  // A key pasted into a hosted client crosses the public internet, so once this gate is published
  // the form STARTS on 90 days instead of Never. The Console never BLOCKS a never-expiring key —
  // the gateway's own rule at the bridge is the only gate, and a second rule here is how two tables
  // start disagreeing.
  //
  // Why `chosen` is `number | null | undefined` rather than a plain `useState(default)`: a
  // `useState` initialiser runs on the FIRST render, when `useExposure()` is still pending, so the
  // default would freeze at Never and never catch up when the answer arrives. `undefined` means
  // "the operator hasn't picked yet, follow the gate"; `null` is a real, explicit choice of Never.
  const exposure = useExposure();
  const [chosen, setChosen] = useState<number | null | undefined>(preset?.expiresInDays);
  const expiryDays = chosen !== undefined ? chosen : defaultExpiryDays(exposure.data);
  const setExpiryDays = (days: number | null) => setChosen(days);
  const gateIsPublished = exposure.data?.configured != null;
  // The gateway did not ANSWER — never collapsed into "the gateway answered: no MCP edge", whose
  // sentence is a claim about the box (§Decision 7).
  const exposureFailed = exposure.isError || (!exposure.isPending && exposure.data == null);
  const localEndpoint = exposureFailed ? null : (exposure.data?.localEndpoint ?? null);

  const locked = preset?.lock === true;
  const isRotate = preset?.rotate === true;
  const grantedList = useMemo(() => SECTORS.filter((s) => granted.has(s)), [granted]);

  const toggle = (s: Sector) =>
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const mintMut = useMutation({
    mutationFn: () =>
      api.createAgent({
        agentId: name.trim(),
        sectors: grantedList,
        expiresInDays: expiryDays ?? undefined,
      }),
    onSuccess: (res) => {
      setMinted(res);
      invalidate();
    },
    onError: (e) => toast.show({ message: `Mint failed — ${errMsg(e)}`, tone: "error" }),
  });

  const canMint = name.trim().length > 0 && !mintMut.isPending;

  const copy = (text: string, msg: string) => {
    void navigator?.clipboard?.writeText?.(text).then(
      () => toast.show({ message: msg }),
      () => toast.show({ message: "Couldn't copy — select and copy manually.", tone: "error" }),
    );
  };

  // ── The reveal-once state ──────────────────────────────────────────────────
  if (minted) {
    const openedSectors = SECTORS.filter((s) => minted.sectors.includes(s));
    // The complete connect config, composed HERE — where the plaintext key already is (#139). It is
    // the register's block from the register's derivation, with this key in the bearer instead of
    // the placeholder; the key is not persisted, refetched or logged to build it, and it leaves this
    // component only through the clipboard, at the person's own click. Null when the gateway serves
    // no address: a pasteable config carrying a guessed URL is worse than none — it looks right and
    // silently does not work.
    const connectConfig = localEndpoint != null ? remoteConfigJson(localEndpoint, minted.key) : null;
    return (
      <div className={styles.page}>
        {/* "Copy the key now" was never enough on its own: the hosted flow asks for this key at a
            LATER step, in another app, after the connect page's own Copy button has replaced it on
            the clipboard (witnessed 2026-08-01 — the URL got pasted into the key box, and the
            client answered "That agent key was not accepted"). So the sentence says where to put
            it, not just to copy it. */}
        <SubHead
          kicker="The gate"
          verdict={`${minted.agentId} is ready`}
          sub="Copy the key now and keep it somewhere safe — it is shown once, and claude.ai or ChatGPT will ask for it later, in the middle of signing in. Postern keeps only a hash of it; lose it and you simply mint another."
        />

        {/* The plaintext key — shown ONCE, poppy card. */}
        <div className={styles.keyCard}>
          <div className={styles.keyCardHead}>
            <span className={styles.keyCardLabel}>Agent key — shown once</span>
            <button
              type="button"
              className={styles.keyCopy}
              onClick={() => copy(minted.key, "Key copied — store it now; it isn't shown again")}
            >
              Copy
            </button>
          </div>
          <code className={styles.keyValue}>{minted.key}</code>
        </div>

        {/* Opens — the recap of granted sectors. */}
        <div className={styles.opens}>
          <span className={styles.sectionLabel}>Opens</span>
          <div className={styles.opensRow}>
            {openedSectors.length > 0 ? (
              <>
                {openedSectors.map((s) => (
                  <GrantChip key={s} sector={s} />
                ))}
                <span className={styles.opensNote}>read and act, across every provider in each</span>
              </>
            ) : (
              <span className={styles.opensNote}>no sectors — this key is denied everything</span>
            )}
          </div>
        </div>

        {/* The address and the config that carries it. Both served by the gateway, never a
            build-time constant, and honestly absent when this gateway runs no MCP edge — and the two
            absences are told apart, because the sentence for one is an instruction to go change a
            box the other never reached (§Decision 7). One card, so that sentence is said ONCE. */}
        <div className={styles.endpointCard}>
          <div className={styles.endpointHead}>
            <span className={styles.sectionLabel}>MCP endpoint</span>
            {localEndpoint != null ? (
              <button
                type="button"
                className={styles.endpointCopy}
                onClick={() => copy(localEndpoint, "Endpoint copied")}
              >
                Copy
              </button>
            ) : null}
          </div>
          {exposure.isPending ? (
            <Skeleton width="60%" />
          ) : localEndpoint != null ? (
            // The served address decides this branch on its own. The config rides INSIDE it rather
            // than gating it: a block that failed to compose must cost the reader the block, never
            // turn a serving gateway into the sentence "this gateway isn't serving MCP".
            <>
              <div className={styles.endpointValue}>{localEndpoint}</div>

              {connectConfig != null ? (
                <>
                  <div className={styles.configHead}>
                    <span className={styles.sectionLabel}>Connect config</span>
                    <button
                      type="button"
                      className={styles.configCopy}
                      onClick={() =>
                        copy(connectConfig, "Config copied — it carries this key; store it like one")
                      }
                    >
                      Copy config · key included
                    </button>
                  </div>
                  {/* ONE call, rendered and copied — never a second stringify that can drift from
                      what is on screen, which is the split that makes a Copy button a liar. */}
                  <pre className={styles.configBlock}>
                    <code>{connectConfig}</code>
                  </pre>
                  <div className={styles.endpointNote}>
                    Paste the whole object into your agent's MCP config — Claude Code's{" "}
                    <code>.mcp.json</code>, Cursor's <code>mcp.json</code> — then restart it. This
                    key is already in it; there is nothing to fill in.
                  </div>
                </>
              ) : null}
            </>
          ) : exposureFailed ? (
            <div className={styles.endpointNote}>{EXPOSURE_UNANSWERED}</div>
          ) : (
            <div className={styles.endpointNote}>
              This gateway isn’t serving MCP yet, so it has no address to pair with this key.
            </div>
          )}
        </div>

        <div className={styles.revealActions}>
          <button type="button" className={styles.primaryBtn} onClick={() => navigate("/agents")}>
            Done
          </button>
          <Link className={styles.revealLink} to="/agents/connect/hosted">
            Connect a hosted client (claude.ai, ChatGPT) →
          </Link>
        </div>
      </div>
    );
  }

  // ── The mint form ──────────────────────────────────────────────────────────
  const summary = grantSummary(grantedList);
  return (
    <div className={styles.page}>
      <SubHead
        kicker="The gate"
        verdict={isRotate ? `Rotate ${preset?.agentId}` : "Mint a key"}
        sub={
          isRotate
            ? "Minting replaces this key's secret with a fresh one — the old key (and every token derived from it) stops working at once. Its grants and name carry over. You will see the new key once."
            : "Name a key, choose which sectors it opens, and set when it lapses. Granting a sector grants read and act across every provider in it — there is nothing narrower to grant. You will see the key once."
        }
      />

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (canMint) mintMut.mutate();
        }}
      >
        {/* Name */}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="agent-name">
            Name
          </label>
          <input
            id="agent-name"
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-agent"
            autoComplete="off"
            spellCheck={false}
            disabled={locked}
            readOnly={locked}
          />
          {locked ? (
            <span className={styles.fieldHint}>
              The name carries over on {isRotate ? "rotate" : "re-mint"} — one key per agent.
            </span>
          ) : null}
        </div>

        {/* Grant which sectors */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Grant which sectors</span>
          <div className={styles.toggleGrid} role="group" aria-label="Grant which sectors">
            {SECTORS.map((s) => (
              <SectorToggle key={s} sector={s} granted={granted.has(s)} onToggle={toggle} />
            ))}
          </div>
          {/* #106: "Default-deny —" named the rule for us; the clause after it already states the
              rule for the reader, so the label was doing no work on this screen. */}
          <span className={styles.fieldHint}>
            Nothing is granted until you pick it. Tap a sector to toggle it.
          </span>
          <ReadActNote granted={grantedList} />
        </div>

        {/* Expires */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Expires</span>
          <div className={styles.expiryRow} role="group" aria-label="Expires">
            {EXPIRY_OPTIONS.map((opt) => {
              const on = expiryDays === opt.days;
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={styles.expiryChip}
                  data-on={on || undefined}
                  aria-pressed={on}
                  onClick={() => setExpiryDays(opt.days)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {gateIsPublished ? (
            <span className={styles.fieldHint}>
              This gate is published. A key you paste into a hosted client should expire.
            </span>
          ) : null}
        </div>

        {/* Mint */}
        <div className={styles.submitRow}>
          <button type="submit" className={styles.primaryBtn} disabled={!canMint}>
            {mintMut.isPending ? "Minting…" : isRotate ? "Rotate the key" : "Mint the key"}
          </button>
          <span className={styles.submitNote}>
            {summary.kind === "none"
              ? "No sectors granted yet — this key would be denied everything until you edit its grants."
              : "Revoke later kills the key and every token derived from it, at once."}
          </span>
        </div>
      </form>
    </div>
  );
}
