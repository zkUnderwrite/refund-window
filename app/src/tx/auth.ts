// Authorization entries for `pay`.
//
// `pay` calls `buyer.require_auth()` and, when refund_to differs from the
// buyer, `refund_to.require_auth()`. The buyer's authorisation also covers the
// token transfer buyer -> contract made inside `pay`. So a two-signer checkout
// carries two address-credential entries:
//   buyer:     pay(args)  └─ token.transfer(buyer, contract, amount)
//   refund_to: pay(args)
// On testnet these entries come back from simulation; building them locally
// lets the CLI and tests check exactly what each wallet is asked to sign, and
// lets the second wallet sign its entry (Wallets Kit `signAuthEntry`) without
// seeing the buyer's key.

import { Address, Keypair, authorizeEntry, xdr } from "@stellar/stellar-sdk";
import { addr, i128, payArgs, type PayParams } from "./args.ts";

function contractFn(contractId: string, fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizedFunction {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contractId).toScAddress(), functionName: fn, args }),
  );
}

function entry(signer: string, nonce: bigint, root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

export interface PayAuth {
  buyer: xdr.SorobanAuthorizationEntry;
  refundTo?: xdr.SorobanAuthorizationEntry;
}

/** Unsigned entries for `pay`; `refundTo` is present only when it differs from the buyer. */
export function payAuthEntries(contractId: string, p: PayParams, nonces: { buyer: bigint; refundTo?: bigint }): PayAuth {
  const args = payArgs(p);
  const transfer = new xdr.SorobanAuthorizedInvocation({
    function: contractFn(p.token, "transfer", [addr(p.buyer), addr(contractId), i128(p.amount)]),
    subInvocations: [],
  });
  const buyer = entry(
    p.buyer,
    nonces.buyer,
    new xdr.SorobanAuthorizedInvocation({ function: contractFn(contractId, "pay", args), subInvocations: [transfer] }),
  );
  if (!p.refundTo || p.refundTo === p.buyer) return { buyer };
  const refundTo = entry(
    p.refundTo,
    nonces.refundTo ?? nonces.buyer + 1n,
    new xdr.SorobanAuthorizedInvocation({ function: contractFn(contractId, "pay", args), subInvocations: [] }),
  );
  return { buyer, refundTo };
}

/** Signs one entry with a local key (CLI path; the web path uses the wallet). */
export function signEntry(
  e: xdr.SorobanAuthorizationEntry,
  kp: Keypair,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  // authorizeEntry signs with whatever key it is given; a mismatch would only
  // fail on-chain. Refuse it here so the wrong wallet never signs.
  const who = entrySigner(e);
  if (who !== kp.publicKey()) {
    return Promise.reject(new Error(`this entry must be signed by ${who}, not ${kp.publicKey()}`));
  }
  return authorizeEntry(e, kp, validUntilLedger, networkPassphrase);
}

/** The address an entry's credentials belong to (G… or C…). */
export function entrySigner(e: xdr.SorobanAuthorizationEntry): string {
  const c = e.credentials as unknown as { address?: xdr.SorobanAddressCredentials };
  if (!c.address) throw new Error("entry uses source-account credentials");
  return Address.fromScAddress(c.address.address).toString();
}

export interface InvocationView {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
  sub: InvocationView[];
}

export function describeInvocation(inv: xdr.SorobanAuthorizedInvocation): InvocationView {
  const f = inv.function as unknown as { contractFn?: xdr.InvokeContractArgs };
  if (!f.contractFn) throw new Error("not a contract-function invocation");
  return {
    contract: Address.fromScAddress(f.contractFn.contractAddress).toString(),
    fn: f.contractFn.functionName.toString(),
    args: f.contractFn.args,
    sub: inv.subInvocations.map(describeInvocation),
  };
}
