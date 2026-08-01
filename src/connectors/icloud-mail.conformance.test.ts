// iCloud Mail conformance — contract layer (always) + the INTEGRATION layer (a client-class mock;
// gated on DATABASE_URL). The integration drives the REAL syncConnection via the injectable imapflow
// fake to assert H6 (the runner injects connection_id/user_id, raw=rec.raw, deleted_at=null), H7 (the
// per-folder cursor map persists), H8/S2 (fetchRecordLive serves the body but stores NOTHING), and S1
// (a connect failure that EMBEDS the ASP is masked — the error is secret-free). Uses a DEDICATED
// throwaway user distinct from icloud-mail.db.test.ts so the parallel suites never contend the
// unique(user_id, provider) credential row.

import { describeConformance, type ConformanceIntegrationCtx } from "../sdk/index.js";
import type { SyncContext } from "./types.js";
import { IcloudMailConnector } from "./icloud-mail.js";
import { ICLOUD_MAIL_CONFORMANCE } from "./icloud-mail.conformance.js";
import {
  INBOX_MSG_1,
  SENT_MSG_1,
  MESSAGE_BODY_RESULT,
  INBOX_PATH,
  SENT_PATH,
  UIDVALIDITY_INBOX,
  UIDVALIDITY_SENT,
  makeFakeImap,
  type FakeRound,
} from "./icloud-mail.fixtures.js";

// A DEDICATED throwaway user, distinct from icloud-mail.db.test.ts — both run in parallel and would
// otherwise contend the unique(user_id, provider) credential row.
const TEST_USER = "00000000-0000-0000-0000-0000000009c2";
const ASP = "icloud-conformance-app-specific-password";
const APPLE_ID = "operator@icloud.com";

let connectionId = "";
let credentialId = "";
let secretRef = "";

function inboxFolder(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return { path: INBOX_PATH, specialUse: "\\Inbox", uidValidity: UIDVALIDITY_INBOX, highestModseq: 55n, ...over };
}
function sentFolder(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return { path: SENT_PATH, specialUse: "\\Sent", uidValidity: UIDVALIDITY_SENT, highestModseq: 77n, ...over };
}

/** The one productive round: an inbox message + a sent message → lands two envelope rows. */
const PRODUCTIVE_ROUND: FakeRound = {
  folders: [inboxFolder({ messages: [INBOX_MSG_1] }), sentFolder({ messages: [SENT_MSG_1] })],
};

describeConformance(new IcloudMailConnector(), ICLOUD_MAIL_CONFORMANCE, {
  integration: {
    setup: async () => {
      const { pool } = await import("../db.js");
      const { seal } = await import("../secrets/index.js");
      await pool.query(
        `insert into users (id, label) values ($1, 'icloud-mail-conformance') on conflict (id) do nothing`,
        [TEST_USER],
      );
      // Seal the ASP as the sentinel SECRET — S1 proves it never leaks into an error.
      secretRef = await seal({ userId: TEST_USER, provider: "apple", purpose: "access" }, ASP);
      const cred = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
         values ($1, 'apple', 'static_token', $2, $3, 'active') returning id`,
        [TEST_USER, secretRef, APPLE_ID],
      );
      credentialId = cred.rows[0].id as string;
      const conn = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, 'mail', 'apple', 'active') returning id`,
        [TEST_USER, credentialId],
      );
      connectionId = conn.rows[0].id as string;
    },
    teardown: async () => {
      const { pool } = await import("../db.js");
      await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
      await pool.query(`delete from secrets where ref = $1`, [secretRef]);
      await pool.query(`delete from users where id = $1`, [TEST_USER]);
      await pool.end();
    },
    ctx: (): ConformanceIntegrationCtx => ({
      connectionId,
      userId: TEST_USER,
      table: "mail_messages",
      probeSourceObjectId: `inbox:${INBOX_MSG_1.uid}`,
      secret: ASP,
      runProductiveSync: async () => {
        const { registerConnector, syncConnection } = await import("../sync/index.js");
        registerConnector(new IcloudMailConnector(makeFakeImap({ rounds: [PRODUCTIVE_ROUND] }).factory));
        return syncConnection(connectionId);
      },
      runFetchLive: async () => {
        const fake = makeFakeImap({
          rounds: [{ folders: [inboxFolder({})] }],
          bodyByUid: { [INBOX_MSG_1.uid]: MESSAGE_BODY_RESULT },
        });
        const ctx: SyncContext = {
          userId: TEST_USER,
          connectionId,
          secretRef,
          secret: ASP,
          username: APPLE_ID,
        };
        return new IcloudMailConnector(fake.factory).fetchRecordLive(ctx, `inbox:${INBOX_MSG_1.uid}`);
      },
      runLeakySync: async () => {
        const { registerConnector, syncConnection } = await import("../sync/index.js");
        // failConnect leaks the ASP in the raw error; the connector MUST mask it.
        registerConnector(
          new IcloudMailConnector(makeFakeImap({ rounds: [PRODUCTIVE_ROUND], failConnect: true }).factory),
        );
        return syncConnection(connectionId);
      },
    }),
  },
});
