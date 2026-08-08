<!-- SPDX-License-Identifier: Apache-2.0 -->

# ADR 0037 — At the session cap, reclaim the most-idle session behind an idle floor (amends ADR 0034 §D5)

**Status:** Accepted · **Date:** 2026-08-08 · **Amends:** ADR 0034 §D5's cap behavior ("refused with 503 rather than evicting an existing session") and the half of its rejected-alternatives entry that rejected eviction at the cap. Everything else in ADR 0034 — the revocation sweep, the bind fence, the read/write asymmetry — stands untouched.

## Context

ADR 0034 bounded the MCP session map (`MAX_SESSIONS = 512`, `src/mcp/http.ts`) and chose refuse-over-evict: an MCP client legitimately idles for hours and holds one session for days, so LRU eviction would silently kill a standing hosted-client connection at exactly the moment the box gets busy. That reasoning assumed the population at the cap contains live sessions worth protecting.

Production falsified the premise on 2026-08-08 (#147). Hosted MCP clients abandon sessions rather than closing them: every new chat and every reconnect creates a session, nothing ever removes it, and the map fills monotonically — 512 sessions in six days of one person's normal use. At the cap the map held abandoned sessions almost exclusively, and refuse-over-evict inverted its own goal: **every live caller was refused so that abandoned state could be preserved.** The refusal also logged nothing, so the box went deaf silently; the incident was diagnosable only from source.

## Decision

1. **At the cap — and only at the cap — a new authenticated `initialize` may reclaim exactly one session:** the least-recently-**used** one, and only if it has been idle at least `SESSION_IDLE_RECLAIM_MS` (1 hour). "Used" means served a request; recency is stamped on the request-routing path.
2. **If no session passes the idle floor, the initialize is refused exactly as before** — same 503, same JSON-RPC envelope. Genuine saturation by live sessions still protects the live sessions; ADR 0034's concern binds through the floor.
3. **Both capacity events log.** Reclaim and refusal each emit one stderr line carrying the event and counts — never a bearer, a session id, a user id, or any attacker-influenced byte. The line's grammar is closed and test-pinned.
4. **Below the cap, nothing changes.** No TTL, no background sweep, no timers. A session held for days is untouched unless the box is full **and** it is the single most idle **and** it has not served a request for an hour.
5. **A reclaimed session's client recovers by re-initializing** — the path every hosted client already travels at a container restart. The reclaim clears both stores (ctx and transport) before teardown, so no half-dead entry can ever serve.

## Rejected

- **Keeping refuse-only.** The incident: a total new-connection lockout roughly every 5–6 days of normal hosted-agent use, silent. The cap protected exactly the wrong population.
- **A TTL or periodic idle sweep.** Expires working standing sessions *below* the cap — precisely the regression ADR 0034 refused, and it still refuses it. The floor-gated at-cap reclaim keeps that protection: reclamation happens only when the alternative is refusing a live caller.
- **Per-key session budgets.** More machinery, and it does not address the observed fill: one person's own hosted clients filled the map — there is no second tenant to budget against.
- **Scheduled restarts.** Operational papering-over that every self-hoster would have to rediscover during their own week-one lockout.

## Consequences / accepted residuals

- A session whose only traffic is a standing open stream is stamped at request receipt, so a listen-only client can look idle and be reclaimed under cap pressure after an hour. It recovers by re-initializing, and in the observed fill pattern the victim must out-idle 511 abandoned sessions to be picked. Accepted trade against starvation.
- A revoke landing inside an at-cap initialize's window can cost a third party one idle session for a slot the fenced initialize never uses. Rare, non-destructive, recorded.
- Refusal lines are unthrottled — bounded by an authenticated caller's reconnect rate at saturation. Container log rotation is the operational backstop and is out of this decision's scope.
- An unknown session id answers 400 (pre-existing; the MCP spec names 404 as the re-initialize trigger). Hosted-client recovery is empirically established at every container restart, not SDK-contractual — stated as such in the code.
