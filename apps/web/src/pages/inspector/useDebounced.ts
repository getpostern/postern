// A tiny debounce so the filter box maps to a query() request only after typing settles — a keystroke
// is not a reason to hit the gateway, and the loopback read is cheap but the re-render churn is not.

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}
