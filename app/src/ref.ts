// Merchant order-reference normalisation, shared by Node and the browser
// checkout (no Node imports here). "ord 1044", "ORD-1044" and "#ORD1044" all
// normalise to "ORD1044".
export function normaliseRef(ref: string): string {
  const n = ref.trim().toUpperCase().replace(/[\s#-]+/g, "");
  if (n.length === 0) throw new Error(`order reference "${ref}" is empty after normalisation`);
  return n;
}

/** The exact bytes hashed into an order id: `merchant_strkey:NORMALISED_REF`. */
export function orderIdPreimage(merchant: string, ref: string): string {
  return `${merchant}:${normaliseRef(ref)}`;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
