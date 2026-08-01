// Connector registry — a Map<provider, Connector>. Real connectors register in their own waves;
// tests inject fakes. The runner and scheduler look connectors up here by provider.

import type { Connector } from "../connectors/types.js";

const connectors = new Map<string, Connector>();

/** Register a connector under its declared `provider`. Last registration wins. */
export function registerConnector(c: Connector): void {
  connectors.set(c.provider, c);
}

/** Resolve a connector by provider, or undefined when none is registered. */
export function getConnector(provider: string): Connector | undefined {
  return connectors.get(provider);
}
