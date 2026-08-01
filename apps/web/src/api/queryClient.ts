// The shared TanStack Query client.
//
// The default posture changed in the port (#62). Before: `refetchOnWindowFocus: false` and a 30s
// staleTime everywhere, with `useHealthz` the only polling query — so freshness, the product's core
// signal, never advanced on a watched screen. An operator could sit on a connection card while a
// sync landed, or while a push socket died, and see nothing move.
//
// Now: focus refetching is ON, and the queries that carry freshness declare their own poll interval
// and a zero staleTime (see `hooks.ts`). Heavy operator data reads keep the 30s staleTime — the
// cache is the point of the gateway, and the inspector must stay instant.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      /** Coming back to the tab is the strongest "is this still true?" signal there is. Queries
       *  whose staleTime has not elapsed still skip the fetch — freshness queries set it to 0. */
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
