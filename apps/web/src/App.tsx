// App — the full route table (console-port-plan §4 / D5). Phase 1 owns the router so seven phase-2
// children each replace ONLY their own page directory and no child ever edits routing — the seam
// that makes seven-way parallelism safe. Every route renders the real shell (rail + active state,
// derived from the URL in AppShell) around a marked <PlaceholderBody> naming its owning group.
//
// Reveal-once is a STATE of `/agents/new` after minting, NEVER a route: a plaintext key must not be
// able to reach a URL, a history entry, or a referer.

import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { AppShell } from "./shell";
import { PlaceholderBody } from "./pages/_placeholder/PlaceholderBody";
// Phase-2 page groups, wired in by the mother as each lands (replacing its PlaceholderBody).
import { Gatehouse } from "./pages/gatehouse";
import { AgentsPage, MintKeyPage, AgentDetailPage, ConnectHostedPage } from "./pages/agents";
import { LedgerPage, SettingsPage, EraseConfirmPage } from "./pages/records";
import { SectorLensPage, ConfirmMergePage } from "./pages/lenses";
import { InspectorPage, RecordDrillPage } from "./pages/inspector";
import { SourcesPage, ConnectionDetail } from "./pages/sources";
import { AddASource, ConnectProvider } from "./pages/connect";

/** The layout route: the shell wraps every page via its <Outlet />. */
function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * The route table, exported as DATA so the backend↔frontend redirect contract is assertable
 * (`pages/connect/route-contract.test.ts`). `/connections` — the target every OAuth consent 302'd
 * to — was deleted with the dark-SaaS surface in 4bbb22f and matched only the `*` route below.
 * A redirect target that resolves to `*` is a dead end (#96 §1).
 *
 * Every phase-2 route points at its placeholder until its group lands. `unit` names that group.
 */
export const ROUTE_TABLE: RouteObject[] = [
  {
    element: <ShellLayout />,
    children: [
      { index: true, element: <Gatehouse /> },

      // Sector lenses + confirm-a-merge — P2c (lenses)
      { path: "sectors/:sector", element: <SectorLensPage /> },
      {
        path: "sectors/finance/merges/:bankKey",
        element: <ConfirmMergePage />,
      },

      // Inspectors + record drill — P2d (inspector)
      { path: "sectors/:sector/inspect", element: <InspectorPage /> },
      {
        path: "sectors/:sector/inspect/:id",
        element: <RecordDrillPage />,
      },

      // Sources + connection detail — P2b (sources)
      { path: "sources", element: <SourcesPage /> },
      { path: "sources/:connectionId", element: <ConnectionDetail /> },

      // Add a source + connect screens — P2e (connect)
      { path: "connect", element: <AddASource /> },
      { path: "connect/:provider", element: <ConnectProvider /> },

      // Agents & keys + sub-pages — P2f (agents). /agents/new holds the reveal-once STATE.
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/new", element: <MintKeyPage /> },
      { path: "agents/connect/hosted", element: <ConnectHostedPage /> },
      { path: "agents/:agentId", element: <AgentDetailPage /> },

      // The ledger, Settings, Erase — P2g (records)
      { path: "ledger", element: <LedgerPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/erase", element: <EraseConfirmPage /> },

      { path: "*", element: <PlaceholderBody unit="— not found" /> },
    ],
  },
];

const router = createBrowserRouter(ROUTE_TABLE);

export function App() {
  return <RouterProvider router={router} />;
}
