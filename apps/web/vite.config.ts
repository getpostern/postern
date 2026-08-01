import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Console is a thin client over the local REST edge. The typed RestClient
// (src/api/client.ts) issues SAME-ORIGIN RELATIVE requests by default
// (GATEWAY_URL = ""), so this dev proxy is what carries `/api` and `/healthz` from
// the dev server to the loopback-bound gateway.
//
// `changeOrigin: false` preserves the dev-server Host header so the forwarded
// request arrives with a loopback Host — which is what the `localOnly` routes
// check (src/rest/host-allowlist.ts). It has NOTHING to do with the OAuth
// redirect_uri: that is PINNED server-side to PCI_PUBLIC_BASE_URL and
// `callbackUrl(_ctx, provider)` ignores its ctx entirely (ADR 0014, ADR 0035 §D4),
// so the same literal is sent from every origin. The comment that used to claim
// otherwise here is what produced #102 §2's wrong premise.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/healthz": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
});
