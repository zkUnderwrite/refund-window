# Arbiter guide

You are the PSP's arbiter. The contract gives you one power: to split the held amount of a **disputed** order between that order's two bound addresses, its `refund_to` (the buyer's refund address, fixed at checkout) and its `payout` (the merchant's payout, fixed at checkout), before the order's `resolve_by`.

## What you cannot do

- You cannot name a recipient. `resolve(order_id, refund_amount, ruling_hash)` has no address parameter.
- You cannot touch an order that is not disputed, or any other order.
- You cannot act after `resolve_by`. After that anyone can trigger a full refund (`timeout_refund`).
- You cannot rule twice. A ruling is **final on-chain**: the recourse for a wrong ruling is off-chain, between the parties and the PSP.
- If the PSP changes its arbiter, orders paid earlier keep the arbiter recorded at checkout, and only that key can rule on them.
- Your key is still sensitive. A stolen key can misallocate disputed orders between their two parties, but it cannot take funds (tested: `a_compromised_arbiter_sweeping_every_order_takes_nothing`).

## Timeline

1. The buyer opens a dispute before `T`, with a reason code and the hash of an evidence manifest. Release is frozen. `resolve_by = dispute time + arbiter_timeout` (7 days by default).
2. The merchant may respond with its own evidence manifest (it can replace it), refund part or all of the order, or do nothing. The buyer may withdraw the dispute; no second dispute is possible.
3. You rule before `resolve_by`:

   ```bash
   refundwin resolve --arbiter <alias> --ref <order ref> --refund 25.60 --ruling ruling.md
   ```

   - The refund share goes to `refund_to`.
   - The PSP fee is taken **only from the merchant share**; the rest goes to `payout`.
   - The sha256 of `ruling.md` is recorded on-chain as the ruling hash. Keep the file: it is the only place your reasons live.
4. **If you do not rule in time, the buyer is refunded in full.** A silent arbiter defaults to a refund. Staff the queue accordingly.

## What you see

```bash
refundwin brief --ref <order ref> --out brief.md   # or --provider llm, if enabled
```

The brief contains:

- a neutral summary;
- a timeline, built from on-chain events (`[chain]`) and each side's evidence (`[buyer]`, `[merchant]`);
- the claims of each side;
- an evidence checklist for the reason code, showing who provided what and what is missing;
- rule-based inconsistency flags, for example carrier "delivered" dated before the payment, "in transit" with no delivery, or evidence submitted after `resolve_by`;
- suggested questions for each side.

**The brief never recommends an outcome, a split or an amount.** Its schema rejects any such field. The raw statements (redacted) and the evidence manifest (file names, kinds and sha256) are always printed beside it; read them.

If the PSP enabled the LLM provider, the summary may be rewritten by a model. Three safeguards apply:

- the model can add checklist items but never remove one;
- a numbers guard replaces the summary if it contains any amount or date not found in the receipt or the evidence;
- statements were redacted before the model saw them.

Treat the brief as preparation, not as evidence.

## Checklists by reason

| Reason | What the checklist looks for |
|---|---|
| NOT_RECEIVED | tracking number; carrier status showing delivery; delivery address matching the order; delivery date before the dispute |
| NOT_AS_DESCRIBED | listing snapshot at the payment date; buyer photos; return policy; merchant's reply |
| DIGITAL_NOT_DELIVERED | access log showing a download or login after payment; the buyer's screenshot of the error |
| DUPLICATE_CHARGE | both order ids, same buyer and amount within 24 h; check them against the chain |
| CANCELLED_BEFORE_FULFILMENT | cancellation message time against the shipping time |
| OTHER | a statement from each side |

## Evidence integrity

Each side's on-chain evidence hash is the sha256 of the sorted manifest lines `<sha256 of file>  <file name>`. Anyone holding the files can recompute it. Ask the parties for the files and check them against the hash before relying on them.

## Neutrality

The PSP earns its fee from the merchant and also arbitrates. Disclose this to buyers and merchants, record every ruling file, and consider a second reviewer for large orders. This conflict is a documented risk (risk 5), and no technical control removes it.
