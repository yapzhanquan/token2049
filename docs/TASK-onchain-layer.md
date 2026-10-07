# Task: add Bulkhead's on-chain layer (Aiken Session Vault + staking + vote delegation) on PREPROD

(The user's brief, verbatim. Encodings are fixed in docs/VAULT-SPEC.md.)

Scope rules:
- PREPROD only. Refuse mainnet everywhere.
- NOWNodes is OUT OF SCOPE for this task: do not touch NOWNodes code, and do not use or remove it.
- Add ONLY what is listed here. If something seems useful but is not required by this task,
  write it in the README roadmap instead of building it.
- Keep the existing native-script session wallets working as `walletMode: "native"` (fallback).
  The new contract is `walletMode: "vault"` and becomes the default once all tests pass.
- Do not break any passing test. Run `pnpm verify:chain` and `pnpm e2e:preprod` at the end.

## 1. Smart contract: Bulkhead Session Vault (Aiken, Plutus V3) — the ONLY validator to write

### 1.1 Design (parameterised, one script address per session)
- Location: `contracts/` (Aiken project). Validator `session_vault.ak`, spend purpose.
- Parameters (applied off-chain per session, so every session has its own script hash/address):
  - `owner`: the owner's payment credential + full owner address (where everything returns)
  - `captain_vkh`: the captain's verification key hash
  - `session_vkh`: the session's verification key hash
  - `expiry`: POSIX time (ms)
  - `payees`: a list of allowed payment credentials (max 10; a plain list is enough, no Merkle tree)
  - `per_tx_max_tusd`: max tUSD that may leave the vault in one transaction
  - `ada_allowance`: max lovelace that may leave the vault in one transaction (covers the min-ADA
    attached to payee outputs + the fee)
  - `tusd_policy`, `tusd_name`: identify tUSD
- Vault address = script payment credential + the OWNER's stake credential (so funds stay staked
  to the owner).
- Outputs to the vault carry inline datum `Void` (unit), for wallet/tool compatibility. The validator
  ignores datum content.

### 1.2 Redeemers and rules
Let "own" mean inputs/outputs whose address EQUALS this vault's full address (payment + stake
credential). Compute per asset: `leaving = sum(own inputs) - sum(own outputs)`.

`Pay`:
- signed by `session_vkh`
- tx validity range has an upper bound and that upper bound ≤ `expiry`
- every output whose address is not own pays to a payment credential in `payees`
- `leaving` contains only lovelace and tUSD (no other asset may leave)
- `leaving.tusd ≤ per_tx_max_tusd` and `leaving.lovelace ≤ ada_allowance`
- continuing own outputs keep exactly the same address (no stake-credential swap)
- checks are computed over the WHOLE transaction (not per input), so several own inputs in one tx
  cannot double-count (double satisfaction)

`Revoke` (captain sweeps at any time):
- signed by `captain_vkh`
- every non-own output goes to the `owner` address, and no own outputs remain (full sweep)

`Recover` (anyone, after expiry — permissionless recovery):
- tx validity range lower bound > `expiry`
- every non-own output goes to the `owner` address, and no own outputs remain
- no signature required (so the owner can recover even if Bulkhead is offline)

Never allow any other redeemer. Reject an unbounded validity range for `Pay`.

### 1.3 Tests (`aiken check` must pass)
Unit + property tests for at least:
- Pay to an allowed payee within limits → ok.
- Pay to a non-allowed payee → fail. (This is the "attacker address" case.)
- tUSD over `per_tx_max_tusd` → fail. Lovelace over `ada_allowance` → fail.
- Pay after expiry / with no upper bound / upper bound > expiry → fail (test both bounds and the
  exact boundary).
- Missing session signature → fail. Wrong signer → fail.
- Extra asset leaving → fail.
- Two own inputs in one tx where the total exceeds the limit → fail.
- Change output to the same script but a different stake credential → fail.
- Revoke by captain sends all to owner → ok; Revoke by anyone else → fail; Revoke leaving funds
  elsewhere → fail.
- Recover before expiry → fail; after expiry by a random party, all to owner → ok; any output not to
  the owner → fail.
Report execution units (mem/steps) for Pay, Revoke and Recover with a realistic tx shape, and the
compiled script size. All must be well within protocol limits.

### 1.4 "ABI": blueprint, typed client, deployment record
- Build with `aiken build` → `contracts/plutus.json` (CIP-57 blueprint). Commit it. Record:
  - the unapplied validator hash
  - Aiken compiler version and Plutus version
- Generate a typed TypeScript wrapper in `packages/chain/src/vault/`:
  - `applyVaultParams(params) → { scriptCbor, scriptHash, address }`
  - typed redeemer builders `Pay`, `Revoke`, `Recover`
  - tx builders `buildVaultPay`, `buildVaultRevoke`, `buildVaultRecover` (Mesh), attaching the script
    in the tx (scripts are per-session, so no shared reference script is needed)
  - collateral: an ADA-only UTxO from the captain wallet, with collateral return; the captain
    co-signs as collateral provider
- Add a test that fails if the compiled script hash changes without an intentional version bump.
- `deployments/preprod.json` + `DEPLOYMENTS.md`, containing:
  - network, Aiken version, the blueprint path and the unapplied validator hash
  - parameter / redeemer / datum schemas (copied from the blueprint)
  - for the demo run, each session: applied script hash, vault address, and the funding / pay /
    revoke / recover tx hashes with preprod.cardanoscan.io links
  - execution units and script size

### 1.5 Integrate with Bulkhead
- `walletMode: "vault"`:
  - SessionManager creates the session's vault (apply params) and funds it from the treasury
    (exactly its budget + `ada_allowance` headroom).
  - The Signer still pre-checks policy (fast feedback), but the CHAIN is the final authority.
  - Close/kill uses `Revoke` (with the existing metadata 674 log/handback hashes).
  - `pnpm recover --session <id>` uses `Recover`.
- Approval-threshold logic stays off-chain (in the Signer + decision ledger). Do not put it in the
  contract.
- UI:
  - session panel shows "Enforced on-chain by Bulkhead Session Vault" + script hash + vault address
    link;
  - Session Tree / Agent Map unchanged otherwise.

### 1.6 On-chain attack proof (for the demo)
- Add `pnpm demo:attack-onchain`: builds a `Pay` tx signed by a real session key that sends tUSD to
  the attacker address, deliberately bypassing the Signer.
- Evaluate it, then try to submit it.
- Assert the script fails (capture the evaluation/submission error and show it). Note: the node
  rejects it before inclusion, so no collateral is lost.
- Record the result in CHAIN_VERIFICATION.md.

## 2. Staking: delegate the owner's stake key
- For each user treasury (custodial users; for self-custody users, build the tx for their wallet
  to sign):
  1. register the stake credential (stake registration certificate; record the deposit);
  2. delegate it to a preprod stake pool. The pool id is configurable (`STAKE_POOL_ID`); default to
     an active preprod pool chosen via the provider's pool list, and print which one.
- Session vault addresses already use the owner's stake credential. Assert this in a test, so
  session budgets count toward the owner's stake.
- Treasury card in the UI: "Staked to <pool ticker/id>" + tx link.
- Implement `withdrawRewards()` but do NOT claim rewards in the demo (preprod epochs take days).
  Test the tx builder with a zero/available amount only if the chain allows; otherwise document it.
- Add a "stop staking" option (deregister, refund the deposit) behind a confirm.

## 3. Governance: vote delegation (required for reward withdrawals in Conway)
- With the staking setup, add a vote-delegation certificate for the same stake credential:
  - default: `always_abstain`;
  - optional: a user-chosen DRep id (`DREP_ID` or a UI field).
- Show "Voting power delegated: Always abstain / <DRep>" on the treasury card.
- Explain in the README why this is needed: since the Conway era, reward withdrawals require the
  stake credential to have delegated its vote.
- Nothing else for governance (no proposals, no voting UI).

## 4. Tests and verification
- Off-chain integration tests on PREPROD, vault mode:
  - fund a vault → Pay an allowed payee (confirmed) → Pay over the limit (rejected by script) →
    Pay to the attacker (rejected by script) → Revoke (everything returns to owner, metadata 674
    present) → a second vault with a short expiry → Recover by a random key after expiry.
- Staking: registration + pool delegation + vote delegation txs confirmed; the stake address shows
  the pool and DRep via the provider.
- Re-run the full demo scenario in vault mode (3 sessions in parallel, hired agent, attack,
  approval, closes). All leftovers return to the treasury.
- Update CHAIN_VERIFICATION.md and DEPLOYMENTS.md with every tx hash, script hash, the exec units
  and the pool/DRep ids.
- Finish with `pnpm verify:chain` and `pnpm e2e:preprod` passing.

## 5. Report back
- What was built (files), test results, and exec units.
- The deployment table (script hashes, addresses, tx links).
- Anything that could not be verified on preprod and why.
- What you deliberately did NOT build and added to the roadmap (e.g. CIP-68 mandate tokens,
  hierarchical mandates, Merkle allowlists).
