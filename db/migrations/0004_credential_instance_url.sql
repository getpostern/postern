-- Wave 11b — per-credential instance URL (#3).
-- Home Assistant is a push connector that authenticates against a per-instance WebSocket URL, but the
-- connect drawer collects only a token — so the URL could previously come ONLY from the global HA_URL
-- env (wrong: every HA is at a different address). Persist it on the CREDENTIAL (the URL is where the
-- token authenticates; HA is one credential -> one connector, so there is no fan-out reason to put it
-- on connectors). bootstrap.startPushConnectors threads it into connector.start({ haUrl }); HA_URL
-- stays as the global/dogfood fallback (per-connection instance_url takes precedence). It is NOT a
-- secret — a plain connection address, never sealed, kept out of logs. Additive + idempotent.
alter table provider_credentials add column if not exists instance_url text;
