// The provider→mark-id table has ONE home, and a fourth copy cannot appear silently (#95 item 8).
//
// WHY A GUARD AND NOT JUST A DELETION. Three page groups each held their own copy of this table, and
// this repo has been bitten three times by that exact shape — `humanize("homeassistant")` →
// "Homeassistant", the `apple` → iCloud rename that looked applied and was not, and all three tables
// keyed on `homeassistant` while the gateway serves `home_assistant`, so the Home card, the Home lens
// row and the Home connection page each drew no mark at all. Every time, the entry was not the defect:
// the DUPLICATE was, and the fixtures agreed with the duplicate, so the suite stayed green.
//
// Deleting the third copy therefore is not the fix on its own — the fix is that a fourth cannot be
// written without this file going red. Two of the three copies live outside the owning unit's files
// (`pages/gatehouse/helpers.ts`, `pages/lenses/SourcesBand.tsx`), so they are pinned AGAINST the shared
// table here rather than merged: they cannot drift in silence, which is the only thing the duplicate
// could ever cost, and the merge is reported for whoever owns those files next.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_MARK_KEYS, providerMarkFor } from "./providerMarks";
import { providerMark } from "../pages/gatehouse/helpers";

const SRC = fileURLToPath(new URL("..", import.meta.url)); // apps/web/src

/** The one table. */
const CANONICAL = "marks/providerMarks.ts";

/**
 * The two copies that still exist, each with the reason it is not merged here.
 *
 * `pages/gatehouse/helpers.ts` and `pages/lenses/SourcesBand.tsx` were outside the owned file set of
 * the unit that consolidated this (2026-07-26). Both are pinned below. Delete an entry from this list
 * as its file is pointed at `providerMarkFor` — never ADD one.
 */
const KNOWN_DUPLICATES = ["pages/gatehouse/helpers.ts", "pages/lenses/SourcesBand.tsx"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Pull every `Record<string, ProviderId>` object literal out of a source file, as a plain map.
 *
 * Source text rather than an import because two of the three tables are module-private — and a guard
 * that could only see EXPORTED tables would miss the shape that actually caused all three incidents.
 * Comments are stripped first: these tables carry long comments naming the very provider strings the
 * parser is looking for, so leaving them in finds phantom entries.
 */
function providerTablesIn(source: string): Record<string, string>[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tables: Record<string, string>[] = [];
  const decl = /Record<\s*string\s*,\s*ProviderId\s*>\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    // Walk to the matching brace so a nested literal cannot truncate the capture.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(m.index + m[0].length, i - 1);
    const table: Record<string, string> = {};
    for (const pair of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)) {
      table[pair[1]] = pair[2];
    }
    tables.push(table);
  }
  return tables;
}

const FILES = walk(SRC)
  .map((f) => relative(SRC, f).replaceAll("\\", "/"))
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

const WITH_TABLE = FILES.filter((f) => providerTablesIn(readFileSync(join(SRC, f), "utf8")).length > 0);

/** The canonical table, read back through the parser — so the parser itself is proved on real input. */
function canonicalTable(): Record<string, string> {
  const [table] = providerTablesIn(readFileSync(join(SRC, CANONICAL), "utf8"));
  return table;
}

describe("provider → mark id lives in exactly one place (#95 item 8)", () => {
  it("the detector is not vacuous — it finds the canonical table AND both known duplicates", () => {
    // A regex that matched nothing would let every assertion below pass. Naming the survivors here is
    // what makes "no fourth" meaningful rather than "no table anywhere, including ours".
    expect(WITH_TABLE).toContain(CANONICAL);
    for (const dup of KNOWN_DUPLICATES) expect(WITH_TABLE).toContain(dup);
  });

  it("the parser reads real entries, not an empty object", () => {
    const table = canonicalTable();
    // Both spellings of the one provider whose wire value and mark id differ — the entry every past
    // incident turned on.
    expect(table.home_assistant).toBe("homeassistant");
    expect(table.homeassistant).toBe("homeassistant");
    expect(Object.keys(table).sort()).toEqual([...PROVIDER_MARK_KEYS].sort());
  });

  it("no FOURTH copy exists anywhere in the app", () => {
    const unexpected = WITH_TABLE.filter(
      (f) => f !== CANONICAL && !(KNOWN_DUPLICATES as readonly string[]).includes(f),
    );
    expect(unexpected).toEqual([]);
  });

  it("pages/sources/model.ts no longer declares one — it delegates", () => {
    // The copy this unit owned and deleted. Pinned by NAME so the deletion cannot quietly come back
    // as a convenience map inside the same file.
    expect(WITH_TABLE).not.toContain("pages/sources/model.ts");
  });

  /**
   * The surviving duplicates must ANSWER THE SAME as the shared table, spelling for spelling.
   *
   * MUTATION: drop `home_assistant` from `marks/providerMarks.ts` (the exact shape of the original bug)
   * → RED here on both duplicates, because they still carry it. Change one duplicate's value → RED too.
   */
  it.each(KNOWN_DUPLICATES)("%s agrees with the shared table on every key", (dup) => {
    const tables = providerTablesIn(readFileSync(join(SRC, dup), "utf8"));
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(Object.keys(table).sort()).toEqual([...PROVIDER_MARK_KEYS].sort());
    for (const [wire, mark] of Object.entries(table)) {
      expect(providerMarkFor(wire)).toBe(mark);
    }
  });

  it("the gatehouse's exported providerMark() answers identically for every key, and for an unknown one", () => {
    // The one duplicate whose reader is exported, so it can be compared as BEHAVIOUR rather than text.
    for (const wire of PROVIDER_MARK_KEYS) expect(providerMark(wire)).toBe(providerMarkFor(wire));
    expect(providerMark("bank_of_nowhere")).toBeNull();
  });
});

describe("providerMarkFor", () => {
  it("translates the served spelling AND the legacy alias to the one mark id", () => {
    // The wire serves `home_assistant`; the vault's mark id is `homeassistant`. A membership test that
    // assumes the two vocabularies are one string draws nothing at all — three surfaces did.
    expect(providerMarkFor("home_assistant")).toBe("homeassistant");
    expect(providerMarkFor("homeassistant")).toBe("homeassistant");
  });

  it("answers null for a provider the vault has no mark for — never a guessed mark", () => {
    expect(providerMarkFor("monzo")).toBeNull();
    expect(providerMarkFor("")).toBeNull();
  });

  it("covers every provider the connect catalog can create", () => {
    // The nine backend provider keys (`pages/connect/catalog.ts`). A source you can connect and then
    // cannot see a mark for is the visible half of the original bug.
    for (const wire of [
      "apple",
      "gmail",
      "simplefin",
      "home_assistant",
      "microsoft",
      "google",
      "whoop",
      "plaid",
      "apple_health",
    ]) {
      expect(providerMarkFor(wire)).not.toBeNull();
    }
  });
});
