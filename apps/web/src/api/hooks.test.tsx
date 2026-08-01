// The polling / invalidation contract (#62) and the coverage-count departure from #60.
//
// The bug being fixed: today ONLY `useHealthz` polls and `refetchOnWindowFocus` is false, so
// "synced 2m ago" sits frozen while the operator watches it and a push socket can die on screen
// without the screen changing. Freshness is the product's core signal; a frozen one is a lie with
// a timestamp on it.

import "./test-dom"; // installs a jsdom global BEFORE React/testing-library load (see test-dom.ts)
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_POLL_MS,
  FRESHNESS_POLL_MS,
  auditHitCeiling,
  useConnectors,
  useInvalidateConnectors,
  useSectorCoverage,
} from "./hooks";
import { useTick } from "./format";
import { api } from "./client";
import { queryClient as appQueryClient } from "./queryClient";
import { AUDIT_LIMIT_DEFAULT } from "./types";

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
  });
}

beforeEach(() => {
  // Every test starts on REAL timers. This top-level hook runs before any nested one, so the
  // useTick describe's own `beforeEach(vi.useFakeTimers)` still wins for its tests — but a
  // coverage/ledger test can never inherit fake timers a prior test forgot to restore (which would
  // freeze `waitFor`'s own polling and time it out against nothing).
  vi.useRealTimers();
});

afterEach(() => {
  // Unmount every rendered hook. We are not using vitest's `jsdom` environment (see test-dom.ts),
  // so testing-library's auto-cleanup afterEach is never registered — without this, components
  // accumulate and earlier hooks' live query observers (15s refetchInterval) keep firing into
  // later tests. That cross-talk is why a coverage test passed alone but failed in the full run.
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("freshness advances on a watched screen (#62)", () => {
  it("useConnectors declares a freshness refetchInterval and is stale-on-arrival", async () => {
    // Asserting the OPTION rather than sleeping 15s: react-query stores the observer's resolved
    // options on the live query, so this pins the contract deterministically. A frozen
    // "synced 2m ago" is precisely the bug — the interval is what unfreezes it.
    const listConnectors = vi.spyOn(api, "listConnectors").mockResolvedValue([]);
    const client = freshClient();
    const { result } = renderHook(() => useConnectors(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listConnectors).toHaveBeenCalledTimes(1);

    const query = client.getQueryCache().find({ queryKey: ["connectors"] });
    const opts = query?.observers[0]?.options;
    expect(opts?.refetchInterval).toBe(FRESHNESS_POLL_MS);
    expect(opts?.staleTime).toBe(0); // returning to the tab always re-reads
    client.clear();
  });

  it("the poll intervals are declared, not accidental", () => {
    expect(FRESHNESS_POLL_MS).toBe(15_000);
    expect(AUDIT_POLL_MS).toBe(30_000);
  });

  it("the app's shared client refetches on window focus — coming back is a 'still true?' signal", () => {
    expect(appQueryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true);
  });

  it("a mutation invalidates the connector queries it affects — a 15s lag reads as a broken button", async () => {
    const listConnectors = vi.spyOn(api, "listConnectors").mockResolvedValue([]);
    const client = freshClient();
    const { result } = renderHook(
      () => ({ list: useConnectors(), invalidate: useInvalidateConnectors() }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const before = listConnectors.mock.calls.length;

    result.current.invalidate("c1");
    await waitFor(() => expect(listConnectors.mock.calls.length).toBeGreaterThan(before));
    client.clear();
  });
});

describe("useTick — labels advance WITHOUT a refetch", () => {
  // Deliberately REAL timers with tiny sub-second intervals, not fake ones. A hand-rolled jsdom under
  // the root runner plus react-query plus @sinonjs fake-timers proved to leave later queries wedged
  // in "pending" across tests; real timers keep this hook's tests hermetic. The intervals are 50ms,
  // so the suite stays fast.

  it("increments on its interval", async () => {
    const { result } = renderHook(() => useTick(0.05));
    expect(result.current).toBe(0);
    await waitFor(() => expect(result.current).toBeGreaterThanOrEqual(1));
    const seen = result.current;
    await waitFor(() => expect(result.current).toBeGreaterThan(seen));
  });

  it("issues NO network call — a second hand is not a reason to hit the gateway", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useTick(0.02));
    await waitFor(() => expect(result.current).toBeGreaterThanOrEqual(2));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("clears its interval on unmount — a page left behind must not keep ticking", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useTick(5));
    unmount();
    expect(clear).toHaveBeenCalled();
  });

  it("a non-positive interval schedules nothing rather than spinning", () => {
    const set = vi.spyOn(globalThis, "setInterval");
    renderHook(() => useTick(0));
    expect(set).not.toHaveBeenCalled();
  });
});

describe("sector coverage is query() truth, not summed cached_count (#60 departure)", () => {
  it("asks for a count aggregate per REGISTRY object in the sector", async () => {
    const queryData = vi.spyOn(api, "queryData").mockImplementation(async (object) =>
      ({
        sector: object,
        object,
        aggregate: { fn: "count" },
        count: 1,
        groups: [{ group: {}, value: object === "finance.account" ? 12 : 480 }],
      }) as never,
    );
    const client = freshClient();
    const { result } = renderHook(() => useSectorCoverage("finance"), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.counts).toBeDefined());
    expect(result.current.counts).toEqual({
      "finance.account": 12,
      "finance.transaction": 480,
      "finance.holding": 480,
    });

    // Three objects, three count aggregates — and NOT a connectors-list read: `cached_count`
    // triple-counts a cross-provider-merged finance account (both pristine provider rows plus the
    // synthetic union row), so summing it reports a figure no agent will ever see.
    expect(queryData).toHaveBeenCalledTimes(3);
    for (const [, body] of queryData.mock.calls) {
      expect(body).toEqual({ aggregate: { fn: "count" } });
    }
    client.clear();
  });

  it("counts stay UNDEFINED until every object has answered — a partial total is a wrong total", async () => {
    // A controllable deferred for the objects we want to hold pending. EVERY one is resolved before
    // the test returns — a dangling unresolved queryFn promise poisons the NEXT test's scheduler
    // (react-query never leaves the pending state), which is a real cross-test hazard, not cosmetic.
    const pending: Array<(v: unknown) => void> = [];
    const answer = (object: string) => ({
      sector: object,
      object,
      aggregate: { fn: "count" },
      count: 1,
      groups: [{ group: {}, value: 5 }],
    });
    vi.spyOn(api, "queryData").mockImplementation(async (object) => {
      if (object === "health.sample") return answer(object) as never;
      return new Promise<never>((res) => pending.push(res as (v: unknown) => void)) as never;
    });
    const client = freshClient();
    const { result } = renderHook(() => useSectorCoverage("health"), { wrapper: wrapper(client) });

    // Wait until the first object has landed but the others are still outstanding.
    await waitFor(() => expect(pending.length).toBe(2));
    // The figure must not paint yet (the caller renders a Skeleton — the em-dash-at-hero-size
    // defect is fixed by the skeleton, not by taking the wrong source fast).
    expect(result.current.counts).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    // Drain every held query with a VALID aggregate, so nothing dangles into the next test.
    await act(async () => {
      for (const res of pending) res(answer("health.x"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.counts).toBeDefined());
    client.clear();
  });

  it("coerces a pg numeric string, so a count never renders as '480' concatenated somewhere", async () => {
    vi.spyOn(api, "queryData").mockImplementation(async (object) =>
      ({
        sector: object,
        object,
        aggregate: { fn: "count" },
        count: 1,
        groups: [{ group: {}, value: "2481" }],
      }) as never,
    );
    const client = freshClient();
    const { result } = renderHook(() => useSectorCoverage("mail"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.counts).toBeDefined());
    expect(result.current.counts).toEqual({ mail: 2481 });
    expect(typeof result.current.counts?.mail).toBe("number");
    client.clear();
  });
});

describe("the ledger is honest about its ceiling", () => {
  it("flags a full page as 'there is more you cannot reach'", () => {
    expect(auditHitCeiling(new Array(AUDIT_LIMIT_DEFAULT).fill({}))).toBe(true);
    expect(auditHitCeiling(new Array(AUDIT_LIMIT_DEFAULT - 1).fill({}))).toBe(false);
    expect(auditHitCeiling(new Array(200).fill({}), { limit: 200 })).toBe(true);
    expect(auditHitCeiling(new Array(199).fill({}), { limit: 200 })).toBe(false);
  });

  it("respects the server's hard cap when a caller asks for more than it will give", () => {
    // getAudit does Math.min(n, 1000) silently, so 1000 rows back from a limit:5000 request IS the
    // ceiling — treating 5000 as the target would report "complete" on a truncated answer.
    expect(auditHitCeiling(new Array(1000).fill({}), { limit: 5000 })).toBe(true);
  });

  it("says nothing before the data arrives", () => {
    expect(auditHitCeiling(undefined)).toBe(false);
  });
});
