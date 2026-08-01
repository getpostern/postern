// sync-runner — the generic engine that keeps the local store fresh.
//
// One code path for every sector: load a connector's connection, resolve its token from the vault,
// stream raw records through the connector's normalize, idempotently upsert them into the domain
// table, and advance the cursor. A declarative scheduler drives `poll` connectors on their cadence.
// No per-sector logic — the only thing that varies is the connector's declared SyncPolicy.
//
// This is the stable surface other units import.

export { registerConnector, getConnector } from "./registry.js";
export {
  syncConnection,
  ingestRecords,
  buildUpsert,
  tableForObject,
  maskError,
  markError,
  markStreamState,
  MAX_SYNC_ATTEMPTS,
  RETRY_BACKOFF_MS,
  RETRY_JITTER_FRACTION,
} from "./runner.js";
export type { SyncResult, SyncOptions } from "./runner.js";
// Sync error classification (#99, ADR 0034) — the transient/terminal taxonomy the runner acts on.
export {
  classifySyncError,
  isTransientHttpStatus,
  PROVIDER_RETRYABILITY,
} from "./retryability.js";
export type { SyncErrorClass, ProviderRetryability } from "./retryability.js";
export { RetryableError } from "./errors.js";
export {
  startScheduler,
  isStale,
  effectiveIntervalSec,
  effectiveToleranceSec,
  intervalFloorSec,
} from "./scheduler.js";
