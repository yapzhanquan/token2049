//// Bulkhead Session Vault (Plutus V3, spend purpose).
////
//// One parameterised script per agent session. The vault address is the APPLIED script's
//// payment credential + the OWNER's stake credential, so idle session funds stay staked to the owner.
////
//// Redeemers (VaultAction): Pay | Revoke | Recover. No other constructor decodes.
////
//// "own address" = Address { Script(own hash), owner.stake_credential } (full address equality).
//// leaving (per asset) = Σ own inputs − Σ own outputs, computed over the WHOLE transaction, so several
//// vault inputs in one tx are checked together (no double satisfaction).
////
//// Inputs: every input whose PAYMENT credential is this script counts as an own input (a UTxO that
//// somebody sent to this script under a foreign stake credential is therefore also limited by Pay and
//// can only be swept to the owner). Outputs: only outputs at the exact own address count as own.
//// Both choices are strictly more conservative than "full address equality" alone.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite, IntervalBound}
use cardano/address.{Address, Credential, Script}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  Datum, InlineDatum, Input, Output, OutputReference, Transaction,
}

/// The only accepted redeemers: Constr 0 [] / Constr 1 [] / Constr 2 [].
pub type VaultAction {
  /// Session key pays an allowed payee, within the per-tx limits, before expiry.
  Pay
  /// Captain sweeps everything to the owner, any time.
  Revoke
  /// Anyone sweeps everything to the owner, strictly after expiry.
  Recover
}

validator session_vault(
  owner: Address,
  captain_vkh: VerificationKeyHash,
  session_vkh: VerificationKeyHash,
  expiry: Int,
  payees: List<Credential>,
  per_tx_max_tusd: Int,
  ada_allowance: Int,
  tusd_policy: PolicyId,
  tusd_name: AssetName,
) {
  spend(
    _datum: Option<Data>,
    redeemer: VaultAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, validity_range, extra_signatories, .. } = self

    // Our own script credential = payment credential of the input being validated.
    expect Some(own_input) = transaction.find_input(inputs, own_ref)
    expect Script(own_hash) = own_input.output.address.payment_credential
    let own_cred = Script(own_hash)
    let own_address = Address {
      payment_credential: own_cred,
      stake_credential: owner.stake_credential,
    }

    when redeemer is {
      Pay -> {
        // Upper bound present and ≤ expiry (unbounded / NegativeInfinity / PositiveInfinity rejected).
        expect IntervalBound { bound_type: Finite(upper), .. } = validity_range.upper_bound
        let leaving = leaving_value(inputs, outputs, own_cred, own_address)
        and {
          list.has(extra_signatories, session_vkh)?,
          (upper <= expiry)?,
          // Continuing own outputs: exact own address, inline datum, no reference script (a datum
          // HASH with an unknown preimage would brick the remaining funds for Revoke/Recover).
          // Every other output pays a payment credential in `payees`.
          list.all(
            outputs,
            fn(o) {
              if o.address == own_address {
                and {
                  is_inline(o.datum),
                  o.reference_script == None,
                }
              } else {
                list.has(payees, o.address.payment_credential)
              }
            },
          )?,
          only_ada_and_tusd_leave(leaving, tusd_policy, tusd_name)?,
          (assets.quantity_of(leaving, tusd_policy, tusd_name) <= per_tx_max_tusd)?,
          (assets.lovelace_of(leaving) <= ada_allowance)?,
        }
      }
      Revoke -> and {
          list.has(extra_signatories, captain_vkh)?,
          // Every output → owner; hence no own output remains (the owner address cannot be this
          // script: the script hash depends on the owner parameter).
          all_to_owner(outputs, owner)?,
        }
      Recover -> {
        expect IntervalBound { bound_type: Finite(lower), .. } = validity_range.lower_bound
        and {
          (lower > expiry)?,
          all_to_owner(outputs, owner)?,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

fn is_inline(d: Datum) -> Bool {
  when d is {
    InlineDatum(_) -> True
    _ -> False
  }
}

/// Every tx output goes to the owner address (so nothing stays at this script).
fn all_to_owner(outputs: List<Output>, owner: Address) -> Bool {
  list.all(outputs, fn(o) { o.address == owner })
}

/// Σ inputs paid from this script − Σ outputs at the exact own address, over the whole tx.
fn leaving_value(
  inputs: List<Input>,
  outputs: List<Output>,
  own_cred: Credential,
  own_address: Address,
) -> Value {
  let value_in = list.foldl(
    inputs,
    assets.zero,
    fn(i, acc) {
      if i.output.address.payment_credential == own_cred {
        assets.merge(acc, i.output.value)
      } else {
        acc
      }
    },
  )
  list.foldl(
    outputs,
    value_in,
    fn(o, acc) {
      if o.address == own_address {
        assets.merge(acc, assets.negate(o.value))
      } else {
        acc
      }
    },
  )
}

/// No asset other than lovelace and tUSD has a positive net outflow.
fn only_ada_and_tusd_leave(
  leaving: Value,
  tusd_policy: PolicyId,
  tusd_name: AssetName,
) -> Bool {
  list.all(
    assets.flatten(leaving),
    fn(entry) {
      let (p, a, q) = entry
      q <= 0 || p == assets.ada_policy_id || p == tusd_policy && a == tusd_name
    },
  )
}
