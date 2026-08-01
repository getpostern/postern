// ReadActNote — #79 read-vs-act legibility. A grant is domain-level and covers read AND act (that
// permission-accurate wording stays), but only ONE sector has a real action catalog today: home
// (the HA entity×service catalog). The other five are read-only — "act" is a granted-but-no-op
// capability. Shipping the grant matrix without saying so is the ambiguity #79 flags.
//
// The action COUNT ("home: +N actions") comes from the catalog mirror, which IS served now
// (`GET /api/actions`, #58/#89). This calls the real `listActions("home")` and still degrades per the
// contract: served → the count; nothing served → NO count at all, never a fabricated number and never
// a silent "read-only" that would hide home's act half. The degradation is now an ABSENCE rather than
// a sentence about our wire (#106) — the act half of the grant is still stated in full either way,
// which is the thing #79 exists to make legible.
//
// `ActionCatalog.count` is the number of specs in THIS RESPONSE, never a total, so `truncated` has to
// reach the sentence: the server's cap cut an id-sorted list, and quoting the prefix as the whole
// catalog is the silent-truncation defect the shape was introduced to prevent. Reading `.length` off
// the old bare-array declaration is what made every lens say "read-only, no actions" the day the route
// landed — `undefined` is falsy and nothing errored.

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { SECTOR_TITLE } from "./helpers";
import { SECTORS, type Sector } from "../../api/types";
import styles from "./ReadActNote.module.css";

/** The one sector with a real action catalog today. */
const ACT_SECTOR: Sector = "home";

function useHomeActionCount() {
  return useQuery({
    queryKey: ["actions", ACT_SECTOR],
    queryFn: () => api.listActions(ACT_SECTOR),
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * #79 read-vs-act legibility, made GRANT-ACCURATE. The note describes what THIS grant set confers —
 * it does not claim Home's act half for an agent that isn't granted Home, and it names only the
 * read-only sectors actually granted, not all five (design/adversarial review). The empty grant
 * (a fresh Mint draft under default-deny) is the one case that teaches the general vocabulary,
 * because there is no specific grant to describe yet.
 *
 * @param granted the sectors currently granted (mint draft or a saved agent).
 */
export function ReadActNote({ granted }: { granted: Sector[] }): JSX.Element {
  const q = useHomeActionCount();
  const grantsHome = granted.includes(ACT_SECTOR);
  const readOnlyGranted = granted.filter((s) => s !== ACT_SECTOR);

  // Home's act phrase, or NULL when there is no count to give. `count` is what this response carried;
  // when the cap trimmed it, "at least" is the only honest reading of that number.
  //
  // #106: the degraded branch used to read "action count not served yet", so the sentence a person saw
  // was "This grant can act on Home (action count not served yet)" — a parenthetical about our wire,
  // wedged into a statement about what their agent may do. An unknown count is now ABSENCE: "This
  // grant can act on Home." That claims strictly LESS, not more — the grant confers act on Home
  // whatever the catalogue says, and the count was never the claim. Pending, unserved and errored all
  // collapse here on purpose; the third phrasing ("read + act") was a pending-state string that read
  // like a count and is retired with them.
  let actPhrase: string | null = null;
  if (q.data) {
    const n = q.data.count;
    const noun = `action${n === 1 ? "" : "s"}`;
    actPhrase = q.data.truncated ? `at least ${n} ${noun}` : `${n} ${noun}`;
  }

  // Empty draft → the vocabulary, so a minter under default-deny learns what "act" means.
  if (granted.length === 0) {
    const allReadOnly = SECTORS.filter((s) => s !== ACT_SECTOR)
      .map((s) => SECTOR_TITLE[s])
      .join(", ");
    return (
      <p className={styles.note}>
        A grant covers read <em>and</em> act, but only <strong>Home</strong> has a catalogue to act
        on today; {allReadOnly} are read-only.
      </p>
    );
  }

  // Grant-accurate: only what this agent actually holds.
  const readOnlyNames = readOnlyGranted.map((s) => SECTOR_TITLE[s]).join(", ");
  return (
    <p className={styles.note}>
      {grantsHome ? (
        <>
          This grant can <strong>act</strong> on Home{actPhrase ? ` (${actPhrase})` : ""}
          {readOnlyGranted.length > 0 ? " and read " : ""}
          {readOnlyNames}
          {readOnlyGranted.length > 0 ? " (read-only today)" : ""}.
        </>
      ) : (
        <>
          This grant is <strong>read-only today</strong> — {readOnlyNames} have no action catalogue;
          only Home can act, and it isn’t granted here.
        </>
      )}
    </p>
  );
}
