// Erase's pure logic — the scope → { body, copy } mapping, kept testable so the #17 data-loss
// lesson (right scope, right blast radius, enforced export-first, typed guard) is provable without a
// DOM. The token is a FAT-FINGER GUARD, not auth: loopback is the only authz (build-notes §4).

import type { EraseBody, EraseScope } from "../../api/types";

/** The literal token the operator types. A mismatch just disables the seal button; it is not a
 *  password (a loopback caller is already the operator). */
export const ERASE_TOKEN = "ERASE";

export interface EraseTarget {
  /** Required when scope === "connection". */
  connectionId?: string;
  /** Required when scope === "sector". */
  sector?: string;
}

/** The three scope cards, verbatim from `640-0`. */
export const ERASE_SCOPES: { scope: EraseScope; title: string; blurb: string }[] = [
  { scope: "connection", title: "One connection", blurb: "Drop one source's cached rows." },
  { scope: "sector", title: "A sector", blurb: "Everything in one sector, all providers." },
  { scope: "all", title: "Everything", blurb: "Every sector, every connection." },
];

/** True once the chosen scope has the target it needs (a connection / a sector picked). "all" is
 *  always ready. Gates the whole confirm — you cannot type ERASE against an unchosen target. */
export function eraseTargetReady(scope: EraseScope, t: EraseTarget): boolean {
  if (scope === "connection") return Boolean(t.connectionId);
  if (scope === "sector") return Boolean(t.sector);
  return true;
}

/** The wire body for the chosen scope. `confirm` is always the literal token — the server re-checks
 *  it as its own fat-finger guard. Scope-irrelevant target fields are omitted, not sent null. */
export function eraseBodyFrom(scope: EraseScope, t: EraseTarget): EraseBody {
  const body: EraseBody = { scope, confirm: ERASE_TOKEN };
  if (scope === "connection" && t.connectionId) body.connectionId = t.connectionId;
  if (scope === "sector" && t.sector) body.sector = t.sector;
  return body;
}

/** The consequence copy ConfirmBar shows for the chosen scope: a title (what happens) + a blast line
 *  (the exact reach) + the seal-button verb. Erase drops CACHED DATA only — the connection stays
 *  connected and the gate keeps its identity + agent keys; re-sync repopulates. That distinction is
 *  load-bearing: erase is not disconnect. */
export function eraseConsequence(
  scope: EraseScope,
  labels: { sectorLabel?: string; connectionLabel?: string } = {},
): { title: string; blast: string; verb: string } {
  if (scope === "all") {
    return {
      title: "This erases every sector and every connection.",
      blast:
        "All cached rows across finance, mail, calendar, contacts, health, and home are hard-deleted. The gate keeps its identity and your agent keys — but the data is gone, and there is no undo.",
      verb: "Erase everything",
    };
  }
  if (scope === "sector") {
    const s = labels.sectorLabel ?? "this sector";
    return {
      title: `This erases everything in ${s}.`,
      blast: `All cached rows in ${s}, across every provider, are hard-deleted. The connections stay connected and a re-sync repopulates them — but what is here now is gone, and there is no undo.`,
      verb: "Erase this sector",
    };
  }
  const c = labels.connectionLabel ?? "this connection";
  return {
    title: `This erases the cached rows for ${c}.`,
    blast: `Only ${c}'s cached rows are hard-deleted. It stays connected and a re-sync repopulates it — but what is here now is gone, and there is no undo.`,
    verb: "Erase this connection",
  };
}
