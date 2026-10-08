# Data protection

## What goes on-chain (public, permanent)

| Data | Example |
|---|---|
| Addresses | buyer, `refund_to`, merchant, payout, arbiter, `fee_to`, token contract |
| Amounts | paid, held, refunded, released, fee |
| Times | paid, release, dispute, resolve-by, closed |
| Reason code | 1–5 or 99 |
| Three kinds of 32-byte hashes | `memo_hash` (order reference + line items), evidence manifest hashes, ruling hash |

Nothing personal is written on-chain: no names, emails, postal addresses, statements or files.

**The links are public, though.** Anyone can see that a buyer address paid a merchant address a given amount at a given time, and whether it was refunded or disputed. We recommend (Assumption) that buyers use a fresh address per merchant, and that the checkout says so.

## What stays off-chain

- **At the merchant:** order reference, line items (the preimage of `memo_hash`), return policy, shipping or access records.
- **At the buyer:** statements and evidence files.
- **At the PSP:** merchant configuration, dispute statements and evidence manifests submitted through the CLI (the local index), ruling files and notes, and the receipt cache (`~/.refundwin/receipts`).

The evidence hash commits to the files without revealing them. A party can later prove which files it submitted by handing them over for recomputation.

## The LLM is off by default

The dispute brief works fully without a model (the heuristic provider). The LLM provider sends dispute data to a third-party API (Anthropic Messages API), so it is enabled only when **both** `LLM_API_KEY` is set and `LLM_DISPUTES_ALLOWED=true` is in `.env`. That flag records the PSP's data-protection sign-off, for example a DPIA and a processor agreement. When it is enabled:

- statements are redacted first (`app/src/ai/redact.ts`): emails, phone numbers, street-address patterns (English, Spanish, Portuguese) and card-like numbers are replaced with `[EMAIL]`, `[PHONE]`, `[ADDRESS]` and `[CARD]`;
- only the redacted statements, the evidence manifest (names, kinds, hashes, extracted carrier fields) and the receipt are sent. Evidence files themselves are not;
- the model's output is schema-checked and cannot carry an outcome.

Redaction is pattern-based and will miss things, such as a name, or an address written in an unusual form. Do not enable the provider for markets whose rules forbid sending such data to the provider at all.

## Retention

- The chain is permanent.
- RPC keeps events for 7 days.
- The receipt cache and the local index are the PSP's records. Keep them for the period your recourse and accounting duties require, then delete statements and evidence while keeping the hashes and receipts.
- Testnet resets (next listed 2026-12-16, 01-§3) erase testnet state, but not your local receipts.
