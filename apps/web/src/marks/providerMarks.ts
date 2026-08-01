// The ONE served-provider → mark-id translation (#95 item 8).
//
// THE DEFECT THIS EXISTS TO END. Three page groups each kept their own copy of this table —
// `pages/gatehouse/helpers.ts` `PROVIDER_MARK`, `pages/lenses/SourcesBand.tsx` `PROVIDER_TILE`,
// `pages/sources/model.ts` `PROVIDER_TILE` — and the repo has now been bitten three times by exactly
// that shape: the entry was never the defect, the DUPLICATE was.
//   - `humanize("homeassistant")` returned "Homeassistant" because one table normalised and four call
//     sites did not (#95 item 2).
//   - The `apple` → iCloud rename looked applied and was not, because `format.ts` said "iCloud" and a
//     second display table in `sources/model.ts` said "Apple" (§18.4.1).
//   - All three of these tables were once keyed on `homeassistant` ALONE, while the gateway serves
//     `home_assistant` — so the Home sector card, the Home lens row and the Home connection page each
//     rendered no mark at all, and the fixtures spelled it the same wrong way, so the suite was green
//     while the real box was broken.
//
// TWO VOCABULARIES, WHICH IS THE WHOLE REASON A MAP IS NEEDED. The KEY is the wire value the gateway
// serves (`src/connectors/*.ts` → `readonly provider`); the VALUE is the mark id in the asset vault
// (`ProviderTile`). For Home Assistant they differ, and a membership test that assumes they are the
// same string silently draws nothing. Both spellings resolve, as all three copies already allowed.
//
// An unknown provider answers `null` — never a guessed mark. If a provider needs one, it is PORTED
// from the law's plate; a mark that is not on the plate is not approved (see ./index.ts).

import type { ProviderId } from "./ProviderTile";

/**
 * Served provider string → its brand mark id.
 *
 * This is legitimate display: a provider's mark is its invariant identity. It is NOT the forbidden
 * provider→custody map (build-notes §16.1), whose wrongness is that custody varies by FLOW — nothing
 * here may ever be consulted to choose a reconnect or sign-in path.
 */
const PROVIDER_MARK: Record<string, ProviderId> = {
  apple: "apple",
  apple_health: "apple_health",
  gmail: "gmail",
  google: "google",
  microsoft: "microsoft",
  plaid: "plaid",
  simplefin: "simplefin",
  whoop: "whoop",
  // The served spelling first, then the legacy unhyphenated alias three page groups still key on.
  home_assistant: "homeassistant",
  homeassistant: "homeassistant",
};

/** The mark id for a served provider string, or null when the vault carries none (never invent one). */
export function providerMarkFor(provider: string): ProviderId | null {
  return PROVIDER_MARK[provider] ?? null;
}

/** Every provider spelling this table answers for — the handle the guard test enumerates. */
export const PROVIDER_MARK_KEYS: readonly string[] = Object.keys(PROVIDER_MARK);
