// A thin Home Assistant WebSocket client.
//
// Responsibilities (and nothing more — the connector owns the cache + dispatch semantics):
//   * connect to <haUrl>/api/websocket and run the auth handshake
//       (server: auth_required → client: auth{access_token} → server: auth_ok | auth_invalid)
//   * send id-correlated commands and resolve each on its matching `id` result
//       (get_services, get_states, config/{area,device,entity}_registry/list, call_service, …)
//   * subscribe to events (state_changed + registry-update events) and fan them to a handler
//   * reconnect with capped exponential backoff on an unexpected drop, re-running the handshake
//
// The long-lived token is read once, sent in the auth frame, and NEVER logged or surfaced in an
// error/result (auth_invalid carries no token; we throw a fixed message).

import WebSocket from "ws";

/** A parsed HA WebSocket message. HA frames are JSON objects with a `type` discriminator. */
export interface HaMessage {
  type: string;
  id?: number;
  success?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: unknown;
  [k: string]: unknown;
}

export type HaEventHandler = (event: { event_type: string; data: unknown }) => void;

export interface HaWsOptions {
  /** Base HA URL, e.g. "http://homeassistant.local:8123" or "https://ha.example.com". */
  haUrl: string;
  /** The long-lived access token. Sent only in the auth frame; never logged. */
  token: string;
  /** Injectable socket factory (tests pass a fake; default opens a real `ws`). */
  socketFactory?: (url: string) => HaSocket;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Disable auto-reconnect (tests). Default: reconnect on unexpected close. */
  autoReconnect?: boolean;
}

/** The minimal socket surface the client needs — `ws.WebSocket` satisfies it; tests fake it. */
export interface HaSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** Derive the ws(s)://<host>/api/websocket URL from an http(s) base. */
export function wsUrl(haUrl: string): string {
  const u = new URL(haUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Preserve any base path, then append the API endpoint.
  const base = u.pathname.replace(/\/$/, "");
  u.pathname = `${base}/api/websocket`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export class HaWsClient {
  private readonly opts: Required<Pick<HaWsOptions, "minBackoffMs" | "maxBackoffMs" | "autoReconnect">> & HaWsOptions;
  private socket?: HaSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<HaEventHandler>();
  private readonly reconnectHandlers = new Set<() => void>();
  /** #39 stream-state hooks: up = every successful auth; down = reconnect wait or terminal failAuth. */
  private readonly upHandlers = new Set<() => void>();
  private readonly downHandlers = new Set<(reason: string) => void>();
  /** Subscriptions to re-establish after a reconnect: id → the original subscribe command. */
  private readonly subscriptions = new Map<number, Record<string, unknown>>();
  private authResolve?: () => void;
  private authReject?: (err: Error) => void;
  private ready = false;
  private closed = false;
  private backoffMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: HaWsOptions) {
    this.opts = {
      minBackoffMs: 500,
      maxBackoffMs: 30_000,
      autoReconnect: true,
      ...options,
    };
    this.backoffMs = this.opts.minBackoffMs;
  }

  /** True once the auth handshake has completed and the socket is usable. */
  isReady(): boolean {
    return this.ready;
  }

  /** Connect + run the auth handshake; resolves on auth_ok, rejects on auth_invalid/socket error. */
  connect(): Promise<void> {
    this.closed = false;
    return new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      this.openSocket();
    });
  }

  private openSocket(): void {
    const url = wsUrl(this.opts.haUrl);
    const factory = this.opts.socketFactory ?? defaultSocketFactory;
    const socket = factory(url);
    this.socket = socket;

    socket.on("open", () => {
      // HA sends `auth_required` first; we reply to that, not to "open".
    });
    socket.on("message", (data: unknown) => this.onMessage(data));
    socket.on("error", (err: unknown) => this.onError(err));
    socket.on("close", () => this.onClose());
  }

  private onMessage(data: unknown): void {
    let msg: HaMessage;
    try {
      const text = typeof data === "string" ? data : String(data);
      msg = JSON.parse(text) as HaMessage;
    } catch {
      return; // ignore unparseable frames
    }

    switch (msg.type) {
      case "auth_required":
        // Reply with the token. This is the ONLY place the token is sent.
        this.rawSend({ type: "auth", access_token: this.opts.token });
        return;
      case "auth_ok":
        this.onAuthOk();
        return;
      case "auth_invalid":
        // Never echo the token or HA's message verbatim (avoid leaking anything sensitive).
        this.failAuth(new Error("home assistant auth failed: invalid token"));
        return;
      case "result": {
        if (typeof msg.id === "number") this.resolvePending(msg.id, msg);
        return;
      }
      case "event": {
        const ev = msg.event as { event_type?: string; data?: unknown } | undefined;
        if (ev && typeof ev.event_type === "string") {
          for (const h of this.eventHandlers) h({ event_type: ev.event_type, data: ev.data });
        }
        return;
      }
      default:
        return; // pong / unknown — ignore
    }
  }

  private onAuthOk(): void {
    this.ready = true;
    this.backoffMs = this.opts.minBackoffMs; // reset backoff after a clean auth
    const r = this.authResolve;
    // No pending connect() promise → this auth_ok is a RE-auth after an internal reconnect.
    const isReconnect = r === undefined;
    this.authResolve = undefined;
    this.authReject = undefined;
    // Re-establish subscriptions after a reconnect (fresh ids, same commands).
    const toResub = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const cmd of toResub) void this.subscribe(cmd).catch(() => {});
    // #39: the stream is up — EVERY successful auth (initial connect AND re-auth), after
    // re-subscription. Throwing handlers are swallowed like reconnect handlers.
    for (const h of this.upHandlers) {
      try {
        h();
      } catch {
        // swallowed — stream-state handlers must not take down the socket loop
      }
    }
    if (isReconnect) {
      // Fire-and-forget, after re-subscription: a throwing handler must not break the client.
      for (const h of this.reconnectHandlers) {
        try {
          h();
        } catch {
          // swallowed — reconnect handlers must not take down the socket loop
        }
      }
    }
    r?.();
  }

  private failAuth(err: Error): void {
    const r = this.authReject;
    this.authResolve = undefined;
    this.authReject = undefined;
    this.ready = false;
    // An auth failure is terminal — do not reconnect-loop on a bad token.
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    // #39: fire onDown even when there is no pending connect() to reject — a RE-auth failure
    // (authReject undefined) previously died SILENTLY with the client closed forever. The reason is
    // fixed/secret-free by construction (err.message never carries the token).
    const reason = err.message.includes("invalid token") ? "auth invalid" : err.message;
    for (const h of this.downHandlers) {
      try {
        h(reason);
      } catch {
        // swallowed — stream-state handlers must not take down the socket loop
      }
    }
    r?.(err);
  }

  private resolvePending(id: number, msg: HaMessage): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.success === false) {
      // Surface a sanitized error — HA error messages never contain the token.
      p.reject(new Error(msg.error?.message ?? `home assistant command ${id} failed`));
    } else {
      p.resolve(msg.result);
    }
  }

  private onError(_err: unknown): void {
    // Never log the error object (defensive: it could carry the URL/headers). Auth-phase errors
    // reject connect(); post-auth errors surface via the close handler's reconnect/backoff.
    if (this.authReject) this.failAuth(new Error("home assistant websocket error"));
  }

  private onClose(): void {
    this.ready = false;
    // Reject any in-flight commands so callers don't hang.
    for (const [, p] of this.pending) p.reject(new Error("home assistant websocket closed"));
    this.pending.clear();
    if (this.authReject) {
      this.failAuth(new Error("home assistant websocket closed during handshake"));
      return;
    }
    if (this.closed || !this.opts.autoReconnect) return;
    // #39: entering the reconnect wait — the stream is down until the next successful re-auth.
    for (const h of this.downHandlers) {
      try {
        h("socket closed — reconnecting");
      } catch {
        // swallowed — stream-state handlers must not take down the socket loop
      }
    }
    // Unexpected drop → reconnect with capped exponential backoff.
    this.reconnectTimer = setTimeout(() => {
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
      this.openSocket();
    }, this.backoffMs);
  }

  private rawSend(obj: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(obj));
  }

  /**
   * Send an id-correlated command and resolve with HA's `result`. The id is allocated here and
   * matched on the result frame. Rejects on `success:false` or a socket close.
   */
  command(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error("home assistant websocket not ready"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.rawSend({ id, type, ...fields });
    });
  }

  /**
   * Subscribe to events. Records the command so it can be re-issued after a reconnect, and fans
   * every matching event to the registered handlers. Returns the subscription id.
   */
  async subscribe(fields: Record<string, unknown>): Promise<number> {
    if (!this.ready) throw new Error("home assistant websocket not ready");
    const id = this.nextId++;
    const cmd = { type: "subscribe_events", ...fields };
    this.subscriptions.set(id, cmd);
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
      this.rawSend({ id, ...cmd });
    });
    return id;
  }

  /** Register a handler for incoming events (state_changed + registry updates). */
  onEvent(handler: HaEventHandler): void {
    this.eventHandlers.add(handler);
  }

  /**
   * Register a handler fired after a successful RE-auth (auto-reconnect after a drop) — NOT on the
   * initial connect() (that resolves the connect promise instead). Fired after internal
   * re-subscription. Handlers must not throw (errors are swallowed).
   */
  onReconnect(handler: () => void): void {
    this.reconnectHandlers.add(handler);
  }

  /**
   * #39: register a handler fired after EVERY successful auth (+re-subscription) — the initial
   * connect AND each re-auth. Handlers must not throw (errors are swallowed).
   */
  onUp(handler: () => void): void {
    this.upHandlers.add(handler);
  }

  /**
   * #39: register a handler fired when the stream goes down: entering the reconnect wait after an
   * unexpected drop (reason 'socket closed — reconnecting'), or a terminal auth failure via failAuth
   * (reason 'auth invalid') — INCLUDING a RE-auth failure with no pending connect() promise, the
   * previously-silent mid-run death (the client stays closed and never reconnects). Reasons are
   * short, fixed, and secret-free. Handlers must not throw (errors are swallowed).
   */
  onDown(handler: (reason: string) => void): void {
    this.downHandlers.add(handler);
  }

  /** Close the socket and stop reconnecting. Idempotent. */
  close(): void {
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
  }
}

/** Default real-socket factory — a `ws.WebSocket`. */
function defaultSocketFactory(url: string): HaSocket {
  const sock = new WebSocket(url);
  return {
    send: (data: string) => sock.send(data),
    close: () => sock.close(),
    on: (event: string, cb: (...a: unknown[]) => void) =>
      sock.on(event as "open" | "message" | "close" | "error", cb as never),
  } as HaSocket;
}
