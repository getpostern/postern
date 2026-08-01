// Redaction for audit `args`. Defense-in-depth: a key denylist + a size cap. Secrets do not flow
// through tool args (those are validated query/action params), but we strip anything that *looks*
// like a credential anyway, and bound the serialized payload so a pathological arg can't bloat the
// audit_log. Pure + synchronous — runs on the calling (hot) path inside audit().

/** Keys whose value is replaced with '[redacted]' (case-insensitive substring match). */
const SENSITIVE_KEY = /pass|secret|token|key|authorization|cookie/i;

/** Replacement marker for a denylisted value. */
const REDACTED = "[redacted]";

/** Replacement marker when the serialized payload exceeds the cap. */
const TRUNCATED = "[truncated]";

/** Approximate byte cap on the serialized `args` payload (~4 KB). */
const MAX_SERIALIZED_BYTES = 4096;

/**
 * Recursively copy `args`, replacing any value whose KEY matches the denylist with '[redacted]'.
 * Returns a structurally-cloned, redacted value (never mutates the input). Arrays/objects recurse;
 * scalars pass through unchanged. Guards against cycles (a cyclic ref becomes '[truncated]').
 */
function redactKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value as object)) return TRUNCATED; // cycle guard
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactKeys(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactKeys(v, seen);
  }
  return out;
}

/**
 * Redact `args` for the audit log: denylisted keys -> '[redacted]', and the whole payload size-capped
 * (anything serializing beyond ~4 KB collapses to '[truncated]'). Ordinary args pass through unchanged.
 * Never throws — non-serializable input (e.g. a BigInt or cycle) degrades to '[truncated]'.
 */
export function redactArgs(args: unknown): unknown {
  if (args === undefined) return undefined;

  let redacted: unknown;
  try {
    redacted = redactKeys(args, new WeakSet());
  } catch {
    return TRUNCATED;
  }

  // Size cap: measure the serialized form; if it (or serialization itself) blows the budget, truncate.
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized === undefined) return redacted; // e.g. a bare function/symbol — leave as-is
    if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
      return TRUNCATED;
    }
    return redacted;
  } catch {
    // Non-serializable (BigInt, etc.): we can't bound it, so drop it to the truncation marker.
    return TRUNCATED;
  }
}
