-- Wave 12 (finance dogfood, #34a) — balance-sign backfill. One-shot, provider-gated, idempotent.
-- Plaid reports a POSITIVE magnitude for EVERY account type — even liabilities — so a credit/loan/
-- mortgage `current_balance` reads +742.19 while the same SimpleFIN card reads −742.19. The connector
-- normalize() seam now negates Plaid liability balances on write (owed = NEGATIVE everywhere, matching
-- SimpleFIN + the `amount<0 = money out` invariant), so the PRIMARY fix is the next-sync upsert. This
-- backfill flips ALREADY-cached Plaid liability rows for immediacy. Forward-only (ADR 0010).
--
-- Safety / idempotency: the `provider = 'plaid'` join is MANDATORY (SimpleFIN is already signed and its
-- account_type is NULL on every row, so it is untouched here regardless) and the `current_balance > 0`
-- guard makes a re-run a no-op (an already-negated row is < 0 and is skipped — never double-negated).
-- Only liability types are flipped; assets (depository/investment) stay positive.
update finance_accounts a
   set current_balance = -a.current_balance
  from connectors c
 where c.id = a.connection_id
   and c.provider = 'plaid'
   and a.account_type in ('credit', 'loan', 'mortgage')
   and a.current_balance > 0;
