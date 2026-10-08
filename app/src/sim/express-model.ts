// Offline model of express mode: one classic claimable balance per order with
// two claimants, buyer before(T) and merchant not(before(T)). The semantics
// modelled here (buyer may claim iff close_time < T, merchant iff close_time >= T)
// are the documented protocol rules; verify-first item (b) re-checks them on
// testnet, including the exact behaviour at T.

export interface ExpressBalance {
  id: string;
  order_n: number;
  buyer: string;
  merchant: string;
  asset: string;
  amount: bigint;
  releaseAt: number;
  createdAt: number;
  claimedBy: "buyer" | "merchant" | null;
  claimedAt: number;
}

export const CANNOT_CLAIM = "CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM";
export const DOES_NOT_EXIST = "CLAIM_CLAIMABLE_BALANCE_DOES_NOT_EXIST";

export class ExpressModel {
  balances = new Map<string, ExpressBalance>();

  create(b: Omit<ExpressBalance, "claimedBy" | "claimedAt">): void {
    if (this.balances.has(b.id)) throw new Error(`balance ${b.id} exists`);
    this.balances.set(b.id, { ...b, claimedBy: null, claimedAt: 0 });
  }

  /** Returns "ok" or the classic result code. */
  claim(id: string, claimant: string, now: number): "ok" | typeof CANNOT_CLAIM | typeof DOES_NOT_EXIST {
    const b = this.balances.get(id);
    if (!b || b.claimedBy) return DOES_NOT_EXIST;
    if (claimant === b.buyer && now < b.releaseAt) {
      b.claimedBy = "buyer";
      b.claimedAt = now;
      return "ok";
    }
    if (claimant === b.merchant && now >= b.releaseAt) {
      b.claimedBy = "merchant";
      b.claimedAt = now;
      return "ok";
    }
    return CANNOT_CLAIM;
  }
}
