// Static-file serve for the built Console (apps/web/dist), mounted same-origin behind the REST edge
// so the SPA + the API share one origin (true one-place; the Console therefore issues RELATIVE
// requests and works at whatever address the browser reached it on). The OAuth redirect_uri is NOT
// derived from the inbound Host — it is pinned to PCI_PUBLIC_BASE_URL server-side (ADR 0014, ADR
// 0035 §D4). Path-traversal-safe: every request path is resolved against the
// root and rejected unless it stays inside it. Unknown extensionless paths SPA-fall-back to index.html
// so vue-router history routes resolve; a missing asset (has an extension) 404s rather than returning
// HTML. Pure Node http + fs — no framework, no body of secrets ever flows through here.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/** Minimal extension→content-type map for the assets a Vite build emits. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve `pathname` within `root`, returning the absolute path ONLY if it stays inside root.
 * Returns null on any escape (the path-traversal guard) — caller treats null as a miss (404).
 */
function safeResolve(root: string, pathname: string): string | null {
  const candidate = resolve(root, "." + pathname); // leading "." anchors a rooted path under root
  if (candidate === root || candidate.startsWith(root + sep)) return candidate;
  return null;
}

/** Stream a regular file to the response. Returns false (response untouched) if it isn't a real file. */
async function sendFile(res: ServerResponse, filePath: string): Promise<boolean> {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  return await new Promise<boolean>((resolveP) => {
    const stream = createReadStream(filePath);
    let opened = false;
    stream.on("open", () => {
      opened = true;
      res.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "content-length": String(st.size),
      });
      stream.pipe(res);
    });
    stream.on("error", () => {
      if (!opened && !res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      } else {
        res.end();
      }
      resolveP(true); // a response was sent (or attempted) — the caller must not also respond
    });
    res.on("finish", () => resolveP(true));
  });
}

/**
 * Serve a static file from `rootDir` for a GET, with SPA fallback to index.html. Returns true if a
 * response was sent; false if the caller should handle the miss (no matching file, traversal attempt,
 * or no index.html to fall back to). Path-traversal-safe (resolve + in-root prefix check).
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
): Promise<boolean> {
  const root = resolve(rootDir);

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false; // malformed percent-encoding — treat as a miss
  }

  // Direct file hit (e.g. /assets/app.js), traversal-guarded.
  const target = safeResolve(root, pathname);
  if (target === null) return false; // escaped root — caller 404s, no detail leaked
  if (target !== root) {
    if (await sendFile(res, target)) return true;
  }

  // SPA fallback: serve index.html for an unmatched, extensionless route (/, /connectors, /audit …)
  // so client-side history routing resolves. A missing ASSET (has an extension) 404s instead of
  // returning HTML, so a broken script tag fails loudly rather than silently rendering the shell.
  if (extname(pathname) === "") {
    return await sendFile(res, join(root, "index.html"));
  }
  return false;
}
