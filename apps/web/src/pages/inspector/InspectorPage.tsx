// The inspector — the demoted, gateway-not-dashboard verification surface (build-notes §5). One
// REGISTRY-driven template, six sectors: a browsable `query()` table drilling to a truthful
// `getRecord()`. Multi-object sectors get object tabs; single-object sectors don't. Finance
// front-loads a SOURCE column and offers the includeShadowed reveal (#82).

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LedgerTable, ZeroState, type LedgerColumn, type SortState } from "../../kit";
import { api, NotServedError } from "../../api/client";
import { useDataQuery } from "../../api/hooks";
import { count as fmtCount } from "../../api/format";
import {
  isAggregateResult,
  type ObjectSchema,
  type QueryBody,
  type QueryResult,
  type Row,
} from "../../api/types";
import { analyzeColumns, renderCell } from "./cells";
import { InspectorError } from "./InspectorError";
import { listState } from "./liststate";
import { isSortable, sectorDef, type ObjectDef, type SectorDef } from "./registry";
import { useDebounced } from "./useDebounced";
import shared from "./inspector.module.css";
import styles from "./InspectorPage.module.css";

const PAGE_SIZE = 25;

/** The tab/tabpanel id pair for one object. A `role="tab"` with no `aria-controls` and no
 *  `role="tabpanel"` anywhere announces "tab, 1 of 3, selected" with nowhere to move (a11y sweep) —
 *  these two ids are what make the relationship real. */
const tabId = (sector: string, key: string): string => `inspector-tab-${sector}-${key}`;
const panelId = (sector: string, key: string): string => `inspector-panel-${sector}-${key}`;

/** Pull the total out of a count-aggregate result (`groups: [{ value }]`), else undefined. */
function totalOf(data: QueryResult | undefined): number | undefined {
  if (!data || !isAggregateResult(data)) return undefined;
  const raw = data.groups[0]?.value;
  return raw == null ? 0 : Number(raw);
}

/** The SERVED failure text, or null. Never `String(e)` — a non-Error rejection would put
 *  "[object Object]" on screen — and never an invented sentence. */
function msgOf(e: unknown): string | null {
  return e instanceof Error && e.message ? e.message : null;
}

export function InspectorPage(): JSX.Element {
  const { sector = "" } = useParams();
  const def = sectorDef(sector);
  if (!def) {
    return (
      <div className={shared.page}>
        <div className={shared.notFound}>Unknown sector — <Link to="/">back to the Gatehouse</Link>.</div>
      </div>
    );
  }
  return <InspectorBody def={def} />;
}

function InspectorBody({ def }: { def: SectorDef }): JSX.Element {
  const navigate = useNavigate();
  const [objectKey, setObjectKey] = useState(def.objects[0].key);
  const object = def.objects.find((o) => o.key === objectKey) ?? def.objects[0];
  const tabbed = def.objects.length > 1;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Roving tabindex with MANUAL activation (ARIA APG): arrows move focus, Enter/Space selects.
  // Automatic activation is wrong here — selecting an object remounts the table and fires three
  // query() reads, so arrowing across three tabs would fire nine.
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number): void {
    const last = def.objects.length - 1;
    let next: number;
    if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <div className={shared.page}>
      <Link to={`/sectors/${def.sector}`} className={shared.back}>
        ← {def.title}
      </Link>

      <header className={shared.masthead}>
        <div className={shared.eyebrow}>Inspect · {def.sector}</div>
        <h1 className={shared.title}>The records</h1>
        <p className={shared.subtitle}>{def.subtitle}</p>
      </header>

      {tabbed ? (
        <div className={styles.tabs} role="tablist" aria-label="Objects">
          {def.objects.map((o, i) => {
            const active = o.key === object.key;
            return (
              <button
                key={o.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                id={tabId(def.sector, o.key)}
                type="button"
                role="tab"
                aria-selected={active}
                /* ONLY the selected tab carries `aria-controls`. Exactly one panel is rendered —
                   the unselected objects have no element — so giving every tab its own panel id
                   produced a DANGLING IDREF on every tab but one: invalid ARIA
                   (`aria-valid-attr-value`), and worse than the absent relationship it replaced,
                   because it reads as a promise. Caught at review 2026-07-25. The alternative is
                   rendering all panels with `hidden`, which costs a query per object. */
                {...(active ? { "aria-controls": panelId(def.sector, o.key) } : {})}
                tabIndex={active ? 0 : -1}
                className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                onClick={() => setObjectKey(o.key)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
              >
                {o.tabLabel}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The tabpanel needs a box, and `ObjectTable` is a fragment — so the wrapper reuses the
          page stack (`shared.page`: flex column, the same 26px gap) rather than declaring a second
          one. That keeps the rhythm of the four rows below byte-identical to before the box existed. */}
      <div
        className={shared.page}
        {...(tabbed
          ? {
              id: panelId(def.sector, object.key),
              role: "tabpanel",
              "aria-labelledby": tabId(def.sector, object.key),
            }
          : {})}
      >
        {/* Remounting per object resets sort/filter/page — each object is its own table. */}
        <ObjectTable key={object.key} def={def} object={object} onOpen={(id) =>
          navigate(`/sectors/${def.sector}/inspect/${encodeURIComponent(id)}?object=${encodeURIComponent(object.key)}`)
        } />
      </div>
    </div>
  );
}

/**
 * #82 — the published read contract for THIS object, as an agent receives it.
 *
 * The control it replaces was drawn struck-through and disabled, with the reason *"the published read
 * schema is on the bearer-gated agent mirror, and the Console carries no agent key"* — the exact
 * anti-pattern #106 names: our vocabulary, not the reader's, explaining a limit they cannot act on.
 * `get_schema` is served to the loopback Console now (`GET /api/operator/schema`, commit 8529bd3), so
 * the control works. The read is `enabled` only once it is opened: a schema nobody asked to see is not
 * worth a round trip on every inspector paint.
 *
 * The three ways it can still come back short, each stated in plain words and none of them synthesised:
 *   · the gateway has no such route (an older build) → `NotServedError`;
 *   · the read failed → the SERVED message, never an invented cause;
 *   · the answer carries nothing for this object → said as such, not rendered as an empty schema.
 */
function SchemaPeek({ objectKey }: { objectKey: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["operator-schema", objectKey],
    queryFn: () => api.getSchema(objectKey.split(".")[0]),
    enabled: open,
    retry: false,
    staleTime: Infinity,
  });

  // `SchemaResult` is keyed by REGISTRY key, so a multi-object sector answers for all of its objects
  // and this picks the one on screen. `{}` is a real answer ("nothing here for you"), never an error.
  const schema: ObjectSchema | undefined = q.data?.[objectKey];
  const fields = schema ? Object.entries(schema.fields) : [];

  return (
    <div className={styles.degraded}>
      <button
        type="button"
        className={styles.schemaBtn}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "Hide the schema" : "View schema — as an agent sees it"}
      </button>
      {/* Deliberately does NOT repeat the object's noun: the count line one row up already says
          "2 envelopes", and two elements carrying the same word is a surface where neither a person
          nor a test can tell which one they are reading. */}
      <span className={styles.degradedReason}>
        The exact field list an agent gets here, straight from the gate.
      </span>

      {open ? (
        <div className={styles.schemaPanel}>
          {q.isPending ? (
            <div className={styles.schemaNote}>Asking the gate…</div>
          ) : q.error instanceof NotServedError ? (
            // Plain words, not "no route for get_schema": what a person can do about it is upgrade
            // the box, and that is what the sentence says.
            <div className={styles.schemaNote}>
              This gate is running a build from before it could show the Console what an agent sees.
              Nothing is wrong with your data — update the gate and this will fill in.
            </div>
          ) : q.isError ? (
            <div className={styles.schemaNote}>
              The gate could not answer.
              {q.error instanceof Error && q.error.message ? ` ${q.error.message}` : ""}
            </div>
          ) : schema === undefined ? (
            <div className={styles.schemaNote}>
              The gate returned no field list for <code>{objectKey}</code>.
            </div>
          ) : (
            <>
              <div className={styles.schemaHead}>
                {schema.object} · table <code>{schema.table}</code>
                {schema.primaryTime ? (
                  <>
                    {" · ordered by "}
                    <code>{schema.primaryTime}</code>
                  </>
                ) : null}
              </div>
              <dl className={styles.schemaFields}>
                {fields.map(([name, type]) => (
                  <div className={styles.schemaField} key={name}>
                    <dt className={styles.schemaName}>{name}</dt>
                    <dd className={styles.schemaType}>{type}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ObjectTable({
  def,
  object,
  onOpen,
}: {
  def: SectorDef;
  object: ObjectDef;
  onOpen: (id: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const isFinance = def.sector === "finance";
  const [filterRaw, setFilterRaw] = useState("");
  const [offset, setOffset] = useState(0);
  const [includeShadowed, setIncludeShadowed] = useState(false);
  const [sort, setSort] = useState<SortState>({ field: object.primaryTime, dir: "desc" });

  const filter = useDebounced(filterRaw.trim(), 250);

  // The served where-clause: a single `contains` on the object's filter field. Real query() operator,
  // not a synthesised search index.
  const where = useMemo(() => {
    if (!filter || !object.filterField) return undefined;
    return { [object.filterField]: { contains: filter } };
  }, [filter, object.filterField]);

  const shadowedOpt = isFinance && includeShadowed ? { includeShadowed: true } : {};

  const rowsBody: QueryBody = useMemo(
    () => ({
      ...(where ? { where } : {}),
      orderBy: [{ field: sort.field, dir: sort.dir }],
      limit: PAGE_SIZE,
      offset,
      ...shadowedOpt,
    }),
    [where, sort.field, sort.dir, offset, isFinance, includeShadowed],
  );

  const filteredCountBody: QueryBody = useMemo(
    () => ({ aggregate: { fn: "count" }, ...(where ? { where } : {}), ...shadowedOpt }),
    [where, isFinance, includeShadowed],
  );

  const storeCountBody: QueryBody = useMemo(
    () => ({ aggregate: { fn: "count" }, ...shadowedOpt }),
    [isFinance, includeShadowed],
  );

  const rowsQ = useDataQuery(object.key, rowsBody);
  const filteredCountQ = useDataQuery(object.key, filteredCountBody);
  // Only a distinct query when a filter narrows the set; otherwise the store total IS the filtered one.
  const storeCountQ = useDataQuery(object.key, where ? storeCountBody : filteredCountBody);

  const rows: Row[] = rowsQ.data && "rows" in rowsQ.data ? rowsQ.data.rows : [];
  const filteredTotal = totalOf(filteredCountQ.data);
  const storeTotal = totalOf(storeCountQ.data);

  const { visible, sparse } = useMemo(() => analyzeColumns(object.columns, rows), [object.columns, rows]);

  const columns: LedgerColumn<Row>[] = visible.map((col) => ({
    field: col.field,
    header: sparse.has(col.field) ? <span className={styles.sparseHead}>{col.header}</span> : col.header,
    render: (r) => renderCell(col, r),
    width: col.width,
    align: col.align,
    sortable: isSortable(col),
  }));

  function onSort(field: string): void {
    setOffset(0);
    setSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "desc" }));
  }

  function changeFilter(v: string): void {
    setFilterRaw(v);
    setOffset(0);
  }

  const shown = rows.length;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const hasNext = filteredTotal != null && to < filteredTotal;
  const hasPrev = offset > 0;

  // ── the list state (#100 item 1) ──
  //
  // This used to be a TWO-way choice on `storeTotal === 0`, with no `isError` branch anywhere. A
  // failed query() leaves rows=[] and storeTotal=undefined, so an OUTAGE fell into the else and
  // rendered "Nothing matches that filter" over an empty <code></code> with "Total not served"
  // beneath — the Console reporting "you have no data" for "we could not read it", and offering no
  // retry because there was no state to hang one on. `listState` is the whole precedence, tested on
  // its own; everything below is a render of its answer.
  const state = listState({
    isError: rowsQ.isError,
    isPending: rowsQ.isPending,
    rowCount: rows.length,
    storeTotal,
    filter,
  });

  /** The ONLY retry in the four empty states — and it re-reads all three queries, because all three
   *  are what a page needs to stop being an outage. */
  const retry = (): void => {
    void rowsQ.refetch();
    void filteredCountQ.refetch();
    void storeCountQ.refetch();
  };

  // An empty store (nothing cached for this object) is a different sentence from a filter that
  // matched nothing, which is a different sentence again from a page that came back empty with no
  // filter set. `counting` deliberately renders NOTHING: a page that has not counted yet has no
  // claim to make about the store, and "nothing matches" before the count lands is the same lie in
  // miniature.
  const empty =
    state === "store-empty" ? (
      <ZeroState
        headline={`No ${object.noun} cached yet`}
        reason={`Nothing has synced into ${def.title.toLowerCase()} · ${object.tabLabel.toLowerCase()} yet.`}
        kind="unconnected"
        action={{ label: "Connect a source", onAct: () => navigate("/connect") }}
      />
    ) : state === "filter-empty" ? (
      <ZeroState
        headline="Nothing matches that filter"
        reason={<>No {object.noun} match <code>{filter}</code>.</>}
        kind="filtered"
        totalHeld={storeTotal ?? null}
        freshnessLine={null}
      />
    ) : state === "page-empty" ? (
      // No <code> here — this is the branch that used to render an empty one.
      <ZeroState
        headline="Nothing on this page"
        reason={`The store holds ${fmtCount(storeTotal ?? 0)} ${object.noun}, but this page came back empty.`}
        kind="filtered"
        totalHeld={storeTotal ?? null}
        freshnessLine={null}
      />
    ) : undefined;

  return (
    <>
      <div className={styles.toolbar}>
        {object.filterField ? (
          <input
            type="text"
            className={styles.filter}
            placeholder={object.filterPlaceholder}
            value={filterRaw}
            onChange={(e) => changeFilter(e.target.value)}
            aria-label={object.filterPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <div className={styles.filterSpacer} />
        )}
        <div className={styles.grow} />
        {isFinance ? (
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={includeShadowed}
              onChange={(e) => {
                setIncludeShadowed(e.target.checked);
                setOffset(0);
              }}
            />
            Show provider rows behind merges
          </label>
        ) : null}
        {/* Under an outage this used to tick "…" forever — a permanent loading lie over a read that
            already failed. A count we could not read is "count unavailable", full stop. */}
        <div className={styles.count}>
          {rowsQ.isError || filteredCountQ.isError
            ? "count unavailable"
            : filteredTotal == null
              ? "…"
              : `${fmtCount(filteredTotal)} ${object.noun}`}
        </div>
      </div>

      {/* #82 / #57 — "View schema — as an agent sees it" IS REACHABLE NOW (`GET /api/operator/schema`),
          so it is a working control rather than a struck-through one. The operator's question about the
          old version was literally *"why is this even here"*, and the answer to a control that can never
          be pressed is to press it, not to redraw the strikethrough.
          Still suppressed under an outage: two "not available" notices stacked bury the one that matters. */}
      {state === "error" ? null : <SchemaPeek objectKey={object.key} />}

      {state === "error" ? (
        // IN PLACE OF the table, not inside its `empty` slot: column headers above an outage are
        // furniture, and role="alert" inside role="table" is invalid ARIA.
        <InspectorError noun={object.noun} message={msgOf(rowsQ.error)} onRetry={retry} />
      ) : (
        <LedgerTable
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.id ?? r.source_object_id ?? "")}
          onOpen={(r) => onOpen(String(r.id ?? ""))}
          sort={sort}
          onSort={onSort}
          loading={rowsQ.isPending}
          empty={empty}
        />
      )}

      {/* No pager under an outage — a "0 of …" row beneath a failed read is furniture too. */}
      {state === "error" ? null : (
        <div className={styles.pager}>
          <div className={styles.pagerInfo}>
            {filteredTotal == null
              ? "…"
              : shown === 0
                ? `0 of ${fmtCount(filteredTotal)}`
                : `Showing ${fmtCount(from)}–${fmtCount(to)} of ${fmtCount(filteredTotal)}`}
          </div>
          <div className={styles.grow} />
          {hasPrev ? (
            <button
              type="button"
              className={styles.pagerBtn}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              ← Newer
            </button>
          ) : null}
          {hasNext ? (
            <button
              type="button"
              className={styles.pagerBtn}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Older →
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
