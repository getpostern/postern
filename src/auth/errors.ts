/**
 * Raised on an authentication failure (unknown/revoked/expired credential) or an authorization
 * failure (an ungranted sector). Two DISTINCT fields, never conflated (mcp-auth-bridge):
 *  - `sector` — set only when the denial is per-sector (assertSector / sectorOf).
 *  - `reason` — the credential-failure vocabulary ("unknown agent" | "revoked" | "expired"),
 *    threaded into audit `deny_reason` so the sector column stays clean on both audit paths.
 * The single-arg constructor stays backward-compatible (sector-position callers unchanged).
 */
export class AccessDenied extends Error {
  readonly sector?: string;
  readonly reason?: string;
  constructor(sector?: string, reason?: string) {
    super(reason ? `access denied: ${reason}` : sector ? `access denied: ${sector}` : "access denied");
    this.name = "AccessDenied";
    this.sector = sector;
    this.reason = reason;
  }
}
