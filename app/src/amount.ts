// Amounts are carried as bigint stroops (7 decimals, the precision of every
// Stellar classic asset and of the SAC). Strings are parsed strictly: no
// exponents, no signs, no thousands separators, at most 7 decimals.

export const DECIMALS = 7;
export const ONE = 10_000_000n;
/** Largest single order accepted by the contract: 10^15 stroops. */
export const MAX_AMOUNT = 1_000_000_000_000_000n;

export function parseAmount(input: string): bigint {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid amount "${input}": use digits with an optional decimal point`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > DECIMALS) {
    throw new Error(`invalid amount "${input}": at most ${DECIMALS} decimals`);
  }
  return BigInt(whole) * ONE + BigInt(frac.padEnd(DECIMALS, "0") || "0");
}

/** Always 7 decimals, e.g. 49.9900000. */
export function formatAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  const v = neg ? -stroops : stroops;
  const whole = v / ONE;
  const frac = (v % ONE).toString().padStart(DECIMALS, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Human form: trailing zeros trimmed but at least 2 decimals, e.g. 49.99, 0.000005. */
export function displayAmount(stroops: bigint): string {
  const full = formatAmount(stroops);
  const [w, f] = full.split(".") as [string, string];
  let t = f.replace(/0+$/, "");
  if (t.length < 2) t = t.padEnd(2, "0");
  return `${w}.${t}`;
}
