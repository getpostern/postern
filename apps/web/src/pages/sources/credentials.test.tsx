// useConnectorCredentials — reads each connection's owning credentialId straight off the SERVED
// connector list (core toStatus sets it on every row), synchronously. No detail fetch, no resolution
// race. Plaid Items resolve to undefined (grouped by app; §12.1). `resolved` is always true, so a
// destructive blast-radius claim is never made against a half-resolved set (the security fix).

import type { ConnectorStatus } from "../../api/types";
import { describe, expect, it } from "vitest";
import { useConnectorCredentials } from "./credentials";

function status(over: Partial<ConnectorStatus>): ConnectorStatus {
  return {
    connectionId: "x", credentialId: "cred-x", provider: "microsoft", sector: "mail", status: "active",
    last_synced_at: null, last_error: null, last_error_at: null, policy_mode: "poll",
    next_sync_at: null, scopes: [], credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null, sync_window_days: null, sync_interval_sec: null,
    min_interval_sec: null, default_interval_sec: null, cached_count: 0, push_kind: null,
    ...over,
  };
}

// It touches no hooks — it is a pure derivation over the list — so it can be called directly.
describe("useConnectorCredentials", () => {
  it("reads each non-Plaid connection's served credentialId, and returns undefined for Plaid", () => {
    const creds = useConnectorCredentials([
      status({ connectionId: "m1", provider: "microsoft", credentialId: "cred-m1" }),
      status({ connectionId: "m2", provider: "microsoft", credentialId: "cred-m2" }),
      status({ connectionId: "p1", provider: "plaid", credentialId: "cred-p1" }),
    ]);
    expect(creds.credentialIdOf("m1")).toBe("cred-m1");
    expect(creds.credentialIdOf("m2")).toBe("cred-m2");
    // Plaid is grouped by app, never by credential — its per-Item credentialId is not a boundary here.
    expect(creds.credentialIdOf("p1")).toBeUndefined();
  });

  it("is always resolved (synchronous) — a blast-radius claim is never made mid-resolution", () => {
    expect(useConnectorCredentials([status({ connectionId: "m1" })]).resolved).toBe(true);
    expect(useConnectorCredentials(undefined).resolved).toBe(true);
    expect(useConnectorCredentials([]).resolved).toBe(true);
  });

  it("never fabricates a credentialId for an unknown connection", () => {
    const creds = useConnectorCredentials([status({ connectionId: "m1", credentialId: "cred-m1" })]);
    expect(creds.credentialIdOf("nope")).toBeUndefined();
  });
});
