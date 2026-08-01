// Provider marks — colour encodes SOURCE.
//
// PORTED, NEVER REDRAWN. get_jsx({format:"inline-styles"}) from the app file
// 01KY3S7JMA16R0QZVSX084WWDD provider-icon kit `3D7-0` (8 children: apple · microsoft · google ·
// gmail · simplefin · plaid · whoop · homeassistant), plus `apple_health` from the law's plate
// (landing file 01KXV3PJEGEJW84ERA8Z46GVS8, `p-applehealth` FQM-0) — whose mark is the SAME Apple
// glyph, drawn at 26 rather than 24. That is the plate's own treatment, not a substitution.
//
// Colour discipline (build-notes §0): provider marks carry brand colour because colour encodes the
// *source*. Agent marks are single-ink and never carry a brand logo (the AgentMark component was
// deleted 2026-07-25 with zero render sites; re-port from plate ER1-0/ER4-0/ERJ-0/EP3-0 if needed).
//
// Sizes are the kit's own. Each provider keeps its native aspect; `size` scales the width and the
// height follows, so a vector is never re-laid-out. A caller that needs a uniform lane gives the
// mark a fixed-width slot — that is layout, and it belongs to the page.

// `.mark` is the vault's one shared rule (flex-shrink + display:block). It lives in
// NavMark.module.css rather than being duplicated per file; provider marks need no styling of their
// own, because everything visual about them is inside the vector.
import shared from "./NavMark.module.css";

export type ProviderId =
  | "apple"
  | "gmail"
  | "google"
  | "microsoft"
  | "homeassistant"
  | "plaid"
  | "simplefin"
  | "whoop"
  | "apple_health";

/** The Apple glyph, shared by the `apple` credential and by Apple Health (per the law's plate). */
const APPLE_PATH =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";

function AppleGlyph() {
  return <path d={APPLE_PATH} fill="#2A2118" />;
}

function MicrosoftGlyph() {
  return (
    <>
      <rect x="2.7" y="4.2" width="8.6" height="8.6" transform="rotate(-1.4 7 8.5)" fill="#DE4E1C" stroke="#2A2118" strokeWidth="0.9" />
      <rect x="12.8" y="4.4" width="8.6" height="8.6" transform="rotate(1.2 17 8.5)" fill="#40794C" stroke="#2A2118" strokeWidth="0.9" />
      <rect x="2.9" y="14.4" width="8.6" height="8.6" transform="rotate(1.5 7 18.7)" fill="#5877C0" stroke="#2A2118" strokeWidth="0.9" />
      <rect x="12.9" y="14.2" width="8.6" height="8.6" transform="rotate(-1.2 17 18.7)" fill="#E7A42A" stroke="#2A2118" strokeWidth="0.9" />
    </>
  );
}

function GoogleGlyph() {
  return (
    <g transform="rotate(-2 12 13)">
      <path d="M18.7 7.3 A8.1 8.1 0 0 0 5.9 8.9" fill="none" stroke="#DE4E1C" strokeWidth="3.3" strokeLinecap="round" />
      <path d="M5.9 8.9 A8.1 8.1 0 0 0 6.1 17.5" fill="none" stroke="#E7A42A" strokeWidth="3.3" strokeLinecap="round" />
      <path d="M6.1 17.5 A8.1 8.1 0 0 0 17.6 19.1" fill="none" stroke="#40794C" strokeWidth="3.3" strokeLinecap="round" />
      <path d="M17.6 19.1 A8.1 8.1 0 0 0 20.1 13.4 L12.6 13.4" fill="none" stroke="#5877C0" strokeWidth="3.3" strokeLinecap="round" />
    </g>
  );
}

function GmailGlyph() {
  return (
    <g transform="rotate(-1.6 12 13)">
      <rect x="2.6" y="6.6" width="18.8" height="13" rx="1.2" fill="#FFFDF4" stroke="#2A2118" strokeWidth="1.1" />
      <path d="M3.5 8.5 L3.5 19.4" fill="none" stroke="#DE4E1C" strokeWidth="1.7" />
      <path d="M20.5 8.4 L20.5 19.4" fill="none" stroke="#DE4E1C" strokeWidth="1.7" />
      <path d="M3.5 8.3 L12 14.9 L20.5 8.2" fill="none" stroke="#DE4E1C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function SimplefinGlyph() {
  return (
    <g transform="translate(-177.316,-357.874)">
      <path
        d="m 578.124,558.279 c 0,110.68 -89.724,200.404 -200.404,200.404 -110.68,0 -200.404,-89.724 -200.404,-200.404 0,-110.68 89.724,-200.404 200.404,-200.404 110.68,0 200.404,89.724 200.404,200.404 z"
        fill="#0088CC"
      />
      <path
        d="m 100.681,694.586 c 0.026,-15.911 4.281,-25.426 9.497,-44.699 0.302,-1.116 4.394,-6.264 4.754,-6.735 13.306,-14.057 28.573,-26.125 43.568,-38.309 23.175,-17.97 45.981,-36.398 68.977,-54.595 25.232,-20.181 52.55,-37.437 80.078,-54.257 24.029,-14.599 48.483,-28.488 73.792,-40.746 7.299,-3.459 14.765,-6.545 22.195,-9.705 2.138,-0.909 6.595,-2.947 9.134,-3.364 1.113,-0.183 2.256,0.013 3.383,0.02 0.971,0.474 2.102,0.707 2.913,1.422 5.232,4.617 4.147,19.286 4.173,25.478 -0.043,17.133 -1.191,34.327 2.093,51.274 0.857,4.423 2.127,8.757 3.191,13.135 8.179,26.975 23.055,51.094 41.132,72.552 4.683,5.558 9.724,10.805 14.585,16.207 22.156,22.811 47,42.89 73.541,60.373 15.7,10.342 21.173,13.041 37.275,22.057 25.946,14.254 53.607,24.796 81.612,34.158 9.448,3.161 19.06,5.801 28.713,8.251 0,0 -8.961,35.082 -8.961,35.082 l 0,0 c -9.44,-3.494 -18.917,-6.896 -28.255,-10.657 -27.906,-10.838 -55.264,-23.146 -81.042,-38.458 -6.027,-3.637 -12.132,-7.148 -18.08,-10.912 -33.271,-21.056 -65.219,-44.554 -93.469,-72.054 -11.618,-11.909 -17.59,-17.353 -27.712,-30.25 -13.115,-16.711 -23.695,-35.489 -30.602,-55.584 -1.24,-4.24 -2.712,-8.419 -3.721,-12.72 -1.332,-5.678 -2.854,-16.924 -3.184,-22.877 -0.49,-8.826 0.306,-17.733 -0.139,-26.566 -0.127,-5.614 -0.148,-11.257 -0.701,-16.851 -0.109,-1.102 -0.281,-2.198 -0.437,-3.294 -0.105,-0.739 -0.077,-1.515 -0.344,-2.212 -0.174,-0.455 -0.622,-0.75 -0.932,-1.125 -4.087,-0.524 -6.74,0.716 -10.662,2.035 -7.297,2.454 -14.536,5.094 -21.665,8.001 -25.157,11.09 -49.652,23.603 -72.962,38.232 -27.386,17.099 -54.717,34.407 -79.8,54.827 -12.103,9.551 -23.987,19.348 -35.966,29.053 -7.459,6.043 -15.049,11.924 -22.502,17.975 -3.574,2.902 -7.082,5.883 -10.624,8.825 -9.035,7.643 -17.987,15.32 -26.531,23.515 -3.957,3.795 -8.898,8.606 -12.46,12.895 -1.435,1.729 -2.675,3.611 -4.012,5.416 -0.799,1.417 -1.711,2.776 -2.397,4.251 -0.522,1.122 -1.489,4.716 -1.214,3.51 13.907,-60.851 7.424,-40.885 7.813,-28.054 0,0 -14.049,35.483 -14.049,35.483 z"
        fill="#FFFFFF"
      />
    </g>
  );
}

function PlaidGlyph() {
  return (
    <g transform="rotate(45 12 13.3)">
      <rect x="6.2" y="7.2" width="3.1" height="3.1" fill="#2A2118" />
      <rect x="10.3" y="7.2" width="3.1" height="3.1" fill="#2A2118" opacity="0.78" />
      <rect x="14.4" y="7.2" width="3.1" height="3.1" fill="#2A2118" />
      <rect x="6.2" y="11.3" width="3.1" height="3.1" fill="#2A2118" opacity="0.78" />
      <rect x="10.3" y="11.3" width="3.1" height="3.1" fill="#2A2118" />
      <rect x="14.4" y="11.3" width="3.1" height="3.1" fill="#2A2118" opacity="0.78" />
      <rect x="6.2" y="15.4" width="3.1" height="3.1" fill="#2A2118" />
      <rect x="10.3" y="15.4" width="3.1" height="3.1" fill="#2A2118" opacity="0.78" />
      <rect x="14.4" y="15.4" width="3.1" height="3.1" fill="#2A2118" />
    </g>
  );
}

function WhoopGlyph() {
  return (
    <>
      <circle cx="12" cy="12" r="11" fill="#FFFDF4" stroke="#2A2118" />
      <circle cx="12" cy="12" r="8.6" fill="#2A2118" />
      <path d="M7.5 9.7 L9.8 16.2 L12 11.6 L14.2 16.2 L16.5 9.7" fill="none" stroke="#F5EDDA" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function HomeAssistantGlyph() {
  return (
    <g transform="rotate(-1.2 12 13)">
      <path d="M12 3.6 L21.4 12.4 L21.4 21.6 L2.6 21.6 L2.6 12.4 Z" fill="#6FA8D8" stroke="#2A2118" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M12 19.6 L12 9.4 M12 12.6 L8.4 9.6 M12 14.8 L15.6 11.6" fill="none" stroke="#FFFDF4" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="12" cy="8.6" r="1.35" fill="#FFFDF4" />
      <circle cx="7.8" cy="9" r="1.2" fill="#FFFDF4" />
      <circle cx="16.2" cy="11" r="1.2" fill="#FFFDF4" />
      <rect x="10.4" y="17.4" width="3.2" height="4.2" fill="#FFFDF4" stroke="#2A2118" strokeWidth="0.6" />
    </g>
  );
}

type ProviderSpec = {
  /** Native drawn width and height from the kit; `size` scales against the width. */
  width: number;
  height: number;
  viewBox: string;
  /** The provider's name, used as the standalone mark's accessible name. */
  name: string;
  Glyph: () => JSX.Element;
};

// `name` is the mark's ACCESSIBLE name, so it is display vocabulary and must match what the screen
// says. `apple` is iCloud (§18.4.1): the tile sits inside the same <Link> as the visible "iCloud"
// title on Add-a-source, and while it said "Apple" that link's computed name read "Apple … iCloud"
// — a third name for a provider that had already been ruled to have exactly one. The GLYPH is
// shared by both Apple providers per the plate and is unchanged; it is the name that splits.
const PROVIDER: Record<ProviderId, ProviderSpec> = {
  apple: { width: 24, height: 24, viewBox: "0 0 24 24", name: "iCloud", Glyph: AppleGlyph },
  apple_health: { width: 26, height: 26, viewBox: "0 0 24 24", name: "Apple Health", Glyph: AppleGlyph },
  microsoft: { width: 24, height: 26, viewBox: "0 0 24 26", name: "Microsoft", Glyph: MicrosoftGlyph },
  google: { width: 24, height: 26, viewBox: "0 0 24 26", name: "Google", Glyph: GoogleGlyph },
  gmail: { width: 24, height: 26, viewBox: "0 0 24 26", name: "Gmail", Glyph: GmailGlyph },
  simplefin: { width: 26, height: 26, viewBox: "0 0 400.808 400.808", name: "SimpleFIN", Glyph: SimplefinGlyph },
  plaid: { width: 24, height: 26, viewBox: "0 0 24 26", name: "Plaid", Glyph: PlaidGlyph },
  whoop: { width: 24, height: 24, viewBox: "0 0 24 24", name: "WHOOP", Glyph: WhoopGlyph },
  homeassistant: { width: 24, height: 26, viewBox: "0 0 24 26", name: "Home Assistant", Glyph: HomeAssistantGlyph },
};

/**
 * A provider mark at kit scale. `size` scales the width; the native aspect is preserved.
 *
 * Carries `role="img"` and the provider's name: a provider mark is used standalone (the provider
 * chips, connect screens' headers) as often as it is used beside a label, and a standalone mark
 * without an accessible name is a silent one.
 */
export function ProviderTile({ provider, size }: { provider: ProviderId; size?: number }): JSX.Element {
  const spec = PROVIDER[provider];
  const width = size ?? spec.width;
  const height = width * (spec.height / spec.width);

  return (
    <svg
      className={shared.mark}
      width={width}
      height={height}
      viewBox={spec.viewBox}
      role="img"
      aria-label={spec.name}
      focusable="false"
    >
      <spec.Glyph />
    </svg>
  );
}
