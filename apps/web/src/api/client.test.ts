// api.setSyncInterval wire-shape test (spec sync-cadence-control, Child B): the client must hit
// the frozen route `POST /api/connectors/:id/sync-interval` with the strict `{ interval_sec }`
// body — null serialized explicitly (the reset), never dropped — and surface the typed 400 the
// backend answers for a below-floor value as a RestError carrying the server's message.

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, NotServedError, RestError } from "./client";

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.setSyncInterval", () => {
  it("the shipped Console addresses the gateway at its own origin — request paths are relative", async () => {
    // The LITERAL path, not `${GATEWAY_URL}${path}`: interpolating the same constant on both sides
    // is an identity that holds for every possible default, so it could not fail. The Console is
    // served BY the gateway (src/rest/static.ts), so its origin IS the gateway's — a baked absolute
    // origin makes it work at exactly one address and accuse itself of being down at every other.
    const fetchFn = stubFetch(200, { ok: true });
    const r = await api.setSyncInterval("c1", 3600);
    expect(r).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/connectors/c1/sync-interval");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ interval_sec: 3600 });
  });

  it("no absolute origin is ever baked into a request URL", async () => {
    const fetchFn = stubFetch(200, { ok: true });
    await api.setSyncInterval("c1", 3600);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).not.toMatch(/^[a-z]+:\/\//i);
    expect(url.startsWith("/")).toBe(true);
  });

  it("serializes the null reset explicitly (interval_sec: null, not an absent key)", async () => {
    const fetchFn = stubFetch(200, { ok: true });
    await api.setSyncInterval("c1", null);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"interval_sec":null}');
  });

  it("surfaces the typed below-floor 400 as a RestError with the server's message", async () => {
    stubFetch(400, { error: "interval_sec below the connector floor (3600s)" });
    const err = await api.setSyncInterval("c1", 300).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect((err as RestError).status).toBe(400);
    expect((err as RestError).message).toContain("floor");
  });

  it("surfaces the non-poll 409", async () => {
    stubFetch(409, { error: "cadence applies only to poll connections" });
    const err = await api.setSyncInterval("c-push", 3600).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect((err as RestError).status).toBe(409);
  });
});

// ONE source for the OAuth redirect_uri, and it is the gateway (ADR 0035 §D4). The Console asks and
// renders; it never composes the string itself.
describe("api.oauthRedirectUri", () => {
  it("the redirect URI the Console shows comes from the gateway, verbatim", async () => {
    // Deliberately a host the Console could NEVER derive from its own origin: if the method
    // synthesized the value, this exact string could not come back.
    const fetchFn = stubFetch(200, {
      provider: "google",
      configured: true,
      clientId: "cid",
      confidential: true,
      redirectUri: "https://gw.example.com/api/oauth/google/callback",
    });
    const uri = await api.oauthRedirectUri("google");
    expect(uri).toBe("https://gw.example.com/api/oauth/google/callback");
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/oauth/google/app");
  });

  it("a gateway that cannot report its redirect URI is reported as not served, never as a blank one", async () => {
    // An older or misconfigured gateway answers the route without the field. `undefined` rendered
    // into a <code> is exactly the invented-value failure this whole unit removes.
    stubFetch(200, { provider: "google", configured: true, clientId: "cid", confidential: true });
    const err = await api.oauthRedirectUri("google").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotServedError);
    expect((err as NotServedError).reason).toBe("no_route");
    expect((err as NotServedError).message).toBe(
      "Not served — this gateway did not answer with the redirect URI it uses.",
    );
  });
});
