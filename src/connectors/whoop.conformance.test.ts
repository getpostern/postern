// WHOOP conformance — contract layer (always) + the INTEGRATION layer (a fetch-mock connector;
// gated on DATABASE_URL). The integration drives the REAL syncConnection via WHOOP's own HTTP mock to
// assert H6 (the runner injects connection_id/user_id, raw=rec.raw, deleted_at=null) and H7 (the
// cursor advances). Mirrors whoop.db.test.ts's setup (a dedicated throwaway user so it never races it).

import { vi } from "vitest";
import { describeConformance, type ConformanceIntegrationCtx } from "../sdk/index.js";
import { WhoopConnector } from "./whoop.js";
import { WHOOP_CONFORMANCE } from "./whoop.conformance.js";
import { SLEEP_SCORED, WORKOUT_SCORED, RECOVERY_SCORED, whoopPage } from "./whoop.fixtures.js";

// A DEDICATED throwaway user, distinct from whoop.db.test.ts (07f1) — both run in parallel and would
// otherwise contend the unique(user_id, provider) credential row.
const TEST_USER = "00000000-0000-0000-0000-0000000008c1";
const SECRET = "whoop-conformance-access-token";

const P_SLEEP = "/developer/v2/activity/sleep";
const P_WORKOUT = "/developer/v2/activity/workout";
const P_RECOVERY = "/developer/v2/recovery";

const realFetch = globalThis.fetch;

let connectionId = "";
let credentialId = "";
let secretRef = "";

interface Page {
  records: unknown[];
  next_token: string | null;
}

/** Mock fetch: one page per pathname (single-page; the runner needs no chaining here). */
function mockWhoop(pagesByPath: Record<string, Page>): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const page = pagesByPath[url.pathname] ?? { records: [], next_token: null };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describeConformance(new WhoopConnector(), WHOOP_CONFORMANCE, {
  integration: {
    setup: async () => {
      const { pool } = await import("../db.js");
      const { seal } = await import("../secrets/index.js");
      const { registerConnector } = await import("../sync/index.js");
      await pool.query(
        `insert into users (id, label) values ($1, 'whoop-conformance') on conflict (id) do nothing`,
        [TEST_USER],
      );
      secretRef = await seal({ userId: TEST_USER, provider: "whoop", purpose: "access" }, SECRET);
      const cred = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
         values ($1, 'whoop', 'first_party', $2, 'active') returning id`,
        [TEST_USER, secretRef],
      );
      credentialId = cred.rows[0].id as string;
      const conn = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, 'health', 'whoop', 'active') returning id`,
        [TEST_USER, credentialId],
      );
      connectionId = conn.rows[0].id as string;
      // Preset a recent cursor → incremental (single window, single fetch per endpoint) for determinism.
      await pool.query(`update connectors set cursor = $2 where id = $1`, [
        connectionId,
        new Date(Date.now() - 3600_000).toISOString(),
      ]);
      registerConnector(new WhoopConnector());
    },
    teardown: async () => {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
      const { pool } = await import("../db.js");
      await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
      await pool.query(`delete from secrets where ref = $1`, [secretRef]);
      await pool.query(`delete from users where id = $1`, [TEST_USER]);
      await pool.end();
    },
    ctx: (): ConformanceIntegrationCtx => ({
      connectionId,
      userId: TEST_USER,
      table: "health_workouts",
      probeSourceObjectId: WORKOUT_SCORED.id,
      runProductiveSync: async () => {
        const { syncConnection } = await import("../sync/index.js");
        mockWhoop({
          [P_SLEEP]: whoopPage([SLEEP_SCORED]),
          [P_WORKOUT]: whoopPage([WORKOUT_SCORED]),
          [P_RECOVERY]: whoopPage([RECOVERY_SCORED]),
        });
        return syncConnection(connectionId);
      },
    }),
  },
});
