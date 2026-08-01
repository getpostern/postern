// The four reads the Console could not reach, and the one distinction the whole of #58 turns on:
// **"not served" is a fact about the wire; "none" is a claim about the gateway's capability.**
//
// `CAN ACT: none` on a sector lens is the exact sentence this file exists to prevent. All four are
// SERVED now (commit 8529bd3), which moved the danger rather than removing it: the client used to fail
// LOUDLY on every one of them, and a client that keeps a stale declaration against a route that started
// answering fails SILENTLY instead. Both halves are pinned below.
//
// Route facts pinned here (verified in `src/rest/index.ts` + `src/rest/mirror.ts` at commit 8529bd3):
//   · `GET  /api/actions`             — localOnly (loopback operator). Serves core's ActionCatalog
//                                       `{ actions, count, truncated }` VERBATIM — NOT a bare array.
//   · `GET  /api/operator/context`    — localOnly. describe_context.
//   · `GET  /api/operator/schema`     — localOnly. get_schema, filtered to granted sectors.
//   · `POST /api/operator/fetch_live` — localOnly. The one read-time upstream path.
// The BEARER paths (`/api/context`, `/api/schema`, `/api/fetch_live`) are a separate, still-bearer-gated
// surface this client must never call: a loopback fallback there would let a missing or mistyped bearer
// silently succeed as the ALL-SECTORS operator.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_URL, NotServedError, RestError, api } from "./client";

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** An empty-but-real catalog: the shape a read-only sector genuinely answers with. */
const EMPTY_CATALOG = { actions: [], count: 0, truncated: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

const call = {
  listActions: () => api.listActions("home"),
  fetchLive: () => api.fetchLive("mail", { id: "abc" }),
  describeContext: () => api.describeContext(),
  getSchema: () => api.getSchema("finance"),
} as const;

describe("the methods exist and issue the REAL request", () => {
  it("listActions hits GET /api/actions?sector=", async () => {
    const f = stubFetch(200, EMPTY_CATALOG);
    await api.listActions("home");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY_URL}/api/actions?sector=home`);
    expect(init.method).toBe("GET");
  });

  it("fetchLive POSTs the sector, and the id only when drilling one record", async () => {
    const f = stubFetch(200, { sector: "mail", mode: "record", id: "abc", record: null });
    await api.fetchLive("mail", { id: "abc" });
    let [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY_URL}/api/operator/fetch_live`);
    expect(JSON.parse(init.body as string)).toEqual({ sector: "mail", id: "abc" });

    // Sector sync-now: `id` must be ABSENT, not null — the route body is `.strict()` and a bad
    // `id` must 400 rather than silently degrading a drill into a whole-sector sync (#1).
    const f2 = stubFetch(200, { sector: "mail", mode: "sync" });
    await api.fetchLive("mail");
    [url, init] = f2.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"sector":"mail"}');
  });

  it("describeContext and getSchema hit the OPERATOR routes", async () => {
    const f = stubFetch(200, {});
    await api.describeContext();
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${GATEWAY_URL}/api/operator/context`);

    const f2 = stubFetch(200, {});
    await api.getSchema("finance");
    expect((f2.mock.calls[0] as unknown as [string])[0]).toBe(
      `${GATEWAY_URL}/api/operator/schema?sector=finance`,
    );

    const f3 = stubFetch(200, {});
    await api.getSchema();
    expect((f3.mock.calls[0] as unknown as [string])[0]).toBe(`${GATEWAY_URL}/api/operator/schema`);
  });

  it("NEVER calls a BEARER-gated mirror path — the Console carries no bearer by construction", async () => {
    // The three primitives are served to loopback at /api/operator/*, and were deliberately NOT added
    // as a fallback on the bearer paths: a fallback there would let a missing or mistyped bearer
    // silently succeed as the all-sectors operator. A client that drifts back onto /api/context,
    // /api/schema or /api/fetch_live is asking an authenticated surface a question with no credential.
    const urls: string[] = [];
    for (const [, fn] of Object.entries(call)) {
      const f = stubFetch(200, EMPTY_CATALOG);
      await fn().catch(() => undefined);
      urls.push((f.mock.calls[0] as unknown as [string])[0]);
      vi.unstubAllGlobals();
    }
    const BEARER_ONLY = ["/api/context", "/api/schema", "/api/fetch_live", "/api/query", "/api/records/"];
    for (const url of urls) {
      const path = url.slice(GATEWAY_URL.length);
      for (const bearer of BEARER_ONLY) {
        // `startsWith`, not `includes`: /api/operator/schema legitimately CONTAINS "/api/schema"'s tail
        // but is a different route, and a test that could not tell them apart would pass either way.
        expect(path.startsWith(bearer)).toBe(false);
      }
    }
    // and every one of them is under the operator/local surface
    expect(urls.map((u) => u.slice(GATEWAY_URL.length)).sort()).toEqual([
      "/api/actions?sector=home",
      "/api/operator/context",
      "/api/operator/fetch_live",
      "/api/operator/schema?sector=finance",
    ]);
  });
});

describe("a missing route is NotServedError{no_route} — never an empty answer", () => {
  // Still reachable, and not hypothetical: the routes exist on THIS build, so a 404 means the BOX is
  // running an older gateway than the Console — the ordinary state midway through a staged deploy.
  for (const [name, fn] of Object.entries(call)) {
    it(`${name} on a gateway older than the route rejects with no_route`, async () => {
      stubFetch(404, { error: "not found" });
      const err = await fn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotServedError);
      expect((err as NotServedError).reason).toBe("no_route");
    });
  }

  it("listActions does NOT resolve to an empty catalog on a 404", async () => {
    // THE #58 INVARIANT. An empty catalog and an unreachable catalog are different facts, and the
    // failure mode is asymmetric: resolving to `{actions:[]}` here would print "read-only, no actions"
    // for a sector that may act.
    stubFetch(404, { error: "not found" });
    const err = await api.listActions("home").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotServedError);
    expect(err).not.toEqual(EMPTY_CATALOG);
  });

  it("405 (route shape exists, verb does not) is also no_route", async () => {
    stubFetch(405, { error: "method not allowed" });
    const err = await call.listActions().catch((e: unknown) => e);
    expect((err as NotServedError).reason).toBe("no_route");
  });
});

describe("a 403 from the loopback Host guard is a LOUD error, never 'not served'", () => {
  // These four routes are `localOnly`, so the only 403 they can answer is the Host-allowlist —
  // the DNS-rebinding guard — refusing THIS REQUEST (a Console opened at a non-allowlisted host,
  // e.g. through a Funnel). The capability is present; the request was rejected. Reporting it as
  // "not served — this is on the bearer-gated mirror, and the Console carries no agent key" would be
  // flatly false and would send the operator hunting for a bearer that is not the problem. Every other
  // operator route surfaces this as the RestError it is, and so must these.
  for (const [name, fn] of Object.entries(call)) {
    it(`${name} surfaces a 403 as RestError with the server's message`, async () => {
      stubFetch(403, { error: "forbidden host" });
      const err = await fn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RestError);
      expect(err).not.toBeInstanceOf(NotServedError);
      expect((err as RestError).status).toBe(403);
      expect((err as RestError).message).toBe("forbidden host");
    });
  }

  it("401 is not folded in either", async () => {
    stubFetch(401, { error: "unauthorized" });
    const err = await call.describeContext().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect(err).not.toBeInstanceOf(NotServedError);
  });
});

describe("the sentence says 'not served', never 'none'", () => {
  it("every NotServedError message begins 'Not served' and never claims 'none'", async () => {
    for (const fn of Object.values(call)) {
      stubFetch(404, { error: "nope" });
      const err = (await fn().catch((e: unknown) => e)) as NotServedError;
      expect(err).toBeInstanceOf(NotServedError);
      expect(err.message).toMatch(/^Not served/);
      expect(err.message.toLowerCase()).not.toMatch(/\bnone\b/);
      vi.unstubAllGlobals();
    }
  });

  it("the no_route sentence blames the gateway's BUILD, and names the capability not the route", async () => {
    stubFetch(404, { error: "not found" });
    const noRoute = (await call.listActions().catch((e: unknown) => e)) as NotServedError;
    expect(noRoute.message).toBe("Not served — this gateway has no route for the action catalog yet.");
    expect(noRoute.message).not.toMatch(/\/api\//);
  });

  it("the unauthorized reason survives as vocabulary for the bearer surface", () => {
    // Nothing PRODUCES it today (no method here calls a bearer path), and that is the point: the
    // reason is kept so the two facts stay nameable, and so narrowing an exported union does not break
    // a consumer for nothing. If a method ever calls a bearer route again, this is its reason.
    const e = new NotServedError("unauthorized", "Not served to the Console — needs an agent key.");
    expect(e.reason).toBe("unauthorized");
    expect(e.message).toMatch(/^Not served/);
  });

  it("is an Error subclass with a stable name, so a boundary can render it", () => {
    const e = new NotServedError("no_route", "Not served — x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NotServedError");
  });
});

describe("a BROKEN gateway is not an unserved capability", () => {
  it("500 stays a RestError — folding it in would turn an outage into 'this feature doesn't exist'", async () => {
    for (const fn of Object.values(call)) {
      stubFetch(500, { error: "internal" });
      const err = await fn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RestError);
      expect(err).not.toBeInstanceOf(NotServedError);
      vi.unstubAllGlobals();
    }
  });

  it("502 (the source could not serve a live fetch) stays a RestError with the server's message", async () => {
    stubFetch(502, { error: "home assistant websocket not connected" });
    const err = await call.fetchLive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect((err as RestError).status).toBe(502);
  });

  it("a network failure is not swallowed into 'not served' either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await call.describeContext().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
  });
});

describe("a real answer passes through", () => {
  it("a served catalog resolves to the whole envelope, count and truncated included", async () => {
    const wire = {
      actions: [{ id: "home.light.turn_on", description: "Turn on", params: [] }],
      count: 1,
      truncated: false,
    };
    stubFetch(200, wire);
    await expect(api.listActions("home")).resolves.toEqual(wire);
  });

  it("a served EMPTY catalog is a real answer and must NOT read as not-served", async () => {
    // A read-only connector genuinely has no actions. `{actions: [], count: 0}` means "this sector
    // cannot act", which is a true claim; the NotServedError path means "we don't know" — different.
    stubFetch(200, EMPTY_CATALOG);
    await expect(api.listActions("finance")).resolves.toEqual(EMPTY_CATALOG);
  });
});
