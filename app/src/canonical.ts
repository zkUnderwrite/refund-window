// Canonical JSON: object keys sorted at every level, no insignificant
// whitespace, bigints as decimal strings, undefined fields dropped. The same
// input always yields the same bytes, so a sha256 over it is a stable digest.
import { createHash } from "node:crypto";

/** Recursively standardizes an object by sorting its keys and formatting bigints. */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Converts a value to its canonical JSON representation. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Returns the SHA-256 hash of the canonical JSON string representation. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
