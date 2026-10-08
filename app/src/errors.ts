// Contract error codes (contracts/refund_escrow/src/types.rs).
export const ERRORS = {
  NotAuthorised: 1,
  Paused: 2,
  UnknownMerchant: 3,
  MerchantInactive: 4,
  MerchantExists: 5,
  TokenNotEnabled: 6,
  InvalidAmount: 7,
  DuplicateOrder: 8,
  WindowOutOfRange: 9,
  OrderNotFound: 10,
  BadState: 11,
  WindowClosed: 12,
  WindowOpen: 13,
  DisputeUsed: 14,
  ArbiterExpired: 15,
  ArbiterWindowOpen: 16,
  NothingOwed: 17,
  FeeTooHigh: 18,
  BatchTooLarge: 19,
  BadReason: 20,
  Overflow: 21,
  BadConfig: 22,
  TransferFailed: 23,
} as const;

export type ErrorName = keyof typeof ERRORS;

export function errorName(code: number): ErrorName | `Unknown(${number})` {
  const hit = (Object.entries(ERRORS) as [ErrorName, number][]).find(([, c]) => c === code);
  return hit ? hit[0] : `Unknown(${code})`;
}

export class ContractError extends Error {
  readonly code: number;
  readonly errName: string;
  constructor(code: number) {
    super(`contract error ${code} (${errorName(code)})`);
    this.code = code;
    this.errName = errorName(code);
  }
}
