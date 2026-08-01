// Add a source (artboard 1WR-0) — the one place every sector is connected. The masthead + section
// rules come from the frozen shell; the provider grid is ported here. Cards are CONNECTION-AWARE
// (#55): a source that already has a live connection shows a quiet "connected" marker and still
// routes to its connect screen, which handles the reconnect/replace intent rather than silently
// re-running addCredential.

import { Link } from "react-router-dom";
import { Masthead, SectionRule } from "../../shell";
import { SectorChip } from "../../marks";
import { useConnectors } from "../../api/hooks";
import type { ConnectorStatus } from "../../api/types";
import { ADD_SOURCE_GROUPS, type AddSourceGroup, type ProviderDef } from "./catalog";
import { ProviderTileBox } from "./parts";
import styles from "./connect.module.css";

/** The set of provider keys that already have at least one live (non-revoked) connection. */
function connectedProviders(connectors: ConnectorStatus[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const c of connectors ?? []) {
    if (c.status !== "revoked") set.add(c.provider);
  }
  return set;
}

function ProviderCard({ def, connected }: { def: ProviderDef; connected: boolean }): JSX.Element {
  return (
    <Link className={styles.card} to={`/connect/${def.slug}`}>
      <div className={styles.cardHead}>
        <ProviderTileBox def={def} variant="card" />
        <div className={styles.cardHeadSpacer} />
        {connected ? (
          <span className={styles.cardConnected}>
            <span className={styles.cardConnectedDot} aria-hidden="true" />
            connected
          </span>
        ) : (
          <span className={styles.cardArrow} aria-hidden="true">
            →
          </span>
        )}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{def.name}</div>
        <div className={styles.cardSub}>{def.cardSub}</div>
      </div>
      {/* The sector run: the shared <SectorChip> specimen per sector, then the one mono name-run
          (build-notes §17.2 / #95 §1). This was the last surface in the Console that drew a sector as
          an anonymous 6px colour square — a legend-less swatch at the exact moment a user is choosing
          what to connect, where every other surface has taught them "sector = specimen + name".
          §17.2 rules the COMPACT variant, 13px. `SectorChipSize` is `15 | 16 | … | 20`, so 13 is a
          compile error, and widening a union that lives in `src/marks/` is not this surface's call —
          15 is the chip's own authored size and the size `CreatesFooter` already uses two clicks away.
          The 2px is reported, not smuggled in by widening the guard.
          aria-hidden sits on the run, not on each chip: standing alone a chip is `role="img"` with the
          sector as its accessible name, which would announce every sector twice against the name-run
          beside it. The dots it replaces were aria-hidden for the same reason. */}
      <div className={styles.cardSectors}>
        <span className={styles.cardSectorMarks} aria-hidden="true">
          {def.sectors.map((s) => (
            <SectorChip key={s} sector={s} size={15} />
          ))}
        </span>
        <span className={styles.cardSectorRun}>{def.cardSectorRun}</span>
      </div>
    </Link>
  );
}

function Group({ group, connected }: { group: AddSourceGroup; connected: Set<string> }): JSX.Element {
  return (
    <div className={styles.group}>
      <SectionRule label={group.header} gloss={group.gloss} />
      <div className={styles.grid}>
        {group.providers.map((def) => (
          <ProviderCard key={def.slug} def={def} connected={connected.has(def.providerKey)} />
        ))}
      </div>
    </div>
  );
}

export function AddASource(): JSX.Element {
  const { data: connectors } = useConnectors();
  const connected = connectedProviders(connectors);

  // The design lays the first two groups full-width, then the last two (Hosted link · On your device)
  // side by side.
  const [paste, oauth, hosted, device] = ADD_SOURCE_GROUPS;

  return (
    <div className={`${styles.page} ${styles.pageAdd}`}>
      <Masthead
        kicker="The gate"
        verdict="Add a source"
        sub="Connect a sector of your life once. Postern uses a credential you already hold — link the account at its source, then hand over the token or the consent. It is the gate that uses the key, never the locksmith."
      />

      <div className={styles.groups}>
        <Group group={paste} connected={connected} />
        <Group group={oauth} connected={connected} />
        <div className={styles.groupSplit}>
          <div className={styles.groupCol}>
            <Group group={hosted} connected={connected} />
          </div>
          <div className={styles.groupCol}>
            <Group group={device} connected={connected} />
          </div>
        </div>
      </div>
    </div>
  );
}
