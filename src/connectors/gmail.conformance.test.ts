// Gmail conformance — contract layer (always) + the INTEGRATION layer (a client-class mock; gated on
// DATABASE_URL). The integration drives the REAL syncConnection via Gmail's injectable imapflow fake
// to assert H6 (the runner injects connection_id/user_id, raw=rec.raw, deleted_at=null), H7 (the
// per-folder cursor map persists), H8/S2 (fetchRecordLive serves the body but stores NOTHING), and S1
// (a connect failure that EMBEDS the app-password is masked — the error is secret-free). Mirrors
// gmail.db.test.ts's setup (a dedicated throwaway user so it never races it).

import { describeConformance, type ConformanceIntegrationCtx } from "../sdk/index.js";
import type { SyncContext } from "./types.js";
import { GmailConnector } from "./gmail.js";
import { GMAIL_CONFORMANCE } from "./gmail.conformance.js";
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
} from "./gmail.fixtures.js";

// A DEDICATED throwaway user, distinct from gmail.db.test.ts (07b1) — both run in parallel and would
// otherwise contend the unique(user_id, provider) credential row.
const TEST_USER = "00000000-0000-0000-0000-0000000008c2";
const APP_PASSWORD = "gmail-conformance-app-password";
const GMAIL_ADDR = "operator@example.com";

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

describeConformance(new GmailConnector(), GMAIL_CONFORMANCE, {
  integration: {
    setup: async () => {
      const { pool } = await import("../db.js");
      const { seal } = await import("../secrets/index.js");
      await pool.query(
        `insert into users (id, label) values ($1, 'gmail-conformance') on conflict (id) do nothing`,
        [TEST_USER],
      );
      // Seal the app-password as the sentinel SECRET — S1 proves it never leaks into an error.
      secretRef = await seal({ userId: TEST_USER, provider: "gmail", purpose: "access" }, APP_PASSWORD);
      const cred = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
         values ($1, 'gmail', 'static_token', $2, $3, 'active') returning id`,
        [TEST_USER, secretRef, GMAIL_ADDR],
      );
      credentialId = cred.rows[0].id as string;
      const conn = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, 'mail', 'gmail', 'active') returning id`,
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
      secret: APP_PASSWORD,
      runProductiveSync: async () => {
        const { registerConnector, syncConnection } = await import("../sync/index.js");
        registerConnector(new GmailConnector(makeFakeImap({ rounds: [PRODUCTIVE_ROUND] }).factory));
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
          secret: APP_PASSWORD,
          username: GMAIL_ADDR,
        };
        return new GmailConnector(fake.factory).fetchRecordLive(ctx, `inbox:${INBOX_MSG_1.uid}`);
      },
      runLeakySync: async () => {
        const { registerConnector, syncConnection } = await import("../sync/index.js");
        // failConnect leaks the app-password in the raw error; the connector MUST mask it.
        registerConnector(new GmailConnector(makeFakeImap({ rounds: [PRODUCTIVE_ROUND], failConnect: true }).factory));
        return syncConnection(connectionId);
      },
    }),
  },
});
