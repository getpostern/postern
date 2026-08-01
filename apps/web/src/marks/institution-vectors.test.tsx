// Every ported institution vector is REAL, VALID geometry that lands on the plate's 24-unit box.
//
// This exists because of what porting 15 marks off the plate in one pass actually turned up (#107 §3):
// one plate node (`i-nubank` H34-0) serves path data that is NOT valid SVG — the second half of the
// ligature loses its command letters and the final cubic is one argument short. A browser draws such a
// path up to the error and then silently stops, so the failure mode is a HALF-DRAWN BRAND MARK on a
// user's Sources page, with nothing in the console and nothing in a snapshot diff to say so. The mark
// was parked instead of being hand-repaired, and this file is the judgement made mechanical so the
// next port cannot land the same thing by eye.
//
// Two properties, over the markup the component actually renders (not over an exported table — the
// point is to check what ships):
//
//   1. the path parses under the SVG 1.1 §8.3 grammar, arc flag-packing and all;
//   2. its control hull — every on- and off-curve point — sits inside the 24-unit viewBox, so no mark
//      is silently clipped, and a corrupted path whose coordinates fly off the box fails loudly.
//
// And the validator is itself validated, on the real corrupt string, because a parser that returns
// "fine" for everything is the exact shape of this repo's signature defect.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InstitutionMark } from "./InstitutionMark";
import { CRAFTED_INSTITUTION_KEYS } from "./institutions";

/**
 * Every institution whose mark is a ported vector, taken FROM THE RESOLVER, not from a list written
 * here. A hand-written list would have covered the sixteen marks in this change and nothing after it —
 * and the next port is exactly the one these two laws exist to catch. Normalised keys are what the
 * resolver stores and `normaliseInstitutionName` is idempotent, so they work as component input.
 */
const PORTED_LABELS = CRAFTED_INSTITUTION_KEYS;

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/;
const COMMAND = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUMBER_START = /[0-9.+-]/;

/** A cursor over path data. One scanner serves both the grammar check and the hull, so the two can
 *  never disagree about how a path is read. */
function scanner(d: string) {
  let i = 0;
  const n = d.length;
  return {
    get pos() {
      return i;
    },
    done: () => i >= n,
    ws() {
      while (i < n && /[\s,]/.test(d[i]!)) i++;
    },
    peek(): string | undefined {
      return d[i];
    },
    take(): string {
      return d[i++]!;
    },
    /** Reads a number, or returns null — which is how a truncated argument list is detected. */
    number(): number | null {
      this.ws();
      const m = NUMBER.exec(d.slice(i));
      if (!m || m.index !== 0) return null;
      i += m[0].length;
      return Number.parseFloat(m[0]);
    },
    /** An arc flag is a SINGLE character, which is what lets "0 015 5" be six characters and seven
     *  arguments. Reading it as a number is the classic way to mis-parse an arc. */
    flag(): "0" | "1" | null {
      this.ws();
      const c = d[i];
      if (c === "0" || c === "1") {
        i++;
        return c;
      }
      return null;
    },
    startsNumber(): boolean {
      const save = i;
      this.ws();
      const ok = i < n && NUMBER_START.test(d[i]!);
      i = save;
      return ok;
    },
  };
}

/** null when the path is valid; otherwise the reason, positioned. */
export function pathDataError(d: string): string | null {
  const s = scanner(d);
  s.ws();
  if (s.done()) return "empty path";
  const first = s.peek();
  if (first !== "M" && first !== "m") return `must start with M/m, got '${first}'`;

  let cmd: string | null = null;
  while (!s.done()) {
    s.ws();
    if (s.done()) break;
    const ch = s.peek()!;
    if (COMMAND.test(ch)) {
      cmd = s.take();
    } else if (cmd == null) {
      return `argument at ${s.pos} before any command`;
    } else if (!NUMBER_START.test(ch)) {
      return `unexpected '${ch}' at ${s.pos}`;
    } else if (cmd === "Z" || cmd === "z") {
      return `argument after closepath at ${s.pos}`;
    } else if (cmd === "M") {
      cmd = "L"; // a repeated moveto argument set is an implicit lineto
    } else if (cmd === "m") {
      cmd = "l";
    }

    const up = cmd.toUpperCase();
    if (ARG_COUNT[up] === 0) continue;
    if (up === "A") {
      for (const part of ["rx", "ry", "rotation"]) {
        if (s.number() == null) return `arc ${part} missing at ${s.pos}`;
      }
      if (s.flag() == null) return `arc large-arc-flag missing or not 0/1 at ${s.pos}`;
      if (s.flag() == null) return `arc sweep-flag missing or not 0/1 at ${s.pos}`;
      if (s.number() == null) return `arc x missing at ${s.pos}`;
      if (s.number() == null) return `arc y missing at ${s.pos}`;
    } else {
      const want = ARG_COUNT[up]!;
      for (let k = 0; k < want; k++) {
        if (s.number() == null) return `${cmd}: argument ${k + 1} of ${want} missing at ${s.pos}`;
      }
    }
  }
  return null;
}

/** The control hull of a path: every point the pen or a control handle touches, absolute-ised. The
 *  hull always contains the drawn curve, so a hull inside the box proves the drawing is inside it. */
export function controlHull(d: string): { minX: number; maxX: number; minY: number; maxY: number; points: number } {
  const s = scanner(d);
  const pts: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let cmd: string | null = null;

  while (!s.done()) {
    s.ws();
    if (s.done()) break;
    if (COMMAND.test(s.peek()!)) cmd = s.take();
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    if (cmd == null) break;

    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (up === "Z") {
      x = startX;
      y = startY;
      continue;
    }
    if (up === "A") {
      s.number();
      s.number();
      s.number();
      s.flag();
      s.flag();
      const ax = s.number()!;
      const ay = s.number()!;
      x = rel ? x + ax : ax;
      y = rel ? y + ay : ay;
      pts.push([x, y]);
    } else if (up === "H") {
      const hx = s.number()!;
      x = rel ? x + hx : hx;
      pts.push([x, y]);
    } else if (up === "V") {
      const vy = s.number()!;
      y = rel ? y + vy : vy;
      pts.push([x, y]);
    } else {
      const pairs = ARG_COUNT[up]! / 2;
      let nx = x;
      let ny = y;
      for (let k = 0; k < pairs; k++) {
        const px = s.number()!;
        const py = s.number()!;
        nx = rel ? x + px : px;
        ny = rel ? y + py : py;
        pts.push([nx, ny]);
      }
      x = nx;
      y = ny;
      if (up === "M") {
        startX = x;
        startY = y;
      }
    }
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    points: pts.length,
  };
}

/** The `d` the component actually put in the DOM. */
function renderedPath(label: string): string {
  const markup = renderToStaticMarkup(<InstitutionMark institution={label} />);
  const m = /\sd="([^"]+)"/.exec(markup);
  expect(m, `${label} rendered no path at all`).not.toBeNull();
  return m![1]!;
}

describe("the validator has teeth — checked against the real corrupt path first", () => {
  // VERBATIM from `i-nubank` H34-0 on the locked-assets plate, 2026-07-26. The plate's own drawing is
  // correct (the node renders the "nu" ligature); it is the serialisation that is broken, and this is
  // the string. Kept here as the parser's negative probe: if `pathDataError` ever returns null for it,
  // the guard below has stopped guarding and every future port goes in unchecked.
  const CORRUPT_NUBANK =
    "M7.279 5.434c-1.181 0-2.185.4628-2.943 1.252h-.002c-.0541-.0022-.1074-.002-.162-.002-1.544 0-2.993.8835-3.699 2.256-.3088.6-.4234 1.244-.459 1.9-.0321.589 0 1.186 0 1.77v5.652H3.184s.0022-2.784 0-5.178c-.0014-1.611-.0118-3.047 0-3.342.056-1.394.4372-2.305 1.148-3.051 2.358.0018 3.885 1.609 3.97 4.168.02.5874.025 3.73.0254 3.73v3.672h3.168v-4.965c0-1.501.0127-2.801-.0918-3.695-.292-2.5-1.821-4.168-4.125-4.168zm8.39.3008l-3.166.004v4.965c0 1.501-.0127 2.801.0919 3.695.2921 2.5 1.821 4.168 4.125 4.168 1.181 0 2.185-.4628 2.943-1.252-.3.002.0004.002 0 .542.002.1093.002.164.002 1.544 0 2.99-.8835 3.697-2.256.3088-.5997.423-1.244.459-1.9.032-.5889 0-1.186 0-1.77V5.738H20.816s-.0022 2.784 0 5.178c.0015 1.611.0119 3.047 0 3.342-.056 1.393-.4372 2.305-1.148 3.051-2.359-.0018-3.885-1.609-3.971-4.168-.0196-.5874-.0273-2.044-.0273-3.732Z";

  it("REJECTS the Nubank path the plate serves, naming the truncated cubic", () => {
    const err = pathDataError(CORRUPT_NUBANK);
    expect(err).not.toBeNull();
    expect(err).toContain("argument 6 of 6 missing");
  });

  it("rejects the other ways path data goes wrong", () => {
    expect(pathDataError("")).not.toBeNull();
    expect(pathDataError("   ")).not.toBeNull();
    // does not start with a moveto
    expect(pathDataError("L4 4")).not.toBeNull();
    // truncated final pair
    expect(pathDataError("M0 0L4")).not.toBeNull();
    // a stray letter that is not a command
    expect(pathDataError("M0 0 x4 4")).not.toBeNull();
    // an arc missing its second flag
    expect(pathDataError("M0 0a5 5 0 0 4 4")).not.toBeNull();
    // an arc flag that is not 0 or 1
    expect(pathDataError("M0 0a5 5 0 2 1 4 4")).not.toBeNull();
    // arguments hanging off a closepath
    expect(pathDataError("M0 0L4 4z 5 5")).not.toBeNull();
  });

  it("accepts the compact forms real optimised path data uses", () => {
    // packed arc flags, no separator: rx ry rot laf sf x y = 5 5 0 0 1 5 5
    expect(pathDataError("M0 0a5 5 0 015 5")).toBeNull();
    // implicit repeated linetos after a moveto, and implicit repeated cubics
    expect(pathDataError("M0 0 4 4 8 8z")).toBeNull();
    expect(pathDataError("M0 0c1 1 2 2 3 3 4 4 5 5 6 6")).toBeNull();
    // no separator between a number ending in a digit and one starting with a dot
    expect(pathDataError("M0 15.415c0 .468.38.85.848.85h5.937V.575Z")).toBeNull();
    // exponent form, and a bare trailing decimal point
    expect(pathDataError("M0 0L1e1 2.")).toBeNull();
  });

  it("the hull reader is not vacuous either", () => {
    // A square via absolute and relative commands must give the same hull, and it must be the square.
    expect(controlHull("M0 0H24V24H0Z")).toMatchObject({ minX: 0, maxX: 24, minY: 0, maxY: 24 });
    expect(controlHull("M0 0h24v24h-24z")).toMatchObject({ minX: 0, maxX: 24, minY: 0, maxY: 24 });
    // and a path that leaves the box is seen to leave it
    expect(controlHull("M0 0L900 900").maxX).toBe(900);
  });
});

describe("every ported institution vector", () => {
  it("the laws below are looking at a real set, not an empty one", () => {
    // The failure this catches: `CRAFTED_INSTITUTION_KEYS` becoming empty (or the export being
    // renamed to something falsy) would make every `it.each` below run zero times and the suite go
    // green having checked nothing.
    expect(PORTED_LABELS.length).toBe(16);
  });

  it.each(PORTED_LABELS)("%s draws a single valid path on the 24-unit box", (label) => {
    const d = renderedPath(label);
    expect(pathDataError(d), `${label}: ${pathDataError(d)}`).toBeNull();

    const hull = controlHull(d);
    // Half a unit of tolerance: two plate marks reach a hair past the edge on a control handle
    // (Barclays -0.01, Robinhood -0.19) and both draw inside the box.
    expect(hull.minX, `${label} x`).toBeGreaterThanOrEqual(-0.5);
    expect(hull.minY, `${label} y`).toBeGreaterThanOrEqual(-0.5);
    expect(hull.maxX, `${label} x`).toBeLessThanOrEqual(24.5);
    expect(hull.maxY, `${label} y`).toBeLessThanOrEqual(24.5);

    // Real geometry, not a placeholder: the plate's simplest mark (Deutsche Bank) is 15 points.
    expect(hull.points, `${label} is too simple to be a brand mark`).toBeGreaterThan(10);
    // and it actually fills the box in at least one axis — a mark shrunk into a corner is a mis-port.
    expect(Math.max(hull.maxX - hull.minX, hull.maxY - hull.minY)).toBeGreaterThan(12);
  });

  it("none of them is a horizontal logotype at Console scale", () => {
    // The ~32px wordmark rule's geometric root cause (build-notes §13.2). The plate's tier-2 rationale
    // names 4:1 and wider as unreadable at icon size, and every Console placement is 22–24px, so a
    // ported vector wider than 3:1 is a smudge waiting to ship. This is the check that caught Venmo
    // (5.3:1) and Coinbase (5.6:1) — both tier-1 marks the plate's five-name wordmark list misses.
    for (const label of PORTED_LABELS) {
      const hull = controlHull(renderedPath(label));
      const ratio = (hull.maxX - hull.minX) / (hull.maxY - hull.minY);
      expect(ratio, `${label} is ${ratio.toFixed(1)}:1 — a wordmark, not a mark`).toBeLessThan(3);
      expect(1 / ratio, `${label} is 1:${(1 / ratio).toFixed(1)} — too tall to read at 22px`).toBeLessThan(3);
    }
  });
});
