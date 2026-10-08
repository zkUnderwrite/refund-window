// Dispute reason codes; the contract only checks membership in this set.
export const REASONS = {
  NOT_RECEIVED: 1,
  NOT_AS_DESCRIBED: 2,
  DUPLICATE_CHARGE: 3,
  CANCELLED_BEFORE_FULFILMENT: 4,
  DIGITAL_NOT_DELIVERED: 5,
  OTHER: 99,
} as const;

export type ReasonName = keyof typeof REASONS;

export function reasonCode(name: string): number {
  const key = name.trim().toUpperCase().replace(/[\s-]+/g, "_") as ReasonName;
  const code = REASONS[key];
  if (code === undefined) {
    throw new Error(`unknown reason "${name}" (use one of ${Object.keys(REASONS).join(", ")})`);
  }
  return code;
}

export function reasonName(code: number): ReasonName {
  const hit = (Object.entries(REASONS) as [ReasonName, number][]).find(([, c]) => c === code);
  if (!hit) throw new Error(`unknown reason code ${code}`);
  return hit[0];
}
