# ADR 0003 — Home Assistant action model

**Status:** Accepted (2026-06-06) · **Scope:** how the gateway enables agent actions on Home Assistant (the act path). Research-backed (HA REST/WebSocket APIs, registries, LLM/Assist precedent).

## Context
V0 enables an agent to act on HA. HA collapses *every* controllable thing into one primitive — an action `<domain>.<service>` invoked with a target. HA ships its own LLM/Assist API + MCP server, but they are deliberately **curated** (intent-based, exposed-entity allowlist, "no administrative tasks"). Our differentiator: **one place + the full action surface + cached speed + harness-agnostic.**

## Decisions
1. **Scope = full device/entity *control*.** Every action a device/entity/scene/script/automation/button/helper supports (the `call_service` surface). **HA admin/config mutation is deferred** (create/delete automations, registry/dashboard edits, add-on management, system restart/reload) — most of that isn't a `call_service` at all (it's the config WS API, which we don't expose), and the few admin *services* are excluded via a small denylist (`homeassistant.restart|stop|reload*`, `hassio.*`, `*.reload`). A later, deliberately-more-powerful tier can add admin mutation.
2. **No guardrails** (locked): the user's prompt is the authorization; the `home` domain grant gates; async audit records. We facilitate, we don't confirm.
3. **Transport = one authenticated WebSocket** (the HA long-lived token). On connect: `get_services` (action catalog) + `get_states` (entities + `supported_features`) + the three registries (`area/device/entity_registry/list`). Kept fresh via `subscribe_events(state_changed)` + registry-update events. REST is the one-shot fallback. (HA connector `policy: push` — self-managed WS, not the poll scheduler.)
4. **Cache = the value-add.** Entities → `home_entities` (DB: domain, area, name, attributes incl. `supported_features`, state). The service registry + area/device graph → in-memory per connection (rebuilt on connect). **HA won't tell you which services apply to an entity — we compute that join** (entity domain + `supported_features` × the service registry). That cached join is what makes discovery instant.
5. **Catalog = dynamic, cache-served, filterable** (by area/domain/entity). The `Connector` gains an additive optional `listActions?(ctx, filter)`; the HA connector implements it, read-only connectors don't. **No N-typed-tools** (the #1 LLM pitfall is context saturation) — one generic `invoke_action` + on-demand catalog (mirrors HA's own `GetLiveContext`).
6. **Dispatch:** `invoke_action(ctx, actionId, params)`, `actionId = home.<domain>.<service>`, `params` = a structured **selector** (area/domain/name/entity_id) + service data. Selector resolved server-side against the cache; **prefer passing `target.area_id`** and let HA expand (robust to new devices). **One live dispatch, NO auto-retry, sync-confirm + async targeted re-sync.** Ambiguous failure → reported "unknown", never retried.
7. **Scenes / scripts / automations / buttons / helpers = first-class actions** (`scene.turn_on`, `script.<id>`, `automation.trigger`, `button.press`, `input_*`).

## Consequences
- New `homeassistant-actions` unit: the HA WebSocket connector (sync + capability cache + dispatch + re-sync), the selector, and the action-runtime bodies in `core/actions.ts` (signatures unchanged so `mcp-edge` stays decoupled).
- Adds a `ws` dependency (HA WebSocket; registries are WS-only).
- `Connector` contract gains an additive `listActions?`; `ActionSpec` may gain optional fields for dynamic params.

## Sources
HA REST/WebSocket APIs, `dev_101_services` (targets), area/device/entity registries, `core/llm` (Assist API), the official MCP Server integration, Assist best-practices (context-saturation pitfall). (URLs in the research synthesis.)
