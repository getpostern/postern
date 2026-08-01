# Runbook — Connect your finances via Plaid

The Console (`PlaidSetup`) walks you through this in-app; this is the headless/reference mirror. **Plaid is the paid coverage-upgrade — SimpleFIN stays the free default. Connect Plaid only for banks SimpleFIN can't reach.**

## The one thing to understand first
Plaid only reads banks you link **inside this gateway's own Link flow**. Your `client_id` + secret identify the app; alone they read nothing, and **connections you made at `my.plaid.com` do NOT transfer** here. You authenticate each bank through the gateway's hosted Link; that mints a per-bank token we store.

## Setup
1. **Plaid developer account** — sign up at `dashboard.plaid.com`. A **new US/Canada team** gets the free **Trial plan** (real data, ≤10 banks, no security questionnaire). An **existing** team uses its Production access directly — **paid** (pay-as-you-go: Transactions billed monthly per linked bank, Balance per request; Plaid publishes no price list). The `/trial-plan` link redirecting to your dashboard overview means your team predates Trial → use Production.
2. **Keys** — Developers → Keys (`dashboard.plaid.com/developers/keys`): copy `client_id` (same across environments) + the **Production** secret (Sandbox secret connects test logins only).
3. **Application Display Info** — fill it in the Dashboard (app name/logo). Some OAuth banks reject an empty profile even on Trial. You do **not** need to register any redirect URI for this gateway's web Hosted Link.
4. **Paste into the Console** — `PlaidSetup`: `client_id` + secret + Environment (Production for real data). The secret is sealed in the vault.
5. **Connect** — click Connect; the Plaid-hosted page opens in a new tab; authenticate each bank (one session can add several). The gateway auto-picks-up the linked banks — **you never paste a token**.

## Keeping connections alive
Bank consent **expires ~annually** (e.g. Capital One, Fidelity, Bank of America) and connections can also break (login changed). The Console shows a per-connection health state and a **"Reconnect"** button (`action_required` → quick re-auth, same connection) or **"Fresh link"** (`dead` → new link). Reconnect before/after expiry to resume; the cursor backfills what was missed.

## Caveats
- **10-Item lifetime cap** on the Trial plan; removing a bank does NOT free a slot — test against Plaid **Sandbox**, not real banks, to avoid burning slots.
- Some banks take time to enable for a new app (**Charles Schwab up to ~6 weeks**); most are minutes–hours.
- **Disconnect/erase calls Plaid `/item/remove`** to stop billing — so a Plaid *erase* needs a fresh Link to resume (unlike other providers).
- Real Production data is **billed**; weigh it against the free SimpleFIN connector for banks SimpleFIN already covers.
