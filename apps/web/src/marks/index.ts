// The asset vault — the single import surface for every drawn mark the Console renders.
//
// `console-shell` and all seven phase-2 page groups import exactly this. Nothing else in the app may
// draw a mark: if a surface needs one that is not here, the answer is to PORT it from the law's
// plate (landing file 01KXV3PJEGEJW84ERA8Z46GVS8 node F69-0), never to author one. That is the law's
// one rule — if a mark is not on the plate, it is not approved.

export { NavMark, PosternMark } from "./NavMark";
export type { GateMark } from "./NavMark";

export { SectorChip } from "./SectorChip";
export type { Sector, SectorChipSize } from "./SectorChip";

export { SectorSpecimen } from "./SectorSpecimen";
export type { SectorSpecimenSize } from "./SectorSpecimen";

export { InstitutionMark } from "./InstitutionMark";
export {
  resolveInstitutionMark,
  // The DOMAIN fold — the stable identifier marks are keyed on (institutions.ts rule 1). Exported
  // because it is not only a mark concern: `pages/sources/grain.ts` folds bank cards into institutions
  // with the same function, and two copies of it would let the Console's grouping disagree with the
  // dedup engine's merges. That module imports the file directly rather than this barrel — the barrel
  // pulls components and their CSS.
  canonicalHostLabel,
  plateLabelForDomain,
  normaliseInstitutionName,
  WORDMARK_MIN_SIZE,
  NEUTRAL_MONOGRAM_HEX,
} from "./institutions";
export type { InstitutionMarkResolution, CraftedInstitutionId } from "./institutions";

export { ProviderTile } from "./ProviderTile";
export type { ProviderId } from "./ProviderTile";

// The ONE served-provider → mark-id translation (#95 item 8). Three page groups each held a private
// copy; the mark id and the wire value differ for Home Assistant, and every past divergence of these
// two vocabularies drew nothing at all. See ./providerMarks.ts for the three incidents.
export { providerMarkFor, PROVIDER_MARK_KEYS } from "./providerMarks";

// `AgentMark` was DELETED 2026-07-25 (operator ruling; console-specimens §5) — it was a plate-approved
// port with zero production render sites, exercised only by its own test. It is re-portable verbatim
// from the law's plate (file 01KXV3PJEGEJW84ERA8Z46GVS8): claude ER1-0 · openai ER4-0 · openclaw
// ERJ-0 · generic EP3-0. The same four marks still ride the pollinator's eyespots on NavMark:agents,
// so the drawings have not left the Console — only the unused component has.
