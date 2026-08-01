// ConfirmOverlay — a page-local host that centres the frozen <ConfirmBar> over a dim backdrop. This
// is NOT a kit change and NOT a second confirm implementation: it hosts the one ConfirmBar (which is
// the only destructive confirm in the app, #70 / law 7 — never window.confirm). The overlay adds the
// modal affordances a destructive action deserves — role="dialog" + aria-modal, Escape and backdrop
// cancel, and initial focus moved onto the dialog — so the confirm is reachable and dismissible by
// keyboard alone (#69). The frozen focus ring is inherited.

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./ConfirmOverlay.module.css";

export function ConfirmOverlay({
  title,
  onCancel,
  children,
}: {
  /** The accessible dialog name (e.g. "Revoke myclaw"). */
  title: string;
  onCancel: () => void;
  children: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Move focus onto the dialog so keyboard users land inside it, not stranded on the page behind.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // A click inside the panel must not bubble to the backdrop's cancel.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
