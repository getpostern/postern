// WHAT AGENTS CAN DO HERE — the two lanes (#58, the act half this redesign exists to fix).
//
// CAN READ ← `agent_grants` (served). CAN ACT ← the action catalog, which IS NOW SERVED to the
// loopback Console (`GET /api/actions`, commit 8529bd3). The block is built in FULL and states
// whichever of the six answers is true — it is NEVER blank (shipping it blank re-commits #58), and it
// NEVER reads "none" (a claim of emptiness the wire cannot back).
//
// **The defect this file's shape now prevents (#58, round two).** The route landed serving
// `{ actions, count, truncated }`, the client still declared a bare `ActionSpec[]`, and this lane's
// producer read `.length` off it: `undefined > 0` is false, so EVERY sector lens *including Home*
// rendered "read-only, no actions" — a loud failure turned into a silent wrong answer, with no error
// anywhere. So `ActCatalog` now names all six states apart, and `truncated` is one of them:
//
//   loading         — the read is in flight. Claims nothing.
//   error           — the read FAILED (500 / 403 / network). NOT "not served", NOT "read-only".
//   not-served      — this gateway is older than the catalog route (a real state mid-deploy). Said in
//                     the reader's words, never the wire's (#106 §2c).
//   readonly        — a real, served, EMPTY catalog: this sector genuinely cannot act.
//   narrowed-empty  — a served empty answer to a NARROWING. Says nothing about the sector.
//   catalog         — specs, plus `truncated`: the cap cut an id-sorted list, so a whole trailing
//                     DOMAIN can be missing. A trimmed catalog shown as the complete one is the
//                     silent-truncation defect already removed from the MCP surface once, so the
//                     count never reads as a total and the narrowing that fixes it is offered here.

import type { ReactNode } from "react";
import { plural } from "../../api/format";
import type { ActionSpec } from "../../api/types";
import styles from "./AgentsBand.module.css";

/** One agent that can read this domain. `lastSeen` is the #89 per-agent(×sector) last-seen seam —
 *  `undefined` = the gateway did not tell us, and then the cell renders NOTHING (#106 §2a); a served
 *  string renders relative. Neither ever renders "never" — a quiet agent is not an absent one. */
export interface ReadAgent {
  agentId: string;
  /** ISO last-seen, or `undefined` when this gateway's build does not serve it. */
  lastSeen?: string | null;
  /** The already-rendered relative last-seen string when served (kept out of this pure component so
   *  it needn't tick); `null` when the value is not served. */
  lastSeenLabel: string | null;
}

/**
 * The state of the action catalog for this sector. Six arms, all reachable — see the file header for
 * why each is a separate fact rather than a shade of "no actions".
 */
export type ActCatalog =
  | { kind: "loading" }
  /** The read failed. `message` is the SERVED text, or null when the failure carried none — never invented. */
  | { kind: "error"; message: string | null }
  /** No `message`, deliberately (#106 §2c): the client's not-served sentence is OUR words about OUR
   *  wire, and a field carrying it here is how it gets printed again by the next hand. The arm itself
   *  stays — the state is real and it is not "read-only". */
  | { kind: "not-served" }
  | { kind: "readonly" }
  /** A narrowing matched nothing. A fact about the FILTER, never about the sector's capability. */
  | { kind: "narrowed-empty"; narrow: string }
  /** `truncated` MUST be rendered: it means what came back is a prefix of an id-sorted list. */
  | { kind: "catalog"; specs: ActionSpec[]; truncated: boolean };

/** The narrowing the person can apply when the cap trimmed the catalog. The value goes on the wire
 *  as the connector's `domain` filter (Home Assistant: the entity domain — light, switch, lock). */
export interface ActNarrowing {
  value: string;
  onChange: (next: string) => void;
}

export function AgentsBand({
  readAgents,
  actions,
  narrowing,
}: {
  readAgents: ReadAgent[];
  actions: ActCatalog;
  /** REQUIRED, deliberately: the surface that shows a trimmed catalog must also carry the control
   *  that un-trims it. An optional prop is how a truncation notice ships with nothing to press. */
  narrowing: ActNarrowing;
}): JSX.Element {
  return (
    <div className={styles.band}>
      <div className={styles.head}>
        <span className={styles.headLabel}>What agents can do here</span>
        <span className={styles.hairline} aria-hidden="true" />
        <span className={styles.headGloss}>granted at the domain level — read and act together</span>
      </div>

      <div className={styles.lanes}>
        <ReadLane agents={readAgents} />
        <span className={styles.laneDivider} aria-hidden="true" />
        <ActLane actions={actions} narrowing={narrowing} />
      </div>
    </div>
  );
}

function ReadLane({ agents }: { agents: ReadAgent[] }): JSX.Element {
  return (
    <div className={styles.lane}>
      <div className={styles.laneHead}>
        <span className={styles.laneLabel}>Can read</span>
        <span className={styles.laneCount}>
          {agents.length === 0 ? "no agents" : `${agents.length} agent${agents.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {agents.length === 0 ? (
        /* #100 item 10 — one phrase per concept. This read "No agent holds keys to this domain
           yet.", a third phrasing of the sector-scoped zero beside the card's "read by 0 agents"
           and the verdict's "no agent holds keys here". The count cell above ("no agents") is a
           different slot — it is parallel to "3 agents" — and stays as it is. */
        <p className={styles.laneEmpty}>No agents hold keys here.</p>
      ) : (
        agents.map((a) => (
          <div className={styles.agentRow} key={a.agentId}>
            <span className={styles.agentDot} aria-hidden="true" />
            <span className={styles.agentId}>{a.agentId}</span>
            {/* Last-seen is the #89 seam. Served → a relative "read Xm ago". Not served → nothing at
                all: it used to read "last read not served yet", on every agent row of every one of the
                six lenses (#106 §2a). "Served" is our word for our wire, and the sentence told the
                reader about our plumbing where a time was owed. Absence claims nothing, which is what
                we have; the agent's row still renders, so no reader is hidden with the value. */}
            {a.lastSeenLabel != null ? (
              <span className={styles.agentSeen}>read {a.lastSeenLabel}</span>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function ActLane({
  actions,
  narrowing,
}: {
  actions: ActCatalog;
  narrowing: ActNarrowing;
}): JSX.Element {
  let count: ReactNode = null;
  let body: ReactNode;
  // The lane's closing footnote, rendered AFTER the narrowing so the sentence that admits truncation
  // and the control that answers it are adjacent — a technical footnote wedged between them separates
  // an instruction from the thing it instructs.
  //
  // ONE arm sets it now (#106 §2c): the served reason a catalog read failed, which is the gateway's own
  // words and belongs to the reader. The two that used to set it were ours about ourselves — see the
  // `catalog` and `readonly` arms below.
  let foot: ReactNode = null;

  if (actions.kind === "catalog") {
    const n = actions.specs.length;
    // NEVER `plural(n, "action")` when the cap trimmed the list: `count` is items in THIS response,
    // not a total, and "12 actions" beside a trimmed catalog is the silent-truncation lie in one word.
    count = (
      <span className={styles.laneCount}>{actions.truncated ? `showing ${n}` : plural(n, "action")}</span>
    );
    body = (
      <div className={styles.actList}>
        {actions.specs.map((s) => (
          <div className={styles.actItem} key={s.id}>
            <span className={styles.actId}>{s.id}</span>
            <span className={styles.actDesc}>{s.description}</span>
          </div>
        ))}
        {actions.truncated ? (
          <p className={styles.actMore}>
            …and more. The gate stopped at {n}, and the list is cut in id order — so whole groups after
            the last one above may be missing entirely.
          </p>
        ) : null}
      </div>
    );
    // NO FOOTNOTE HERE, and this is a deletion rather than a rewrite (#106 §2c). It read
    // "invoke_action · target resolved from the cache (area / domain / name) · admin services
    // denylisted" — an MCP primitive, our resolution strategy, and our word for a rule, printed at 11px
    // under the one list on this surface a person might actually act on. Neither fact is theirs: how a
    // target is looked up is plumbing, and the admin-service denylist is one connector's carve-out
    // (Home Assistant's) that a sector-generic footnote cannot claim truthfully for every source. A
    // sentence that would have to overclaim to be plain is better not said here.
  } else if (actions.kind === "narrowed-empty") {
    body = (
      <p className={styles.actReadonly}>
        Nothing here is called “{actions.narrow}”. That is an answer about what you asked for, not
        about what this domain can do.
      </p>
    );
  } else if (actions.kind === "readonly") {
    // A real, served, empty catalog: the five read-only sectors. The body carries the whole fact —
    // the gate answered and its list here is empty — so the footnote that used to sit under it,
    // `actions: [ ]`, is gone (#106 §2c). It was the wire's own notation as a caption: it told a person
    // nothing the sentence above it had not already said, in a form only we can read.
    body = (
      <p className={styles.actReadonly}>
        Read-only. No actions are exposed — a granted sector still only reads here.
      </p>
    );
  } else if (actions.kind === "not-served") {
    // This gateway is older than the catalog route — a real state mid-deploy, and it must be SAID
    // (a silent lane here would imply "nothing to act on", the #58 lie). What it must not say is the
    // wire's own sentence: `NotServedError.message` reads "Not served — this gateway has no route for
    // the action catalog yet", and "not served" and "no route" are our vocabulary for our plumbing
    // (#106 §2). The client still throws exactly that — untouched — and this is the same fact in the
    // reader's words, ending where they can act: update the gate. Same voice as the inspector's schema
    // peek, deliberately: one gate, one explanation for an old build.
    body = (
      <p className={styles.actReadonly}>
        This gate is running a build from before it could list what agents can do here. Nothing is
        wrong with your data — update the gate and this will fill in.
      </p>
    );
  } else if (actions.kind === "error") {
    // An outage is NOT an absent capability (notserved.test.ts's whole distinction).
    body = <p className={styles.actReadonly}>The list of what agents can do here could not be read.</p>;
    foot = actions.message != null ? <p className={styles.actFoot}>{actions.message}</p> : null;
  } else {
    // loading — claims nothing at all about the sector.
    body = <p className={styles.laneEmpty}>Reading what agents can do here…</p>;
  }

  // The narrowing is offered exactly when it can change the answer: the cap trimmed the list, or a
  // narrowing is already applied and has to be clearable. Never drawn as decoration.
  const showNarrowing =
    (actions.kind === "catalog" && actions.truncated) ||
    narrowing.value.trim() !== "" ||
    actions.kind === "narrowed-empty";

  // The examples come OFF THE WIRE (`ActionSpec.domain`), never from a hardcoded list. "light, switch,
  // lock" is Home Assistant's vocabulary, and `domain` belongs to whichever connector serves the
  // sector — so typing its meaning into a sector-generic component would be inventing an answer for
  // every connector that is not HA. No served domains → no examples, and the label says only what it
  // knows.
  const examples =
    actions.kind === "catalog"
      ? [...new Set(actions.specs.map((s) => s.domain).filter((d): d is string => !!d))].slice(0, 3)
      : [];

  return (
    <div className={styles.lane}>
      <div className={styles.laneHead}>
        <span className={styles.laneLabel}>Can act</span>
        {count}
      </div>
      {body}
      {showNarrowing ? (
        <div className={styles.actNarrow}>
          <label className={styles.actNarrowLabel} htmlFor="act-narrow">
            Show one group in full
            {examples.length > 0 ? ` — ${examples.join(", ")}…` : ""}
          </label>
          <input
            id="act-narrow"
            type="text"
            className={styles.actNarrowInput}
            value={narrowing.value}
            onChange={(e) => narrowing.onChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {narrowing.value.trim() !== "" ? (
            <button
              type="button"
              className={styles.actNarrowClear}
              onClick={() => narrowing.onChange("")}
            >
              Show everything again
            </button>
          ) : null}
        </div>
      ) : null}
      {foot}
    </div>
  );
}
