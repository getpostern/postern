// Copyable — a value with a Copy affordance. Ported from the gate-address field (`1Q-0`). The Copy
// button flips to "Copied" briefly on success; it never uses a browser dialog. Identifiers stay
// mono (`mono`), so an agent id or ingest URL reads exactly, character for character (#37).

import { useCallback, useRef, useState } from "react";
import styles from "./Copyable.module.css";

export function Copyable({
  value,
  label,
  mono = false,
}: {
  value: string;
  label?: string;
  mono?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onCopy = useCallback(() => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    // navigator.clipboard is absent under some test/insecure contexts — fail quietly, never throw.
    void navigator?.clipboard?.writeText?.(value).then(done, () => undefined);
  }, [value]);

  return (
    <div className={styles.wrap}>
      {label != null ? <div className={styles.label}>{label}</div> : null}
      <div className={styles.box}>
        <span className={styles.value} data-mono={mono || undefined}>
          {value}
        </span>
        <button type="button" className={styles.copy} onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
