// Erase data (confirm) — the highest-blast-radius operation in the app, on its OWN page (`640-0`).
// Owns #74 (scope connection|sector|all through <ConfirmBar>, never window.confirm) and makes the
// #17 data-loss lesson unmissable: export-first is enforced by ConfirmBar, the token is a fat-finger
// guard (not auth — loopback is the authz), and there is no undo and no import.
//
// Safety default: the LEAST-destructive scope (one connection) is selected first; the operator
// escalates to "all" deliberately. The artboard depicts the erase-everything scenario to show the
// scariest copy — it is not a mandate to default there.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Masthead } from "../../shell";
import { ConfirmBar, useToast } from "../../kit";
import { SECTORS, type EraseScope } from "../../api/types";
import { useConnectors, useInvalidateConnectors, useInvalidateData } from "../../api/hooks";
import { api } from "../../api/client";
import { humanize } from "../../api/format";
import { ERASE_SCOPES, eraseBodyFrom, eraseConsequence, eraseTargetReady } from "./erase";
import { downloadExport } from "./download";
import styles from "./EraseConfirmPage.module.css";

function TargetSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <span className={styles.selectWrap}>
      <select
        className={styles.select}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className={styles.caret} aria-hidden="true">
        ▾
      </span>
    </span>
  );
}

export function EraseConfirmPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidateData = useInvalidateData();
  const invalidateConnectors = useInvalidateConnectors();
  const { data: connectors, isLoading: connsLoading } = useConnectors();

  const [scope, setScope] = useState<EraseScope>("connection");
  const scopeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [sector, setSector] = useState("");
  const [busy, setBusy] = useState(false);

  const connectionOptions = useMemo(
    () =>
      (connectors ?? []).map((c) => ({
        value: c.connectionId,
        label: `${humanize(c.provider)} — ${humanize(c.sector)} · ${c.connectionId.slice(0, 8)}`,
      })),
    [connectors],
  );
  const sectorOptions = useMemo(
    () => SECTORS.map((s) => ({ value: s, label: humanize(s) })),
    [],
  );

  const connectionLabel = connectionOptions.find((o) => o.value === connectionId)?.label;
  const sectorLabel = sector ? humanize(sector) : undefined;

  const ready = eraseTargetReady(scope, { connectionId, sector });
  const { title, blast, verb } = eraseConsequence(scope, { sectorLabel, connectionLabel });

  function pickScope(next: EraseScope) {
    setScope(next);
    // Clear the other scope's target so a stale value never rides into the erase body.
    if (next !== "connection") setConnectionId("");
    if (next !== "sector") setSector("");
  }

  // Roving tabindex over the scope radios. `role="radiogroup"` promises exactly one tab stop and
  // arrow-key traversal; without it the group announced itself as a radiogroup and then behaved
  // like three separate buttons, which is a lie AT cannot recover from. Radios select on arrow
  // (ARIA APG) — picking a scope is local state, and the destructive step is ConfirmBar's token.
  function onScopeKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number): void {
    const last = ERASE_SCOPES.length - 1;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    pickScope(ERASE_SCOPES[next].scope);
    scopeRefs.current[next]?.focus();
  }

  async function onConfirm() {
    setBusy(true);
    try {
      await api.erase(eraseBodyFrom(scope, { connectionId, sector }));
      invalidateData(scope === "sector" ? sector : undefined);
      invalidateConnectors();
      toast.show({ message: "Erased. The data is gone; there is no undo.", tone: "ok" });
      navigate("/settings");
    } catch (e) {
      toast.show({ message: `Erase failed — ${(e as Error).message}`, tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <Link to="/settings" className={styles.back}>
        ← Settings
      </Link>

      <Masthead
        kicker="Your data"
        verdict="Erase data"
        sub="Hard-delete by scope. Export a bundle first — there is no undo and no import."
      />

      <div className={styles.scopeBlock}>
        <div className={styles.fieldLabel}>What to erase</div>
        <div className={styles.scopeGrid} role="radiogroup" aria-label="What to erase">
          {ERASE_SCOPES.map((s, i) => (
            <button
              key={s.scope}
              ref={(el) => {
                scopeRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={scope === s.scope}
              tabIndex={scope === s.scope ? 0 : -1}
              className={scope === s.scope ? `${styles.scopeCard} ${styles.scopeCardActive}` : styles.scopeCard}
              onClick={() => pickScope(s.scope)}
              onKeyDown={(e) => onScopeKeyDown(e, i)}
            >
              <span className={styles.scopeTitle}>{s.title}</span>
              <span className={styles.scopeBlurb}>{s.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      {scope === "connection" ? (
        <div className={styles.target}>
          <div className={styles.fieldLabel}>Which connection</div>
          {connsLoading ? (
            <span className={styles.pending}>Reading your connections…</span>
          ) : connectionOptions.length === 0 ? (
            <span className={styles.pending}>No connections to erase.</span>
          ) : (
            <TargetSelect
              label="Which connection to erase"
              value={connectionId}
              onChange={setConnectionId}
              options={connectionOptions}
            />
          )}
        </div>
      ) : null}

      {scope === "sector" ? (
        <div className={styles.target}>
          <div className={styles.fieldLabel}>Which sector</div>
          <TargetSelect
            label="Which sector to erase"
            value={sector}
            onChange={setSector}
            options={sectorOptions}
          />
        </div>
      ) : null}

      {ready ? (
        // KEYED BY THE ERASE TARGET (#134 fix round, F5): one slot serves every scope, and
        // requireTyped is the constant "ERASE" — so without the key, arming the seal for one
        // connection and then clicking the "Everything" scope card left an ARMED erase-everything
        // with no re-confirmation. The key makes any retarget (scope flip OR a different
        // connection/sector) a REMOUNT: typed box cleared, export gate re-closed, scrolled into
        // view again. Re-taking the export on escalation is deliberate, not incidental — the
        // scarier target re-earns both guards.
        <ConfirmBar
          key={`${scope}:${connectionId}:${sector}`}
          verb={verb}
          consequence={title}
          blastRadius={blast}
          requireTyped="ERASE"
          exportFirst={{
            label: "Export first",
            onExport: () => {
              void downloadExport().then(
                () => toast.show({ message: "Export downloaded.", tone: "ok" }),
                (e) => toast.show({ message: `Export failed — ${(e as Error).message}`, tone: "error" }),
              );
            },
          }}
          onConfirm={onConfirm}
          onCancel={() => navigate("/settings")}
          busy={busy}
        />
      ) : (
        <span className={styles.pending}>
          {scope === "connection" ? "Choose a connection to continue." : "Choose a sector to continue."}
        </span>
      )}
    </div>
  );
}
