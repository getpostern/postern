// HA WebSocket client tests with a fully in-memory fake socket (no network).
// Covers: the auth handshake (auth_required → auth → auth_ok), id-correlated commands, event
// fan-out, the wsUrl derivation, that the token only ever rides the auth frame, and the
// onReconnect hook (fires once per RE-auth, never on the initial connect, after re-subscription).

import { describe, it, expect, vi } from "vitest";
import { HaWsClient, wsUrl, type HaSocket } from "./homeassistant-ws.js";

/** A scriptable fake socket: capture sent frames, and let the test push server frames back. */
class FakeSocket implements HaSocket {
  sent: string[] = [];
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  send(data: string): void {
    this.sent.push(data);
    // Auto-respond to the handshake so the client reaches "ready" deterministically.
    const msg = JSON.parse(data);
    if (msg.type === "auth") {
      // Default: accept. Tests that want auth_invalid override before connect resolves.
      queueMicrotask(() => this.server({ type: "auth_ok", ha_version: "test" }));
    }
  }
  close(): void {
    this.emit("close");
  }
  on(event: string, cb: (arg?: unknown) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  private emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  /** Simulate the socket opening and HA sending its first frame. */
  open(): void {
    this.emit("open");
  }
  /** Push a server frame to the client. */
  server(obj: unknown): void {
    this.emit("message", JSON.stringify(obj));
  }
  /** The last parsed frame the client sent. */
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
  sentTypes(): string[] {
    return this.sent.map((s) => JSON.parse(s).type);
  }
}

function makeClient(opts?: { onSocket?: (s: FakeSocket) => void }) {
  const sock = new FakeSocket();
  const client = new HaWsClient({
    haUrl: "http://ha.local:8123",
    token: "SECRET-TOKEN",
    autoReconnect: false,
    socketFactory: () => sock,
  });
  opts?.onSocket?.(sock);
  return { client, sock };
}

describe("wsUrl", () => {
  it("derives ws://host/api/websocket from http", () => {
    expect(wsUrl("http://ha.local:8123")).toBe("ws://ha.local:8123/api/websocket");
  });
  it("derives wss:// from https and preserves a base path", () => {
    expect(wsUrl("https://example.com/ha/")).toBe("wss://example.com/ha/api/websocket");
  });
});

describe("auth handshake", () => {
  it("auth_required → sends auth{access_token} → resolves on auth_ok", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required", ha_version: "test" });
    await connected;

    expect(client.isReady()).toBe(true);
    const authFrame = JSON.parse(sock.sent[0]);
    expect(authFrame.type).toBe("auth");
    expect(authFrame.access_token).toBe("SECRET-TOKEN");
  });

  it("rejects on auth_invalid without echoing the token", async () => {
    const sock = new FakeSocket();
    // Override: respond to the auth frame with auth_invalid.
    sock.send = function (this: FakeSocket, data: string) {
      this.sent.push(data);
      const msg = JSON.parse(data);
      if (msg.type === "auth") queueMicrotask(() => this.server({ type: "auth_invalid", message: "bad" }));
    };
    const client = new HaWsClient({
      haUrl: "http://ha.local:8123",
      token: "SECRET-TOKEN",
      autoReconnect: false,
      socketFactory: () => sock,
    });
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required" });

    await expect(connected).rejects.toThrow(/auth failed/);
    // The rejection message must not contain the token.
    await connected.catch((e: Error) => expect(e.message).not.toContain("SECRET-TOKEN"));
    expect(client.isReady()).toBe(false);
  });
});

describe("id-correlated commands", () => {
  it("a command resolves with the matching result frame's `result`", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required" });
    await connected;

    const p = client.command("get_states");
    const sent = sock.lastSent();
    expect(sent.type).toBe("get_states");
    expect(typeof sent.id).toBe("number");

    sock.server({ type: "result", id: sent.id, success: true, result: [{ entity_id: "light.x" }] });
    await expect(p).resolves.toEqual([{ entity_id: "light.x" }]);
  });

  it("two concurrent commands resolve to their own ids (no cross-talk)", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required" });
    await connected;

    const a = client.command("get_services");
    const idA = sock.lastSent().id as number;
    const b = client.command("get_states");
    const idB = sock.lastSent().id as number;
    expect(idA).not.toBe(idB);

    sock.server({ type: "result", id: idB, success: true, result: "B" });
    sock.server({ type: "result", id: idA, success: true, result: "A" });
    expect(await a).toBe("A");
    expect(await b).toBe("B");
  });

  it("a success:false result rejects the command", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required" });
    await connected;

    const p = client.command("call_service", { domain: "light", service: "nope" });
    const id = sock.lastSent().id as number;
    sock.server({ type: "result", id, success: false, error: { code: "x", message: "no such service" } });
    await expect(p).rejects.toThrow(/no such service/);
  });
});

describe("events", () => {
  it("subscribe + a state_changed event fans to the handler", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.open();
    sock.server({ type: "auth_required" });
    await connected;

    const seen: { event_type: string; data: unknown }[] = [];
    client.onEvent((e) => seen.push(e));

    const subP = client.subscribe({ event_type: "state_changed" });
    const subId = sock.lastSent().id as number;
    sock.server({ type: "result", id: subId, success: true });
    await subP;

    sock.server({
      type: "event",
      id: subId,
      event: { event_type: "state_changed", data: { entity_id: "light.x", new_state: { state: "on" } } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].event_type).toBe("state_changed");
    expect((seen[0].data as { entity_id: string }).entity_id).toBe("light.x");
  });
});

// ── onReconnect — fired per RE-auth, never on the initial connect ───────────────
/** A reconnecting client whose factory mints a fresh fake socket per openSocket(). */
function makeReconnectingClient() {
  const sockets: FakeSocket[] = [];
  const client = new HaWsClient({
    haUrl: "http://ha.local:8123",
    token: "SECRET-TOKEN",
    autoReconnect: true,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { client, sockets };
}

/** Drive the freshest socket through open → auth_required → (auto auth_ok) and let it settle. */
async function handshake(sockets: FakeSocket[]): Promise<void> {
  const sock = sockets[sockets.length - 1];
  sock.open();
  sock.server({ type: "auth_required" });
  await new Promise((r) => setTimeout(r, 0)); // let the queued auth_ok land
}

/** Wait for the reconnect backoff timer (1ms) to mint the next socket. */
async function awaitNextSocket(sockets: FakeSocket[], want: number): Promise<void> {
  for (let i = 0; i < 50 && sockets.length < want; i++) await new Promise((r) => setTimeout(r, 2));
  expect(sockets.length).toBe(want);
}

describe("onReconnect", () => {
  it("fires once per RE-auth, NOT on the initial connect", async () => {
    const { client, sockets } = makeReconnectingClient();
    let fired = 0;
    client.onReconnect(() => fired++);

    const connected = client.connect();
    await handshake(sockets);
    await connected;
    expect(fired).toBe(0); // the initial connect resolves the promise instead

    // Drop 1 → reconnect → re-auth → exactly one firing.
    sockets[0].close();
    await awaitNextSocket(sockets, 2);
    await handshake(sockets);
    expect(fired).toBe(1);
    expect(client.isReady()).toBe(true);

    // Drop 2 → another re-auth → another single firing.
    sockets[1].close();
    await awaitNextSocket(sockets, 3);
    await handshake(sockets);
    expect(fired).toBe(2);
    client.close();
  });

  it("fires AFTER re-subscription, and a throwing handler is swallowed (others still run)", async () => {
    const { client, sockets } = makeReconnectingClient();
    const connected = client.connect();
    await handshake(sockets);
    await connected;

    // An active subscription that must be re-issued on the new socket before handlers fire.
    const subP = client.subscribe({ event_type: "state_changed" });
    const subId = sockets[0].lastSent().id as number;
    sockets[0].server({ type: "result", id: subId, success: true });
    await subP;

    let sawResub = false;
    let secondRan = false;
    client.onReconnect(() => {
      sawResub = sockets[1].sentTypes().includes("subscribe_events");
      throw new Error("handler boom"); // must be swallowed
    });
    client.onReconnect(() => {
      secondRan = true;
    });

    sockets[0].close();
    await awaitNextSocket(sockets, 2);
    await handshake(sockets);

    expect(sawResub).toBe(true); // re-subscription preceded the handler
    expect(secondRan).toBe(true); // the throw did not break the loop
    expect(client.isReady()).toBe(true); // …or the client
    client.close();
  });
});

// ── onUp / onDown — the #39 stream-state hooks ──────────────────────────────────
describe("onUp / onDown (#39)", () => {
  it("fires onUp once on the initial connect", async () => {
    const { client, sockets } = makeReconnectingClient();
    let ups = 0;
    client.onUp(() => ups++);

    const connected = client.connect();
    await handshake(sockets);
    await connected;

    expect(ups).toBe(1); // EVERY successful auth fires onUp — including the initial connect
    client.close();
  });

  it("a socket drop fires onDown('socket closed…'); the re-auth fires onUp again", async () => {
    const { client, sockets } = makeReconnectingClient();
    let ups = 0;
    const downs: string[] = [];
    client.onUp(() => ups++);
    client.onDown((reason) => downs.push(reason));

    const connected = client.connect();
    await handshake(sockets);
    await connected;
    expect(ups).toBe(1);

    sockets[0].close(); // unexpected drop → the client enters its reconnect wait
    expect(downs).toEqual(["socket closed — reconnecting"]);

    await awaitNextSocket(sockets, 2);
    await handshake(sockets);
    expect(ups).toBe(2); // re-auth → up again
    expect(client.isReady()).toBe(true);
    client.close();
  });

  it("a RE-auth auth_invalid fires onDown('auth invalid'); the client stays closed — no reconnect loop, no unhandled rejection", async () => {
    // The previously-silent mid-run death: failAuth with NO pending connect() promise (authReject
    // undefined) must still fire onDown, and must not reject anything unhandled.
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    try {
      const { client, sockets } = makeReconnectingClient();
      const downs: string[] = [];
      client.onDown((reason) => downs.push(reason));

      const connected = client.connect();
      await handshake(sockets);
      await connected;

      // Drop → the reconnect socket's server rejects the RE-auth with auth_invalid.
      sockets[0].close();
      await awaitNextSocket(sockets, 2);
      const s2 = sockets[1];
      s2.send = (data: string) => {
        s2.sent.push(data);
        const msg = JSON.parse(data);
        if (msg.type === "auth") queueMicrotask(() => s2.server({ type: "auth_invalid", message: "bad" }));
      };
      s2.open();
      s2.server({ type: "auth_required" });
      await new Promise((r) => setTimeout(r, 0)); // let the queued auth_invalid land

      expect(downs).toEqual(["socket closed — reconnecting", "auth invalid"]);
      expect(client.isReady()).toBe(false);

      // Terminal: no reconnect loop — with a 1ms backoff a loop would mint socket 3 immediately.
      await new Promise((r) => setTimeout(r, 25));
      expect(sockets.length).toBe(2);

      await new Promise((r) => setTimeout(r, 0)); // unhandledRejection fires on a later tick
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("a throwing onUp/onDown handler is swallowed (later handlers still run, the client survives)", async () => {
    const { client, sockets } = makeReconnectingClient();
    let upAfterThrow = false;
    let downAfterThrow = false;
    client.onUp(() => {
      throw new Error("up boom");
    });
    client.onUp(() => {
      upAfterThrow = true;
    });
    client.onDown(() => {
      throw new Error("down boom");
    });
    client.onDown(() => {
      downAfterThrow = true;
    });

    const connected = client.connect();
    await handshake(sockets);
    await connected;
    expect(upAfterThrow).toBe(true);

    sockets[0].close();
    expect(downAfterThrow).toBe(true);

    await awaitNextSocket(sockets, 2); // the throwing handlers did not break the reconnect loop
    await handshake(sockets);
    expect(client.isReady()).toBe(true);
    client.close();
  });
});
