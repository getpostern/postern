// iCloud Mail conformance fixtures — a live envelope record in the SHAPE sync() persists (the
// IcloudEnvelopeRaw: uid + envelope + flags + internalDate + bodyStructure + the synthetic
// __pci_folder enum — NEVER the body, and NO Gmail X-GM extensions), and a QRESYNC VANISHED deletion
// for the same "<folder>:<uid>" id. The deletionPair proves the tombstone externalId == the live
// source_object_id.

import type { FetchMessageObject } from "imapflow";
import type { ConformanceFixtures } from "../sdk/index.js";
import { INBOX_MSG_1 } from "./icloud-mail.fixtures.js";

const FOLDER_KEY = "__pci_folder";

/** Mirror icloud-mail.ts toRawRecord(): build the envelope `raw` (body-free) + the folder enum. */
function envelopeRaw(msg: FetchMessageObject, folderEnum: string): Record<string, unknown> {
  return {
    uid: msg.uid,
    envelope: msg.envelope ?? {},
    flags: msg.flags ? Array.from(msg.flags) : [],
    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
    bodyStructure: msg.bodyStructure,
    [FOLDER_KEY]: folderEnum,
  };
}

const INBOX_ID = `inbox:${INBOX_MSG_1.uid}`;

export const ICLOUD_MAIL_CONFORMANCE: ConformanceFixtures = {
  sectors: ["mail"],
  live: [{ object: "message", externalId: INBOX_ID, raw: envelopeRaw(INBOX_MSG_1, "inbox") }],
  deletions: [{ object: "message", deleted: true, externalId: INBOX_ID, raw: null }],
  deletionPairs: [{ sourceObjectId: INBOX_ID, externalId: INBOX_ID }],
};
