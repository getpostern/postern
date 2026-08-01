// @pci/sdk — the connector author's surface (barrel).
//
// Internal `src/sdk/` module now; extractable to a published `@pci/sdk` package later (the physical
// move of the contract types out of `connectors/types.ts` and the npm publish are deferred follow-ups).
// A connector author imports the CONTRACT (types + obligations) from here; a connector's
// *.conformance.test.ts imports describeConformance from here.

export type {
  Connector,
  SyncContext,
  RawRecord,
  SyncPolicy,
  ActionSpec,
  ActionParam,
  ActionContext,
  ActionResult,
  ObligationTier,
  ContractObligation,
} from "./contract.js";
export { CONTRACT_OBLIGATIONS } from "./contract.js";

export type {
  ConformanceFixtures,
  ConformanceOpts,
  ConformanceIntegrationCtx,
  ConformanceCheck,
} from "./conformance.js";
export {
  describeConformance,
  runContractChecks,
  buildRunnerRow,
  secretLeakFree,
  CONTRACT_CHECK_IDS,
} from "./conformance.js";
