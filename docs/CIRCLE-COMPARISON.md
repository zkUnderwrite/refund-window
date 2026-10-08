# Comparison with Circle's Refund Protocol

**Scope and limits.** This comparison uses only what research dossier 11 (§R3) recorded from the Refund Protocol's public README and Circle's announcement blog post. **The team has not reviewed its code.** Where a point below depends on how Circle's contract actually works, it is labelled as unknown.

## What the sources say about the Refund Protocol

- It is described as the "closest thing to a shipped non-custodial dispute resolution standard" for stablecoin payments.
- It is EVM-only, with 29 stars and 5 commits at the time of research, unaudited and "provided as is".
- It discloses a known issue that "allows an arbiter to drain other users' payments", with "a fix in development".

## Design comparison

| Topic | Refund Protocol (public description) | Refund Window |
|---|---|---|
| Chain | EVM (Arbitrum can cover gas through Circle's paymaster) | Stellar / Soroban; express mode on classic claimable balances |
| Custody | Non-custodial escrow contract | Non-custodial escrow contract, one per PSP; express mode has no contract |
| Refund destination | Not established from the sources | `refund_to` is fixed at `pay` and must have signed `pay`. `refund`, `resolve` and `timeout_refund` have no recipient parameter |
| Arbiter power | Known issue: the arbiter can drain other users' payments | The order's snapshot arbiter can act only on that order, only while it is disputed, only before `resolve_by`, and only by splitting between that order's `refund_to` and `payout`. Tested with a compromised arbiter sweeping every order |
| Arbiter silence | Not established from the sources | Full refund to `refund_to` at `resolve_by`; anyone can trigger it |
| Release to merchant | Not established from the sources | Anyone, from `T`; batched by a keeper; no approval |
| Admin power | Not established from the sources | Fees only (`withdraw_fees`); no sweep, no upgrade; pause blocks new payments only |
| Audit | Unaudited | Unaudited |

## The drain lesson and how it is applied here

The disclosed issue shows what goes wrong when an arbiter's authority is not tied to one order's funds and parties. Refund Window builds the bound into the interface and the tests:

1. **No free recipient.** No function that moves order funds takes a recipient address. The destinations are the order's own `refund_to`, `payout` and the PSP's `fee_to` (fees only).
2. **Per-order state.** `resolve` reads `held` from the one disputed order and cannot exceed it (`arbiter_moves_at_most_the_disputed_orders_held_amount`, `arbiter_cannot_touch_other_orders`, `arbiter_can_never_rule_twice`).
3. **Snapshot authority.** The arbiter is recorded per order at `pay`; changing the config does not grant a new key power over old orders.
4. **Property test.** Across 300 random sequences, with `set_arbiter` and `set_payout` mixed in, the balances of the admin, the arbiter and attacker addresses never increase, and the per-token balance invariant holds after every step.

None of this says anything about the quality of Circle's fix, which was "in development" when researched. An EVM contribution in the spirit of this design would be an upstream fix or a port, not a competing product (specification, "Why not Arbitrum").
