// Credential resolution for the Sources surface.
//
// THE FACT: `credentialId` is SERVED on every connectors LIST row (core `toStatus`,
// GET /api/connectors) — not only on the per-connection DETAIL wire. Two connections sharing this
// id share one consent + vault secret, so a credential-level revoke removes them all; the true blast
// radius is therefore computable from the list ALONE, synchronously. (An earlier port believed only
// the detail wire carried it and fetched each connection's detail to recover it — an N+1 that also
// introduced a resolution RACE where a fan-out Remove could name only a subset of what the backend
// would revoke. Reading the served field removes both the fetches and the race.)
//
// Plaid is deliberately skipped: every Plaid Item is its OWN credential (§12.1), so the Plaid group
// spans many credentials and is grouped by app, never by a single credentialId.

import type { ConnectorStatus } from "../../api/types";

export interface ConnectorCredentials {
  /**
   * The credential id backing a connection, read from the served list row. `undefined` for a Plaid
   * Item (grouped by app, never by credential). Never fabricated.
   */
  credentialIdOf: (connectionId: string) => string | undefined;
  /**
   * Always `true`: resolution is now synchronous from the list, so a destructive blast-radius claim
   * is never made against an unresolved set. Kept in the interface so callers that gate on it stay
   * correct (and to make the "no race" property explicit at every call site).
   */
  resolved: boolean;
}

/**
 * Resolve each connection's owning `credentialId` directly from the served connector list. No fetch,
 * no race. Plaid Items resolve to `undefined` (grouped by app; their per-Item credentials are never
 * a shared boundary).
 */
export function useConnectorCredentials(
  connectors: ConnectorStatus[] | undefined,
): ConnectorCredentials {
  const map = new Map<string, string>();
  for (const c of connectors ?? []) {
    if (c.provider !== "plaid") map.set(c.connectionId, c.credentialId);
  }
  return {
    credentialIdOf: (connectionId: string) => map.get(connectionId),
    resolved: true,
  };
}
