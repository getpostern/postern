// The one global toast system (#77) — before this the Console had three page-local ones. A single
// <ToastProvider> at the root; `useToast().show(...)` from anywhere. `useToast` outside a provider
// returns a no-op (so a component never crashes for want of a provider), and the live region is
// aria-live="polite" so a confirmation is announced.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./Toast.module.css";

export interface ToastInput {
  message: ReactNode;
  tone?: "ok" | "error";
}

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** The dismiss delay. Long enough to read a short sentence, short enough not to stack. */
const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const show = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast} data-tone={t.tone ?? "ok"}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
