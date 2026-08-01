// AppShell — the one layout frame: the rail plus a fluid main column.
//
// The router (App.tsx, owned by this unit) wraps every route in AppShell, so a phase-2 page ships
// only its body and never touches the shell or the rail. `active` is derived from the pathname here
// rather than threaded through the signature — the URL is the single source of truth for which rail
// row is current, and deriving it in one place means no route can disagree with the address bar.

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { NavRail, type NavId } from "./NavRail";
import { isSector } from "../api/types";
import styles from "./AppShell.module.css";

/**
 * Which rail row is current for a pathname. Sub-routes resolve to their section's row: every
 * `/sectors/:sector/*` lights the sector; `/sources/*` and `/connect/*` light Sources;
 * `/agents/*` lights Agents; and so on. Exported for the route-coverage test.
 */
export function navIdForPath(pathname: string): NavId {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "gatehouse";
  switch (parts[0]) {
    case "sectors": {
      const sector = parts[1];
      return sector && isSector(sector) ? sector : "gatehouse";
    }
    case "sources":
    case "connect":
      return "sources";
    case "agents":
      return "agents";
    case "ledger":
      return "ledger";
    case "settings":
      return "settings";
    default:
      return "gatehouse";
  }
}

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  const active = navIdForPath(pathname);

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <NavRail active={active} />
      <main id="main-content" className={styles.main}>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
