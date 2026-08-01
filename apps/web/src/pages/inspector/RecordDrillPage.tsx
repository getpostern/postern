// The record drill (build-notes §5.2) — the ONE place `raw` is shown, verbatim. Three sections:
// Normalized (the REGISTRY scalars), Provenance (connection · soid · ingested · tombstone · dedup),
// Raw (the provider's own payload). It MIRRORS the stored row; it never summarises or derives.

import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Skeleton } from "../../kit";
import { api, NotServedError } from "../../api/client";
import { useConnectors, useRecord } from "../../api/hooks";
import { humanize } from "../../api/format";
import type { Row } from "../../api/types";
import { normalizedEntries, provenanceEntries, recordHeadline, recordSubtitle } from "./record";
import { sectorDef } from "./registry";
import shared from "./inspector.module.css";
import styles from "./RecordDrillPage.module.css";

/**
 * The outcome of ONE live drill (#57). Deliberately not folded into the cached record: the whole point
 * of the issue is that a live fetch must never be presentable as a cache refetch, so what came back
 * from the source is rendered in its OWN labelled block beside the cached copy, and the cached block is
 * never overwritten. `record: null` is a real answer — the source says the object is gone.
 */
type LiveDrill =
  | { ok: true; record: unknown }
  | { ok: false; reason: string };

export function RecordDrillPage(): JSX.Element {
  const { sector = "", id = "" } = useParams();
  const [params] = useSearchParams();

  // The drill needs the exact REGISTRY object key (a bare multi-object sector would 500 in getRecord).
  // The list passes ?object=; single-object sectors fall back to their one object.
  const def = sectorDef(sector);
  const objectKey = params.get("object") ?? def?.objects[0]?.key ?? sector;

  const recordQ = useRecord(objectKey, id);
  const connectorsQ = useConnectors();

  // ── #57 — the per-record live drill ──
  //
  // `POST /api/operator/fetch_live` is served to the loopback Console now, so the affordance that used
  // to be drawn permanently disabled ("fetching live from the source is on the bearer-gated agent
  // mirror") does the thing it names. Two rules the issue turns on:
  //   · the drill is NEVER a cache refetch. It does not invalidate `useRecord`, and it does not touch
  //     the cached blocks — a live answer gets its own labelled block. Record mode does not write to
  //     the store server-side either, so there is nothing to re-read.
  //   · the gateway can answer a whole-sector SYNC if the `id` failed to reach it (the route body is
  //     `.strict()`, so that would be a 400 — but a future shape change must not silently degrade a
  //     drill into a sync while this page keeps the "live" label on it). That case is reported as a
  //     failure, not shown as this record fetched live.
  const [live, setLive] = useState<LiveDrill | null>(null);
  const [fetching, setFetching] = useState(false);

  async function onFetchLive(): Promise<void> {
    setFetching(true);
    setLive(null);
    try {
      const res = await api.fetchLive(objectKey, { id });
      if (res.mode !== "record") {
        setLive({
          ok: false,
          reason:
            "The gate ran a whole-sector sync instead of fetching this one entry, so nothing here came from the source just now.",
        });
        return;
      }
      setLive({ ok: true, record: res.record });
    } catch (err) {
      setLive({
        ok: false,
        reason:
          err instanceof NotServedError
            ? // Plain words: "no route for fetch_live" is our vocabulary, not the reader's (#106).
              "This gate is running a build from before it could go out to the source for one entry. Update the gate and this will work."
            : err instanceof Error && err.message
              ? err.message // the SERVED reason — including "live record fetch not supported for <provider>"
              : "The source did not answer.",
      });
    } finally {
      setFetching(false);
    }
  }

  const record = (recordQ.data?.record as Row | undefined) ?? undefined;

  const providerLabel = useMemo(() => {
    if (!record) return null;
    const cid = record.connection_id;
    if (cid == null) return null;
    const conn = connectorsQ.data?.find((c) => c.connectionId === cid);
    return conn ? humanize(conn.provider) : null;
  }, [record, connectorsQ.data]);

  const backTitle = def?.title ?? sector;

  if (recordQ.isPending) {
    return (
      <div className={shared.page}>
        <Link to={`/sectors/${sector}/inspect`} className={shared.back}>
          ← {backTitle} · records
        </Link>
        <Skeleton lines={3} />
      </div>
    );
  }

  if (recordQ.isError || !record) {
    return (
      <div className={shared.page}>
        <Link to={`/sectors/${sector}/inspect`} className={shared.back}>
          ← {backTitle} · records
        </Link>
        <div className={shared.notFound}>
          No record found for <code>{id}</code> in <code>{objectKey}</code>.
        </div>
      </div>
    );
  }

  const headline = recordHeadline(objectKey, record);
  const subtitle = recordSubtitle(objectKey, record, providerLabel);
  const normalized = normalizedEntries(record);
  const provenance = provenanceEntries(record, providerLabel, connectorsQ.isPending);
  const rawValue = record.raw;
  const isMail = objectKey === "mail";

  const rawText =
    rawValue == null
      ? null
      : typeof rawValue === "string"
        ? rawValue
        : JSON.stringify(rawValue, null, 2);

  return (
    <div className={shared.page}>
      <Link to={`/sectors/${sector}/inspect`} className={shared.back}>
        ← {backTitle} · records
      </Link>

      <header className={shared.masthead}>
        <div className={shared.eyebrow}>Record · {objectKey}</div>
        <h1 className={shared.title}>{headline}</h1>
        <p className={styles.recordSub}>{subtitle}</p>
      </header>

      <div className={styles.columns}>
        <div className={styles.left}>
          <div className={styles.group}>
            <Section title="Normalized" />
            <dl className={styles.fields}>
              {normalized.map((e) => (
                <FieldRow key={e.key} k={e.key} v={e.value} />
              ))}
            </dl>
          </div>

          <div className={styles.group}>
            <Section title="Provenance" />
            <dl className={styles.fields}>
              {provenance.map((e) => (
                <FieldRow key={e.key} k={e.key} v={e.value} muted={e.muted} />
              ))}
            </dl>
          </div>
        </div>

        <div className={styles.right}>
          <Section title="Raw · as the provider returned it" />
          {rawText == null ? (
            /* #106 §1 — this said "null — this is a synthetic union row. Drill its pristine provider
               rows for their raw payloads." Every noun in it was ours: `union:` is a reserved
               `source_object_id` namespace (ADR 0021), "pristine" is the dedup code's word for the
               untouched provider rows, and "drill" is this page's own name for itself. The fact is
               ordinary and the reader's: this entry is the one Postern serves for an account two
               providers both report, so it has no provider payload of its own — the ones behind it do.
               "Merged" is the word every other finance surface already uses for it. */
            <div className={styles.rawEmpty}>
              No payload — this entry is the merged one Postern serves for an account more than one
              provider reports, so it has none of its own. Open the rows behind the merge to read
              theirs.
            </div>
          ) : (
            <div className={styles.rawScroll}>
              <pre className={styles.raw}>{rawText}</pre>
            </div>
          )}
          <p className={styles.rawCaption}>
            The faithful cache — the provider's own payload, normalized on top. Postern stores and
            serves; it never derives.
          </p>

          {/* #57 — the per-record live drill, WIRED. The button reaches the source; whatever comes
              back is rendered below as its own thing, so a live answer can never be mistaken for the
              cached copy above (and the cached copy is never replaced by one). */}
          <div className={styles.liveDrill}>
            <button
              type="button"
              className={styles.liveBtn}
              onClick={() => void onFetchLive()}
              disabled={fetching}
            >
              {fetching
                ? "Asking the source…"
                : isMail
                  ? "Fetch the body & attachments live"
                  : "Fetch live from source"}
            </button>
            <span className={styles.liveReason}>
              Goes out to the source for this one entry. Nothing above changes — what comes back is
              shown separately, so you can see the difference.
            </span>

            {live == null ? null : live.ok ? (
              <div className={styles.liveResult}>
                {/* The label names WHERE it came from. "Live" over a cache read is half of what #57
                    is about, so the two blocks are never merged and never swap places. */}
                <Section title="Live · straight from the source, not stored" />
                {live.record == null ? (
                  <div className={styles.rawEmpty}>
                    The source says this entry no longer exists. The cached copy above is what Postern
                    still holds.
                  </div>
                ) : (
                  <div className={styles.rawScroll}>
                    <pre className={styles.raw}>
                      {typeof live.record === "string"
                        ? live.record
                        : JSON.stringify(live.record, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.liveFailed} role="status">
                {live.reason}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title }: { title: string }): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{title}</div>
      <div className={styles.sectionRule} />
    </div>
  );
}

function FieldRow({ k, v, muted = false }: { k: string; v: string; muted?: boolean }): JSX.Element {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldKey}>{k}</dt>
      <dd className={muted ? `${styles.fieldVal} ${styles.fieldValMuted}` : styles.fieldVal}>{v}</dd>
    </div>
  );
}
