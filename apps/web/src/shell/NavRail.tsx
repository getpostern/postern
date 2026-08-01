// The ONE nav rail (console-port-plan §7 law 5; 47 Paper copies are a tool limitation).
//
// Structure ported from the Gatehouse rail `2-0`: brand lockup · rule · Gatehouse · SECTORS +
// six sector items · THE GATE + Sources/Agents/Ledger/Settings · flex spacer · gate-status footer.
//
// Residual #1: the Gatehouse nav item uses <NavMark mark="gatehouse"/> (17×17), NEVER
// PosternMark(17) — PosternMark keeps the 22×28 door aspect and would render 17×21.6 in a 17-lane.
// Residual #2: every icon sits in a fixed-width `.iconSlot` so the text lane never drifts.

import { Link } from "react-router-dom";
import { NavMark, PosternMark, SectorChip } from "../marks";
import type { GateMark } from "../marks/NavMark";
import { SECTORS, type Sector } from "../api/types";
import { GATEWAY_URL } from "../api/client";
import { useHealthz } from "../api/hooks";
import styles from "./NavRail.module.css";

/** Every rail destination — the union the whole app types its active state against. */
export type NavId = "gatehouse" | Sector | "sources" | "agents" | "ledger" | "settings";

/** Sector display names for the rail (Title-case, matching the design). */
const SECTOR_LABEL: Record<Sector, string> = {
  finance: "Finance",
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
  health: "Health",
  home: "Home",
};

interface GateItem {
  id: Exclude<NavId, Sector | "gatehouse">;
  label: string;
  mark: GateMark;
  to: string;
}

/** The Gate group — Sources, Agents & keys, The ledger, Settings. */
const GATE_ITEMS: GateItem[] = [
  { id: "sources", label: "Sources", mark: "sources", to: "/sources" },
  { id: "agents", label: "Agents & keys", mark: "agents", to: "/agents" },
  { id: "ledger", label: "The ledger", mark: "ledger", to: "/ledger" },
  { id: "settings", label: "Settings", mark: "settings", to: "/settings" },
];

/** One rail row. The icon lives in a fixed-width slot; active is a data-attr the CSS keys off. */
function RailItem({
  to,
  active,
  home = false,
  icon,
  label,
}: {
  to: string;
  active: boolean;
  home?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className={styles.item}
        data-active={active}
        data-home={home || undefined}
        aria-current={active ? "page" : undefined}
      >
        {/* The visible text label is the item's accessible name, so the mark is decorative —
            aria-hidden here prevents a sector chip (role=img "Calendar") from double-announcing
            beside the "Calendar" text (a11y review, 1c-B). Consistent across sector + gate marks. */}
        <span className={styles.iconSlot} aria-hidden="true">
          {icon}
        </span>
        <span className={styles.label}>{label}</span>
        {active && home ? <span className={styles.sealBar} aria-hidden="true" /> : null}
      </Link>
    </li>
  );
}

/** The gate-status footer — an honest liveness read, polled by `useHealthz` (never a static badge). */
function GateStatus() {
  const { data, isLoading, isError } = useHealthz();
  const ok = data?.ok === true;
  const tone = isLoading ? "idle" : ok ? "ok" : "error";
  const title = isLoading
    ? "Reading the gate…"
    : ok
      ? "The gate is open"
      : "The gate is unreachable";
  // Same-origin build (the shipped default): the gate's address IS this page's address — the honest
  // value is the browser's own host, never an invented one. A configured cross-origin value is shown
  // as configured. (`new URL("")` throws, so the old bare parse fell into its catch and rendered a
  // dangling "operator · " at every address.)
  const configured = GATEWAY_URL.trim();
  let host = "";
  if (configured === "") {
    host = typeof window !== "undefined" ? window.location.host : "";
  } else {
    try {
      host = new URL(configured).host || configured;
    } catch {
      host = configured;
    }
  }

  return (
    <div className={styles.gateStatus}>
      <span className={styles.gateDot} data-tone={tone} aria-hidden="true" />
      <div className={styles.gateBody}>
        <div className={styles.gateTitle}>{title}</div>
        <div className={styles.gateSub}>
          {/* Never emit a dangling separator. The empty-`host` branch is unreachable in a real
              browser (window.location.host is never empty) — the guard exists so no future
              same-origin path can leave a bare "·" on screen. */}
          {isError && !isLoading ? host || "this origin" : host ? `operator · ${host}` : "operator"}
        </div>
      </div>
    </div>
  );
}

/**
 * The navigation rail. `active` names the current destination; exactly one row carries
 * `aria-current="page"`. Keyboard-reachable links, the one inherited focus ring.
 */
export function NavRail({ active }: { active: NavId }): JSX.Element {
  return (
    <nav className={styles.rail} aria-label="Primary">
      <Link to="/" className={styles.brand} aria-label="Postern — the Gatehouse">
        <PosternMark size={22} lockup />
      </Link>

      <div className={styles.rule} aria-hidden="true" />

      <ul className={styles.group}>
        <RailItem
          to="/"
          active={active === "gatehouse"}
          home
          icon={<NavMark mark="gatehouse" />}
          label="Gatehouse"
        />
      </ul>

      <div className={styles.sectionLabel}>Sectors</div>
      <ul className={styles.group}>
        {SECTORS.map((sector) => (
          <RailItem
            key={sector}
            to={`/sectors/${sector}`}
            active={active === sector}
            icon={<SectorChip sector={sector} />}
            label={SECTOR_LABEL[sector]}
          />
        ))}
      </ul>

      <div className={styles.sectionLabel}>The gate</div>
      <ul className={styles.group}>
        {GATE_ITEMS.map((item) => (
          <RailItem
            key={item.id}
            to={item.to}
            active={active === item.id}
            icon={<NavMark mark={item.mark} />}
            label={item.label}
          />
        ))}
      </ul>

      <div className={styles.spacer} />

      <GateStatus />
    </nav>
  );
}
