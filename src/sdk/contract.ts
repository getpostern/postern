// @pci/sdk — the connector CONTRACT surface.
//
// This is the single, stable surface a connector author imports. Today it RE-EXPORTS the compile-time
// types from `connectors/types.ts` (the physical move into the SDK is a later, import-touching unit —
// the SDK is the seam now, the move is mechanical later) and adds the machine-readable obligation
// catalog the conformance harness checks. Nothing here forks or duplicates a type: a connector that
// satisfies `Connector` here satisfies the runner, byte-for-byte.
//
// The PROSE form of these obligations — what a future / agent author reads — lives in `README.md`.

export type {
  Connector,
  SyncContext,
  RawRecord,
  SyncPolicy,
  ActionSpec,
  ActionParam,
  ActionContext,
  ActionResult,
} from "../connectors/types.js";

/** Where an obligation is enforced today: the runner throws on a violation, or it is convention-only. */
export type ObligationTier = "hard" | "soft";

/** One machine-readable contract obligation (the README is the prose mirror). */
export interface ContractObligation {
  /** Stable id used by the conformance harness, e.g. "H1" | "S3". */
  readonly id: string;
  readonly tier: ObligationTier;
  /** Whether it is mechanically enforced by the runner today, or convention/review-only. */
  readonly enforcedBy: "runner" | "convention";
  /** A one-line statement of the obligation. */
  readonly summary: string;
}

/**
 * The contract every connector owes the runner + the gateway. HARD obligations are enforced by the
 * runner today (a violator throws/breaks at runtime); SOFT obligations are convention/review-only —
 * the conformance harness is what makes them mechanical. (S5 — action param validation — is a
 * documented `it.todo` this wave: only HA has actions and its catalog is known-unwired, per ADR 0003.)
 */
export const CONTRACT_OBLIGATIONS: readonly ContractObligation[] = [
  { id: "H1", tier: "hard", enforcedBy: "runner", summary: "every emitted record's (servedSector, rec.object ?? objectType) resolves via tableForObject to a REGISTRY entry" },
  { id: "H2", tier: "hard", enforcedBy: "runner", summary: "normalize() emits ONLY keys in that entry's REGISTRY field allow-list" },
  { id: "H3", tier: "hard", enforcedBy: "runner", summary: "normalize() returns a non-empty string source_object_id" },
  { id: "H4", tier: "hard", enforcedBy: "runner", summary: "buildUpsert accepts the injected row (conflict target (connection_id, source_object_id))" },
  { id: "H5", tier: "hard", enforcedBy: "runner", summary: "deletion records carry deleted:true and a non-empty string externalId" },
  { id: "H6", tier: "hard", enforcedBy: "runner", summary: "the runner injects connection_id/user_id from ctx (never the payload), raw=rec.raw, deleted_at=null on live writes" },
  { id: "H7", tier: "hard", enforcedBy: "runner", summary: "the cursor advances only from a non-null rec.cursor; a null run keeps the prior" },
  { id: "H8", tier: "hard", enforcedBy: "runner", summary: "fetch_live persists nothing core-side" },
  { id: "H-types", tier: "hard", enforcedBy: "runner", summary: "the required Connector members are present (compile-time + runtime presence)" },
  { id: "S1", tier: "soft", enforcedBy: "convention", summary: "errors are secret-free — a credential never appears in a thrown/returned message" },
  { id: "S2", tier: "soft", enforcedBy: "convention", summary: "fetchRecordLive stores nothing connector-side" },
  { id: "S3", tier: "soft", enforcedBy: "convention", summary: "strongKeys is deterministic + stable and returns a Record<string,string>" },
  { id: "S4", tier: "soft", enforcedBy: "convention", summary: "a read-only execute() throws; an action connector rejects an unknown action id" },
  { id: "S5", tier: "soft", enforcedBy: "convention", summary: "action connectors validate params against their ActionSpec (deferred — it.todo this wave)" },
  { id: "S6", tier: "soft", enforcedBy: "convention", summary: "the STATIC (sector, objectType) is a valid REGISTRY pair" },
  { id: "S7", tier: "soft", enforcedBy: "convention", summary: "a deletion's externalId uses the same id scheme as the live source_object_id (the tombstone hits the live row)" },
  { id: "S8", tier: "soft", enforcedBy: "convention", summary: "a live RawRecord.externalId is a non-empty string" },
  { id: "S9", tier: "soft", enforcedBy: "convention", summary: "the cursor is round-trippable (no dup/skip when re-fed)" },
  { id: "S10", tier: "soft", enforcedBy: "convention", summary: "normalize returns a plain object (not null, not an array)" },
  { id: "S11", tier: "soft", enforcedBy: "convention", summary: "normalize does NOT emit the uuid PK 'id'" },
  { id: "S12", tier: "soft", enforcedBy: "convention", summary: "policy.mode ∈ {push,poll,on_demand}; poll ⇒ a positive defaultIntervalSec" },
] as const;
