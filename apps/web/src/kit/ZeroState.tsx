// ZeroState — an empty screen that says WHY it is empty. Nothing-connected and nothing-matched are
// deliberately different call sites (build-notes §14.1e): confusing them is how an empty screen
// reads as a broken one. The `filtered` kind REQUIRES the total it filtered from — so a page cannot
// render "nothing matches" without also being able to say "…out of the 2,481 the store holds",
// which is what stops the operator suspecting data loss.

import type { ReactNode } from "react";
import { count } from "../api/format";
import styles from "./ZeroState.module.css";

/** Two shapes, two obligations. `filtered` cannot be built without its `totalHeld`. */
export type ZeroStateKind =
  | { kind: "unconnected"; action: { label: string; onAct: () => void } }
  | { kind: "filtered"; totalHeld: number | null; freshnessLine: ReactNode };

export function ZeroState(
  p: { headline: string; reason: ReactNode } & ZeroStateKind,
): JSX.Element {
  return (
    <div className={styles.zero}>
      <div className={styles.headline}>{p.headline}</div>
      <p className={styles.reason}>{p.reason}</p>

      {p.kind === "filtered" ? (
        <p className={styles.meta}>
          {/* The fallback used to read "Total not served" — a status report on our own wire, standing
              in for the one number this state exists to give a person: how much is still there. It
              cannot be hidden (that is the whole point of the `filtered` kind: nobody may say
              "nothing matches" without also saying what the store holds), so it is said plainly and
              it stops at what we know. #106 §2d.

              No page can reach this arm today: the inspector is the only `filtered` caller and an
              unlanded count is its own `counting` state (`pages/inspector/liststate.ts`), which renders
              no zero state at all. The arm stays because the prop is `number | null` and the next
              caller may well hand over a null — an unrenderable branch is cheap; a branch that
              reappears with the old sentence in it is not. */}
          {p.totalHeld != null
            ? `${count(p.totalHeld)} held in total`
            : "The gate didn’t say how many are held here in total."}
          {p.freshnessLine != null ? <> · {p.freshnessLine}</> : null}
        </p>
      ) : (
        <div className={styles.actionRow}>
          <button type="button" className={styles.action} onClick={p.action.onAct}>
            {p.action.label}
          </button>
        </div>
      )}
    </div>
  );
}
