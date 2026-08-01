// ConfirmBar — the typed in-app destructive confirm (#70, law 7). There is NO window.confirm /
// alert / prompt anywhere in this app; this is the replacement. Ported from `640-0`.
//
// The consequence and its blast radius are stated plainly; when `exportFirst` is set the confirm is
// GATED until the operator has taken the export (build-notes §4 — "export-first is enforced"; the
// #17 data-loss lesson: there is no undo and no import, restore is the backup). When `requireTyped`
// is set the operator must also type the exact token. `busy` locks it mid-flight.
//
// REVEAL = IN VIEW (#134). Every ConfirmBar in the app mounts in response to a deliberate operator
// act (Remove, Disconnect, Revoke, Stop publishing, picking an erase target) and several hosts
// render it as the LAST child of a long page — on a multi-source gateway it sat below the fold, so
// the operator clicked Remove and saw nothing happen (live, 2026-07-30). The bar scrolls itself
// into view on mount, in the kit so BOTH reveal sites (SourcesPage remove, ConnectionDetail
// disconnect/revoke) — and every future host — inherit the fix. `block: "nearest"` is the
// stillness-respecting choice (soul §7): a bar already visible moves nothing at all. jsdom-guarded
// like the #112 arrival effect (jsdom implements no layout, so scrollIntoView is absent there).
// Focus is deliberately NOT taken: the agents' ConfirmOverlay already owns dialog focus (#69), and
// stealing it here would fight that.
//
// HOST OBLIGATION — key a retargetable bar by its TARGET. A host that renders ONE conditional
// ConfirmBar slot for whichever thing is being confirmed (SourcesPage remove, EraseConfirmPage's
// scopes) must set `key` to the target's identity: React then REMOUNTS on retarget, which is what
// re-fires the reveal scroll AND resets the typed/export arming. Without it, switching targets
// re-renders the same instance — the scroll never re-fires and, far worse, a seal armed for target
// A stays armed for target B (live shape: arm an erase for one connection, click "Everything" —
// an armed erase-everything with no re-confirmation). ConnectionDetail's two confirms are separate
// conditional slots, so they remount by position and need no key.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./ConfirmBar.module.css";

export function ConfirmBar({
  verb,
  consequence,
  blastRadius,
  requireTyped,
  exportFirst,
  onConfirm,
  onCancel,
  busy = false,
}: {
  verb: string;
  consequence: ReactNode;
  blastRadius?: ReactNode;
  requireTyped?: string;
  exportFirst?: { label: string; onExport: () => void };
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [exported, setExported] = useState(false);
  const inputId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const typedOk = !requireTyped || typed === requireTyped;
  // Export-first is a real gate, not just an offer: with exportFirst set, the seal stays disabled
  // until the export has actually been taken.
  const exportOk = !exportFirst || exported;
  const canConfirm = typedOk && exportOk && !busy;

  // The #134 reveal: bring the bar into view ONCE, on mount — see the file header. Empty deps on
  // purpose: a re-render (typing the token, `busy` flipping) must never yank the viewport again.
  useEffect(() => {
    const el = barRef.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div className={styles.bar} ref={barRef}>
      <div className={styles.consequence}>
        <div className={styles.consequenceTitle}>{consequence}</div>
        {blastRadius != null ? <div className={styles.blast}>{blastRadius}</div> : null}
      </div>

      {exportFirst ? (
        <div className={styles.exportRow} data-done={exported || undefined}>
          <div className={styles.exportLead}>
            {exported
              ? "Exported. Keep that file safe — it is the only copy; there is no undo and no import."
              : "Export a copy first — there is no undo and no import."}
          </div>
          <button
            type="button"
            className={styles.exportBtn}
            onClick={() => {
              exportFirst.onExport();
              setExported(true);
            }}
          >
            {exported ? "Export again" : exportFirst.label}
          </button>
        </div>
      ) : null}

      {requireTyped ? (
        <div className={styles.typedBlock}>
          <label className={styles.typedLabel} htmlFor={inputId}>
            Type {requireTyped} to confirm
          </label>
          <input
            id={inputId}
            className={styles.typedInput}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={requireTyped}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirm}
          onClick={onConfirm}
          disabled={!canConfirm}
        >
          {busy ? "Working…" : verb}
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
