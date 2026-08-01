// export route — GET /api/export[?sector=<sector>] → the operator's portability bundle as a JSON
// attachment. OPERATOR-ONLY: wrapped in localOnly (the loopback Host-allowlist guard), NOT a
// bearer/agent path — the bundle returns the WHOLE store for the user, unscoped by grant, so it must
// be the operator at the box. Read-only; no secrets are ever in the bundle, headers, or any error.

import { resolveLocal } from "../auth/index.js";
import { exportBundle } from "../core/export.js";
import { localOnly } from "./host-allowlist.js";
import type { RouteContext } from "./router.js";

/**
 * GET /api/export[?sector=<sector>] — stream the ExportBundle as a downloadable JSON attachment.
 * `?sector=` narrows to one sector's tables (an unknown sector → QueryValidationError → 400). The
 * operator is the seeded local user (loopback admin); export is unscoped by grant ON PURPOSE.
 */
export async function getExport(ctx: RouteContext): Promise<void> {
  const sector = ctx.query.get("sector");
  const auth = await resolveLocal();
  const bundle = await exportBundle(auth, sector ? { sector } : undefined);

  // Filesystem-safe UTC stamp (no ':' in the filename): "pci-export-2026-06-14T12-30-00Z.json".
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const payload = JSON.stringify(bundle);
  ctx.res.writeHead(200, {
    "content-type": "application/json",
    "content-disposition": `attachment; filename="pci-export-${stamp}.json"`,
  });
  ctx.res.end(payload);
}

/**
 * The wired route — localOnly (loopback operator) per spec. The mother registers this in
 * src/rest/index.ts at merge: `router.get("/api/export", exportRoute)`.
 */
export const exportRoute = localOnly(getExport);
