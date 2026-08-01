/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * REST base URL for the gateway — an ESCAPE HATCH, not the default.
   * UNSET (the shipped default) ⇒ "" ⇒ same-origin RELATIVE requests: the gateway
   * serves this SPA itself, so the gate's address is whatever address the browser
   * reached it on. Set an absolute origin ONLY for a cross-origin dev setup, and
   * never in the Dockerfile — baking one in is the bug ADR 0035 §D4 removes.
   */
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Plaid Link is loaded at runtime from the Plaid CDN (U4 onboarding); a minimal
// ambient type for the global so the exchange flow can reference it.
interface PlaidHandler {
  open(): void;
  exit(opts?: { force?: boolean }): void;
  destroy(): void;
}
interface PlaidCreateOptions {
  token: string;
  onSuccess: (publicToken: string, metadata: unknown) => void;
  onExit?: (err: unknown, metadata: unknown) => void;
  onEvent?: (eventName: string, metadata: unknown) => void;
}
interface PlaidGlobal {
  create(opts: PlaidCreateOptions): PlaidHandler;
}
interface Window {
  Plaid?: PlaidGlobal;
}
