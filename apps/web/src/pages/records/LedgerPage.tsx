// The ledger — the append-only audit trail as entry rows (printed timestamps, hairlines, not cards).
// Ported from `2QU-0`. It owns three findings:
//   #61 — first-class filters bound to the SERVED params (agent · tool · SECTOR · decision · since) and
//         a real KEYSET pager. Both halves of this finding were honestly degraded for weeks and both
//         degradations are now obsolete: `?sector=` is a real equality clause, and the gateway mints a
//         cursor in its response headers, so "older entries cannot be reached from here" is retired
//         along with the limit ladder (100 → 250 → 500 → 1,000) that used to stand in for a pager.
//   #78 — a per-row drill; the THIRD decision state (an allowed-but-errored call is not a green
//         "allow" — see DecisionPill / decisionState); and an export of the FILTERED view. The export
//         was the sub-finding `coverage.md` wrongly recorded as shipped for weeks: until it landed the
//         page held exactly two controls, the decision chips and Load more.
//   #72 — the dead ⌘K box is simply never drawn (it lived in the old Shell; the new shell has none).
//
// The Decision column is EXCEPTIONS-ONLY (§17.5). It used to print "Admitted" on every admitted row
// — five of seven — and a column whose value is the same on ~95% of rows carries no information
// while burying the two rows that matter; `Denied` and `Errored` now stand alone in an otherwise
// empty lane. The record is not lost: the per-row drill still names all three states. The
// **Admitted filter chip stays** — a filter is a query the API serves, which is a different thing
// from a label repeated down a page.
//
// PAGER FORM. Paper's `2YK-0` draws a two-direction pager ("← Newer" · "Older →") over a quoted total.
// Neither survives contact with the wire, and the divergence is deliberate: there is no total on this
// route (the body is a bare row array), and a keyset cursor only ever walks in ONE direction — the
// server mints a "continue from here" marker and no going-back marker. Loading forward keeps every row
// already read on the page, so there is nothing to go back TO, and it is what lets the export stay
// exactly "the view" while the view grows to the whole trail. "Load more ↓" carries `2YK-0`'s seal
// accent from "Older →" verbatim.

import { Fragment, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Masthead } from "../../shell";
import { LedgerTable, type LedgerColumn } from "../../kit";
import { SectorChip } from "../../marks";
import { api } from "../../api/client";
import { isSector, type AuditFilters, type AuditPage, type AuditRow } from "../../api/types";
import { AUDIT_POLL_MS, useAgents } from "../../api/hooks";
import { count } from "../../api/format";
import { DecisionPill } from "./DecisionPill";
import { LedgerDetail } from "./LedgerDetail";
import {
  AUDIT_TOOLS,
  DECISION_FILTERS,
  LEDGER_PAGE_SIZE,
  SECTOR_FILTERS,
  SINCE_PRESETS,
  argsCell,
  auditRowsToCsv,
  decisionFilterParam,
  ledgerExportFilename,
  ledgerExportNote,
  ledgerReach,
  ledgerStamp,
  sectorFilterCaveat,
  sinceParam,
  type DecisionFilter,
  type SincePreset,
} from "./ledger";
import { downloadTextFile } from "./download";
import styles from "./LedgerPage.module.css";

/** A native <select> dressed as the drawn pill — keyboard-operable, no custom listbox to mishandle. */
function Pick({
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

export function LedgerPage(): JSX.Element {
  const [agent, setAgent] = useState("");
  const [tool, setTool] = useState("");
  const [sector, setSector] = useState("");
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [sincePreset, setSince] = useState<SincePreset>("any");
  const [selected, setSelected] = useState<AuditRow | null>(null);

  // `now` is captured only when the preset changes, so the query key is stable across renders.
  const since = useMemo(() => sinceParam(sincePreset), [sincePreset]);

  const filters: AuditFilters = useMemo(() => {
    const f: AuditFilters = { limit: LEDGER_PAGE_SIZE };
    if (agent) f.agent = agent;
    if (tool) f.tool = tool;
    if (sector) f.sector = sector;
    const d = decisionFilterParam(decision);
    if (d) f.decision = d;
    if (since) f.since = since;
    return f;
  }, [agent, tool, sector, decision, since]);

  /**
   * The keyset walk. Each page is `api.auditPage(filters + before?)`, and the cursor handed back is the
   * gateway's own header value — `ledgerReach` is the ONE place that decides whether there is a next
   * page, so the Load more button and the fetch can never disagree about it.
   *
   * `hasNextPage` is deliberately NOT used for that decision: it is a boolean, and this wire has three
   * facts. A gateway that sends no has-more header would arrive as `hasNextPage: false` — the exact
   * collapse of "nobody knows" into "you have reached the end of your own record" that #61 forbids.
   *
   * `filters` is the whole query key, so changing any filter starts a FRESH walk from the newest page:
   * a cursor minted under one filter must never be replayed under another.
   */
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["audit", "keyset", filters] as const,
    queryFn: ({ pageParam }) =>
      api.auditPage(pageParam == null ? filters : { ...filters, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditPage) => {
      const reach = ledgerReach(last);
      return reach.kind === "more" ? reach.cursor : undefined;
    },
    // The ledger's 30s poll is kept ONLY while a single page is loaded. Refetching an infinite query
    // re-reads every loaded page, so polling at page eight would fire eight requests every 30 seconds
    // and re-walk history under the reader. The head is the watched screen; walking back is a
    // deliberate act, and a deliberate act should not be undone on a timer.
    refetchInterval: (q) => ((q.state.data?.pages.length ?? 1) > 1 ? false : AUDIT_POLL_MS),
    staleTime: 0,
  });

  const { data: agents } = useAgents();

  const agentOptions = useMemo(
    () => [
      { value: "", label: "All agents" },
      ...(agents ?? []).map((a) => ({ value: a.agentId, label: a.agentId })),
    ],
    [agents],
  );
  const toolOptions = useMemo(
    () => [{ value: "", label: "All tools" }, ...AUDIT_TOOLS.map((t) => ({ value: t, label: t }))],
    [],
  );

  const filtersActive =
    Boolean(agent) || Boolean(tool) || Boolean(sector) || decision !== "all" || sincePreset !== "any";

  // Every page walked so far, oldest page last — the accumulated view, which is also the export.
  const list = useMemo(() => (data?.pages ?? []).flatMap((p) => p.rows), [data]);
  const lastPage = data?.pages[data.pages.length - 1];
  const reach = lastPage ? ledgerReach(lastPage) : null;
  const sectorCaveat = sectorFilterCaveat(sector);

  // #78 — the export is of the FILTERED VIEW: `list` is every row this walk has loaded and exactly what
  // the table is showing, so the file and the screen cannot disagree. It deliberately does NOT re-read
  // the trail, and it does NOT walk the remaining pages behind the reader's back: an export that
  // quietly widens to everything is the #74 complaint this repo already fixed. The pager is what grows
  // the view; the export just takes it.
  //
  // No audit write rides along. Audit is async and detective by invariant, and this is a client-side
  // download of rows the gateway already served and already recorded serving — there is nothing to
  // await and nothing new to record.
  // The note is rendered INSIDE the pager, where `reach` is non-null by construction. A
  // `reach?.kind ?? "unknown"` default up here would be a branch no test can reach — no page in hand
  // means no rows, and then the pager is not drawn at all — and correct-looking code behind a guard that
  // cannot fail is this repo's signature defect. The honest fix is to make the state impossible rather
  // than to defend it: mutating that default to `"end"` left the whole suite GREEN, which is how it was
  // found.
  const onExport = () =>
    downloadTextFile(ledgerExportFilename(), "text/csv;charset=utf-8", auditRowsToCsv(list));

  const columns: LedgerColumn<AuditRow>[] = [
    {
      field: "created_at",
      header: "Time",
      // 94px → 140px: the cell now carries the local calendar day as well as the clock (#100 item 9).
      // A date per row, NOT day-separator rows: a separator is a `LedgerTable` capability (it maps
      // `rows` 1:1 and gives `render` no index) and `kit/` is not owned here — and a repeated date
      // survives sorting and filtering, which a separator does not.
      width: "140px",
      render: (r) => {
        const s = ledgerStamp(r.created_at);
        return (
          <>
            <span className={styles.monoDate}>{s.date}</span>
            <span className={styles.monoTime}>{s.time}</span>
          </>
        );
      },
    },
    {
      field: "agent_id",
      // "Who", not "Agent" (#106 §4). `agent_id` is null for a call the person made from this Console
      // and `RecentPassage` substitutes the documented `operator` sentinel for it, so the column headed
      // "Agent" was labelling the owner of the gate one of the visiting agents. The DATA was always
      // honest; the header was not.
      header: "Who",
      width: "128px",
      render: (r) => <span className={styles.mono}>{r.agent_id ?? "—"}</span>,
    },
    {
      field: "tool",
      header: "Tool",
      width: "148px",
      render: (r) => <span className={styles.mono}>{r.tool}</span>,
    },
    {
      field: "sector",
      header: "Sector",
      width: "104px",
      render: (r) =>
        r.sector && isSector(r.sector) ? (
          <span className={styles.sectorCell}>
            <SectorChip sector={r.sector} />
            <span className={styles.sectorName}>{r.sector}</span>
          </span>
        ) : (
          <span className={styles.sectorNone}>—</span>
        ),
    },
    {
      field: "args",
      header: "Args",
      // `argsCell`, not `formatArgs`: a key whose value is null tells a reader nothing, and the row
      // already carries the sector in its own column (#106 §4). The EXPORT still uses `formatArgs` —
      // an archive keeps what the gate recorded.
      render: (r) => <span className={styles.args}>{argsCell(r.args)}</span>,
    },
    {
      field: "decision",
      header: "Decision",
      width: "110px",
      align: "right",
      render: (r) => <DecisionPill row={r} alignRight exceptionsOnly />,
    },
  ];

  const emptyNode = isError ? undefined : (
    <span className={styles.ceiling}>
      {filtersActive
        ? "No entries match these filters. The trail has no total to quote — say what you searched, not what you assume."
        : "Nothing has come through the gate yet. Every read and action will be recorded here."}
    </span>
  );

  return (
    <div className={styles.page}>
      <Masthead
        kicker="The gate"
        verdict="The ledger"
        sub="Every read and action, recorded off the hot path. The only oversight — detective, never preventive. Nothing here blocked anything at the door; everything here is remembered."
      />

      <div className={styles.filterBar}>
        <div className={styles.filters}>
          <Pick label="Filter by agent" value={agent} onChange={setAgent} options={agentOptions} />
          <Pick label="Filter by tool" value={tool} onChange={setTool} options={toolOptions} />
          {/* #61 part 1. The API silently ignored `?sector=` when this page was ported, so drawing the
              control would have been a query that narrowed nothing; it is a real equality clause now. */}
          <Pick
            label="Filter by sector"
            value={sector}
            onChange={setSector}
            options={SECTOR_FILTERS}
          />
          <Pick
            label="Since"
            value={sincePreset}
            onChange={(v) => setSince(v as SincePreset)}
            options={SINCE_PRESETS}
          />
          <span className={styles.spacer} />
          <div className={styles.toggle} role="group" aria-label="Filter by decision">
            {DECISION_FILTERS.map((f, i) => (
              <Fragment key={f.value}>
                {i > 0 ? <span className={styles.segDivider} aria-hidden="true" /> : null}
                <button
                  type="button"
                  className={
                    styles.seg +
                    (decision === f.value ? ` ${styles.segActive}` : "") +
                    (f.value === "deny" ? ` ${styles.segDeny}` : "")
                  }
                  aria-pressed={decision === f.value}
                  onClick={() => setDecision(f.value)}
                >
                  {f.label}
                </button>
              </Fragment>
            ))}
          </div>
        </div>
        {/* Only when a sector is chosen: equality never matches NULL, so the gate-wide calls leave the
            view. Said once, where the filter was set — not left for the reader to notice. */}
        {sectorCaveat ? <p className={styles.ceiling}>{sectorCaveat}</p> : null}
      </div>

      {selected ? <LedgerDetail row={selected} onClose={() => setSelected(null)} /> : null}

      {isError ? (
        <p className={styles.loadError}>
          The ledger could not be read — {(error as Error)?.message ?? "the gate did not answer"}.
        </p>
      ) : (
        <LedgerTable
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          onOpen={(r) => setSelected(r)}
          loading={isLoading}
          empty={emptyNode}
        />
      )}

      {!isError && !isLoading && reach && list.length > 0 ? (
        <div className={styles.pager}>
          <div className={styles.pagerRow}>
            <span className={styles.pagerCount} id="ledger-reach">
              showing {count(list.length)}
              {/* The SERVED end, so it is a statement and not a guess — and it is the disabled control's
                  REASON, which is why the control points at this span. Paper's `2YK-0` quotes a total
                  here ("40,912 entries · showing 7"); this route serves no total, and inventing one
                  from what is loaded would be the same lie in smaller print. */}
              {reach.kind === "end" ? " · the end of the trail" : ""}
            </span>
            <span className={styles.pagerActions}>
              {/* ALWAYS drawn, and disabled with its reason whenever the walk cannot continue — `end`
                  points at the count line beside it, `unknown` at the paragraph below. Removing it
                  instead would cost two things: a keyboard user who reaches the last page loses focus
                  to <body> mid-task, and an absent control reads as "there is nothing more" on a
                  gateway that never said so. Paper's `2YK-0` agrees on form — the direction you cannot
                  travel ("← Newer" at the head of the trail) is drawn FADED, not deleted, which is what
                  `.loadMore:disabled` has been carrying all along. */}
              <button
                type="button"
                className={styles.loadMore}
                onClick={() => void fetchNextPage()}
                disabled={reach.kind !== "more" || isFetchingNextPage}
                aria-describedby={
                  reach.kind === "unknown"
                    ? "ledger-reach-reason"
                    : reach.kind === "end"
                      ? "ledger-reach"
                      : undefined
                }
              >
                Load more ↓
              </button>
              {/* "Export CSV", not Settings' bare "Export": there are two exports in this Console and
                  they answer different questions — the bundle is everything, this is this view. */}
              <button
                type="button"
                className={styles.exportBtn}
                onClick={onExport}
                aria-describedby="ledger-export-note"
              >
                Export CSV
              </button>
            </span>
          </div>
          {reach.kind === "unknown" ? (
            <p id="ledger-reach-reason" className={styles.ceiling}>
              {reach.reason}
            </p>
          ) : null}
          {/* What the FILE will hold, said where the person clicks — and wired to the button by
              `aria-describedby` so a screen-reader user is told it too, not only a sighted one. */}
          <p id="ledger-export-note" className={styles.exportNote}>
            {ledgerExportNote({ shown: list.length, reach: reach.kind })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
