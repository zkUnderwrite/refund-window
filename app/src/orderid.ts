// order_id = sha256(merchant_strkey || ":" || normalise(merchant_order_ref)).
// Normalisation trims, uppercases and strips whitespace, "#" and "-", so
// "ord 1044", "ORD-1044" and "#ORD1044" map to the same id. The vectors in
// data/seed/orderid-vectors.json are checked by both the TypeScript and Rust tests.
import { createHash } from "node:crypto";
import { normaliseRef, orderIdPreimage } from "./ref.ts";

export { normaliseRef };

/** Generates the raw SHA-256 digest bytes for an order id. */
export function orderIdBytes(merchant: string, ref: string): Buffer {
  return createHash("sha256").update(orderIdPreimage(merchant, ref), "utf8").digest();
}

/** Generates the hex-encoded SHA-256 digest for an order id. */
export function orderIdHex(merchant: string, ref: string): string {
  return orderIdBytes(merchant, ref).toString("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
