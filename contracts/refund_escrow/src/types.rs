//! Types, constants, storage keys and errors for `refund_escrow`.

use soroban_sdk::{contracterror, contracttype, Address, BytesN};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Largest PSP fee a merchant can be onboarded with (10%).
pub const MAX_FEE_BPS: u32 = 1_000;
/// Basis-point denominator.
pub const BPS: i128 = 10_000;
/// Largest number of order ids accepted by `release_many` (verify-first item (d)).
pub const MAX_BATCH: u32 = 25;
/// Largest single order: 10^15 stroops = 10^8 units at 7 decimals. Keeps
/// `amount * fee_bps` far away from i128 overflow.
pub const MAX_AMOUNT: i128 = 1_000_000_000_000_000;
/// Upper bound on the arbiter timeout (30 days).
pub const MAX_ARBITER_TIMEOUT: u64 = 30 * DAY;

pub const DAY: u64 = 86_400;
/// Extra lifetime kept on every order entry beyond its last deadline.
pub const TTL_MARGIN_SECS: u64 = 14 * DAY;
/// Ledger close time used to convert seconds into ledgers.
pub const SECS_PER_LEDGER: u64 = 5;

// Reason codes accepted by `dispute`. The contract only checks membership.
pub const REASON_NOT_RECEIVED: u32 = 1;
pub const REASON_NOT_AS_DESCRIBED: u32 = 2;
pub const REASON_DUPLICATE_CHARGE: u32 = 3;
pub const REASON_CANCELLED_BEFORE_FULFILMENT: u32 = 4;
pub const REASON_DIGITAL_NOT_DELIVERED: u32 = 5;
pub const REASON_OTHER: u32 = 99;

pub fn reason_is_valid(reason: u32) -> bool {
    matches!(
        reason,
        REASON_NOT_RECEIVED
            | REASON_NOT_AS_DESCRIBED
            | REASON_DUPLICATE_CHARGE
            | REASON_CANCELLED_BEFORE_FULFILMENT
            | REASON_DIGITAL_NOT_DELIVERED
            | REASON_OTHER
    )
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Reserved for explicit role mismatches. Signature failures are host
    /// auth errors and never reach this code.
    NotAuthorised = 1,
    /// `pay` and `add_merchant` are blocked while paused.
    Paused = 2,
    UnknownMerchant = 3,
    MerchantInactive = 4,
    MerchantExists = 5,
    TokenNotEnabled = 6,
    /// Amount must satisfy 0 < amount <= MAX_AMOUNT (or <= held for refunds).
    InvalidAmount = 7,
    /// This order id has already been paid.
    DuplicateOrder = 8,
    /// Window outside [min_window, max_window].
    WindowOutOfRange = 9,
    OrderNotFound = 10,
    /// The action is not allowed in the order's current state.
    BadState = 11,
    /// The refund window has closed (now >= release_at); no new dispute.
    WindowClosed = 12,
    /// The refund window is still open (now < release_at); no release yet.
    WindowOpen = 13,
    /// The order already had its one dispute.
    DisputeUsed = 14,
    /// The arbiter's time to rule has passed (now >= resolve_by).
    ArbiterExpired = 15,
    /// The arbiter can still rule (now < resolve_by); no timeout refund yet.
    ArbiterWindowOpen = 16,
    /// `settle_refund` called with nothing owed.
    NothingOwed = 17,
    FeeTooHigh = 18,
    BatchTooLarge = 19,
    BadReason = 20,
    Overflow = 21,
    /// Constructor or window parameters are inconsistent.
    BadConfig = 22,
    /// A token transfer failed (insufficient balance at `pay`, or a payout,
    /// refund_to or fee_to that cannot receive). Added beyond the spec's list
    /// so token error codes are never confused with this contract's codes.
    TransferFailed = 23,
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderState {
    /// Paid and held until `release_at`.
    Held,
    /// Buyer opened the order's one dispute; release is frozen.
    Disputed,
    /// Terminal: the whole amount was refunded by the merchant.
    Refunded,
    /// Terminal: the held remainder went to the merchant after `release_at`.
    Released,
    /// Terminal: the arbiter split the held amount.
    Resolved,
    /// Terminal: the arbiter did not rule by `resolve_by`; held amount refunded.
    TimedOut,
}

impl OrderState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            OrderState::Refunded | OrderState::Released | OrderState::Resolved | OrderState::TimedOut
        )
    }
}

/// PSP-wide configuration (instance storage). Every order snapshots the
/// fields it depends on, so later changes affect future orders only.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub arbiter: Address,
    pub fee_to: Address,
    pub arbiter_timeout: u64,
    pub min_window: u64,
    pub max_window: u64,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantCfg {
    pub payout: Address,
    pub fee_bps: u32,
    pub default_window: u64,
    pub active: bool,
}

/// One paid checkout. Amounts are in the token's base units (stroops for
/// 7-decimal assets). Invariant: `amount == held + refunded + released + fee`
/// and `0 <= refund_owed <= refunded`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    // parties and asset
    pub merchant: Address,
    pub payout: Address,
    pub buyer: Address,
    /// The only address refunds can ever reach. It signed `pay`.
    pub refund_to: Address,
    pub token: Address,
    // amounts
    pub amount: i128,
    pub held: i128,
    /// Everything credited to the buyer, including `refund_owed`.
    pub refunded: i128,
    /// Credited to the buyer but not yet transferred (e.g. missing trustline).
    pub refund_owed: i128,
    /// Net paid to the merchant's payout.
    pub released: i128,
    /// PSP fee taken on the merchant share.
    pub fee: i128,
    // terms fixed at payment
    pub fee_bps: u32,
    pub arbiter: Address,
    pub arbiter_timeout: u64,
    // timeline (0 = unset)
    pub paid_at: u64,
    pub release_at: u64,
    pub disputed_at: u64,
    pub resolve_by: u64,
    pub closed_at: u64,
    // dispute record
    pub dispute_used: bool,
    pub reason: u32,
    pub buyer_evidence: Option<BytesN<32>>,
    pub merchant_evidence: Option<BytesN<32>>,
    pub ruling: Option<BytesN<32>>,
    /// sha256 of the merchant's order reference and line items (kept off-chain).
    pub memo_hash: BytesN<32>,
    pub state: OrderState,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Config (instance storage).
    Config,
    /// bool: token allowlist.
    Token(Address),
    /// MerchantCfg.
    Merchant(Address),
    /// Order.
    Order(BytesN<32>),
    /// i128: accrued, not yet withdrawn PSP fees per token.
    Fees(Address),
}
