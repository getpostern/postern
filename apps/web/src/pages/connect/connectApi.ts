// The connect flows + the client-side SHAPE validation — screen-local, no shared surface touched.
//
// Three failure kinds (build-notes §14.1d), and only one is OURS:
//   • shape    — WE reject the input before spending a round-trip. Caught as they type, said with
//                reference to what right looks like. Everything in `validateShape` is this kind.
//   • provider — THEY answered no. The RestError the flow throws carries the provider's own string;
//                the screen renders it VERBATIM in mono (never paraphrased).
//   • already  — nobody's failure. Handled in the screen (a connection already exists) — not here.

import { useEffect, useState } from "react";
import { RestError, api } from "../../api/client";
import type { OAuthProvider, PlaidHostedLinkResult } from "../../api/client";
import type { ProviderDef } from "./catalog";

/** The collected form values, keyed by the field `wire` name. All optional — field count varies. */
export interface ConnectValues {
  username?: string;
  secret?: string;
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/** A shape (ours) rejection: which field is wrong, and what right looks like. */
export interface ShapeError {
  /** The offending field's `wire` name, so the screen can seal that input. */
  field: keyof ConnectValues;
  message: string;
}

/**
 * The redirect URI to register with an OAuth provider, as reported by the gateway.
 *
 * There is ONE source for this string and it is the server (ADR 0035 §D4): the gateway computes the
 * `redirect_uri` it will actually send and reports it on `GET /api/oauth/:provider/app`. The Console
 * renders what it is told, verbatim. It never composes this string from its own origin — the Console
 * and the gateway are configured separately, so any Console-side derivation is a second source that
 * silently disagrees with the one the provider is handed.
 */
export type RedirectUri =
  | { status: "pending" }
  | { status: "ready"; uri: string }
  | { status: "unavailable"; message: string };

/**
 * Resolve the gateway's own redirect URI for an OAuth provider. `null` (a non-OAuth screen) issues
 * NO request and stays "pending" forever — the caller never renders it. Screen-local by design: this
 * is not a polled freshness surface, so it does not go through the shared query hooks.
 */
export function useRedirectUri(provider: OAuthProvider | null): RedirectUri {
  const [state, setState] = useState<RedirectUri>({ status: "pending" });
  useEffect(() => {
    if (provider === null) return;
    // The `live` latch: a provider switch (or an unmount) must not let a late answer overwrite the
    // current one — the same idiom PlaidForm uses for its own screen-local fetch.
    let live = true;
    setState({ status: "pending" });
    api
      .oauthRedirectUri(provider)
      .then((uri) => {
        if (live) setState({ status: "ready", uri });
      })
      .catch((e: unknown) => {
        if (live) setState({ status: "unavailable", message: errorMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [provider]);
  return state;
}

/** Navigate the browser to a full-page URL (the OAuth consent redirect). Wrapped in one place so the
 *  screen never touches `window.location` directly and a test can stand in for the navigation. */
export function redirectTo(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

/** Open a URL in a new tab (Plaid's hosted Link). Returns the window, or null when blocked/unavailable. */
export function openInNewTab(url: string): Window | null {
  if (typeof window === "undefined") return null;
  return window.open(url, "_blank", "noopener,noreferrer");
}

/** A user-safe message from any thrown value (RestError carries the gateway's `{ error }` body). */
export function errorMessage(e: unknown): string {
  if (e instanceof RestError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  // "unreachable on loopback" describes our wiring, not anything the reader can act on (#106). What
  // went wrong and what to do about it: the gateway did not answer, so check it is running.
  return "Postern didn’t answer. Check the gateway is running, then try again.";
}

/**
 * A device-push credential needs a `secret` the vault can seal, but the real gate is the
 * per-connection webhook secret minted afterwards — so the upstream credential is a sentinel, not a
 * usable token. (Same value the pre-revamp Console used, so nothing about the backend contract moves.)
 */
export const DEVICE_PUSH_SENTINEL =
  "device-push (no upstream credential — auth is the per-connection webhook secret)";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;

/**
 * Validate the collected values against the provider's shape BEFORE any round-trip. Returns the first
 * problem (so one seal shows at a time), or null when the shape is right. This is the ONLY place the
 * "ours" failure comes from — a provider's "no" is never predicted here.
 */
export function validateShape(def: ProviderDef, v: ConnectValues): ShapeError | null {
  const trimmed = (s: string | undefined) => (s ?? "").trim();

  if (def.custody === "paste") {
    if (def.providerKey === "apple") {
      if (!EMAIL_RE.test(trimmed(v.username))) {
        return {
          field: "username",
          message:
            "That doesn’t look like an Apple ID — it should be an email like you@icloud.com.",
        };
      }
      if (trimmed(v.secret).length === 0) {
        // #95 item 5: this said "your normal Apple password won't work" two fields from a footnote
        // already corrected to the honest framing. The credential IS an Apple ID password — an
        // app-specific one — so "normal" was drawing a distinction that does not exist, and it told
        // the person what would FAIL instead of what Postern can see. Same vocabulary as the
        // footnote on this screen ("Apple ID password" vs "app-specific password"), so the two agree.
        return {
          field: "secret",
          message:
            "Paste the app-specific password you generated — four groups of four. Postern never sees your Apple ID password, only this one.",
        };
      }
      return null;
    }
    if (def.providerKey === "gmail") {
      if (!EMAIL_RE.test(trimmed(v.username))) {
        return { field: "username", message: "That isn’t an email address — it should look like you@gmail.com." };
      }
      const pw = trimmed(v.secret).replace(/\s+/g, "");
      if (pw.length !== 16) {
        return {
          field: "secret",
          message:
            "A Gmail app password is 16 characters — check you copied all of it (spaces are fine, they’re ignored).",
        };
      }
      return null;
    }
    if (def.providerKey === "home_assistant") {
      if (!URL_RE.test(trimmed(v.instanceUrl))) {
        return {
          field: "instanceUrl",
          message:
            "That isn’t a URL — your Home Assistant address starts with http:// or https://, e.g. http://192.168.1.50:8123.",
        };
      }
      if (trimmed(v.secret).length === 0) {
        return { field: "secret", message: "Paste the long-lived access token you copied from Home Assistant." };
      }
      return null;
    }
    if (def.providerKey === "simplefin") {
      const s = trimmed(v.secret);
      if (s.length === 0) {
        return { field: "secret", message: "Paste your SimpleFIN access URL, or the setup token from the Bridge." };
      }
      // A real access URL embeds credentials (`https://user:pass@host`) — the token sits right after
      // the `//` and before the `@`; a bare bridge address has no such segment. That is the single
      // most common paste mistake, so the machine test keys on the absent `@` (the precise signal) and
      // the message is the design's own drawn copy VERBATIM (FA2-0 / FHH-0), which names the same
      // segment from the reader's side ("after the //"). Do not paraphrase or extend it (law 10).
      if (URL_RE.test(s) && !s.includes("@")) {
        return {
          field: "secret",
          message:
            "That’s the bridge address, not your access URL. Yours starts with https:// and carries a token after the //.",
        };
      }
      return null;
    }
    return null;
  }

  if (def.custody === "oauth" || def.custody === "plaid") {
    if (trimmed(v.clientId).length === 0) {
      return { field: "clientId", message: `Paste the ${def.fields[0]?.label ?? "client ID"} for your app.` };
    }
    // Confidential clients (google/whoop/plaid) cannot sign in without the secret; a public client
    // (microsoft) must NOT collect one.
    if (def.confidential && trimmed(v.clientSecret).length === 0) {
      return {
        field: "clientSecret",
        message: `${def.name} is a confidential client — paste the client secret too, or the sign-in will be refused.`,
      };
    }
    return null;
  }

  return null;
}

/**
 * The first sync's outcome, REPORTED rather than swallowed (#96 §4). `syncNow` fails two ways:
 * it throws (transport / 4xx), or it resolves with `{ ok: false, error }` (api/types.ts — the same
 * discriminant ConnectionDetail reads on its own Sync now). Both fold to `failed`.
 */
export type FirstSync =
  | { kind: "ok" }
  | { kind: "failed"; message: string }
  | { kind: "not_attempted" };

/** The outcome of a paste connect — the connection(s) created, and how their first read went. */
export interface PasteResult {
  connectionIds: string[];
  firstSync: FirstSync;
}

/**
 * Run a paste-token connect. Apple fans out server-side (one credential → mail+calendar+contacts);
 * every other paste source is one addCredential → createConnector pair, then a first sync whose
 * outcome is REPORTED. A provider "no" on the credential/connector still throws (the caller renders
 * it verbatim); a first-sync failure does not — the connection genuinely exists.
 */
export async function runPaste(def: ProviderDef, v: ConnectValues): Promise<PasteResult> {
  if (def.providerKey === "apple") {
    const res = await api.appleOnboard({
      appleId: (v.username ?? "").trim(),
      appSpecificPassword: v.secret ?? "",
    });
    // The fan-out is server-side and no sync is issued here — reporting `ok` would be a claim about
    // a read that never ran.
    return {
      connectionIds: res.connectors.map((c) => c.connectionId),
      firstSync: { kind: "not_attempted" },
    };
  }
  const cred = await api.addCredential({
    provider: def.providerKey,
    secret: v.secret ?? "",
    ...(v.username ? { username: v.username.trim() } : {}),
    ...(v.instanceUrl ? { instanceUrl: v.instanceUrl.trim() } : {}),
  });
  const conn = await api.createConnector({ credentialId: cred.credentialId, sector: def.connectSector as string });
  // The connector is NEVER deleted on a failed first sync: it exists upstream and in the store, so a
  // rollback here would fabricate a state the gateway is not in. We report and let the user decide.
  let firstSync: FirstSync;
  try {
    const r = await api.syncNow(conn.connectionId);
    firstSync =
      r.ok === false || r.error
        ? { kind: "failed", message: r.error ?? "The first sync did not complete." }
        : { kind: "ok" };
  } catch (e) {
    firstSync = { kind: "failed", message: errorMessage(e) };
  }
  return { connectionIds: [conn.connectionId], firstSync };
}

/**
 * Save an OAuth BYO app and resolve the provider's consent URL. The caller redirects the browser to
 * it (the consent happens at the provider, the gateway callback seals the tokens and creates the
 * covered connectors). Microsoft is public — no secret is sent.
 */
export async function prepareOAuth(def: ProviderDef, v: ConnectValues): Promise<string> {
  const provider = def.oauthProvider as OAuthProvider;
  const body: { clientId: string; clientSecret?: string } = { clientId: (v.clientId ?? "").trim() };
  if (def.confidential) body.clientSecret = v.clientSecret ?? "";
  await api.setOauthApp(provider, body);
  return api.oauthAuthorizationUrl(provider);
}

/**
 * Save the BYO Plaid app (Production) and mint a hosted-link session. The caller opens
 * `hostedLinkUrl` in a new tab and polls `linkToken` for the banks the operator authenticates — the
 * poll is the only authoritative success signal (the completion redirect fires on exit too).
 */
export async function startPlaid(v: ConnectValues): Promise<PlaidHostedLinkResult> {
  await api.setPlaidApp({
    clientId: (v.clientId ?? "").trim(),
    clientSecret: v.clientSecret ?? "",
    env: "production",
  });
  return api.plaidHostedLink();
}

/**
 * The minted device ingest connection: the SERVED ingest path + its one-time webhook secret.
 *
 * `ingestPath` is exactly what the backend returns — a RELATIVE path `/api/ingest/<id>` (admin.ts;
 * asserted relative in ingest.db.test.ts). The reachable BASE (your tailnet/public remote-access
 * host, e.g. `https://your-mac.tailnet.ts.net:8443`) is genuinely NOT served: the Console runs on
 * loopback — which a phone can never POST to — and the remote-access address has no fixed offset
 * from this origin (the same caveat the OAuth redirect documents). So we surface the served path
 * honestly and name the host the operator must supply; we never dress `localhost:8787` as the
 * reachable endpoint (#27, degradation contract — console-port-plan §3).
 */
export interface DeviceResult {
  connectionId: string;
  /** The SERVED relative ingest path `/api/ingest/<id>` — NOT a synthesized reachable URL (#27). */
  ingestPath: string;
  /** The one-time `X-PCI-Webhook-Secret` value — shown ONCE. */
  secret: string;
}

/**
 * Create the Apple Health device connector and mint its one-time ingest secret. The secret is the
 * `X-PCI-Webhook-Secret` header the device must send; it is shown ONCE and never re-fetchable.
 */
export async function runDevice(def: ProviderDef): Promise<DeviceResult> {
  const cred = await api.addCredential({ provider: def.providerKey, secret: DEVICE_PUSH_SENTINEL });
  const conn = await api.createConnector({ credentialId: cred.credentialId, sector: def.connectSector as string });
  const mint = await api.mintIngestSecret(conn.connectionId);
  // The backend serves a RELATIVE path; the reachable host is the operator's remote-access address,
  // not the Console's loopback origin — so we do NOT absolutise it here (#27, degradation contract).
  return { connectionId: conn.connectionId, ingestPath: mint.ingestUrl, secret: mint.secret };
}
