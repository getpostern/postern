// Gmail conformance fixtures — a live envelope record in the SHAPE sync() persists (the
// GmailEnvelopeRaw: uid + envelope + flags + internalDate + bodyStructure + threadId/emailId + labels
// + the synthetic __pci_folder enum — NEVER the body), and a QRESYNC VANISHED deletion for the same
// "<folder>:<uid>" id. The deletionPair proves the tombstone externalId == the live source_object_id.

import type { FetchMessageObject } from "imapflow";
import type { ConformanceFixtures } from "../sdk/index.js";
import { INBOX_MSG_1 } from "./gmail.fixtures.js";

const FOLDER_KEY = "__pci_folder";

/** Mirror gmail.ts toRawRecord(): build the envelope `raw` (body-free) + the folder enum threading. */
function envelopeRaw(msg: FetchMessageObject, folderEnum: string): Record<string, unknown> {
  return {
    uid: msg.uid,
    envelope: msg.envelope ?? {},
    flags: msg.flags ? Array.from(msg.flags) : [],
    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
    bodyStructure: msg.bodyStructure,
    threadId: msg.threadId,
    emailId: msg.emailId,
    labels: msg.labels ? Array.from(msg.labels) : [],
    [FOLDER_KEY]: folderEnum,
  };
}

const INBOX_ID = `inbox:${INBOX_MSG_1.uid}`;

export const GMAIL_CONFORMANCE: ConformanceFixtures = {
  sectors: ["mail"],
  live: [{ object: "message", externalId: INBOX_ID, raw: envelopeRaw(INBOX_MSG_1, "inbox") }],
  deletions: [{ object: "message", deleted: true, externalId: INBOX_ID, raw: null }],
  deletionPairs: [{ sourceObjectId: INBOX_ID, externalId: INBOX_ID }],
};
