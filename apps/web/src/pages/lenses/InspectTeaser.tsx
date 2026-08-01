// INSPECT THE RECORDS — the demoted teaser (#64: the lens leads with the gateway view; the raw table
// is a teaser here, not the page). A one-line "raw cache, for verification not analysis" framing and
// a link to the inspector (P2d, /sectors/:sector/inspect). Nothing about the table is drawn here —
// not a row and not a column name. The table itself lives on the inspector.
//
// THE COLUMN-HINT ROW WAS DELETED (#107 §2, operator ruling). It printed the sector's column names
// UNDER the link that opens the table — the schema of a thing you have not opened yet — and its
// source was `INSPECT_COLUMN_HINTS`, a hardcoded compile-time map: a hand-typed shadow of the
// REGISTRY that could silently drift from what the inspector actually renders. The ruling's words:
// "Column names are not a teaser for anything — they are furniture that a person cannot act on."
// The tempting alternative, "show the REAL columns instead", is still REJECTED — but for the ruling's
// reason, not the old one. It used to be argued as backend-blocked ("`get_schema` is bearer-gated"),
// and that is no longer true: `GET /api/operator/schema` is served and the inspector's own schema peek
// reads it (#82). The published field list belongs THERE, one click in, where a person asked for it —
// not under a link to a table they have not opened.

import { Link } from "react-router-dom";
import type { Sector } from "../../api/types";
import { INSPECT_SUB } from "./lensmeta";
import styles from "./InspectTeaser.module.css";

export function InspectTeaser({ sector }: { sector: Sector }): JSX.Element {
  return (
    <section className={styles.teaser}>
      <div className={styles.top}>
        <div className={styles.lead}>
          <div className={styles.title}>Inspect the records</div>
          <p className={styles.sub}>{INSPECT_SUB}</p>
        </div>
        <Link className={styles.open} to={`/sectors/${sector}/inspect`}>
          Open the inspector <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
