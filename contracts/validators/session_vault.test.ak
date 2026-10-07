// Tests for the Bulkhead Session Vault (validators/session_vault.ak).
// Boolean-toggle style: one valid tx per redeemer, then one failing tx per guard, plus property tests.
use aiken/fuzz
use aiken/interval.{
  Finite, Interval, IntervalBound, NegativeInfinity, PositiveInfinity,
}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use session_vault.{Pay, Recover, Revoke}

// ── fixtures ─────────────────────────────────────────────────────────────────

const own_hash = #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const owner_pkh = #"01010101010101010101010101010101010101010101010101010101"

const owner_skh = #"02020202020202020202020202020202020202020202020202020202"

const captain = #"03030303030303030303030303030303030303030303030303030303"

const session = #"04040404040404040404040404040404040404040404040404040404"

const payee_pkh = #"05050505050505050505050505050505050505050505050505050505"

const payee2_pkh = #"06060606060606060606060606060606060606060606060606060606"

const attacker = #"07070707070707070707070707070707070707070707070707070707"

const stranger = #"08080808080808080808080808080808080808080808080808080808"

const tusd_policy = #"09090909090909090909090909090909090909090909090909090909"

const tusd_name = "tUSD"

const other_policy = #"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"

const expiry = 1_760_000_000_000

const max_tusd = 5_000_000

const ada_allowance = 3_000_000

fn owner() -> Address {
  Address {
    payment_credential: VerificationKey(owner_pkh),
    stake_credential: Some(Inline(VerificationKey(owner_skh))),
  }
}

fn vault() -> Address {
  Address {
    payment_credential: Script(own_hash),
    stake_credential: Some(Inline(VerificationKey(owner_skh))),
  }
}

fn payees() {
  [VerificationKey(payee_pkh), VerificationKey(payee2_pkh)]
}

fn key_addr(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

fn oref(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    output_index: i,
  }
}

fn value(lovelace: Int, tusd: Int) {
  assets.from_lovelace(lovelace) |> assets.add(tusd_policy, tusd_name, tusd)
}

fn vault_input(i: Int, lovelace: Int, tusd: Int) -> Input {
  Input {
    output_reference: oref(i),
    output: Output {
      address: vault(),
      value: value(lovelace, tusd),
      datum: InlineDatum(Void),
      reference_script: None,
    },
  }
}

fn out(address: Address, lovelace: Int, tusd: Int) -> Output {
  Output {
    address,
    value: value(lovelace, tusd),
    datum: NoDatum,
    reference_script: None,
  }
}

fn vault_out(lovelace: Int, tusd: Int) -> Output {
  Output { ..out(vault(), lovelace, tusd), datum: InlineDatum(Void) }
}

fn upper(t: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound {
      bound_type: NegativeInfinity,
      is_inclusive: True,
    },
    upper_bound: IntervalBound { bound_type: Finite(t), is_inclusive: False },
  }
}

fn lower(t: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(t), is_inclusive: True },
    upper_bound: IntervalBound {
      bound_type: PositiveInfinity,
      is_inclusive: True,
    },
  }
}

fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  signers: List<ByteArray>,
  range: Interval,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    outputs,
    extra_signatories: signers,
    validity_range: range,
    fee: 400_000,
  }
}

fn run(redeemer, t: Transaction) -> Bool {
  let d: Data = Void
  session_vault.session_vault.spend(
    owner(),
    captain,
    session,
    expiry,
    payees(),
    max_tusd,
    ada_allowance,
    tusd_policy,
    tusd_name,
    Some(d),
    redeemer,
    oref(0),
    t,
  )
}

// A realistic Pay: vault UTxO (20 ADA, 50 tUSD) → payee 1.2 ADA + 2 tUSD, change back to the vault,
// fee 0.4 ADA from the vault. Leaving = 1.6 ADA + 2 tUSD. Signed by session + captain (collateral).
fn good_pay() -> Transaction {
  tx(
    [vault_input(0, 20_000_000, 50_000_000)],
    [
      out(key_addr(payee_pkh), 1_200_000, 2_000_000),
      vault_out(18_400_000, 48_000_000),
    ],
    [session, captain],
    upper(expiry - 600_000),
  )
}

// ── Pay ──────────────────────────────────────────────────────────────────────

test pay_allowed_payee_within_limits() {
  run(Pay, good_pay())
}

test pay_exactly_at_limits() {
  run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(key_addr(payee_pkh), 2_600_000, max_tusd),
        vault_out(20_000_000 - ada_allowance, 50_000_000 - max_tusd),
      ],
      [session],
      upper(expiry),
    ),
  )
}

test pay_full_drain_when_within_limits() {
  // No continuing output at all is fine for Pay as long as the limits hold.
  run(
    Pay,
    tx(
      [vault_input(0, 3_000_000, 1_000_000)],
      [out(key_addr(payee2_pkh), 2_600_000, 1_000_000)],
      [session],
      upper(expiry),
    ),
  )
}

test pay_to_attacker_fails() {
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(key_addr(attacker), 1_200_000, 2_000_000),
        vault_out(18_400_000, 48_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_extra_output_to_attacker_fails() {
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(key_addr(payee_pkh), 1_200_000, 1_000_000),
        out(key_addr(attacker), 1_000_000, 0),
        vault_out(17_400_000, 49_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_attacker_with_payee_stake_cred_fails() {
  // Same stake credential as the payee doesn't help: the PAYMENT credential is checked.
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(
          Address {
            payment_credential: VerificationKey(attacker),
            stake_credential: Some(Inline(VerificationKey(payee_pkh))),
          },
          1_200_000,
          2_000_000,
        ),
        vault_out(18_400_000, 48_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_tusd_over_limit_fails() {
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(key_addr(payee_pkh), 1_200_000, max_tusd + 1),
        vault_out(18_400_000, 50_000_000 - max_tusd - 1),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_lovelace_over_allowance_fails() {
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000)],
      [
        out(key_addr(payee_pkh), 2_600_001, 1_000_000),
        vault_out(20_000_000 - ada_allowance - 1, 49_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_upper_bound_at_expiry_ok() {
  run(Pay, tx(good_pay().inputs, good_pay().outputs, [session], upper(expiry)))
}

test pay_upper_bound_after_expiry_fails() {
  !run(
    Pay,
    tx(good_pay().inputs, good_pay().outputs, [session], upper(expiry + 1)),
  )
}

test pay_after_expiry_fails() {
  // Validity range entirely after expiry.
  !run(
    Pay,
    tx(
      good_pay().inputs,
      good_pay().outputs,
      [session],
      interval.between(expiry + 1, expiry + 600_000),
    ),
  )
}

test pay_no_upper_bound_fails() fail {
  run(Pay, tx(good_pay().inputs, good_pay().outputs, [session], lower(0)))
}

test pay_unbounded_range_fails() fail {
  run(
    Pay,
    tx(good_pay().inputs, good_pay().outputs, [session], interval.everything),
  )
}

test pay_missing_session_signature_fails() {
  !run(
    Pay,
    tx(good_pay().inputs, good_pay().outputs, [], upper(expiry - 600_000)),
  )
}

test pay_wrong_signer_fails() {
  // Captain or a stranger cannot Pay.
  and {
    !run(
      Pay,
      tx(
        good_pay().inputs,
        good_pay().outputs,
        [captain, stranger],
        upper(expiry - 600_000),
      ),
    ),
    !run(
      Pay,
      tx(good_pay().inputs, good_pay().outputs, [owner_pkh], upper(expiry)),
    ),
  }
}

test pay_extra_asset_leaving_fails() {
  let input = Input {
    output_reference: oref(0),
    output: Output {
      ..vault_input(0, 20_000_000, 50_000_000).output,
      value: value(20_000_000, 50_000_000)
        |> assets.add(other_policy, "NFT", 1),
    },
  }
  !run(
    Pay,
    tx(
      [input],
      [
        Output {
          ..out(key_addr(payee_pkh), 1_200_000, 2_000_000),
          value: value(1_200_000, 2_000_000)
            |> assets.add(other_policy, "NFT", 1),
        },
        vault_out(18_400_000, 48_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_other_tusd_name_counts_as_extra_asset() {
  // A token under the tUSD policy but with another name is NOT tUSD.
  let input = Input {
    output_reference: oref(0),
    output: Output {
      ..vault_input(0, 20_000_000, 50_000_000).output,
      value: value(20_000_000, 50_000_000)
        |> assets.add(tusd_policy, "tUSDx", 7),
    },
  }
  !run(
    Pay,
    tx(
      [input],
      [
        Output {
          ..out(key_addr(payee_pkh), 1_200_000, 0),
          value: value(1_200_000, 0) |> assets.add(tusd_policy, "tUSDx", 7),
        },
        vault_out(18_400_000, 50_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_two_own_inputs_total_over_limit_fails() {
  // Each input alone "pays" 3 tUSD (≤ 5), but the tx moves 6 tUSD out of the vault in total.
  // Validated from either input's point of view: the whole-tx sum is what counts.
  let t = tx(
    [
      vault_input(0, 10_000_000, 3_000_000),
      vault_input(1, 10_000_000, 3_000_000),
    ],
    [out(key_addr(payee_pkh), 1_200_000, 6_000_000), vault_out(18_400_000, 0)],
    [session],
    upper(expiry - 600_000),
  )
  let d: Data = Void
  and {
    !run(Pay, t),
    !session_vault.session_vault.spend(
      owner(),
      captain,
      session,
      expiry,
      payees(),
      max_tusd,
      ada_allowance,
      tusd_policy,
      tusd_name,
      Some(d),
      Pay,
      oref(1),
      t,
    ),
  }
}

test pay_two_own_inputs_within_limit_ok() {
  run(
    Pay,
    tx(
      [
        vault_input(0, 10_000_000, 3_000_000),
        vault_input(1, 10_000_000, 3_000_000),
      ],
      [
        out(key_addr(payee_pkh), 1_200_000, 4_000_000),
        vault_out(18_400_000, 2_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_change_to_other_stake_credential_fails() {
  // Change goes to the same script but with the attacker's stake credential.
  !run(
    Pay,
    tx(
      good_pay().inputs,
      [
        out(key_addr(payee_pkh), 1_200_000, 2_000_000),
        Output {
          ..vault_out(18_400_000, 48_000_000),
          address: Address {
            payment_credential: Script(own_hash),
            stake_credential: Some(Inline(VerificationKey(attacker))),
          },
        },
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_change_to_enterprise_script_address_fails() {
  !run(
    Pay,
    tx(
      good_pay().inputs,
      [
        out(key_addr(payee_pkh), 1_200_000, 2_000_000),
        Output {
          ..vault_out(18_400_000, 48_000_000),
          address: address.from_script(own_hash),
        },
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_foreign_stake_input_is_still_limited() {
  // A UTxO at our script under another stake credential is counted as an own input:
  // draining it to a payee above the limit fails.
  let foreign = Input {
    output_reference: oref(1),
    output: Output {
      ..vault_input(1, 10_000_000, 40_000_000).output,
      address: address.from_script(own_hash),
    },
  }
  !run(
    Pay,
    tx(
      [vault_input(0, 20_000_000, 50_000_000), foreign],
      [
        out(key_addr(payee_pkh), 11_200_000, 42_000_000),
        vault_out(18_400_000, 48_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

// ── Revoke ───────────────────────────────────────────────────────────────────

fn sweep_tx(signers: List<ByteArray>, range: Interval) -> Transaction {
  tx(
    [
      vault_input(0, 20_000_000, 50_000_000),
      vault_input(1, 5_000_000, 1_000_000),
    ],
    [out(owner(), 24_600_000, 51_000_000)],
    signers,
    range,
  )
}

test revoke_by_captain_all_to_owner_ok() {
  and {
    run(Revoke, sweep_tx([captain], upper(expiry - 600_000))),
    // Any time, even after expiry and with no bounds at all.
    run(Revoke, sweep_tx([captain], interval.everything)),
    run(Revoke, sweep_tx([captain], lower(expiry + 10_000_000))),
  }
}

test revoke_by_anyone_else_fails() {
  and {
    !run(Revoke, sweep_tx([session], interval.everything)),
    !run(Revoke, sweep_tx([owner_pkh], interval.everything)),
    !run(Revoke, sweep_tx([stranger], interval.everything)),
    !run(Revoke, sweep_tx([], interval.everything)),
  }
}

test revoke_leaving_funds_elsewhere_fails() {
  !run(
    Revoke,
    tx(
      sweep_tx([], interval.everything).inputs,
      [
        out(owner(), 23_600_000, 50_000_000),
        out(key_addr(attacker), 1_000_000, 1_000_000),
      ],
      [captain],
      interval.everything,
    ),
  )
}

test revoke_leaving_funds_in_vault_fails() {
  !run(
    Revoke,
    tx(
      sweep_tx([], interval.everything).inputs,
      [out(owner(), 20_000_000, 1_000_000), vault_out(4_600_000, 50_000_000)],
      [captain],
      interval.everything,
    ),
  )
}

test revoke_to_owner_payment_key_other_stake_fails() {
  // The FULL owner address is required (no stake-credential swap on the way home).
  !run(
    Revoke,
    tx(
      sweep_tx([], interval.everything).inputs,
      [out(key_addr(owner_pkh), 24_600_000, 51_000_000)],
      [captain],
      interval.everything,
    ),
  )
}

// ── Recover ──────────────────────────────────────────────────────────────────

test recover_after_expiry_by_random_party_ok() {
  // No signer at all (or a random one): permissionless.
  and {
    run(Recover, sweep_tx([], lower(expiry + 1))),
    run(
      Recover,
      sweep_tx([stranger], interval.between(expiry + 1_000, expiry + 900_000)),
    ),
  }
}

test recover_at_exact_expiry_fails() {
  !run(Recover, sweep_tx([], lower(expiry)))
}

test recover_before_expiry_fails() {
  and {
    !run(Recover, sweep_tx([captain], lower(expiry - 1))),
    !run(
      Recover,
      sweep_tx([], interval.between(expiry - 600_000, expiry + 600_000)),
    ),
  }
}

test recover_without_lower_bound_fails() fail {
  run(Recover, sweep_tx([], upper(expiry + 600_000)))
}

test recover_output_not_to_owner_fails() {
  !run(
    Recover,
    tx(
      sweep_tx([], interval.everything).inputs,
      [
        out(owner(), 23_600_000, 50_000_000),
        out(key_addr(stranger), 1_000_000, 1_000_000),
      ],
      [stranger],
      lower(expiry + 1),
    ),
  )
}

test recover_leaving_funds_in_vault_fails() {
  !run(
    Recover,
    tx(
      sweep_tx([], interval.everything).inputs,
      [out(owner(), 20_000_000, 1_000_000), vault_out(4_600_000, 50_000_000)],
      [],
      lower(expiry + 1),
    ),
  )
}

// ── Other ────────────────────────────────────────────────────────────────────

test pay_change_with_datum_hash_fails() {
  // A continuing output locked by a datum HASH (unknown preimage) would brick the vault.
  !run(
    Pay,
    tx(
      good_pay().inputs,
      [
        out(key_addr(payee_pkh), 1_200_000, 2_000_000),
        Output {
          ..vault_out(18_400_000, 48_000_000),
          datum: DatumHash(
            #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          ),
        },
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_change_without_datum_fails() {
  !run(
    Pay,
    tx(
      good_pay().inputs,
      [
        out(key_addr(payee_pkh), 1_200_000, 2_000_000),
        out(vault(), 18_400_000, 48_000_000),
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

test pay_change_with_reference_script_fails() {
  !run(
    Pay,
    tx(
      good_pay().inputs,
      [
        out(key_addr(payee_pkh), 1_200_000, 2_000_000),
        Output {
          ..vault_out(18_400_000, 48_000_000),
          reference_script: Some(own_hash),
        },
      ],
      [session],
      upper(expiry - 600_000),
    ),
  )
}

// ── Property tests ───────────────────────────────────────────────────────────

/// Pay passes iff the tUSD leaving is ≤ per_tx_max_tusd (all else valid).
test prop_pay_tusd_limit(amount via fuzz.int_between(1, 15_000_000)) {
  let t = tx(
    [vault_input(0, 20_000_000, 50_000_000)],
    [
      out(key_addr(payee_pkh), 1_200_000, amount),
      vault_out(18_400_000, 50_000_000 - amount),
    ],
    [session],
    upper(expiry),
  )
  run(Pay, t) == ( amount <= max_tusd )
}

/// Pay passes iff the lovelace leaving (payee min-ADA + fee) is ≤ ada_allowance.
test prop_pay_lovelace_limit(leave via fuzz.int_between(1_000_000, 10_000_000)) {
  let t = tx(
    [vault_input(0, 20_000_000, 50_000_000)],
    [
      out(key_addr(payee_pkh), leave, 1_000_000),
      vault_out(20_000_000 - leave, 49_000_000),
    ],
    [session],
    upper(expiry),
  )
  run(Pay, t) == ( leave <= ada_allowance )
}

/// Pay passes iff the validity upper bound is ≤ expiry (boundary included).
test prop_pay_upper_bound(
  delta via fuzz.either(fuzz.int_between(-1_000, 1_000), fuzz.int()),
) {
  let u = expiry + delta
  run(Pay, tx(good_pay().inputs, good_pay().outputs, [session], upper(u))) == (
    u <= expiry
  )
}

/// Recover passes iff the validity lower bound is strictly > expiry (boundary excluded).
test prop_recover_lower_bound(
  delta via fuzz.either(fuzz.int_between(-1_000, 1_000), fuzz.int()),
) {
  let l = expiry + delta
  run(Recover, sweep_tx([], lower(l))) == ( l > expiry )
}

/// Splitting the vault over N own inputs never lets more than the limit leave in one tx.
test prop_split_inputs_cannot_double_count(
  parts via fuzz.list_between(fuzz.int_between(1, 4_000_000), 1, 6),
) {
  let inputs = list_indexed_inputs(parts, 0)
  let total = sum(parts)
  let t = tx(
    inputs,
    [out(key_addr(payee_pkh), 1_000_000 * list_length(parts), total)],
    [session],
    upper(expiry),
  )
  run(Pay, t) == (
    total <= max_tusd && 1_000_000 * list_length(parts) <= ada_allowance
  )
}

/// Any payment credential outside the payee list is rejected.
test prop_pay_non_payee_rejected(pkh via fuzz.bytearray_fixed(28)) {
  let allowed = pkh == payee_pkh || pkh == payee2_pkh
  let t = tx(
    [vault_input(0, 20_000_000, 50_000_000)],
    [
      out(key_addr(pkh), 1_200_000, 2_000_000),
      vault_out(18_400_000, 48_000_000),
    ],
    [session],
    upper(expiry),
  )
  run(Pay, t) == allowed
}

/// Revoke passes only for the captain's signature.
test prop_revoke_signer(pkh via fuzz.bytearray_fixed(28)) {
  run(Revoke, sweep_tx([pkh], interval.everything)) == ( pkh == captain )
}

fn list_indexed_inputs(parts: List<Int>, i: Int) -> List<Input> {
  when parts is {
    [] -> []
    [p, ..rest] ->
      [vault_input(i, 1_000_000, p), ..list_indexed_inputs(rest, i + 1)]
  }
}

fn sum(xs: List<Int>) -> Int {
  when xs is {
    [] -> 0
    [x, ..rest] -> x + sum(rest)
  }
}

fn list_length(xs: List<a>) -> Int {
  when xs is {
    [] -> 0
    [_, ..rest] -> 1 + list_length(rest)
  }
}
