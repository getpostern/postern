// Sync error classification (#99, ADR 0034) — the ONE derivation the runner acts on when a sync run
// throws. Two states, no third: a TRANSIENT failure is a blip worth retrying (the connection is
// healthy, the network or the provider hiccupped); a TERMINAL failure needs a human (a dead
// credential, a misconfigured app, a connector bug).
//
// Why a message-vocabulary table and not a structural signal: the connectors are not owned by this
// module and their catch blocks DISCARD the cause — `src/connectors/plaid.ts:238` is literally
// `catch { throw new Error("plaid ... failed: network error") }`, and `src/connectors/google.ts:210`
// the same. So for most providers the thrown message is the only signal that survives. The only
// honest way to use a message is a CLOSED, CITED, per-provider vocabulary — which is what
// PROVIDER_RETRYABILITY is. It is a BRIDGE, not the fix: the fix is every connector throwing
// RetryableError for its own transients the way `src/connectors/microsoft.ts` already does (a
// proposed SDK obligation, `src/sdk/contract.ts`). Until then, "declare rather than inherit" is
// enforced by the mandatory `note` + the coverage test, never by a permissive default.
//
// UNKNOWN IS TERMINAL ON PURPOSE. Flipping the default would turn every genuine connector bug into a
// permanent, silent "Syncing…" — the exact inversion #99 warns about, and strictly worse than a loud
// false "needs you".
//
// Identify errors by NAME, never `instanceof`, when they originate in other modules:
// `src/sync/runner.test.ts:21` replaces `../secrets/index.js` with a PARTIAL module mock, so an
// `import { SecretAuthError }` here would be `undefined` in that suite and `err instanceof undefined`
// throws a TypeError from inside a catch block. RetryableError is the one exception — it lives in
// this directory, is never mocked, and stays `instanceof`.
//
// "By name" means BOTH `err.name` AND `err.constructor.name` (see namesOf). Reading only the `name`
// property was a live inversion: `SecretAuthError` USED to declare no `override name`, so a real
// instance carried `.name === "Error"` and a dead vault whose message happened to carry a 5xx would
// classify TRANSIENT → status='syncing' → no Reconnect offered. Both halves were fixed 2026-07-25, in
// two different units of the same wave: the class now sets `override name` (src/secrets/index.ts:42),
// and this classifier no longer depends on that. Keep the constructor read — it is what survives an
// error crossing a boundary that drops its prototype, or that `override name` being removed again.

import { RetryableError } from "./errors.js";

/** The one classification the runner acts on. There is no third state. */
export type SyncErrorClass = "transient" | "terminal";

/**
 * One provider's DECLARED retryability. Every provider registered by `registerConnectors()`
 * (src/bootstrap.ts:33-45) MUST have exactly one entry — a new connector cannot inherit
 * "terminal" by silence; `note` is mandatory and non-empty so the declaration is an act.
 */
export interface ProviderRetryability {
  readonly provider: string;
  /** Anchored patterns matching messages this provider emits for a TRANSIENT condition. */
  readonly transient: readonly RegExp[];
  /** Patterns that are TERMINAL even when a universal transient rule would otherwise match. */
  readonly terminal?: readonly RegExp[];
  /** Why this provider's vocabulary is what it is (throw-site citations). Non-empty. */
  readonly note: string;
}

/**
 * The declaration table — one entry per provider registered by `registerConnectors()`. An EMPTY
 * `transient` list is a real declaration, not an omission: it says "this provider's plain-Error
 * messages are ambiguous (or it declares its own transients as RetryableError), so nothing beyond
 * the universal rules applies". The coverage test in retryability.test.ts asserts set EQUALITY
 * against the registry, so adding a connector to bootstrap.ts without an entry here fails loudly.
 *
 * Throw sites verified against the connectors on 2026-07-25.
 */
export const PROVIDER_RETRYABILITY: readonly ProviderRetryability[] = [
  {
    provider: "plaid",
    transient: [/^plaid .+ failed: network error$/],
    note:
      "The fetch network catch is the only non-status failure shape, and it has exactly two sites " +
      "(plaid.ts:238 in plaidPost, plaid.ts:450 in item_get). Status-bearing failures come through " +
      "the universal `failed: <status>` rule (plaid.ts:249, which appends the error_code enum).",
  },
  {
    provider: "simplefin",
    transient: [],
    note:
      "Status-bearing failures are covered by the universal `returned <status>` rule " +
      "(simplefin.ts:214). `simplefin: account fetch failed` is DELIBERATELY not transient: the " +
      "identical string is thrown by both the network catch (simplefin.ts:211-213) and the " +
      "malformed-access-URL branch (simplefin.ts:193-196), and reading a broken credential as " +
      "transient would hide a real 'reconnect me' behind a permanent 'Syncing…'. Residual: the " +
      "connector should throw RetryableError from the network catch (SDK follow-up).",
  },
  {
    provider: "whoop",
    transient: [/^whoop: fetch .+ failed$/],
    note:
      "Network catch, sole site whoop.ts:262-264 (`whoop: fetch ${path} failed`). Status-bearing " +
      "failures are covered by the universal `returned <status>` rule (whoop.ts:265).",
  },
  {
    provider: "google",
    transient: [/^google: request failed$/, /^google: rate limited \(429\) after retries$/],
    terminal: [/^google: (calendar|people) fetch returned 403 — the .+ is not enabled\b/],
    note:
      "Network catch google.ts httpGet, and the post-retry 429 throttle (the connector already " +
      "exhausted its own Retry-After backoff, so the run — not the request — is what needs " +
      "retrying). Status-bearing failures are covered universally (google.ts fetchFailureMessage, " +
      "`… fetch returned <status>`). The API-disabled 403 (fetchFailureMessage's SERVICE_DISABLED " +
      "branch, #121) is DECLARED terminal — a disabled API needs a human in the Cloud console, and " +
      "the declaration keeps that true even if a future transient rule would otherwise match the " +
      "longer message.",
  },
  {
    provider: "microsoft",
    transient: [],
    note:
      "Declares its OWN transients as RetryableError (microsoft.ts:386,390,417,457,705,809,904,928), " +
      "so rule 1 handles them and no message vocabulary is needed. Its plain-Error status throws " +
      "(:419,:464,:906,:1074) are covered universally. This is the shape every other connector " +
      "should converge on — it is the exemplar the SDK obligation would generalize.",
  },
  {
    provider: "gmail",
    transient: [],
    terminal: [/^gmail: sign-in refused\b/],
    note:
      "An IMAP auth refusal now names itself (`gmail: sign-in refused — …`, gmail.ts " +
      "AUTH_REFUSED_MESSAGE, #121) and is DECLARED terminal: a rejected app password needs a human. " +
      "Everything else still collapses to `gmail: sync failed` at both the search-failure site and " +
      "the catch-all — ambiguous between a blip and some other credential death ⇒ stays terminal " +
      "by the unknown default. Residual: the connector should throw RetryableError for its own " +
      "transients (SDK follow-up).",
  },
  {
    provider: "apple",
    transient: [],
    note:
      "The composite iCloud connector's DAV errors (dav-core.ts:325,335,367,390,454,469,501) each " +
      "collapse a network failure and a 401 into ONE string, so no message can separate a blip from " +
      "a dead app-specific password. Ambiguous ⇒ stays terminal. Residual: SDK follow-up.",
  },
  {
    provider: "home_assistant",
    transient: [],
    note:
      "push/stream mode — never runs through syncConnection's poll path at all; its transport health " +
      "is reported through markStreamState (runner.ts:547), not through status classification.",
  },
  {
    provider: "apple_health",
    transient: [],
    note:
      "push/webhook mode — data arrives via ingestRecords (runner.ts:447), which by design NEVER " +
      "flips status (the NO ERROR LOCKOUT note at runner.ts:441-445), so nothing here is reachable.",
  },
];

const BY_PROVIDER: ReadonlyMap<string, ProviderRetryability> = new Map(
  PROVIDER_RETRYABILITY.map((p) => [p.provider, p]),
);

/** HTTP statuses treated as transient: 408, 425, 429, and every 5xx. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Universal TERMINAL vocabulary. These words mean "a human must act" whatever else the message says,
 * so they are checked BEFORE any status parsing — a `400 ITEM_LOGIN_REQUIRED` must read "reconnect
 * me", not "retry me".
 */
const UNIVERSAL_TERMINAL =
  /\b(unauthorized|forbidden|invalid[_ -]grant|revoked|ITEM_LOGIN_REQUIRED|INVALID_ACCESS_TOKEN|credential not found)\b/i;

/**
 * The two anchored status-bearing message shapes the fleet actually emits (both verified 2026-07-25):
 *   `… returned <status>` — simplefin.ts:214, whoop.ts:265, google.ts:417,:478, microsoft.ts:419,:464,:906,:1074
 *   `… failed: <status>`  — plaid.ts:249
 */
const UNIVERSAL_STATUS_SHAPES: readonly RegExp[] = [/\breturned (\d{3})\b/, /\bfailed: (\d{3})\b/];

/** Node/undici transport failure codes. Read from `err.code` AND `err.cause?.code` (defensively). */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** OAuth error codes that mean the grant itself is dead — terminal even inside a 5xx response. */
const TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "access_denied",
  "no_access_token",
]);

/**
 * Every name this error answers to: its own `name` property AND its `constructor.name`.
 *
 * Reading the constructor is LOAD-BEARING, not belt-and-braces. Some of the classes this classifier
 * keys on declare no `override name`, so a REAL instance carries `.name === "Error"` and a
 * `name === "SecretAuthError"` rule would never fire on the real thing. Proved 2026-07-25: the object
 * literal `{ name: "SecretAuthError", message: "… 503" }` classified terminal while the REAL class
 * with the identical message classified TRANSIENT — a dead vault would then land `status='syncing'`,
 * the quiet state, and the Console would never offer Reconnect. That is the exact inversion #99
 * exists to prevent. `SecretAuthError` itself gained `override name` in the same wave
 * (`src/secrets/index.ts:42`), which is why the object-literal and real-instance cases now agree —
 * but the constructor read is what keeps this true for a flattened error, for a class that never
 * gains the override, and if that line is ever removed.
 *
 * The duck-type deliberately does NOT depend on an `override name` landing upstream: the rule must
 * fire on both shapes forever, whatever any other unit does to the class declaration.
 * (`instanceof` is still not an option here — see the module header: `runner.test.ts` replaces
 * `../secrets/index.js` with a PARTIAL mock, so an imported class would be `undefined`.)
 */
function namesOf(err: unknown): readonly string[] {
  if (err == null || typeof err !== "object") return [];
  const out: string[] = [];
  const own = (err as { name?: unknown }).name;
  if (typeof own === "string" && own !== "") out.push(own);
  const ctor = (err as { constructor?: unknown }).constructor;
  if (typeof ctor === "function") {
    const cn = (ctor as { name?: unknown }).name;
    if (typeof cn === "string" && cn !== "" && !out.includes(cn)) out.push(cn);
  }
  return out;
}

/** `err.message`, read defensively; falls back to a stringification that cannot itself throw. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err != null && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return String(err);
  } catch {
    return "";
  }
}

/** Every transport code reachable on the error: its own `code`, plus one level of `cause`. */
function codesOf(err: unknown): string[] {
  const out: string[] = [];
  if (err == null || typeof err !== "object") return out;
  const own = (err as { code?: unknown }).code;
  if (typeof own === "string") out.push(own);
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string") out.push(c);
  }
  return out;
}

/**
 * Classify one error thrown out of a sync run. `provider` may be "" (the connection row never
 * loaded) — the universal rules still apply. Never throws; unknown ⇒ "terminal".
 *
 * Precedence is deliberate and load-bearing; see ADR 0034. The two orderings that MUST NOT drift:
 *  - `RetryableError` wins over everything (a connector's explicit declaration is authoritative);
 *  - a TokenEndpointError's `code` is consulted BEFORE its `status`, so a dead refresh token wrapped
 *    in a 503 still reads "reconnect me" rather than "retry me".
 */
export function classifySyncError(provider: string, err: unknown): SyncErrorClass {
  try {
    // 1. The connector said so. This is how `microsoft` already works.
    if (err instanceof RetryableError) return "transient";

    // Both the `name` property and the constructor name — see namesOf(). Either alone is insufficient:
    // a flattened literal has no constructor, and a class with no `override name` has no useful `name`.
    const names = namesOf(err);
    // 2. A vault that will not open is a dead credential (src/secrets/index.ts:42).
    if (names.includes("SecretAuthError")) return "terminal";
    // 3. Provider app not configured (src/oauth/providers.ts:27) — a human must act.
    if (names.includes("ConfigError")) return "terminal";
    // 4. Token endpoint (src/oauth/exchange.ts:40-55): the OAuth error CODE outranks the status.
    if (names.includes("TokenEndpointError")) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "string" && TERMINAL_OAUTH_CODES.has(code)) return "terminal";
      const status = (err as { status?: unknown }).status;
      if (typeof status === "number") return isTransientHttpStatus(status) ? "transient" : "terminal";
    }

    const message = messageOf(err);
    const declared = provider ? BY_PROVIDER.get(provider) : undefined;

    // 5. The provider's own terminal overrides.
    for (const re of declared?.terminal ?? []) {
      if (re.test(message)) return "terminal";
    }
    // 6. Universal terminal vocabulary — checked before any status parsing.
    if (UNIVERSAL_TERMINAL.test(message)) return "terminal";
    // 7. Transport codes (today's connectors discard the cause; a future one, or the refresh path,
    //    may not) plus the two abort/timeout error names.
    for (const code of codesOf(err)) {
      if (NETWORK_CODES.has(code)) return "transient";
    }
    if (names.includes("AbortError") || names.includes("TimeoutError")) return "transient";
    // 8. The provider's declared transient vocabulary.
    for (const re of declared?.transient ?? []) {
      if (re.test(message)) return "transient";
    }
    // 9. Universal status vocabulary: a valid HTTP status that is itself transient.
    for (const shape of UNIVERSAL_STATUS_SHAPES) {
      const m = shape.exec(message);
      if (!m) continue;
      const status = Number(m[1]);
      if (!Number.isFinite(status) || status < 100 || status > 599) continue;
      if (isTransientHttpStatus(status)) return "transient";
    }
    // 10. Unknown ⇒ terminal, so a genuine connector bug stays loud.
    return "terminal";
  } catch {
    // The classifier must never be the thing that breaks a sync run.
    return "terminal";
  }
}
