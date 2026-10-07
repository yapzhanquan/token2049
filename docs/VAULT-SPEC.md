# Bulkhead Session Vault — shared spec (contract ⇄ off-chain ⇄ engine)

Source of truth for the task: `docs/TASK-onchain-layer.md` (the user's brief). This file fixes the exact
encodings so three agents can build in parallel. Change it only through the lead.

## Validator
- Aiken project in `contracts/`, validator file `validators/session_vault.ak`, **spend** purpose, Plutus V3,
  stdlib v3.x. Compiler: Aiken v1.1.24 (binary already on disk — see TEAM notes below).
- Parameters, IN THIS ORDER (applied off-chain per session with Mesh `applyParamsToScript`, type "JSON"
  Plutus data):

| # | name | Aiken type | Plutus data encoding |
|---|---|---|---|
| 1 | `owner` | `cardano/address.Address` | Constr 0 [payment Credential, Option<StakeCredential>] (standard Address) |
| 2 | `captain_vkh` | `VerificationKeyHash` | bytes (28) |
| 3 | `session_vkh` | `VerificationKeyHash` | bytes (28) |
| 4 | `expiry` | `Int` | POSIX ms |
| 5 | `payees` | `List<Credential>` | list of Credential (VerificationKey = Constr 0 [bytes], Script = Constr 1 [bytes]); max 10 |
| 6 | `per_tx_max_tusd` | `Int` | micro-tUSD |
| 7 | `ada_allowance` | `Int` | lovelace |
| 8 | `tusd_policy` | `PolicyId` | bytes (28) |
| 9 | `tusd_name` | `AssetName` | bytes (CIP-68 333 "tUSD" = 0014df1074555344; legacy 74555344 deprecated) |

- Redeemer: `type VaultAction { Pay | Revoke | Recover }` → Constr 0 [] / Constr 1 [] / Constr 2 [].
- Datum: outputs to a vault carry inline datum `Void` (unit = Constr 0 []). The validator ignores datum
  content (accept `Option<Data>` / `Data`).
- Vault address = script payment credential (hash of the APPLIED script) + the owner's stake credential
  (StakeCredential = Inline(VerificationKey ownerStakeKeyHash)); enterprise script address if the owner has
  no stake credential.

## Rules (see the task brief §1.2 for the authoritative wording)
- "own" = input/output whose address EQUALS the vault's full address (payment + stake credential).
- `leaving` (per asset) = Σ own inputs − Σ own outputs, over the WHOLE tx.
- `Pay`: signed by session_vkh; validity upper bound present AND ≤ expiry; every non-own output pays to a
  payment credential in `payees`; `leaving` has only lovelace + tUSD; leaving.tusd ≤ per_tx_max_tusd;
  leaving.lovelace ≤ ada_allowance; continuing own outputs keep exactly the same address.
- `Revoke`: signed by captain_vkh; every non-own output → owner address; no own outputs remain.
- `Recover`: validity lower bound > expiry (strict); every non-own output → owner; no own outputs remain;
  no signature required.
- Fees are paid from vault funds (ada_allowance headroom); the captain wallet only provides COLLATERAL
  (ADA-only UTxO + collateral return) and co-signs as collateral provider. Collateral outputs/returns are
  not tx outputs, so they don't break "every non-own output → owner".
- Time: Cardano validity bounds are slots; Mesh `invalidHereafter(slot)` → upper bound (exclusive) at the
  slot's POSIX start. Use Mesh `SLOT_CONFIG_NETWORK.preprod` for slot↔ms. Off-chain, set
  `invalidHereafter = min(slotOf(expiry), tip+900)` such that the bound's POSIX time ≤ expiry, and for
  Recover `invalidBefore = slotOf(expiry) + 1`. Aiken tests must cover both bounds and the exact boundary.

## Off-chain client API (`packages/chain/src/vault/index.ts`, exported from @bulkhead/chain)
```ts
export interface VaultParams {
  ownerAddress: string;          // bech32 addr_test1… (payment key + optional stake key)
  captainKeyHash: string;        // hex 28 bytes
  sessionKeyHash: string;        // hex 28 bytes
  expiryMs: number;
  payees: string[];              // bech32 addr_test1… — their PAYMENT credential is used (≤ 10)
  perTxMaxTusdMicro: bigint;
  adaAllowanceLovelace: bigint;
  tusdPolicyId: string;
  tusdAssetNameHex: string;      // "0014df1074555344" (CIP-68 333 tUSD)
}
export interface AppliedVault { scriptCbor: string; scriptHash: string; address: string; paramsJson: unknown }
export function applyVaultParams(p: VaultParams): AppliedVault;
export const VaultRedeemer: { Pay: Data; Revoke: Data; Recover: Data };   // Mesh Data / JSON
export const UNAPPLIED_VAULT_HASH: string;   // from contracts/plutus.json; a test pins it
// Tx builders (unsigned CBOR + metadata), signed by TxService with the right keys:
buildVaultPay({ vault, utxos, payee, tusdMicro, lovelace?, memo?, reference?, collateral, changeTo: vault.address, ttlSlot })
buildVaultRevoke({ vault, utxos, ownerAddress, collateral, metadata674 })
buildVaultRecover({ vault, utxos, ownerAddress, collateral, validFromSlot, metadata674? })
// TxService additions (signing with KeyVault): vaultPay(sessionId, …), vaultRevoke(sessionId, …), vaultRecover(sessionId, signerKeyId?)
```

## Chain safety for agents (MANDATORY)
- Only ONE process may submit preprod transactions at a time. Before any preprod submit sequence, acquire
  the lock: `mkdir "<repo>/bulkhead/.chain-lock"` (atomic; if it exists, wait/retry every 30 s; write your
  agent name + time into `.chain-lock/owner`). Remove the directory when done (also on failure). Never hold
  it longer than 25 minutes. Offline work (aiken check, unit tests, Mesh offline builds) needs no lock.
- The operator wallet (~649 tADA) and the captain wallet are shared: never spend more than needed; never
  print or log mnemonics/keys; never touch mainnet.
- NOWNodes is out of scope: don't touch its code.
