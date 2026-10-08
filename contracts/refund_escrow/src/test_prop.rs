//! Property test: 300 seeded random sequences of up to 60 steps across 3
//! merchants, 6 buyers and 2 tokens. After every step the §6 invariants are
//! checked against on-chain state:
//!
//! * per order: `amount == held + refunded + released + fee`,
//!   `0 <= refund_owed <= refunded`, and the fee never exceeds the fee on the
//!   non-refunded value;
//! * per token: `balance(contract) == Σ held + Σ refund_owed + Fees(token)`;
//! * per address, exact conservation: every balance equals its mint, minus what
//!   it paid in, plus refunds it received as some order's `refund_to`, plus
//!   releases it received as some order's `payout`, plus fees withdrawn to it as
//!   `fee_to`. In particular the admin, both arbiters, the merchants' signing
//!   addresses and the attackers never gain a single stroop;
//! * terminal orders never change, except `refund_owed -> 0` via `settle_refund`.
//!
//! No extra crate: a xorshift64 generator with fixed seeds. Every call runs
//! with mocked auth (auth is covered in `test.rs`), so the only acceptable
//! failures are this contract's own error codes; they are counted per code.
extern crate std;

use super::*;
use crate::test::T0;
use soroban_sdk::testutils::{Address as _, EnvTestConfig, IssuerFlags, Ledger as _};
use soroban_sdk::token;
use std::collections::BTreeMap;
use std::vec::Vec as StdVec;

const SEQUENCES: u64 = 300;
const MAX_STEPS: u64 = 60;
const UNIT: i128 = 10_000_000;
const MINT: i128 = 1_000_000 * UNIT;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[self.below(v.len() as u64) as usize]
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

struct World {
    env: Env,
    id: Address,
    tokens: StdVec<Address>,
    admin: Address,
    arbiters: StdVec<Address>,
    fee_to: Address,
    merchants: StdVec<Address>,
    payouts: StdVec<StdVec<Address>>,
    buyers: StdVec<Address>,
    refund_addrs: StdVec<Address>,
    attackers: StdVec<Address>,
    orders: StdVec<BytesN<32>>,
    /// Snapshot of terminal orders, to prove they never change.
    terminal: BTreeMap<[u8; 32], Order>,
    /// Fees withdrawn to fee_to, per token index.
    withdrawn: StdVec<i128>,
    next_id: u32,
}

#[derive(Default)]
struct Tally {
    ok: BTreeMap<&'static str, u32>,
    err: BTreeMap<u32, u32>,
}

impl Tally {
    fn rec<T, C>(&mut self, step: &'static str, r: Result<Result<T, C>, Result<Error, soroban_sdk::InvokeError>>) -> bool {
        match r {
            Ok(Ok(_)) => {
                *self.ok.entry(step).or_default() += 1;
                true
            }
            Err(Ok(e)) => {
                *self.err.entry(e as u32).or_default() += 1;
                false
            }
            _ => panic!("step {step}: unexpected host error with all auths mocked"),
        }
    }
}

impl World {
    fn new(rng: &mut Rng) -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            // 300 environments: do not write 300 snapshot files.
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(T0);
        let g = |e: &Env| Address::generate(e);
        let admin = g(&env);
        let arbiters = std::vec![g(&env), g(&env)];
        let fee_to = g(&env);
        let id = env.register(
            RefundEscrow,
            (admin.clone(), arbiters[0].clone(), fee_to.clone(), 7 * DAY, 3_600u64, 60 * DAY),
        );
        let issuer = g(&env);
        let sac_a = env.register_stellar_asset_contract_v2(issuer.clone());
        sac_a.issuer().set_flag(IssuerFlags::RevocableFlag);
        let sac_b = env.register_stellar_asset_contract_v2(issuer);
        let tokens = std::vec![sac_a.address(), sac_b.address()];
        let merchants: StdVec<Address> = (0..3).map(|_| g(&env)).collect();
        let payouts: StdVec<StdVec<Address>> = (0..3).map(|_| std::vec![g(&env), g(&env)]).collect();
        let buyers: StdVec<Address> = (0..6).map(|_| g(&env)).collect();
        let refund_addrs: StdVec<Address> = (0..3).map(|_| g(&env)).collect();
        let attackers: StdVec<Address> = (0..2).map(|_| g(&env)).collect();
        let c = RefundEscrowClient::new(&env, &id);
        for t in &tokens {
            c.set_token(t, &true);
            for b in &buyers {
                token::StellarAssetClient::new(&env, t).mint(b, &MINT);
            }
        }
        let fee_choices = [0u32, 125, 150, 1_000];
        let windows = [3_600u64, 3 * DAY, 14 * DAY];
        for (i, m) in merchants.iter().enumerate() {
            c.add_merchant(m, &payouts[i][0], rng.pick(&fee_choices), &windows[i]);
        }
        World {
            env,
            id,
            tokens,
            admin,
            arbiters,
            fee_to,
            merchants,
            payouts,
            buyers,
            refund_addrs,
            attackers,
            orders: StdVec::new(),
            terminal: BTreeMap::new(),
            withdrawn: std::vec![0, 0],
            next_id: 0,
        }
    }

    fn hash(&self, n: u32) -> BytesN<32> {
        let mut a = [0x5Au8; 32];
        a[..4].copy_from_slice(&n.to_be_bytes());
        BytesN::from_array(&self.env, &a)
    }

    fn any_order(&self, rng: &mut Rng) -> BytesN<32> {
        if self.orders.is_empty() || rng.chance(3) {
            return self.hash(9_999_999); // unknown id
        }
        rng.pick(&self.orders).clone()
    }

    fn step(&mut self, rng: &mut Rng, t: &mut Tally) {
        let env = self.env.clone();
        let cid = self.id.clone();
        let c = RefundEscrowClient::new(&env, &cid);
        match rng.below(16) {
            0..=2 => {
                let buyer = rng.pick(&self.buyers).clone();
                let merchant = rng.pick(&self.merchants).clone();
                let tok = rng.pick(&self.tokens).clone();
                let amount: i128 = match rng.below(10) {
                    0 => 1 + rng.below(100) as i128,                // dust
                    1 => [0i128, -1, MAX_AMOUNT + 1][rng.below(3) as usize], // invalid
                    _ => (1 + rng.below(500) as i128) * UNIT + rng.below(10_000_000) as i128,
                };
                let refund_to = match rng.below(10) {
                    0 | 1 => Some(rng.pick(&self.refund_addrs).clone()),
                    2 => Some(buyer.clone()),
                    _ => None,
                };
                let window = match rng.below(20) {
                    0..=13 => None,
                    14..=18 => Some(3_600 + rng.below(20 * DAY)),
                    _ => Some(if rng.chance(50) { 3_599 } else { 60 * DAY + 1 }),
                };
                let oid = if !self.orders.is_empty() && rng.chance(5) {
                    rng.pick(&self.orders).clone() // duplicate
                } else {
                    self.next_id += 1;
                    self.hash(self.next_id)
                };
                let r = c.try_pay(&buyer, &merchant, &oid, &tok, &amount, &refund_to, &window, &self.hash(0));
                if t.rec("pay", r) {
                    self.orders.push(oid);
                }
            }
            3 | 4 => {
                let oid = self.any_order(rng);
                let held = c.order(&oid).map(|o| o.held).unwrap_or(0);
                let amount = match rng.below(6) {
                    0 => held,
                    1 => held + 1,
                    _ => 1 + (rng.next() as i128).rem_euclid(held.max(1)),
                };
                t.rec("refund", c.try_refund(&oid, &amount));
            }
            5 => {
                let oid = self.any_order(rng);
                let reason = *rng.pick(&[1u32, 2, 3, 4, 5, 99, 1, 2, 0, 7]);
                t.rec("dispute", c.try_dispute(&oid, &reason, &self.hash(1)));
            }
            6 => {
                let oid = self.any_order(rng);
                if rng.chance(50) {
                    t.rec("respond", c.try_respond(&oid, &self.hash(2)));
                } else {
                    t.rec("withdraw_dispute", c.try_withdraw_dispute(&oid));
                }
            }
            7 | 8 => {
                let oid = self.any_order(rng);
                let held = c.order(&oid).map(|o| o.held).unwrap_or(0);
                let split = match rng.below(8) {
                    0 => held + 1 + (rng.below(1_000) as i128),
                    1 => 0,
                    2 => held,
                    3 => -1,
                    _ => (rng.next() as i128).rem_euclid(held + 1),
                };
                t.rec("resolve", c.try_resolve(&oid, &split, &self.hash(3)));
            }
            9 => {
                let oid = self.any_order(rng);
                t.rec("timeout_refund", c.try_timeout_refund(&oid));
            }
            10 => {
                let oid = self.any_order(rng);
                t.rec("release", c.try_release(&oid));
            }
            11 => {
                let n = if rng.chance(10) { 26 } else { rng.below(12) };
                let mut ids = soroban_sdk::Vec::new(&self.env);
                for _ in 0..n {
                    ids.push_back(self.any_order(rng));
                }
                t.rec("release_many", c.try_release_many(&ids));
            }
            12 => {
                // Prefer orders that actually owe something.
                let owing: StdVec<BytesN<32>> = self
                    .orders
                    .iter()
                    .filter(|o| c.order(o).map(|x| x.refund_owed > 0).unwrap_or(false))
                    .cloned()
                    .collect();
                let oid = if !owing.is_empty() && rng.chance(70) {
                    let oid = rng.pick(&owing).clone();
                    if rng.chance(60) {
                        // and give the receiver its trustline back first
                        let o = c.order(&oid).unwrap();
                        token::StellarAssetClient::new(&self.env, &o.token).set_authorized(&o.refund_to, &true);
                    }
                    oid
                } else {
                    self.any_order(rng)
                };
                t.rec("settle_refund", c.try_settle_refund(&oid));
            }
            13 => {
                let i = rng.below(2) as usize;
                let tok = self.tokens[i].clone();
                let r = c.try_withdraw_fees(&tok);
                if let Ok(Ok(v)) = &r {
                    self.withdrawn[i] += *v;
                }
                t.rec("withdraw_fees", r);
            }
            14 => {
                // advance time: minutes, hours or up to 20 days
                let dt = match rng.below(3) {
                    0 => rng.below(3_600),
                    1 => rng.below(2 * DAY),
                    _ => rng.below(20 * DAY + 1),
                };
                self.env.ledger().with_mut(|l| l.timestamp += dt);
                *t.ok.entry("advance_time").or_default() += 1;
            }
            _ => match rng.below(4) {
                0 => {
                    let i = rng.below(3) as usize;
                    let p = rng.pick(&self.payouts[i]).clone();
                    t.rec("set_payout", c.try_set_payout(&self.merchants[i], &p));
                }
                1 => {
                    let a = rng.pick(&self.arbiters).clone();
                    c.set_arbiter(&a);
                    *t.ok.entry("set_arbiter").or_default() += 1;
                }
                _ => {
                    // A buyer, refund address or payout loses / regains the
                    // ability to receive token A (a removed trustline).
                    let mut pool = self.buyers.clone();
                    pool.extend(self.refund_addrs.iter().cloned());
                    pool.extend(self.payouts.iter().flatten().cloned());
                    // Half the time, target the refund_to of an open token-A order.
                    let open_a: StdVec<Address> = self
                        .orders
                        .iter()
                        .filter_map(|o| c.order(o))
                        .filter(|o| o.token == self.tokens[0] && !o.state.is_terminal())
                        .map(|o| o.refund_to)
                        .collect();
                    let who = if !open_a.is_empty() && rng.chance(50) {
                        rng.pick(&open_a).clone()
                    } else {
                        rng.pick(&pool).clone()
                    };
                    let on = rng.chance(60);
                    token::StellarAssetClient::new(&self.env, &self.tokens[0]).set_authorized(&who, &on);
                    *t.ok.entry("toggle_trustline").or_default() += 1;
                }
            },
        }
    }

    fn check(&mut self) {
        let env = self.env.clone();
        let cid = self.id.clone();
        let c = RefundEscrowClient::new(&env, &cid);
        let mut expected: BTreeMap<(Address, usize), i128> = BTreeMap::new();
        let mut contract_due = [0i128; 2];
        for oid in &self.orders {
            let o = c.order(oid).expect("paid order exists");
            // per-order invariants
            assert_eq!(o.amount, o.held + o.refunded + o.released + o.fee, "amount split");
            assert!(o.held >= 0 && o.released >= 0 && o.fee >= 0);
            assert!(o.refund_owed >= 0 && o.refund_owed <= o.refunded, "owed bounds");
            assert!(o.fee <= fee_for(o.amount - o.refunded, o.fee_bps).unwrap(), "fee on refunded value");
            if o.state.is_terminal() {
                assert_eq!(o.held, 0);
                assert!(o.closed_at > 0);
                let key = oid.to_array();
                if let Some(prev) = self.terminal.get(&key) {
                    let mut a = prev.clone();
                    let mut b = o.clone();
                    assert!(b.refund_owed == a.refund_owed || b.refund_owed == 0, "owed only goes to 0");
                    a.refund_owed = 0;
                    b.refund_owed = 0;
                    assert_eq!(a, b, "terminal order changed");
                }
                self.terminal.insert(key, o.clone());
            } else {
                assert!(o.held > 0, "open orders hold funds");
            }
            let ti = self.tokens.iter().position(|t| *t == o.token).unwrap();
            contract_due[ti] += o.held + o.refund_owed;
            *expected.entry((o.buyer.clone(), ti)).or_default() -= o.amount;
            *expected.entry((o.refund_to.clone(), ti)).or_default() += o.refunded - o.refund_owed;
            *expected.entry((o.payout.clone(), ti)).or_default() += o.released;
        }
        for (ti, tok) in self.tokens.iter().enumerate() {
            let tc = token::Client::new(&self.env, tok);
            // per-token invariant
            assert_eq!(tc.balance(&self.id), contract_due[ti] + c.fees(tok), "token invariant");
            *expected.entry((self.fee_to.clone(), ti)).or_default() += self.withdrawn[ti];
            // exact per-address conservation
            let mut everyone: StdVec<Address> = std::vec![self.admin.clone(), self.fee_to.clone()];
            everyone.extend(self.arbiters.iter().cloned());
            everyone.extend(self.merchants.iter().cloned());
            everyone.extend(self.payouts.iter().flatten().cloned());
            everyone.extend(self.buyers.iter().cloned());
            everyone.extend(self.refund_addrs.iter().cloned());
            everyone.extend(self.attackers.iter().cloned());
            for a in everyone {
                let minted = if self.buyers.contains(&a) { MINT } else { 0 };
                let want = minted + expected.get(&(a.clone(), ti)).copied().unwrap_or(0);
                assert_eq!(tc.balance(&a), want, "conservation for an address");
            }
            for a in self.arbiters.iter().chain(self.attackers.iter()).chain([&self.admin]) {
                assert_eq!(tc.balance(a), 0, "admin/arbiter/attacker balances never increase");
            }
            for m in &self.merchants {
                assert_eq!(tc.balance(m), 0, "merchant signing keys never receive order funds");
            }
        }
    }
}

#[test]
fn invariants_hold_over_random_sequences() {
    let mut totals = Tally::default();
    for seq in 0..SEQUENCES {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ (seq.wrapping_mul(0x2545_F491_4F6C_DD1D) + 1));
        let mut w = World::new(&mut rng);
        let steps = 1 + rng.below(MAX_STEPS);
        for _ in 0..steps {
            w.step(&mut rng, &mut totals);
            w.check();
        }
    }
    std::println!("property test: successes {:?}", totals.ok);
    std::println!("property test: expected failures by error code {:?}", totals.err);
    // The run must actually exercise the paths it claims to cover.
    for step in [
        "pay", "refund", "dispute", "respond", "withdraw_dispute", "resolve", "timeout_refund", "release",
        "release_many", "settle_refund", "withdraw_fees", "set_payout", "set_arbiter",
    ] {
        let n = totals.ok.get(step).copied().unwrap_or(0);
        assert!(n > 0, "step {step} never succeeded");
    }
    for code in [
        Error::InvalidAmount as u32,
        Error::DuplicateOrder as u32,
        Error::WindowOutOfRange as u32,
        Error::OrderNotFound as u32,
        Error::BadState as u32,
        Error::WindowClosed as u32,
        Error::WindowOpen as u32,
        Error::ArbiterExpired as u32,
        Error::ArbiterWindowOpen as u32,
        Error::NothingOwed as u32,
        Error::BatchTooLarge as u32,
        Error::BadReason as u32,
    ] {
        assert!(totals.err.get(&code).copied().unwrap_or(0) > 0, "error {code} never exercised");
    }
}
