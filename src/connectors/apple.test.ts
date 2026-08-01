// Unit tests for the composite AppleConnector (#26 integration). Proves the multi-sector routing that
// makes ONE registry entry for provider "apple" serve mail + calendar + contacts (the microsoft/google
// pattern): sync() + fetchRecordLive() route on ctx.sector; normalize()/strongKeys() on rec.object; the
// registry resolves "apple" to the composite and each sector reaches its own sub-connector. No network —
// the three sub-connectors are injected recording stubs.

import { describe, it, expect } from "vitest";
import { AppleConnector } from "./apple.js";
import { registerConnector, getConnector } from "../sync/registry.js";
import type { Connector, RawRecord, SyncContext } from "./types.js";

/** A recording stub sub-connector. `tag` is a normalize/strongKeys sentinel; `object` is what sync yields. */
function stub(
  tag: string,
  object: string,
  withLive = false,
): Connector & { calls: string[] } {
  const calls: string[] = [];
  const c: Connector & { calls: string[] } = {
    calls,
    provider: "apple",
    sector: object,
    objectType: object,
    policy: { mode: "poll", supportsIncremental: true },
    actions: [],
    async *sync(ctx: SyncContext) {
      calls.push(`sync:${ctx.sector}`);
      yield { object, externalId: `${object}-1`, raw: { tag } } as RawRecord;
    },
    normalize(rec: RawRecord) {
      calls.push(`normalize:${rec.object}`);
      return { by: tag };
    },
    strongKeys(rec: RawRecord) {
      calls.push(`strongKeys:${rec.object}`);
      return { by: tag };
    },
    async execute() {
      throw new Error("stub has no actions");
    },
  };
  if (withLive) {
    c.fetchRecordLive = async (_ctx: SyncContext, id: string) => {
      calls.push(`live:${id}`);
      return { liveBy: tag };
    };
  }
  return c;
}

function ctx(sector: string): SyncContext {
  return { userId: "u", connectionId: "c", secretRef: null, sector };
}

function build() {
  const mail = stub("MAIL", "message", true);
  const calendar = stub("CAL", "calendar_event");
  const contacts = stub("CON", "contact");
  return { mail, calendar, contacts, apple: new AppleConnector({ mail, calendar, contacts }) };
}

describe("AppleConnector — shape", () => {
  it("is provider 'apple', read-only, one poll policy with a 300s floor (the multi-sector shape)", () => {
    const apple = new AppleConnector();
    expect(apple.provider).toBe("apple");
    expect(apple.actions).toEqual([]);
    expect(apple.policy.mode).toBe("poll");
    expect(apple.policy.minIntervalSec).toBe(300);
    expect(apple.policy.supportsIncremental).toBe(true);
  });

  it("execute() throws (all three sectors are read-only in V0)", async () => {
    await expect(new AppleConnector().execute()).rejects.toThrow(/no actions/);
  });
});

describe("AppleConnector — sync routes by ctx.sector", () => {
  it("mail/calendar/contacts each reach ONLY their own sub-connector", async () => {
    const { mail, calendar, contacts, apple } = build();

    const drain = async (sector: string) => {
      const out: RawRecord[] = [];
      for await (const r of apple.sync(ctx(sector))) out.push(r);
      return out;
    };

    expect((await drain("mail"))[0].object).toBe("message");
    expect((await drain("calendar"))[0].object).toBe("calendar_event");
    expect((await drain("contacts"))[0].object).toBe("contact");
    // A missing sector falls back to mail (the placeholder default).
    expect((await drain(undefined as unknown as string))[0].object).toBe("message");

    expect(mail.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:mail", "sync:undefined"]);
    expect(calendar.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:calendar"]);
    expect(contacts.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:contacts"]);
  });
});

describe("AppleConnector — normalize / strongKeys route by rec.object", () => {
  it("routes each object to the matching sub-connector", () => {
    const { apple } = build();
    expect(apple.normalize({ object: "message", externalId: "x", raw: {} })).toEqual({ by: "MAIL" });
    expect(apple.normalize({ object: "calendar_event", externalId: "x", raw: {} })).toEqual({ by: "CAL" });
    expect(apple.normalize({ object: "contact", externalId: "x", raw: {} })).toEqual({ by: "CON" });
    // Unset object → mail (default).
    expect(apple.normalize({ externalId: "x", raw: {} })).toEqual({ by: "MAIL" });

    expect(apple.strongKeys({ object: "contact", externalId: "x", raw: {} })).toEqual({ by: "CON" });
    expect(apple.strongKeys({ object: "calendar_event", externalId: "x", raw: {} })).toEqual({ by: "CAL" });
  });
});

describe("AppleConnector — fetchRecordLive routes by ctx.sector", () => {
  it("mail supports the body drill; calendar/contacts report not-supported (secret-free)", async () => {
    const { mail, apple } = build();
    await expect(apple.fetchRecordLive(ctx("mail"), "inbox:1")).resolves.toEqual({ liveBy: "MAIL" });
    expect(mail.calls).toContain("live:inbox:1");
    await expect(apple.fetchRecordLive(ctx("calendar"), "uid1")).rejects.toThrow(/not supported/);
    await expect(apple.fetchRecordLive(ctx("contacts"), "c1")).rejects.toThrow(/not supported/);
  });
});

describe("AppleConnector — registry resolution", () => {
  it("registers under provider 'apple' and resolves each sector to the right sub-connector", async () => {
    const { mail, calendar, contacts, apple } = build();
    registerConnector(apple);

    const resolved = getConnector("apple");
    expect(resolved).toBe(apple);
    expect(resolved).toBeInstanceOf(AppleConnector);

    // Drive each sector exactly as the runner does: getConnector(provider).sync({sector}).
    for (const sector of ["mail", "calendar", "contacts"]) {
      for await (const _ of resolved!.sync(ctx(sector))) {
        /* drain */
      }
    }
    expect(mail.calls).toContain("sync:mail");
    expect(calendar.calls).toContain("sync:calendar");
    expect(contacts.calls).toContain("sync:contacts");
    // No cross-wiring: the mail sub never handled calendar/contacts, etc.
    expect(mail.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:mail"]);
    expect(calendar.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:calendar"]);
    expect(contacts.calls.filter((c) => c.startsWith("sync"))).toEqual(["sync:contacts"]);
  });
});
