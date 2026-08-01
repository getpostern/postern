// serveStatic over real HTTP against a temp build dir: serves an asset, SPA-falls-back to index.html
// for an extensionless route, 404s a missing asset, and rejects path traversal (never serving a file
// outside the root). Plus the createRestApp integration: /api/* misses stay JSON 404 while a non-/api
// GET miss serves the Console. DB-free (no /healthz hit here).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "./static.js";
import { createRestApp } from "./index.js";

const INDEX_HTML = "<!doctype html><html><body><div id=app>SPA SHELL</div></body></html>";
const APP_JS = "console.log('pci console app');";
const SECRET = "TOP SECRET — must never be served";

let baseDir: string;
let root: string;

// Server 1: serveStatic directly (404 on a miss) — exercises the static handler in isolation.
let staticServer: Server;
let staticPort: number;
// Server 2: the full REST app pointed at the temp root — exercises the handle() integration.
let appServer: Server;
let appPort: number;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "pci-static-"));
  root = join(baseDir, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), INDEX_HTML);
  await writeFile(join(root, "assets", "app.js"), APP_JS);
  // A file OUTSIDE the served root — a traversal escape would expose it.
  await writeFile(join(baseDir, "secret.txt"), SECRET);

  staticServer = createServer((req, res) => {
    void (async () => {
      const served = await serveStatic(req, res, root);
      if (!served) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    })();
  });
  await new Promise<void>((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  staticPort = (staticServer.address() as AddressInfo).port;

  appServer = createServer(createRestApp({ staticDir: root }));
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  appPort = (appServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => staticServer.close(() => resolve()));
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await rm(baseDir, { recursive: true, force: true });
});

/** Raw request with FULL path control (so encoded-traversal paths reach the server verbatim). */
function raw(port: number, opts: { method?: string; path: string }): Promise<{
  status: number;
  body: string;
  contentType: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("serveStatic", () => {
  it("serves a built asset with the right content-type", async () => {
    const res = await raw(staticPort, { path: "/assets/app.js" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(APP_JS);
    expect(res.contentType).toMatch(/javascript/);
  });

  it("serves index.html at /", async () => {
    const res = await raw(staticPort, { path: "/" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
    expect(res.contentType).toMatch(/html/);
  });

  it("SPA-falls-back to index.html for an unknown extensionless route", async () => {
    const res = await raw(staticPort, { path: "/connectors/new" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it("404s a missing asset (an extension does NOT fall back to HTML)", async () => {
    const res = await raw(staticPort, { path: "/assets/missing.js" });
    expect(res.status).toBe(404);
    expect(res.body).not.toBe(INDEX_HTML);
  });

  it("rejects path traversal (encoded ../) and never serves a file outside root", async () => {
    const res = await raw(staticPort, { path: "/%2e%2e/secret.txt" });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("TOP SECRET");
  });

  it("rejects deep encoded traversal", async () => {
    const res = await raw(staticPort, { path: "/assets/%2e%2e/%2e%2e/secret.txt" });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("TOP SECRET");
  });
});

describe("createRestApp static integration", () => {
  it("a non-/api GET miss serves the Console (index.html)", async () => {
    const res = await raw(appPort, { path: "/audit" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it("serves a built asset through the app", async () => {
    const res = await raw(appPort, { path: "/assets/app.js" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(APP_JS);
  });

  it("an /api/* miss stays JSON 404 (never the SPA shell)", async () => {
    const res = await raw(appPort, { path: "/api/does-not-exist" });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });

  it("a non-GET miss is JSON 404 (only GET serves static)", async () => {
    const res = await raw(appPort, { method: "DELETE", path: "/some-page" });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });
});
