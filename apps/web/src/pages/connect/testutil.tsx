// Test helpers for the connect group — a ConnectorStatus factory and a render-at-route harness. Not
// a *.test file, so vitest never runs it as a suite; imported by the group's tests.

import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../kit";
import type { ConnectorStatus } from "../../api/types";

/** A live-active ConnectorStatus with sane defaults; override what a test cares about. */
export function conn(partial: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "conn_1",
    provider: "apple",
    sector: "mail",
    status: "active",
    last_synced_at: "2026-07-01T00:00:00.000Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    credentialId: "cred_fixture",
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    ...partial,
  };
}

/** Render a tree at `path` with the router + query + toast providers the pages expect. `routes` maps
 *  path patterns to elements (so `/connect/:provider` can capture the slug). */
export function renderAt(
  path: string,
  routes: { pattern: string; element: ReactNode }[],
): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {routes.map((r) => (
              <Route key={r.pattern} path={r.pattern} element={r.element} />
            ))}
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
