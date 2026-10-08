//! Unit and negative tests for `refund_escrow`, one group per function, plus
//! the arbiter-bound tests that answer Circle's disclosed arbiter-drain bug.
extern crate std;

use super::*;
use soroban_sdk::testutils::{
    storage::Persistent as _, Address as _, AuthorizedFunction, Events as _, IssuerFlags,
    Ledger as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{token, vec, Event as _, IntoVal, Val};
use std::vec::Vec as StdVec;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// 2026-09-01T00:00:00Z
pub const T0: u64 = 1_788_220_800;
pub const HOUR: u64 = 3_600;
/// 1 unit of a 7-decimal asset.
pub const UNIT: i128 = 10_000_000;
pub const ARB_TIMEOUT: u64 = 7 * DAY;
pub const MIN_WINDOW: u64 = HOUR;
pub const MAX_WINDOW: u64 = 60 * DAY;
pub const M_WINDOW: u64 = 14 * DAY;
pub const M_FEE: u32 = 150;

pub struct Fx {
    pub env: Env,
    pub id: Address,
    pub usdc: Address,
    pub eurc: Address,
    pub admin: Address,
    pub arbiter: Address,
    pub fee_to: Address,
    pub merchant: Address,
    pub payout: Address,
    pub buyer: Address,
    pub attacker: Address,
}

impl Fx {
    /// Contract with USDC and EURC enabled and one merchant (150 bps, 14 days).
    /// All auths mocked; tests about auth switch to `mock_auths`.
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        let admin = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let fee_to = Address::generate(&env);
        let id = env.register(
            RefundEscrow,
            (
                admin.clone(),
                arbiter.clone(),
                fee_to.clone(),
                ARB_TIMEOUT,
                MIN_WINDOW,
                MAX_WINDOW,
            ),
        );
        let issuer = Address::generate(&env);
        let usdc_sac = env.register_stellar_asset_contract_v2(issuer.clone());
        // Revocable, so tests can deauthorise a buyer's balance (the
        // "buyer removed the trustline" case).
        usdc_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let eurc_sac = env.register_stellar_asset_contract_v2(issuer);
        let fx = Fx {
            usdc: usdc_sac.address(),
            eurc: eurc_sac.address(),
            merchant: Address::generate(&env),
            payout: Address::generate(&env),
            buyer: Address::generate(&env),
            attacker: Address::generate(&env),
            admin,
            arbiter,
            fee_to,
            id,
            env,
        };
        let c = fx.c();
        c.set_token(&fx.usdc, &true);
        c.set_token(&fx.eurc, &true);
        c.add_merchant(&fx.merchant, &fx.payout, &M_FEE, &M_WINDOW);
        fx.mint(&fx.usdc, &fx.buyer, 10_000 * UNIT);
        fx
    }

    pub fn c(&self) -> RefundEscrowClient<'_> {
        RefundEscrowClient::new(&self.env, &self.id)
    }

    pub fn mint(&self, tok: &Address, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.env, tok).mint(to, &amount);
    }

    pub fn bal(&self, tok: &Address, who: &Address) -> i128 {
        token::Client::new(&self.env, tok).balance(who)
    }

    pub fn usdc(&self, who: &Address) -> i128 {
        self.bal(&self.usdc, who)
    }

    pub fn at(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }

    #[allow(dead_code)]
    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    pub fn oid(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }

    pub fn h(&self, n: u8) -> BytesN<32> {
        let mut a = [0xE0u8; 32];
        a[31] = n;
        BytesN::from_array(&self.env, &a)
    }

    /// Buyer pays `amount` USDC for order `n` with the merchant's default window.
    pub fn pay(&self, n: u8, amount: i128) -> BytesN<32> {
        let id = self.oid(n);
        self.c().pay(
            &self.buyer,
            &self.merchant,
            &id,
            &self.usdc,
            &amount,
            &None,
            &None,
            &self.h(0),
        );
        id
    }

    pub fn order(&self, id: &BytesN<32>) -> Order {
        self.c().order(id).unwrap()
    }

    /// Mock exactly one address's auth for one call on this contract (no
    /// sub-invocations). Everything else the call needs will be missing.
    pub fn only(&self, who: &Address, fn_name: &str, args: soroban_sdk::Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    /// Per-token invariant: contract balance == Σ held + Σ refund_owed + Fees.
    pub fn assert_token_invariant(&self, tok: &Address, ids: &[BytesN<32>]) {
        let mut sum = 0i128;
        for id in ids {
            if let Some(o) = self.c().order(id) {
                if &o.token == tok {
                    sum += o.held + o.refund_owed;
                }
            }
        }
        assert_eq!(self.bal(tok, &self.id), sum + self.c().fees(tok));
    }
}

/// For functions without a contract error type: the call must fail.
pub fn fails<T, E, I>(r: Result<T, Result<E, I>>) {
    assert!(r.is_err(), "expected the call to fail");
}

/// Unwraps the contract error from a `try_` call.
pub fn cerr<T, E>(r: Result<T, Result<Error, E>>) -> Error {
    match r {
        Err(Ok(e)) => e,
        Err(Err(_)) => panic!("expected a contract error, got a host/auth error"),
        Ok(_) => panic!("expected a contract error, call succeeded"),
    }
}

/// Asserts the call failed with a host error (auth failures land here).
pub fn host_err<T, E>(r: Result<T, Result<Error, E>>) {
    match r {
        Err(Err(_)) => {}
        Err(Ok(e)) => panic!("expected an auth/host error, got contract error {:?}", e),
        Ok(_) => panic!("expected an auth/host error, call succeeded"),
    }
}

fn assert_order_invariant(o: &Order) {
    assert_eq!(o.amount, o.held + o.refunded + o.released + o.fee);
    assert!(o.refund_owed >= 0 && o.refund_owed <= o.refunded);
}

// ---------------------------------------------------------------------------
// __constructor
// ---------------------------------------------------------------------------

#[test]
fn constructor_stores_config() {
    let fx = Fx::new();
    let cfg = fx.c().config();
    assert_eq!(cfg.admin, fx.admin);
    assert_eq!(cfg.arbiter, fx.arbiter);
    assert_eq!(cfg.fee_to, fx.fee_to);
    assert_eq!(cfg.arbiter_timeout, ARB_TIMEOUT);
    assert_eq!((cfg.min_window, cfg.max_window), (MIN_WINDOW, MAX_WINDOW));
    assert!(!cfg.paused);
}

#[test]
fn constructor_rejects_bad_config() {
    let bad: [(u64, u64, u64); 5] = [
        (0, HOUR, DAY),              // arbiter_timeout 0
        (31 * DAY, HOUR, DAY),       // arbiter_timeout > 30 days
        (DAY, 0, DAY),               // min_window 0
        (DAY, 2 * DAY, DAY),         // min > max
        (30 * DAY + 1, HOUR, DAY),   // just above the cap
    ];
    for (timeout, min_w, max_w) in bad {
        let r = std::panic::catch_unwind(|| {
            let env = Env::default();
            let a = Address::generate(&env);
            env.register(RefundEscrow, (a.clone(), a.clone(), a, timeout, min_w, max_w));
        });
        assert!(r.is_err(), "config ({timeout},{min_w},{max_w}) must be rejected");
    }
    // The boundary values are accepted.
    let env = Env::default();
    let a = Address::generate(&env);
    env.register(RefundEscrow, (a.clone(), a.clone(), a, 30 * DAY, DAY, DAY));
}

// ---------------------------------------------------------------------------
// admin functions
// ---------------------------------------------------------------------------

#[test]
fn set_token_enables_and_requires_admin() {
    let fx = Fx::new();
    let tok = Address::generate(&fx.env);
    assert!(!fx.c().token_enabled(&tok));
    fx.c().set_token(&tok, &true);
    assert_eq!(
        fx.env.auths()[0].0,
        fx.admin,
        "set_token is authorised by the admin"
    );
    assert!(fx.c().token_enabled(&tok));
    fx.only(&fx.attacker, "set_token", (&tok, false).into_val(&fx.env));
    fails(fx.c().try_set_token(&tok, &false));
    assert!(fx.c().token_enabled(&tok));
}

#[test]
fn admin_setters_reject_non_admin() {
    let fx = Fx::new();
    let x = Address::generate(&fx.env);
    fx.only(&fx.attacker, "set_arbiter", (&x,).into_val(&fx.env));
    fails(fx.c().try_set_arbiter(&x));
    fx.only(&fx.attacker, "set_fee_to", (&x,).into_val(&fx.env));
    fails(fx.c().try_set_fee_to(&x));
    fx.only(&fx.attacker, "set_paused", (true,).into_val(&fx.env));
    fails(fx.c().try_set_paused(&true));
    fx.only(&fx.attacker, "set_merchant_active", (&fx.merchant, false).into_val(&fx.env));
    host_err(fx.c().try_set_merchant_active(&fx.merchant, &false));
    fx.only(&fx.attacker, "withdraw_fees", (&fx.usdc,).into_val(&fx.env));
    fails(fx.c().try_withdraw_fees(&fx.usdc));
    // set_payout needs both merchant and admin: merchant alone is not enough.
    fx.only(&fx.merchant, "set_payout", (&fx.merchant, &x).into_val(&fx.env));
    host_err(fx.c().try_set_payout(&fx.merchant, &x));
    // ...and admin alone is not enough either.
    fx.only(&fx.admin, "set_payout", (&fx.merchant, &x).into_val(&fx.env));
    host_err(fx.c().try_set_payout(&fx.merchant, &x));
    let cfg = fx.c().config();
    assert_eq!(cfg.arbiter, fx.arbiter);
    assert_eq!(cfg.fee_to, fx.fee_to);
    assert!(!cfg.paused);
    assert_eq!(fx.c().merchant(&fx.merchant).unwrap().payout, fx.payout);
}

#[test]
fn admin_setters_update_future_config() {
    let fx = Fx::new();
    let a2 = Address::generate(&fx.env);
    let f2 = Address::generate(&fx.env);
    fx.c().set_arbiter(&a2);
    fx.c().set_fee_to(&f2);
    fx.c().set_paused(&true);
    let cfg = fx.c().config();
    assert_eq!((cfg.arbiter, cfg.fee_to, cfg.paused), (a2, f2, true));
    fx.c().set_paused(&false);
    assert!(!fx.c().config().paused);
}

#[test]
fn add_merchant_needs_admin_and_merchant_auth() {
    let fx = Fx::new();
    let m = Address::generate(&fx.env);
    let p = Address::generate(&fx.env);
    let args: soroban_sdk::Vec<Val> = (&m, &p, 150u32, 3 * DAY).into_val(&fx.env);
    fx.only(&fx.admin, "add_merchant", args.clone());
    host_err(fx.c().try_add_merchant(&m, &p, &150, &(3 * DAY)));
    fx.only(&m, "add_merchant", args.clone());
    host_err(fx.c().try_add_merchant(&m, &p, &150, &(3 * DAY)));
    assert!(fx.c().merchant(&m).is_none());

    // Both sign: accepted, and the auth tree holds exactly admin + merchant.
    fx.env.mock_all_auths();
    fx.c().add_merchant(&m, &p, &150, &(3 * DAY));
    let signers: StdVec<Address> = fx.env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&fx.admin) && signers.contains(&m));
    assert_eq!(signers.len(), 2);
    let cfg = fx.c().merchant(&m).unwrap();
    assert_eq!((cfg.payout, cfg.fee_bps, cfg.default_window, cfg.active), (p, 150, 3 * DAY, true));
}

#[test]
fn add_merchant_validates_fee_window_duplicates_and_pause() {
    let fx = Fx::new();
    let m = Address::generate(&fx.env);
    let p = Address::generate(&fx.env);
    assert_eq!(cerr(fx.c().try_add_merchant(&m, &p, &1_001, &DAY)), Error::FeeTooHigh);
    assert_eq!(cerr(fx.c().try_add_merchant(&m, &p, &100, &(HOUR - 1))), Error::WindowOutOfRange);
    assert_eq!(cerr(fx.c().try_add_merchant(&m, &p, &100, &(MAX_WINDOW + 1))), Error::WindowOutOfRange);
    assert_eq!(
        cerr(fx.c().try_add_merchant(&fx.merchant, &p, &100, &DAY)),
        Error::MerchantExists
    );
    fx.c().set_paused(&true);
    assert_eq!(cerr(fx.c().try_add_merchant(&m, &p, &100, &DAY)), Error::Paused);
    fx.c().set_paused(&false);
    fx.c().add_merchant(&m, &p, &1_000, &DAY); // exactly MAX_FEE_BPS is allowed
}

#[test]
fn set_merchant_active_blocks_new_orders_only() {
    let fx = Fx::new();
    let a = fx.pay(1, 10 * UNIT);
    fx.c().set_merchant_active(&fx.merchant, &false);
    assert!(!fx.c().merchant(&fx.merchant).unwrap().active);
    let r = fx.c().try_pay(&fx.buyer, &fx.merchant, &fx.oid(2), &fx.usdc, &UNIT, &None, &None, &fx.h(0));
    assert_eq!(cerr(r), Error::MerchantInactive);
    // The held order still releases normally.
    fx.at(T0 + M_WINDOW);
    fx.c().release(&a);
    assert_eq!(fx.order(&a).state, OrderState::Released);
    let ghost = Address::generate(&fx.env);
    assert_eq!(cerr(fx.c().try_set_merchant_active(&ghost, &true)), Error::UnknownMerchant);
}

// ---------------------------------------------------------------------------
// pay
// ---------------------------------------------------------------------------

#[test]
fn pay_moves_funds_and_snapshots_terms() {
    let fx = Fx::new();
    let before = fx.usdc(&fx.buyer);
    let id = fx.pay(1, 49_9900000);
    // pay event: topics ("pay", order_id), emitted by this contract
    assert_eq!(fx.env.events().all().filter_by_contract(&fx.id).events().len(), 1);
    assert_eq!(fx.usdc(&fx.buyer), before - 49_9900000);
    assert_eq!(fx.usdc(&fx.id), 49_9900000);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Held);
    assert_eq!((o.amount, o.held, o.refunded, o.released, o.fee), (49_9900000, 49_9900000, 0, 0, 0));
    assert_eq!(o.refund_to, fx.buyer);
    assert_eq!(o.payout, fx.payout);
    assert_eq!(o.fee_bps, M_FEE);
    assert_eq!(o.arbiter, fx.arbiter);
    assert_eq!(o.arbiter_timeout, ARB_TIMEOUT);
    assert_eq!((o.paid_at, o.release_at), (T0, T0 + M_WINDOW));
    assert_eq!((o.disputed_at, o.resolve_by, o.closed_at), (0, 0, 0));
    assert!(!o.dispute_used);
}

#[test]
fn pay_with_custom_window_and_eurc() {
    let fx = Fx::new();
    fx.mint(&fx.eurc, &fx.buyer, 100 * UNIT);
    let id = fx.oid(7);
    fx.c().pay(&fx.buyer, &fx.merchant, &id, &fx.eurc, &(12 * UNIT + 5_000_000), &None, &Some(3 * DAY), &fx.h(1));
    let o = fx.order(&id);
    assert_eq!(o.release_at, T0 + 3 * DAY);
    assert_eq!(o.token, fx.eurc);
    assert_eq!(o.memo_hash, fx.h(1));
}

#[test]
fn pay_rejections() {
    let fx = Fx::new();
    let c = fx.c();
    let (b, m, u) = (&fx.buyer, &fx.merchant, &fx.usdc);
    let id = fx.oid(1);
    let memo = fx.h(0);
    let ghost = Address::generate(&fx.env);
    let off = Address::generate(&fx.env);
    assert_eq!(cerr(c.try_pay(b, &ghost, &id, u, &UNIT, &None, &None, &memo)), Error::UnknownMerchant);
    assert_eq!(cerr(c.try_pay(b, m, &id, &off, &UNIT, &None, &None, &memo)), Error::TokenNotEnabled);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &0, &None, &None, &memo)), Error::InvalidAmount);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &-1, &None, &None, &memo)), Error::InvalidAmount);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &(MAX_AMOUNT + 1), &None, &None, &memo)), Error::InvalidAmount);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &UNIT, &None, &Some(HOUR - 1), &memo)), Error::WindowOutOfRange);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &UNIT, &None, &Some(MAX_WINDOW + 1), &memo)), Error::WindowOutOfRange);
    // boundaries accepted
    c.pay(b, m, &fx.oid(20), u, &UNIT, &None, &Some(HOUR), &memo);
    c.pay(b, m, &fx.oid(21), u, &UNIT, &None, &Some(MAX_WINDOW), &memo);
    // duplicate id
    c.pay(b, m, &id, u, &UNIT, &None, &None, &memo);
    assert_eq!(cerr(c.try_pay(b, m, &id, u, &UNIT, &None, &None, &memo)), Error::DuplicateOrder);
    // disabled token
    c.set_token(u, &false);
    assert_eq!(cerr(c.try_pay(b, m, &fx.oid(2), u, &UNIT, &None, &None, &memo)), Error::TokenNotEnabled);
    c.set_token(u, &true);
    // paused
    c.set_paused(&true);
    assert_eq!(cerr(c.try_pay(b, m, &fx.oid(3), u, &UNIT, &None, &None, &memo)), Error::Paused);
}

#[test]
fn pay_requires_buyer_auth() {
    let fx = Fx::new();
    let id = fx.oid(1);
    let args: soroban_sdk::Vec<Val> = (
        &fx.buyer, &fx.merchant, &id, &fx.usdc, UNIT, Option::<Address>::None, Option::<u64>::None, &fx.h(0),
    )
        .into_val(&fx.env);
    fx.only(&fx.attacker, "pay", args);
    host_err(fx.c().try_pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &UNIT, &None, &None, &fx.h(0)));
    assert!(fx.c().order(&id).is_none());
}

#[test]
fn pay_with_separate_refund_to_requires_its_signature() {
    let fx = Fx::new();
    let r = Address::generate(&fx.env);
    let id = fx.oid(1);
    let args: soroban_sdk::Vec<Val> = (
        &fx.buyer, &fx.merchant, &id, &fx.usdc, 20 * UNIT, Some(r.clone()), Option::<u64>::None, &fx.h(0),
    )
        .into_val(&fx.env);

    // Buyer signs pay (and the nested token transfer) but refund_to does not.
    let transfer_args: soroban_sdk::Vec<Val> = (&fx.buyer, &fx.id, 20 * UNIT).into_val(&fx.env);
    fx.env.mock_auths(&[MockAuth {
        address: &fx.buyer,
        invoke: &MockAuthInvoke {
            contract: &fx.id,
            fn_name: "pay",
            args: args.clone(),
            sub_invokes: &[MockAuthInvoke {
                contract: &fx.usdc,
                fn_name: "transfer",
                args: transfer_args.clone(),
                sub_invokes: &[],
            }],
        },
    }]);
    host_err(fx.c().try_pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &(20 * UNIT), &Some(r.clone()), &None, &fx.h(0)));
    assert!(fx.c().order(&id).is_none());

    // Both sign: accepted, and the auth tree contains refund_to on `pay`.
    fx.env.mock_auths(&[
        MockAuth {
            address: &fx.buyer,
            invoke: &MockAuthInvoke {
                contract: &fx.id,
                fn_name: "pay",
                args: args.clone(),
                sub_invokes: &[MockAuthInvoke {
                    contract: &fx.usdc,
                    fn_name: "transfer",
                    args: transfer_args,
                    sub_invokes: &[],
                }],
            },
        },
        MockAuth {
            address: &r,
            invoke: &MockAuthInvoke {
                contract: &fx.id,
                fn_name: "pay",
                args: args.clone(),
                sub_invokes: &[],
            },
        },
    ]);
    fx.c().pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &(20 * UNIT), &Some(r.clone()), &None, &fx.h(0));
    let auths = fx.env.auths();
    let r_auth = auths.iter().find(|(a, _)| a == &r).expect("refund_to must sign");
    match &r_auth.1.function {
        AuthorizedFunction::Contract((c, f, a)) => {
            assert_eq!(c, &fx.id);
            assert_eq!(f, &Symbol::new(&fx.env, "pay"));
            assert_eq!(a, &args);
        }
        _ => panic!("refund_to must authorise the pay call"),
    }
    assert!(auths.iter().any(|(a, _)| a == &fx.buyer));
    assert_eq!(fx.order(&id).refund_to, r);
}

#[test]
fn pay_with_refund_to_equal_to_buyer_needs_no_second_signature() {
    let fx = Fx::new();
    let id = fx.oid(1);
    fx.c().pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &UNIT, &Some(fx.buyer.clone()), &None, &fx.h(0));
    let signers: StdVec<Address> = fx.env.auths().into_iter().map(|(a, _)| a).collect();
    assert_eq!(signers, std::vec![fx.buyer.clone()]);
    assert_eq!(fx.order(&id).refund_to, fx.buyer);
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

#[test]
fn release_at_t_minus_1_fails_and_at_t_pays_payout_less_fee() {
    let fx = Fx::new();
    let id = fx.pay(1, 10 * UNIT);
    fx.at(T0 + M_WINDOW - 1);
    assert_eq!(cerr(fx.c().try_release(&id)), Error::WindowOpen);
    fx.at(T0 + M_WINDOW);
    fx.c().release(&id); // anyone: no auth involved
    assert!(fx.env.auths().is_empty());
    assert_eq!(fx.usdc(&fx.payout), 10 * UNIT - 1_500_000);
    assert_eq!(fx.c().fees(&fx.usdc), 1_500_000);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Released);
    assert_eq!((o.held, o.released, o.fee, o.closed_at), (0, 10 * UNIT - 1_500_000, 1_500_000, T0 + M_WINDOW));
    assert_order_invariant(&o);
    assert_eq!(cerr(fx.c().try_release(&id)), Error::BadState);
    assert_eq!(cerr(fx.c().try_release(&fx.oid(99))), Error::OrderNotFound);
}

#[test]
fn release_many_counts_and_skips() {
    let fx = Fx::new();
    let due1 = fx.pay(1, UNIT);
    let due2 = fx.pay(2, 2 * UNIT);
    let disputed = fx.pay(3, 3 * UNIT);
    fx.at(T0 + DAY);
    let not_due = fx.pay(4, 4 * UNIT);
    fx.c().dispute(&disputed, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.at(T0 + M_WINDOW);
    let unknown = fx.oid(200);
    let n = fx.c().release_many(&vec![&fx.env, due1.clone(), not_due.clone(), disputed.clone(), unknown, due2.clone(), due1.clone()]);
    assert_eq!(n, 2, "due1 and due2 once each; not-due, disputed, unknown and the repeat are skipped");
    assert_eq!(fx.order(&due1).state, OrderState::Released);
    assert_eq!(fx.order(&due2).state, OrderState::Released);
    assert_eq!(fx.order(&not_due).state, OrderState::Held);
    assert_eq!(fx.order(&disputed).state, OrderState::Disputed);
    assert_eq!(fx.c().release_many(&vec![&fx.env]), 0);
}

#[test]
fn release_many_rejects_more_than_max_batch() {
    let fx = Fx::new();
    let mut ids = soroban_sdk::Vec::new(&fx.env);
    for i in 0..26u8 {
        ids.push_back(fx.oid(i));
    }
    assert_eq!(cerr(fx.c().try_release_many(&ids)), Error::BatchTooLarge);
    ids.pop_back();
    assert_eq!(fx.c().release_many(&ids), 0); // 25 unknown ids: accepted, nothing released
}

// ---------------------------------------------------------------------------
// refund
// ---------------------------------------------------------------------------

#[test]
fn partial_refund_keeps_held_and_fee_applies_to_remainder_only() {
    let fx = Fx::new();
    let id = fx.pay(1, 84_5000000);
    let before = fx.usdc(&fx.buyer);
    fx.c().refund(&id, &25_3500000); // 30%
    assert_eq!(fx.usdc(&fx.buyer), before + 25_3500000);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Held);
    assert_eq!((o.held, o.refunded, o.refund_owed), (59_1500000, 25_3500000, 0));
    fx.at(T0 + M_WINDOW);
    fx.c().release(&id);
    let o = fx.order(&id);
    let fee = 59_1500000 * 150 / 10_000;
    assert_eq!(o.fee, fee);
    assert_eq!(fx.usdc(&fx.payout), 59_1500000 - fee);
    assert!(o.fee <= (o.amount - o.refunded) * (o.fee_bps as i128) / BPS);
    assert_order_invariant(&o);
}

#[test]
fn full_refund_closes_order_and_blocks_release() {
    let fx = Fx::new();
    let id = fx.pay(1, 49_9900000);
    fx.at(T0 + 2 * DAY);
    fx.c().refund(&id, &49_9900000);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Refunded);
    assert_eq!((o.held, o.refunded, o.closed_at), (0, 49_9900000, T0 + 2 * DAY));
    fx.at(T0 + M_WINDOW);
    assert_eq!(cerr(fx.c().try_release(&id)), Error::BadState);
    assert_eq!(cerr(fx.c().try_refund(&id, &1)), Error::BadState);
    assert_eq!(fx.usdc(&fx.payout), 0);
}

#[test]
fn refund_amount_bounds() {
    let fx = Fx::new();
    let id = fx.pay(1, 10 * UNIT);
    assert_eq!(cerr(fx.c().try_refund(&id, &(10 * UNIT + 1))), Error::InvalidAmount);
    assert_eq!(cerr(fx.c().try_refund(&id, &0)), Error::InvalidAmount);
    assert_eq!(cerr(fx.c().try_refund(&id, &-5)), Error::InvalidAmount);
    fx.c().refund(&id, &(4 * UNIT));
    assert_eq!(cerr(fx.c().try_refund(&id, &(6 * UNIT + 1))), Error::InvalidAmount);
    assert_eq!(cerr(fx.c().try_refund(&fx.oid(9), &1)), Error::OrderNotFound);
}

#[test]
fn refund_is_signed_by_the_merchant_only() {
    let fx = Fx::new();
    let id = fx.pay(1, 10 * UNIT);
    let args: soroban_sdk::Vec<Val> = (&id, UNIT).into_val(&fx.env);
    for who in [&fx.payout, &fx.buyer, &fx.admin, &fx.arbiter, &fx.attacker] {
        fx.only(who, "refund", args.clone());
        host_err(fx.c().try_refund(&id, &UNIT));
    }
    assert_eq!(fx.order(&id).held, 10 * UNIT);
    fx.only(&fx.merchant, "refund", args);
    fx.c().refund(&id, &UNIT);
    assert_eq!(fx.env.auths()[0].0, fx.merchant);
}

#[test]
fn refunds_cannot_be_redirected() {
    // (1) The interface has no recipient argument: this only compiles if
    // `refund` takes exactly (order_id, amount).
    let _sig: fn(&RefundEscrowClient<'static>, &BytesN<32>, &i128) = RefundEscrowClient::refund;
    let _settle: fn(&RefundEscrowClient<'static>, &BytesN<32>) -> i128 = RefundEscrowClient::settle_refund;

    // (2) With every auth mocked, any refund only ever credits refund_to.
    let fx = Fx::new();
    let r = Address::generate(&fx.env);
    let id = fx.oid(1);
    fx.c().pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &(30 * UNIT), &Some(r.clone()), &None, &fx.h(0));
    let watch = [&fx.admin, &fx.arbiter, &fx.payout, &fx.attacker, &fx.merchant, &fx.fee_to];
    let before: StdVec<i128> = watch.iter().map(|a| fx.usdc(a)).collect();
    let buyer_before = fx.usdc(&fx.buyer);
    fx.c().refund(&id, &(5 * UNIT));
    fx.c().refund(&id, &(25 * UNIT));
    fx.c().try_settle_refund(&id).ok();
    let after: StdVec<i128> = watch.iter().map(|a| fx.usdc(a)).collect();
    assert_eq!(before, after);
    assert_eq!(fx.usdc(&fx.buyer), buyer_before, "not even the buyer: only the signed refund_to");
    assert_eq!(fx.usdc(&r), 30 * UNIT);

    // (3) A payout change after pay does not touch the held order.
    let id2 = fx.pay(2, 10 * UNIT);
    let new_payout = Address::generate(&fx.env);
    fx.c().set_payout(&fx.merchant, &new_payout);
    assert_eq!(fx.order(&id2).payout, fx.payout);
    fx.at(T0 + M_WINDOW);
    fx.c().release(&id2);
    assert_eq!(fx.usdc(&new_payout), 0);
    assert_eq!(fx.usdc(&fx.payout), 10 * UNIT - 1_500_000);
    // New orders use the new payout.
    let id3 = fx.pay(3, UNIT);
    assert_eq!(fx.order(&id3).payout, new_payout);
}

// ---------------------------------------------------------------------------
// pending refunds and settle_refund
// ---------------------------------------------------------------------------

#[test]
fn refund_to_deauthorised_balance_goes_pending_and_settles_later() {
    let fx = Fx::new();
    let id = fx.pay(1, 120 * UNIT);
    let sac = token::StellarAssetClient::new(&fx.env, &fx.usdc);
    // The buyer "removed the trustline": its balance can no longer receive.
    sac.set_authorized(&fx.buyer, &false);
    let before = fx.usdc(&fx.buyer);
    fx.c().refund(&id, &(120 * UNIT));
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Refunded);
    assert_eq!((o.refunded, o.refund_owed), (120 * UNIT, 120 * UNIT));
    assert_eq!(fx.usdc(&fx.buyer), before);
    assert_eq!(fx.usdc(&fx.id), 120 * UNIT, "the owed amount stays in the contract");
    assert_order_invariant(&o);
    // Retrying while still deauthorised fails and changes nothing.
    fx.at(T0 + DAY);
    assert_eq!(cerr(fx.c().try_settle_refund(&id)), Error::TransferFailed);
    assert_eq!(fx.order(&id).refund_owed, 120 * UNIT);
    // Trustline restored on day +2: anyone settles.
    fx.at(T0 + 2 * DAY);
    sac.set_authorized(&fx.buyer, &true);
    assert_eq!(fx.c().settle_refund(&id), 120 * UNIT);
    assert_eq!(fx.usdc(&fx.buyer), before + 120 * UNIT);
    let o = fx.order(&id);
    assert_eq!((o.refund_owed, o.state, o.closed_at), (0, OrderState::Refunded, T0));
    assert_eq!(cerr(fx.c().try_settle_refund(&id)), Error::NothingOwed);
    fx.assert_token_invariant(&fx.usdc, &[id]);
}

#[test]
fn settle_refund_with_nothing_owed_fails() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    assert_eq!(cerr(fx.c().try_settle_refund(&id)), Error::NothingOwed);
    assert_eq!(cerr(fx.c().try_settle_refund(&fx.oid(2))), Error::OrderNotFound);
}

// ---------------------------------------------------------------------------
// dispute / respond / withdraw_dispute
// ---------------------------------------------------------------------------

#[test]
fn dispute_freezes_release_until_withdrawn() {
    let fx = Fx::new();
    let id = fx.pay(1, 64 * UNIT);
    fx.at(T0 + 10 * DAY);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Disputed);
    assert_eq!((o.disputed_at, o.resolve_by, o.reason), (T0 + 10 * DAY, T0 + 17 * DAY, 1));
    assert_eq!(o.buyer_evidence, Some(fx.h(1)));
    fx.at(T0 + M_WINDOW + DAY);
    assert_eq!(cerr(fx.c().try_release(&id)), Error::BadState);
    assert_eq!(fx.c().release_many(&vec![&fx.env, id.clone()]), 0);
    fx.c().withdraw_dispute(&id);
    assert_eq!(fx.order(&id).state, OrderState::Held);
    // Past T, so the withdrawn order is releasable at once...
    fx.c().release(&id);
    assert_eq!(fx.order(&id).state, OrderState::Released);
}

#[test]
fn only_one_dispute_per_order() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    fx.c().dispute(&id, &REASON_NOT_AS_DESCRIBED, &fx.h(1));
    assert_eq!(cerr(fx.c().try_dispute(&id, &REASON_OTHER, &fx.h(2))), Error::BadState);
    fx.c().withdraw_dispute(&id);
    assert_eq!(cerr(fx.c().try_dispute(&id, &REASON_OTHER, &fx.h(2))), Error::DisputeUsed);
    assert!(fx.order(&id).dispute_used);
}

#[test]
fn dispute_at_exactly_t_is_rejected() {
    let fx = Fx::new();
    let a = fx.pay(1, UNIT);
    let b = fx.pay(2, UNIT);
    fx.at(T0 + M_WINDOW - 1);
    fx.c().dispute(&a, &REASON_NOT_RECEIVED, &fx.h(1)); // T-1: accepted
    fx.at(T0 + M_WINDOW);
    assert_eq!(cerr(fx.c().try_dispute(&b, &REASON_NOT_RECEIVED, &fx.h(1))), Error::WindowClosed);
    fx.at(T0 + M_WINDOW + 2 * HOUR);
    assert_eq!(cerr(fx.c().try_dispute(&b, &REASON_NOT_RECEIVED, &fx.h(1))), Error::WindowClosed);
    fx.c().release(&b);
}

#[test]
fn dispute_validates_reason_state_and_buyer_auth() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    for bad in [0u32, 6, 7, 98, 100, u32::MAX] {
        assert_eq!(cerr(fx.c().try_dispute(&id, &bad, &fx.h(1))), Error::BadReason);
    }
    let args: soroban_sdk::Vec<Val> = (&id, REASON_OTHER, &fx.h(1)).into_val(&fx.env);
    for who in [&fx.merchant, &fx.attacker, &fx.arbiter] {
        fx.only(who, "dispute", args.clone());
        host_err(fx.c().try_dispute(&id, &REASON_OTHER, &fx.h(1)));
    }
    fx.only(&fx.buyer, "dispute", args);
    fx.c().dispute(&id, &REASON_OTHER, &fx.h(1));
    fx.env.mock_all_auths();
    assert_eq!(cerr(fx.c().try_dispute(&fx.oid(5), &REASON_OTHER, &fx.h(1))), Error::OrderNotFound);
    // A refunded order cannot be disputed.
    let r = fx.pay(2, UNIT);
    fx.c().refund(&r, &UNIT);
    assert_eq!(cerr(fx.c().try_dispute(&r, &REASON_OTHER, &fx.h(1))), Error::BadState);
}

#[test]
fn respond_is_merchant_only_and_replaceable() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    assert_eq!(cerr(fx.c().try_respond(&id, &fx.h(5))), Error::BadState);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    let args: soroban_sdk::Vec<Val> = (&id, &fx.h(5)).into_val(&fx.env);
    for who in [&fx.buyer, &fx.payout, &fx.arbiter] {
        fx.only(who, "respond", args.clone());
        host_err(fx.c().try_respond(&id, &fx.h(5)));
    }
    fx.only(&fx.merchant, "respond", args);
    fx.c().respond(&id, &fx.h(5));
    fx.env.mock_all_auths();
    fx.c().respond(&id, &fx.h(6));
    assert_eq!(fx.order(&id).merchant_evidence, Some(fx.h(6)));
}

#[test]
fn withdraw_dispute_is_buyer_only_and_needs_a_dispute() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    assert_eq!(cerr(fx.c().try_withdraw_dispute(&id)), Error::BadState);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    let args: soroban_sdk::Vec<Val> = (&id,).into_val(&fx.env);
    for who in [&fx.merchant, &fx.arbiter, &fx.attacker] {
        fx.only(who, "withdraw_dispute", args.clone());
        host_err(fx.c().try_withdraw_dispute(&id));
    }
    fx.only(&fx.buyer, "withdraw_dispute", args);
    fx.c().withdraw_dispute(&id);
    assert_eq!(fx.order(&id).state, OrderState::Held);
}

#[test]
fn merchant_can_refund_during_a_dispute() {
    let fx = Fx::new();
    let id = fx.pay(1, 19_9900000);
    fx.c().dispute(&id, &REASON_DIGITAL_NOT_DELIVERED, &fx.h(1));
    fx.c().refund(&id, &(5 * UNIT));
    assert_eq!(fx.order(&id).state, OrderState::Disputed);
    fx.c().refund(&id, &14_9900000);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Refunded);
    assert_eq!(o.refunded, 19_9900000);
    // The arbiter has nothing left to rule on.
    assert_eq!(cerr(fx.c().try_resolve(&id, &0, &fx.h(9))), Error::BadState);
    assert_eq!(cerr(fx.c().try_timeout_refund(&id)), Error::BadState);
}

// ---------------------------------------------------------------------------
// resolve / timeout_refund
// ---------------------------------------------------------------------------

#[test]
fn arbiter_split_pays_both_sides_fee_on_merchant_share_only() {
    let fx = Fx::new();
    let id = fx.pay(1, 64 * UNIT);
    fx.at(T0 + 5 * DAY);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.at(T0 + 9 * DAY);
    let buyer_before = fx.usdc(&fx.buyer);
    let refund = 25_6000000; // 40%
    fx.c().resolve(&id, &refund, &fx.h(7));
    assert_eq!(fx.env.auths()[0].0, fx.arbiter);
    let m = 64 * UNIT - refund;
    let fee = m * 150 / 10_000;
    assert_eq!(fx.usdc(&fx.buyer), buyer_before + refund);
    assert_eq!(fx.usdc(&fx.payout), m - fee);
    assert_eq!(fx.c().fees(&fx.usdc), fee);
    let o = fx.order(&id);
    assert_eq!(o.state, OrderState::Resolved);
    assert_eq!((o.held, o.refunded, o.released, o.fee), (0, refund, m - fee, fee));
    assert_eq!(o.ruling, Some(fx.h(7)));
    assert_eq!(o.closed_at, T0 + 9 * DAY);
    assert_order_invariant(&o);
}

#[test]
fn resolve_rejections() {
    let fx = Fx::new();
    let held = fx.pay(1, 10 * UNIT);
    assert_eq!(cerr(fx.c().try_resolve(&held, &0, &fx.h(1))), Error::BadState, "Held order");
    let id = fx.pay(2, 10 * UNIT);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    assert_eq!(cerr(fx.c().try_resolve(&id, &(10 * UNIT + 1), &fx.h(1))), Error::InvalidAmount);
    assert_eq!(cerr(fx.c().try_resolve(&id, &-1, &fx.h(1))), Error::InvalidAmount);
    // Current config arbiter differs from the order's snapshot: cannot rule.
    let new_arb = Address::generate(&fx.env);
    fx.c().set_arbiter(&new_arb);
    let args: soroban_sdk::Vec<Val> = (&id, UNIT, &fx.h(1)).into_val(&fx.env);
    fx.only(&new_arb, "resolve", args.clone());
    host_err(fx.c().try_resolve(&id, &UNIT, &fx.h(1)));
    for who in [&fx.admin, &fx.merchant, &fx.buyer, &fx.attacker] {
        fx.only(who, "resolve", args.clone());
        host_err(fx.c().try_resolve(&id, &UNIT, &fx.h(1)));
    }
    fx.env.mock_all_auths();
    // At resolve_by the arbiter is too late.
    fx.at(T0 + ARB_TIMEOUT);
    assert_eq!(cerr(fx.c().try_resolve(&id, &UNIT, &fx.h(1))), Error::ArbiterExpired);
    // resolve_by - 1 still works, by the snapshot arbiter.
    fx.at(T0 + ARB_TIMEOUT - 1);
    fx.only(&fx.arbiter, "resolve", args);
    fx.c().resolve(&id, &UNIT, &fx.h(1));
    assert_eq!(fx.order(&id).state, OrderState::Resolved);
}

#[test]
fn timeout_refund_boundaries() {
    let fx = Fx::new();
    let id = fx.pay(1, 33 * UNIT);
    fx.at(T0 + HOUR);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    let resolve_by = T0 + HOUR + ARB_TIMEOUT;
    fx.at(resolve_by - 1);
    assert_eq!(cerr(fx.c().try_timeout_refund(&id)), Error::ArbiterWindowOpen);
    fx.at(resolve_by);
    let before = fx.usdc(&fx.buyer);
    fx.c().timeout_refund(&id); // anyone
    assert!(fx.env.auths().is_empty());
    assert_eq!(fx.usdc(&fx.buyer), before + 33 * UNIT);
    let o = fx.order(&id);
    assert_eq!((o.state, o.held, o.refunded, o.closed_at), (OrderState::TimedOut, 0, 33 * UNIT, resolve_by));
    assert_eq!(cerr(fx.c().try_resolve(&id, &0, &fx.h(1))), Error::BadState);
    assert_eq!(cerr(fx.c().try_timeout_refund(&id)), Error::BadState);
    let held = fx.pay(2, UNIT);
    assert_eq!(cerr(fx.c().try_timeout_refund(&held)), Error::BadState);
}

// ---------------------------------------------------------------------------
// The arbiter cannot drain (Circle Refund Protocol's disclosed bug)
// ---------------------------------------------------------------------------

#[test]
fn arbiter_cannot_touch_other_orders() {
    let fx = Fx::new();
    let a = fx.pay(1, 50 * UNIT);
    let b = fx.pay(2, 70 * UNIT);
    let c = fx.pay(3, 90 * UNIT); // never disputed
    fx.c().dispute(&a, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().dispute(&b, &REASON_NOT_AS_DESCRIBED, &fx.h(2));
    let arb_before = fx.usdc(&fx.arbiter);
    let b_before = fx.order(&b);
    fx.c().resolve(&a, &(50 * UNIT), &fx.h(3));
    assert_eq!(fx.order(&b), b_before, "resolving A never changes B");
    assert_eq!(fx.order(&c).held, 90 * UNIT);
    assert_eq!(fx.usdc(&fx.arbiter), arb_before);
    fx.c().resolve(&b, &0, &fx.h(4));
    assert_eq!(fx.usdc(&fx.arbiter), arb_before);
    assert_eq!(fx.order(&c).held, 90 * UNIT);
    // The undisputed order is out of the arbiter's reach.
    assert_eq!(cerr(fx.c().try_resolve(&c, &(90 * UNIT), &fx.h(5))), Error::BadState);
    fx.assert_token_invariant(&fx.usdc, &[a, b, c]);
}

#[test]
fn arbiter_moves_at_most_the_disputed_orders_held_amount() {
    let fx = Fx::new();
    let big = fx.pay(1, 1_999 * UNIT);
    let small = fx.pay(2, 10 * UNIT);
    fx.c().dispute(&small, &REASON_NOT_RECEIVED, &fx.h(1));
    // The merchant already refunded 4 during the dispute: held is now 6.
    fx.c().refund(&small, &(4 * UNIT));
    let contract_before = fx.usdc(&fx.id);
    for too_much in [6 * UNIT + 1, 10 * UNIT, 1_999 * UNIT, MAX_AMOUNT, i128::MAX] {
        assert_eq!(cerr(fx.c().try_resolve(&small, &too_much, &fx.h(1))), Error::InvalidAmount);
    }
    assert_eq!(cerr(fx.c().try_resolve(&small, &i128::MIN, &fx.h(1))), Error::InvalidAmount);
    fx.c().resolve(&small, &(6 * UNIT), &fx.h(1));
    // Outflow is exactly the 6 held on this order; the 1,999 order is intact.
    assert_eq!(fx.usdc(&fx.id), contract_before - 6 * UNIT);
    assert_eq!(fx.order(&big).held, 1_999 * UNIT);
    fx.assert_token_invariant(&fx.usdc, &[big, small]);
}

#[test]
fn arbiter_can_only_pay_the_bound_refund_to_and_payout() {
    let fx = Fx::new();
    let refund_to = Address::generate(&fx.env);
    let id = fx.oid(1);
    fx.c().pay(&fx.buyer, &fx.merchant, &id, &fx.usdc, &(100 * UNIT), &Some(refund_to.clone()), &None, &fx.h(0));
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    // Even if the PSP later changes the merchant payout and the arbiter,
    // the ruling pays the snapshot parties.
    let other_payout = Address::generate(&fx.env);
    fx.c().set_payout(&fx.merchant, &other_payout);
    let watch = [&fx.admin, &fx.arbiter, &fx.attacker, &fx.merchant, &other_payout, &fx.buyer, &fx.fee_to];
    let before: StdVec<i128> = watch.iter().map(|a| fx.usdc(a)).collect();
    fx.c().resolve(&id, &(40 * UNIT), &fx.h(2));
    let after: StdVec<i128> = watch.iter().map(|a| fx.usdc(a)).collect();
    assert_eq!(before, after, "no address other than refund_to and payout gains");
    assert_eq!(fx.usdc(&refund_to), 40 * UNIT);
    assert_eq!(fx.usdc(&fx.payout), 60 * UNIT - 60 * UNIT * 150 / 10_000);
    // The resolve signature has no address parameter at all.
    let _sig: fn(&RefundEscrowClient<'static>, &BytesN<32>, &i128, &BytesN<32>) = RefundEscrowClient::resolve;
}

#[test]
fn arbiter_can_never_rule_twice() {
    let fx = Fx::new();
    let id = fx.pay(1, 20 * UNIT);
    fx.c().dispute(&id, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().resolve(&id, &(5 * UNIT), &fx.h(2));
    let after_first = fx.order(&id);
    let contract_bal = fx.usdc(&fx.id);
    assert_eq!(cerr(fx.c().try_resolve(&id, &(5 * UNIT), &fx.h(2))), Error::BadState);
    assert_eq!(cerr(fx.c().try_resolve(&id, &0, &fx.h(3))), Error::BadState);
    // The buyer cannot reopen a dispute to give the arbiter a second go.
    assert_eq!(cerr(fx.c().try_dispute(&id, &REASON_OTHER, &fx.h(4))), Error::BadState);
    assert_eq!(cerr(fx.c().try_timeout_refund(&id)), Error::BadState);
    assert_eq!(fx.order(&id), after_first);
    assert_eq!(fx.usdc(&fx.id), contract_bal);
    // Nor after a withdrawn dispute: one dispute, one possible ruling.
    let w = fx.pay(2, 20 * UNIT);
    fx.c().dispute(&w, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().withdraw_dispute(&w);
    assert_eq!(cerr(fx.c().try_resolve(&w, &(20 * UNIT), &fx.h(2))), Error::BadState);
    assert_eq!(cerr(fx.c().try_dispute(&w, &REASON_OTHER, &fx.h(1))), Error::DisputeUsed);
}

#[test]
fn a_compromised_arbiter_sweeping_every_order_takes_nothing() {
    // The arbiter key is stolen. The attacker, holding it, tries every
    // resolve it can on every order id, with maximal amounts, repeatedly.
    let fx = Fx::new();
    let mut ids = StdVec::new();
    for n in 1..=6u8 {
        ids.push(fx.pay(n, (n as i128) * 11 * UNIT));
    }
    for id in ids.iter().take(3) {
        fx.c().dispute(id, &REASON_NOT_RECEIVED, &fx.h(1));
    }
    let arb_before = fx.usdc(&fx.arbiter);
    let att_before = fx.usdc(&fx.attacker);
    let held_before: i128 = ids.iter().map(|i| fx.order(i).held).sum();
    for _round in 0..2 {
        for id in ids.iter() {
            let _ = fx.c().try_resolve(id, &i128::MAX, &fx.h(9));
            let held = fx.c().order(id).unwrap().held;
            let _ = fx.c().try_resolve(id, &held, &fx.h(9));
        }
    }
    assert_eq!(fx.usdc(&fx.arbiter), arb_before);
    assert_eq!(fx.usdc(&fx.attacker), att_before);
    // Only the three disputed orders were ruled, each once, each fully to its buyer.
    let mut ruled = 0;
    for id in ids.iter() {
        let o = fx.order(id);
        assert_order_invariant(&o);
        if o.state == OrderState::Resolved {
            ruled += 1;
            assert_eq!(o.refunded, o.amount);
        } else {
            assert_eq!(o.state, OrderState::Held);
        }
    }
    assert_eq!(ruled, 3);
    let held_after: i128 = ids.iter().map(|i| fx.order(i).held).sum();
    assert_eq!(held_before - held_after, (11 + 22 + 33) * UNIT);
    fx.assert_token_invariant(&fx.usdc, &ids);
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

#[test]
fn fee_rounding_vectors() {
    assert_eq!(fee_for(1, 150), Ok(0));
    assert_eq!(fee_for(10_000_000, 150), Ok(150_000));
    assert_eq!(fee_for(33_333_333, 125), Ok(416_666));
    assert_eq!(fee_for(50, 150), Ok(0)); // 0.0000050 USDC
    assert_eq!(fee_for(50, 125), Ok(0));
    assert_eq!(fee_for(MAX_AMOUNT, 1_000), Ok(MAX_AMOUNT / 10));
    assert_eq!(fee_for(i128::MAX, 2), Err(Error::Overflow));
    for (amount, bps, fee) in crate::test_seed::FEE_VECTORS {
        assert_eq!(fee_for(*amount, *bps), Ok(*fee), "shared vector {amount} @ {bps}");
    }
}

#[test]
fn fee_rounding_through_the_contract() {
    let fx = Fx::new();
    // Dust order: fee rounds to 0 and the payout gets every stroop.
    let dust = fx.pay(1, 50);
    // A split where the merchant share is 1 stroop: fee 0.
    let split = fx.pay(2, 10 * UNIT);
    fx.c().dispute(&split, &REASON_OTHER, &fx.h(1));
    fx.c().resolve(&split, &(10 * UNIT - 1), &fx.h(2));
    assert_eq!(fx.order(&split).fee, 0);
    assert_eq!(fx.usdc(&fx.payout), 1);
    // MAX_AMOUNT at 1000 bps settles without overflow.
    let whale = Address::generate(&fx.env);
    let m2 = Address::generate(&fx.env);
    let p2 = Address::generate(&fx.env);
    fx.c().add_merchant(&m2, &p2, &1_000, &DAY);
    fx.mint(&fx.usdc, &whale, MAX_AMOUNT);
    fx.c().pay(&whale, &m2, &fx.oid(3), &fx.usdc, &MAX_AMOUNT, &None, &None, &fx.h(0));
    fx.at(T0 + M_WINDOW);
    fx.c().release(&dust);
    assert_eq!(fx.order(&dust).fee, 0);
    assert_eq!(fx.usdc(&fx.payout), 1 + 50);
    fx.c().release(&fx.oid(3));
    assert_eq!(fx.usdc(&p2), MAX_AMOUNT - MAX_AMOUNT / 10);
    assert_eq!(fx.c().fees(&fx.usdc), MAX_AMOUNT / 10);
}

#[test]
fn withdraw_fees_moves_only_fees() {
    let fx = Fx::new();
    let a = fx.pay(1, 100 * UNIT);
    let b = fx.pay(2, 40 * UNIT); // stays held
    let c = fx.pay(3, 10 * UNIT);
    let sac = token::StellarAssetClient::new(&fx.env, &fx.usdc);
    sac.set_authorized(&fx.buyer, &false);
    fx.c().refund(&c, &(10 * UNIT)); // owed, not transferred
    fx.at(T0 + M_WINDOW);
    fx.c().release(&a);
    fx.at(T0 + M_WINDOW - 1); // pretend b is not yet due: nothing else moves
    let fees = fx.c().fees(&fx.usdc);
    assert_eq!(fees, 1_500_000 * 10);
    assert_eq!(fx.c().withdraw_fees(&fx.usdc), fees);
    assert_eq!(fx.usdc(&fx.fee_to), fees);
    assert_eq!(fx.c().fees(&fx.usdc), 0);
    assert_eq!(fx.c().withdraw_fees(&fx.usdc), 0);
    assert_eq!(fx.usdc(&fx.id), 40 * UNIT + 10 * UNIT, "held + owed untouched");
    fx.assert_token_invariant(&fx.usdc, &[a, b, c]);
    // EURC fees are separate.
    assert_eq!(fx.c().withdraw_fees(&fx.eurc), 0);
}

// ---------------------------------------------------------------------------
// Pause cannot trap funds
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_only_pay_and_add_merchant() {
    let fx = Fx::new();
    let r = fx.pay(1, 10 * UNIT);
    let d = fx.pay(2, 10 * UNIT);
    let t = fx.pay(3, 10 * UNIT);
    let w = fx.pay(4, 10 * UNIT);
    let rel = fx.pay(5, 10 * UNIT);
    fx.c().set_paused(&true);
    fx.c().refund(&r, &(3 * UNIT));
    fx.c().dispute(&d, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().respond(&d, &fx.h(2));
    fx.c().resolve(&d, &UNIT, &fx.h(3));
    fx.c().dispute(&t, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().dispute(&w, &REASON_NOT_RECEIVED, &fx.h(1));
    fx.c().withdraw_dispute(&w);
    fx.at(T0 + ARB_TIMEOUT);
    fx.c().timeout_refund(&t);
    fx.at(T0 + M_WINDOW);
    fx.c().release(&rel);
    assert_eq!(fx.c().release_many(&vec![&fx.env, r.clone(), w.clone()]), 2);
    assert!(fx.c().withdraw_fees(&fx.usdc) > 0);
    assert_eq!(
        cerr(fx.c().try_pay(&fx.buyer, &fx.merchant, &fx.oid(9), &fx.usdc, &UNIT, &None, &None, &fx.h(0))),
        Error::Paused
    );
    fx.assert_token_invariant(&fx.usdc, &[r, d, t, w, rel]);
}

// ---------------------------------------------------------------------------
// Views, TTL, events
// ---------------------------------------------------------------------------

#[test]
fn views_return_none_or_defaults_for_unknown_keys() {
    let fx = Fx::new();
    let x = Address::generate(&fx.env);
    assert!(fx.c().order(&fx.oid(1)).is_none());
    assert!(fx.c().merchant(&x).is_none());
    assert_eq!(fx.c().fees(&x), 0);
    assert!(!fx.c().token_enabled(&x));
    assert!(fx.c().token_enabled(&fx.usdc));
}

#[test]
fn unknown_order_is_order_not_found_everywhere() {
    let fx = Fx::new();
    let x = fx.oid(42);
    assert_eq!(cerr(fx.c().try_refund(&x, &1)), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_dispute(&x, &1, &fx.h(1))), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_respond(&x, &fx.h(1))), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_withdraw_dispute(&x)), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_resolve(&x, &0, &fx.h(1))), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_timeout_refund(&x)), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_release(&x)), Error::OrderNotFound);
    assert_eq!(cerr(fx.c().try_settle_refund(&x)), Error::OrderNotFound);
}

#[test]
fn order_ttl_covers_window_plus_arbiter_timeout_plus_margin() {
    let fx = Fx::new();
    let id = fx.pay(1, UNIT);
    let ttl = fx.env.as_contract(&fx.id, || {
        fx.env.storage().persistent().get_ttl(&DataKey::Order(id.clone()))
    });
    let want = ((M_WINDOW + ARB_TIMEOUT + TTL_MARGIN_SECS) / SECS_PER_LEDGER) as u32;
    assert!(ttl >= want, "ttl {ttl} < {want}");
    assert!(ttl <= fx.env.storage().max_ttl());
    // 60-day window + 30-day timeout + margin stays below the cap used here.
    assert!(((MAX_WINDOW + MAX_ARBITER_TIMEOUT + TTL_MARGIN_SECS) / SECS_PER_LEDGER) < 180 * 17_280);
}

#[test]
fn events_carry_amounts_for_the_receipt_builder() {
    let fx = Fx::new();
    let id = fx.pay(1, 10 * UNIT);
    fx.c().refund(&id, &(2 * UNIT));
    let evs = fx.env.events().all().filter_by_contract(&fx.id);
    let expected = RefundEvent {
        order_id: id.clone(),
        amount: 2 * UNIT,
        refunded: 2 * UNIT,
    };
    assert_eq!(evs.events().last().unwrap().clone(), expected.to_xdr(&fx.env, &fx.id));
}
