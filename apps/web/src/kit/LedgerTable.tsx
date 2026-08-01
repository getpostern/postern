// LedgerTable — the shared list primitive (the ledger, banks, sector rows, agents).
//
// Accessibility is STRUCTURAL, not a later pass (#69, #67): a sortable header is a real <button>
// carrying aria-sort, and a drill row is keyboard-activatable (role="button", tabIndex, Enter/Space)
// — nothing is a click-only <div>. The focus ring is inherited from base.css, never re-declared.
// Wide content scrolls inside `.scroll`; the page body never scrolls sideways.

import type { KeyboardEvent, ReactNode } from "react";
import { Skeleton } from "./Skeleton";
import styles from "./LedgerTable.module.css";

/** One column. `width` fixes the lane (omit → flexible); `sortable` makes the header a sort button. */
export interface LedgerColumn<T> {
  field: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  align?: "left" | "right";
  sortable?: boolean;
}

export interface SortState {
  field: string;
  dir: "asc" | "desc";
}

/** The aria-sort value for a header, given the active sort. */
function ariaSortFor(field: string, sort?: SortState): "ascending" | "descending" | "none" {
  if (!sort || sort.field !== field) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

function cellStyle<T>(col: LedgerColumn<T>): React.CSSProperties | undefined {
  // A fixed width is a per-column datum, not something a static stylesheet can express.
  return col.width ? { width: col.width } : undefined;
}

export function LedgerTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  sort,
  onSort,
  empty,
  loading = false,
}: {
  columns: LedgerColumn<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  onOpen?: (r: T) => void;
  sort?: SortState;
  onSort?: (field: string) => void;
  empty?: ReactNode;
  loading?: boolean;
}): JSX.Element {
  const showEmpty = !loading && rows.length === 0 && empty != null;

  return (
    <div className={styles.scroll}>
      <div className={styles.table} role="table">
        <div className={styles.head} role="row">
          {columns.map((col) => {
            const flex = col.width ? styles.headCell : `${styles.headCell} ${styles.flexCell}`;
            const align = col.align === "right" ? ` ${styles.alignRight}` : "";
            const canSort = Boolean(col.sortable && onSort);
            if (canSort) {
              return (
                <div
                  key={col.field}
                  className={flex + align}
                  style={cellStyle(col)}
                  role="columnheader"
                  aria-sort={ariaSortFor(col.field, sort)}
                >
                  {/* aria-sort lives on the role="columnheader" above — it is invalid on a button
                      (a11y review, 1c-B). The button is only the sort control. */}
                  <button
                    type="button"
                    className={styles.sortBtn + align}
                    onClick={() => onSort?.(col.field)}
                  >
                    {col.header}
                    {sort?.field === col.field ? (
                      <span className={styles.caret} aria-hidden="true">
                        {sort.dir === "asc" ? "▲" : "▼"}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            }
            return (
              <div
                key={col.field}
                className={flex + align}
                style={cellStyle(col)}
                role="columnheader"
              >
                {col.header}
              </div>
            );
          })}
        </div>

        {loading ? (
          Array.from({ length: 5 }, (_, i) => (
            <div key={`sk-${i}`} className={styles.row} role="row">
              {columns.map((col) => (
                <div
                  key={col.field}
                  className={col.width ? styles.cell : `${styles.cell} ${styles.flexCell}`}
                  style={cellStyle(col)}
                  role="cell"
                >
                  <Skeleton width="70%" height={14} />
                </div>
              ))}
            </div>
          ))
        ) : showEmpty ? (
          <div className={styles.empty}>{empty}</div>
        ) : (
          rows.map((row) => {
            const open = onOpen ? () => onOpen(row) : undefined;
            const onKeyDown = open
              ? (e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                  }
                }
              : undefined;
            // A clickable row stays role="row" (not "button") so a screen reader keeps the
            // cell→columnheader structure; role="button" would flatten every cell into one
            // concatenated name. Keyboard-activatable via tabIndex + Enter/Space keeps #69.
            return (
              <div
                key={rowKey(row)}
                className={open ? `${styles.row} ${styles.clickable}` : styles.row}
                role="row"
                tabIndex={open ? 0 : undefined}
                onClick={open}
                onKeyDown={onKeyDown}
              >
                {columns.map((col) => (
                  <div
                    key={col.field}
                    className={
                      (col.width ? styles.cell : `${styles.cell} ${styles.flexCell}`) +
                      (col.align === "right" ? ` ${styles.alignRight}` : "")
                    }
                    style={cellStyle(col)}
                    role="cell"
                  >
                    {col.render(row)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
