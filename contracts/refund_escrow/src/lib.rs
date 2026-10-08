//! Refund Window: refund windows and dispute escrow for stablecoin checkouts.
//!
//! One instance per PSP. At checkout the buyer signs `pay`; the funds move into
//! this contract and the order records, fixed for its lifetime:
//! the merchant's payout address, the PSP fee, the arbiter, the arbiter
//! timeout, the release time `T = paid_at + window`, and `refund_to` — the
//! buyer or a second address that also signed `pay`.
//!
//! * Before `T` the merchant can refund any part of the held amount. There is
//!   no recipient argument: refunds can only reach `refund_to`.
//! * Before `T` the buyer can open one dispute. The order's arbiter (the
//!   snapshot, not the current config) can split the held amount between
//!   `refund_to` and `payout` until `resolve_by`; after that anyone can trigger
//!   a full refund.
//! * From `T` anyone can release an undisputed order to the payout, less fee.
//!
//! Deadline semantics: "before X" means `now < X`, "from X" means `now >= X`.
//!
//! Deliberately absent: upgrade, admin sweep, any function that takes a free
//! recipient for order funds, and any way to change `refund_to` after `pay`.
#![no_std]

mod types;

pub use types::*;

use soroban_sdk::{
    contract, contractevent, contractimpl, symbol_short, token, Address,
    BytesN, Env, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Events. First topic: the event name. Second topic: order id, merchant or
// token. The data carries the amounts, so a receipt builder can rebuild the
// timeline from events alone.
// ---------------------------------------------------------------------------

#[contractevent(topics = ["pay"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub buyer: Address,
    pub merchant: Address,
    pub refund_to: Address,
    pub token: Address,
    pub amount: i128,
    pub release_at: u64,
}

#[contractevent(topics = ["refund"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub amount: i128,
    pub refunded: i128,
}

#[contractevent(topics = ["refund_pending"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundPendingEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub refund_owed: i128,
}

#[contractevent(topics = ["refund_settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundSettledEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub amount: i128,
}

#[contractevent(topics = ["dispute"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub reason: u32,
    pub resolve_by: u64,
}

#[contractevent(topics = ["respond"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RespondEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub evidence_hash: BytesN<32>,
}

#[contractevent(topics = ["dispute_withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeWithdrawnEvent {
    #[topic]
    pub order_id: BytesN<32>,
}

#[contractevent(topics = ["resolve"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolveEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub refund_amount: i128,
    pub merchant_net: i128,
    pub fee: i128,
}

#[contractevent(topics = ["timeout"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeoutEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub refund_amount: i128,
}

#[contractevent(topics = ["release"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseEvent {
    #[topic]
    pub order_id: BytesN<32>,
    pub merchant_net: i128,
    pub fee: i128,
}

#[contractevent(topics = ["fees_withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesWithdrawnEvent {
    #[topic]
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["merchant_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantAddedEvent {
    #[topic]
    pub merchant: Address,
    pub payout: Address,
    pub fee_bps: u32,
    pub default_window: u64,
}

/// `key` is one of: token, merchant_active, payout, arbiter, fee_to, paused.
#[contractevent(topics = ["config_changed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigChangedEvent {
    #[topic]
    pub key: Symbol,
    pub subject: Address,
    pub value: Option<Address>,
    pub flag: bool,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const DAY_LEDGERS: u32 = 17_280;
/// Lifetime kept on config-like entries (tokens, merchants, fees, instance).
const LONG_TTL: u32 = 120 * DAY_LEDGERS;

fn clamp_ttl(env: &Env, want: u32) -> u32 {
    let max = env.storage().max_ttl();
    if want > max {
        max
    } else {
        want
    }
}

fn bump_instance(env: &Env) {
    let ttl = clamp_ttl(env, LONG_TTL);
    env.storage().instance().extend_ttl(ttl, ttl);
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn put_config(env: &Env, cfg: &Config) {
    env.storage().instance().set(&DataKey::Config, cfg);
    bump_instance(env);
}

fn put_long<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, v: &V) {
    env.storage().persistent().set(key, v);
    let ttl = clamp_ttl(env, LONG_TTL);
    env.storage().persistent().extend_ttl(key, ttl, ttl);
}

fn load_order(env: &Env, id: &BytesN<32>) -> Result<Order, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Order(id.clone()))
        .ok_or(Error::OrderNotFound)
}

/// Writes the order and extends its TTL to cover
/// `release_at + arbiter_timeout - now` plus a 14-day margin, at 5 s per
/// ledger, capped at the network's max entry TTL.
fn save_order(env: &Env, id: &BytesN<32>, o: &Order) {
    let key = DataKey::Order(id.clone());
    env.storage().persistent().set(&key, o);
    let now = env.ledger().timestamp();
    let last = o.release_at.saturating_add(o.arbiter_timeout).max(now);
    let secs = last - now + TTL_MARGIN_SECS;
    let want = (secs / SECS_PER_LEDGER + 1).min(u32::MAX as u64) as u32;
    let ttl = clamp_ttl(env, want);
    env.storage().persistent().extend_ttl(&key, ttl, ttl);
}

fn fees_of(env: &Env, token: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Fees(token.clone()))
        .unwrap_or(0)
}

fn add_fees(env: &Env, token: &Address, fee: i128) -> Result<(), Error> {
    if fee == 0 {
        return Ok(());
    }
    let total = fees_of(env, token).checked_add(fee).ok_or(Error::Overflow)?;
    put_long(env, &DataKey::Fees(token.clone()), &total);
    Ok(())
}

/// Floor of `amount * fee_bps / 10_000`, checked.
pub fn fee_for(amount: i128, fee_bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(fee_bps as i128)
        .map(|x| x / BPS)
        .ok_or(Error::Overflow)
}

/// Token transfer that reports a failure as `TransferFailed` instead of
/// letting the token's own error code surface (SAC error codes overlap ours).
fn send(env: &Env, tok: &Address, from: &Address, to: &Address, amount: &i128) -> Result<(), Error> {
    match token::TokenClient::new(env, tok).try_transfer(from, to, amount) {
        Ok(Ok(())) => Ok(()),
        _ => Err(Error::TransferFailed),
    }
}

/// Tries to transfer everything owed to `refund_to`. On failure (for example
/// the buyer removed or lost authorisation on their trustline) the amount stays
/// in `refund_owed` and `refund_pending` is emitted; `settle_refund` retries.
/// Returns the amount actually transferred.
fn push_owed(env: &Env, id: &BytesN<32>, o: &mut Order) -> i128 {
    let owed = o.refund_owed;
    if owed == 0 {
        return 0;
    }
    let tc = token::TokenClient::new(env, &o.token);
    let ok = matches!(
        tc.try_transfer(&env.current_contract_address(), &o.refund_to, &owed),
        Ok(Ok(()))
    );
    if ok {
        o.refund_owed = 0;
        owed
    } else {
        RefundPendingEvent {
            order_id: id.clone(),
            refund_owed: owed,
        }
        .publish(env);
        0
    }
}

/// Whether `release` would succeed right now, without touching anything.
fn releasable(o: &Order, now: u64) -> bool {
    o.state == OrderState::Held && now >= o.release_at && o.held > 0
}

/// Books a release of the whole held amount (fee to `Fees`, net to payout).
/// The caller performs the payout transfer. Returns (net, fee).
fn book_release(env: &Env, o: &mut Order, now: u64) -> Result<(i128, i128), Error> {
    let fee = fee_for(o.held, o.fee_bps)?;
    let net = o.held - fee;
    o.released = o.released.checked_add(net).ok_or(Error::Overflow)?;
    o.fee = o.fee.checked_add(fee).ok_or(Error::Overflow)?;
    o.held = 0;
    o.state = OrderState::Released;
    o.closed_at = now;
    add_fees(env, &o.token, fee)?;
    Ok((net, fee))
}

fn changed(env: &Env, key: Symbol, subject: Address, value: Option<Address>, flag: bool) {
    ConfigChangedEvent {
        key,
        subject,
        value,
        flag,
    }
    .publish(env);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct RefundEscrow;

#[contractimpl]
impl RefundEscrow {
    /// Requires `0 < min_window <= max_window` and `0 < arbiter_timeout <= 30 days`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        arbiter: Address,
        fee_to: Address,
        arbiter_timeout: u64,
        min_window: u64,
        max_window: u64,
    ) -> Result<(), Error> {
        if min_window == 0
            || min_window > max_window
            || arbiter_timeout == 0
            || arbiter_timeout > MAX_ARBITER_TIMEOUT
        {
            return Err(Error::BadConfig);
        }
        put_config(
            &env,
            &Config {
                admin,
                arbiter,
                fee_to,
                arbiter_timeout,
                min_window,
                max_window,
                paused: false,
            },
        );
        Ok(())
    }

    // -- admin -------------------------------------------------------------

    /// Enable or disable a SEP-41 token (the SAC of USDC, EURC, PYUSD...).
    /// Disabling affects new `pay` calls only.
    pub fn set_token(env: Env, token: Address, enabled: bool) {
        let cfg = config(&env);
        cfg.admin.require_auth();
        put_long(&env, &DataKey::Token(token.clone()), &enabled);
        changed(&env, symbol_short!("token"), token, None, enabled);
    }

    /// Onboard a merchant. Both the PSP admin and the merchant sign, so the
    /// merchant consents to the fee and the PSP's arbiter.
    pub fn add_merchant(
        env: Env,
        merchant: Address,
        payout: Address,
        fee_bps: u32,
        default_window: u64,
    ) -> Result<(), Error> {
        let cfg = config(&env);
        cfg.admin.require_auth();
        merchant.require_auth();
        if cfg.paused {
            return Err(Error::Paused);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        if default_window < cfg.min_window || default_window > cfg.max_window {
            return Err(Error::WindowOutOfRange);
        }
        let key = DataKey::Merchant(merchant.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::MerchantExists);
        }
        put_long(
            &env,
            &key,
            &MerchantCfg {
                payout: payout.clone(),
                fee_bps,
                default_window,
                active: true,
            },
        );
        MerchantAddedEvent {
            merchant,
            payout,
            fee_bps,
            default_window,
        }
        .publish(&env);
        Ok(())
    }

    /// Activate or deactivate a merchant. Affects only new `pay` calls.
    pub fn set_merchant_active(env: Env, merchant: Address, active: bool) -> Result<(), Error> {
        config(&env).admin.require_auth();
        let key = DataKey::Merchant(merchant.clone());
        let mut m: MerchantCfg = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::UnknownMerchant)?;
        m.active = active;
        put_long(&env, &key, &m);
        changed(&env, Symbol::new(&env, "merchant_active"), merchant, None, active);
        Ok(())
    }

    /// Change a merchant's payout for future orders. Held orders keep theirs.
    pub fn set_payout(env: Env, merchant: Address, payout: Address) -> Result<(), Error> {
        let cfg = config(&env);
        merchant.require_auth();
        cfg.admin.require_auth();
        let key = DataKey::Merchant(merchant.clone());
        let mut m: MerchantCfg = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::UnknownMerchant)?;
        m.payout = payout.clone();
        put_long(&env, &key, &m);
        changed(&env, symbol_short!("payout"), merchant, Some(payout), true);
        Ok(())
    }

    /// New arbiter for future orders. Existing orders keep their snapshot.
    pub fn set_arbiter(env: Env, arbiter: Address) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        cfg.arbiter = arbiter.clone();
        put_config(&env, &cfg);
        changed(&env, symbol_short!("arbiter"), arbiter, None, true);
    }

    pub fn set_fee_to(env: Env, fee_to: Address) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        cfg.fee_to = fee_to.clone();
        put_config(&env, &cfg);
        changed(&env, symbol_short!("fee_to"), fee_to, None, true);
    }

    /// Pausing blocks only `pay` and `add_merchant`. Refunds, disputes,
    /// rulings, releases and timeouts keep working, so a pause cannot trap funds.
    pub fn set_paused(env: Env, paused: bool) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        cfg.paused = paused;
        let admin = cfg.admin.clone();
        put_config(&env, &cfg);
        changed(&env, symbol_short!("paused"), admin, None, paused);
    }

    /// Sends accrued PSP fees for `token` to `fee_to`. This is the admin's only
    /// outflow: held and owed order funds are unreachable from here.
    pub fn withdraw_fees(env: Env, token: Address) -> Result<i128, Error> {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let amount = fees_of(&env, &token);
        if amount == 0 {
            return Ok(0);
        }
        put_long(&env, &DataKey::Fees(token.clone()), &0i128);
        send(&env, &token, &env.current_contract_address(), &cfg.fee_to, &amount)?;
        FeesWithdrawnEvent {
            token,
            to: cfg.fee_to,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // -- checkout ----------------------------------------------------------

    /// Pay an order into escrow. `refund_to` defaults to the buyer; any other
    /// refund address must also sign this call.
    #[allow(clippy::too_many_arguments)]
    pub fn pay(
        env: Env,
        buyer: Address,
        merchant: Address,
        order_id: BytesN<32>,
        token: Address,
        amount: i128,
        refund_to: Option<Address>,
        window: Option<u64>,
        memo_hash: BytesN<32>,
    ) -> Result<(), Error> {
        buyer.require_auth();
        let cfg = config(&env);
        if cfg.paused {
            return Err(Error::Paused);
        }
        let m: MerchantCfg = env
            .storage()
            .persistent()
            .get(&DataKey::Merchant(merchant.clone()))
            .ok_or(Error::UnknownMerchant)?;
        if !m.active {
            return Err(Error::MerchantInactive);
        }
        let enabled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Token(token.clone()))
            .unwrap_or(false);
        if !enabled {
            return Err(Error::TokenNotEnabled);
        }
        if amount <= 0 || amount > MAX_AMOUNT {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Order(order_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateOrder);
        }
        let window = window.unwrap_or(m.default_window);
        if window < cfg.min_window || window > cfg.max_window {
            return Err(Error::WindowOutOfRange);
        }
        let refund_to = match refund_to {
            Some(r) => {
                if r != buyer {
                    // The refund address must prove control at checkout.
                    r.require_auth();
                }
                r
            }
            None => buyer.clone(),
        };

        send(&env, &token, &buyer, &env.current_contract_address(), &amount)?;

        let now = env.ledger().timestamp();
        let release_at = now.checked_add(window).ok_or(Error::Overflow)?;
        let order = Order {
            merchant: merchant.clone(),
            payout: m.payout,
            buyer: buyer.clone(),
            refund_to: refund_to.clone(),
            token: token.clone(),
            amount,
            held: amount,
            refunded: 0,
            refund_owed: 0,
            released: 0,
            fee: 0,
            fee_bps: m.fee_bps,
            arbiter: cfg.arbiter,
            arbiter_timeout: cfg.arbiter_timeout,
            paid_at: now,
            release_at,
            disputed_at: 0,
            resolve_by: 0,
            closed_at: 0,
            dispute_used: false,
            reason: 0,
            buyer_evidence: None,
            merchant_evidence: None,
            ruling: None,
            memo_hash,
            state: OrderState::Held,
        };
        save_order(&env, &order_id, &order);
        bump_instance(&env);
        PayEvent {
            order_id,
            buyer,
            merchant,
            refund_to,
            token,
            amount,
            release_at,
        }
        .publish(&env);
        Ok(())
    }

    // -- merchant ----------------------------------------------------------

    /// Refund part or all of the held amount to the order's `refund_to`.
    /// Signed by the merchant address (not the payout). No recipient argument.
    pub fn refund(env: Env, order_id: BytesN<32>, amount: i128) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        o.merchant.require_auth();
        if o.state != OrderState::Held && o.state != OrderState::Disputed {
            return Err(Error::BadState);
        }
        if amount <= 0 || amount > o.held {
            return Err(Error::InvalidAmount);
        }
        o.held -= amount;
        o.refunded += amount;
        o.refund_owed += amount;
        if o.held == 0 {
            o.state = OrderState::Refunded;
            o.closed_at = env.ledger().timestamp();
        }
        let sent = push_owed(&env, &order_id, &mut o);
        save_order(&env, &order_id, &o);
        if sent > 0 {
            RefundEvent {
                order_id,
                amount,
                refunded: o.refunded,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Anyone: transfer a pending refund to `refund_to`. Works in any state,
    /// including terminal ones; fails (and changes nothing) while the transfer
    /// still cannot be received.
    pub fn settle_refund(env: Env, order_id: BytesN<32>) -> Result<i128, Error> {
        let mut o = load_order(&env, &order_id)?;
        let owed = o.refund_owed;
        if owed == 0 {
            return Err(Error::NothingOwed);
        }
        send(&env, &o.token, &env.current_contract_address(), &o.refund_to, &owed)?;
        o.refund_owed = 0;
        save_order(&env, &order_id, &o);
        RefundSettledEvent {
            order_id,
            amount: owed,
        }
        .publish(&env);
        Ok(owed)
    }

    // -- disputes ----------------------------------------------------------

    /// Buyer opens the order's single dispute before `release_at`.
    pub fn dispute(
        env: Env,
        order_id: BytesN<32>,
        reason: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        o.buyer.require_auth();
        if o.state != OrderState::Held {
            return Err(Error::BadState);
        }
        let now = env.ledger().timestamp();
        if now >= o.release_at {
            return Err(Error::WindowClosed);
        }
        if o.dispute_used {
            return Err(Error::DisputeUsed);
        }
        if o.held <= 0 {
            return Err(Error::BadState);
        }
        if !reason_is_valid(reason) {
            return Err(Error::BadReason);
        }
        let resolve_by = now.checked_add(o.arbiter_timeout).ok_or(Error::Overflow)?;
        o.state = OrderState::Disputed;
        o.disputed_at = now;
        o.resolve_by = resolve_by;
        o.dispute_used = true;
        o.reason = reason;
        o.buyer_evidence = Some(evidence_hash);
        save_order(&env, &order_id, &o);
        DisputeEvent {
            order_id,
            reason,
            resolve_by,
        }
        .publish(&env);
        Ok(())
    }

    /// Merchant records (or replaces) its evidence hash for the open dispute.
    pub fn respond(env: Env, order_id: BytesN<32>, evidence_hash: BytesN<32>) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        o.merchant.require_auth();
        if o.state != OrderState::Disputed {
            return Err(Error::BadState);
        }
        o.merchant_evidence = Some(evidence_hash.clone());
        save_order(&env, &order_id, &o);
        RespondEvent {
            order_id,
            evidence_hash,
        }
        .publish(&env);
        Ok(())
    }

    /// Buyer withdraws the dispute. `release_at` is unchanged, so a withdrawn
    /// dispute past `T` is releasable at once; `dispute_used` stays true.
    pub fn withdraw_dispute(env: Env, order_id: BytesN<32>) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        o.buyer.require_auth();
        if o.state != OrderState::Disputed {
            return Err(Error::BadState);
        }
        o.state = OrderState::Held;
        save_order(&env, &order_id, &o);
        DisputeWithdrawnEvent { order_id }.publish(&env);
        Ok(())
    }

    /// The order's snapshot arbiter splits the held amount of this one
    /// disputed order: `refund_amount` to `refund_to`, the rest (less fee) to
    /// `payout`. It cannot name a recipient, touch another order, or act from
    /// `resolve_by` on.
    pub fn resolve(
        env: Env,
        order_id: BytesN<32>,
        refund_amount: i128,
        ruling_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        o.arbiter.require_auth();
        if o.state != OrderState::Disputed {
            return Err(Error::BadState);
        }
        let now = env.ledger().timestamp();
        if now >= o.resolve_by {
            return Err(Error::ArbiterExpired);
        }
        if refund_amount < 0 || refund_amount > o.held {
            return Err(Error::InvalidAmount);
        }
        let merchant_share = o.held - refund_amount;
        let fee = fee_for(merchant_share, o.fee_bps)?;
        let net = merchant_share - fee;
        o.refunded += refund_amount;
        o.refund_owed += refund_amount;
        o.released += net;
        o.fee += fee;
        o.held = 0;
        o.state = OrderState::Resolved;
        o.closed_at = now;
        o.ruling = Some(ruling_hash);
        add_fees(&env, &o.token, fee)?;
        if net > 0 {
            send(&env, &o.token, &env.current_contract_address(), &o.payout, &net)?;
        }
        push_owed(&env, &order_id, &mut o);
        save_order(&env, &order_id, &o);
        ResolveEvent {
            order_id,
            refund_amount,
            merchant_net: net,
            fee,
        }
        .publish(&env);
        Ok(())
    }

    /// Anyone, from `resolve_by`: a silent arbiter defaults to a full refund.
    pub fn timeout_refund(env: Env, order_id: BytesN<32>) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        if o.state != OrderState::Disputed {
            return Err(Error::BadState);
        }
        let now = env.ledger().timestamp();
        if now < o.resolve_by {
            return Err(Error::ArbiterWindowOpen);
        }
        let r = o.held;
        o.refunded += r;
        o.refund_owed += r;
        o.held = 0;
        o.state = OrderState::TimedOut;
        o.closed_at = now;
        push_owed(&env, &order_id, &mut o);
        save_order(&env, &order_id, &o);
        TimeoutEvent {
            order_id,
            refund_amount: r,
        }
        .publish(&env);
        Ok(())
    }

    // -- release -----------------------------------------------------------

    /// Anyone, from `release_at`: pay an undisputed order to the payout, less fee.
    pub fn release(env: Env, order_id: BytesN<32>) -> Result<(), Error> {
        let mut o = load_order(&env, &order_id)?;
        let now = env.ledger().timestamp();
        if o.state != OrderState::Held || o.held <= 0 {
            return Err(Error::BadState);
        }
        if now < o.release_at {
            return Err(Error::WindowOpen);
        }
        let (net, fee) = book_release(&env, &mut o, now)?;
        if net > 0 {
            send(&env, &o.token, &env.current_contract_address(), &o.payout, &net)?;
        }
        save_order(&env, &order_id, &o);
        ReleaseEvent {
            order_id,
            merchant_net: net,
            fee,
        }
        .publish(&env);
        Ok(())
    }

    /// Anyone: release up to MAX_BATCH orders. Orders that are unknown, not
    /// due, disputed, terminal, or whose payout cannot receive are skipped.
    /// Returns the number released.
    pub fn release_many(env: Env, order_ids: Vec<BytesN<32>>) -> Result<u32, Error> {
        if order_ids.len() > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }
        let now = env.ledger().timestamp();
        let me = env.current_contract_address();
        let mut count = 0u32;
        for id in order_ids.iter() {
            let mut o = match load_order(&env, &id) {
                Ok(o) => o,
                Err(_) => continue,
            };
            if !releasable(&o, now) {
                continue;
            }
            // Try the payout first; a payout that cannot receive is skipped
            // and the order stays Held for a later retry.
            let net_due = o.held - fee_for(o.held, o.fee_bps)?;
            if net_due > 0 {
                let tc = token::TokenClient::new(&env, &o.token);
                if !matches!(tc.try_transfer(&me, &o.payout, &net_due), Ok(Ok(()))) {
                    continue;
                }
            }
            let (net, fee) = book_release(&env, &mut o, now)?;
            save_order(&env, &id, &o);
            ReleaseEvent {
                order_id: id,
                merchant_net: net,
                fee,
            }
            .publish(&env);
            count += 1;
        }
        Ok(count)
    }

    // -- views -------------------------------------------------------------

    pub fn order(env: Env, order_id: BytesN<32>) -> Option<Order> {
        env.storage().persistent().get(&DataKey::Order(order_id))
    }

    pub fn merchant(env: Env, merchant: Address) -> Option<MerchantCfg> {
        env.storage().persistent().get(&DataKey::Merchant(merchant))
    }

    pub fn config(env: Env) -> Config {
        config(&env)
    }

    pub fn fees(env: Env, token: Address) -> i128 {
        fees_of(&env, &token)
    }

    pub fn token_enabled(env: Env, token: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Token(token))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_prop;
#[cfg(test)]
mod test_scenario;
#[cfg(test)]
mod test_seed;
