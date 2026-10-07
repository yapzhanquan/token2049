# Deployments — Cardano PREPROD

Machine-readable record: [`deployments/preprod.json`](deployments/preprod.json). Every vault run rewrites the `vaultIntegrationRun` part (`packages/engine/scripts/vault-onchain.ts`). The attack demo rewrites the `attackDemo` part (`pnpm demo:attack-onchain`). Explorer: https://preprod.cardanoscan.io.

## Bulkhead Session Vault (the only validator)

| | |
|---|---|
| Network | Cardano **preprod** (network id 0). Mainnet is refused everywhere. |
| Source | `contracts/validators/session_vault.ak`. Tests are in `contracts/validators/session_vault.test.ak`. |
| Validator | `session_vault.session_vault.spend`, which is the spend purpose. Every other purpose fails. |
| Blueprint (CIP-57) | [`contracts/plutus.json`](contracts/plutus.json). It is embedded as `packages/chain/src/vault/blueprint.generated.ts`. To regenerate it, run `node contracts/scripts/gen-ts.mjs` after `aiken build`. |
| Compiler | Aiken **v1.1.24+bacbeb3** with stdlib `aiken-lang/stdlib v3.0.0` and `aiken-lang/fuzz v2.1.1` |
| Plutus version | **V3** |
| Unapplied validator hash | **`edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a`**. It is pinned in `UNAPPLIED_VAULT_HASH` with contract version `1.0.0`. The test `packages/chain/test/vault.test.ts` fails on any change unless the version is bumped. |
| Script size | Unapplied: 1,822 bytes. Applied with 1 payee: **2,092 bytes**. Each extra payee adds about 30 bytes. The ledger limit is 16,384 bytes per tx. |
| Typed client | `packages/chain/src/vault/`, exported from `@bulkhead/chain`. It provides `applyVaultParams`, `VaultRedeemer`, `buildVaultPay` / `buildVaultRevoke` / `buildVaultRecover`, and the TxService methods `vaultFund` / `previewVaultFunding` / `vaultPay` / `vaultRevoke` / `vaultRecover`. |

The script is parameterised, so there is one script hash and one address per session. The vault address is the payment credential of the applied script plus the owner's stake credential. Session budgets therefore stay staked to the owner. There is no shared reference script: each tx attaches the applied script.

### Parameters (blueprint order, applied with Mesh `applyParamsToScript(…, "JSON")`)

| # | name | type | Plutus data |
|---|---|---|---|
| 1 | `owner` | `cardano/address.Address` | `Constr 0 [Credential, Option<Referenced<Credential>>]`. A key credential is `Constr 0 [bytes]` and a script credential is `Constr 1 [bytes]`. `Some(Inline(c))` is `Constr 0 [Constr 0 [c]]`. `None` is `Constr 1 []`. |
| 2 | `captain_vkh` | `VerificationKeyHash` | bytes (28) |
| 3 | `session_vkh` | `VerificationKeyHash` | bytes (28) |
| 4 | `expiry` | `Int` | POSIX ms |
| 5 | `payees` | `List<Credential>` | the payment credentials of the allowed payees (≤ 10, enforced off-chain) |
| 6 | `per_tx_max_tusd` | `Int` | micro-tUSD |
| 7 | `ada_allowance` | `Int` | lovelace (payee min-ADA + fee per tx) |
| 8 | `tusd_policy` | `PolicyId` | bytes (28) |
| 9 | `tusd_name` | `AssetName` | bytes (`0014df1074555344` = CIP-68 333 "tUSD"; the demo runs before the CIP-68 migration used legacy `74555344`) |

Mesh 1.9.1 `addrBech32ToPlutusDataHex` leaves out the `Inline` (StakingHash) layer, so do not use it for these params. `addressToPlutusJson` in the client produces the ledger shape. The on-chain Revoke and Recover runs prove this: they require `output.address == owner`.

### Redeemer and datum

* Redeemer `VaultAction` has three constructors: `Pay` = `Constr 0 []`, `Revoke` = `Constr 1 []`, `Recover` = `Constr 2 []`. Any other constructor fails to decode.
* Datum: every output to a vault carries the inline datum `Void` (`Constr 0 []`, CBOR `d87980`). The validator ignores the datum content. Pay requires its continuing outputs to have *an* inline datum and no reference script. This stops a datum-hash output from locking the remaining funds forever.

### Rules (whole-transaction checks)

"Own address" means `Address { Script(own hash), owner.stake_credential }`. The validator compares full addresses. `leaving` is computed per asset as Σ own inputs − Σ own outputs.

* **Pay** requires all of the following:
  * the tx is signed by `session_vkh`;
  * the upper validity bound is finite and ≤ `expiry`;
  * every non-own output pays a credential in `payees`;
  * only lovelace and tUSD leave the vault, with `leaving.tusd ≤ per_tx_max_tusd` and `leaving.lovelace ≤ ada_allowance`;
  * continuing own outputs keep exactly the own address, carry an inline datum and have no reference script.
* **Revoke** requires a signature from `captain_vkh`, and every output must go to `owner` (a full sweep).
* **Recover** needs no signature. The lower validity bound must be strictly greater than `expiry`, and every output must go to `owner`.
* Inputs at the script's payment credential with a *different* stake credential still count as own inputs. They are therefore limited by Pay and can only be swept to the owner.
* The fee is paid from the vault's ADA. The captain only provides an ADA-only collateral UTxO with a collateral return. Collateral is taken only if a script fails on chain, and the node rejects such txs before inclusion.

### Execution units and size

These are measured by Blockfrost `/utils/txs/evaluate` on real preprod txs: 1 vault input and the 2,092-byte applied script attached. Txs declare the measured units plus 10%.

| Redeemer | mem | steps (cpu) | % of the tx limit (mem 17.5 M / steps 10 G) | fee | tx size |
|---|---|---|---|---|---|
| Pay (1 input → payee + continuing output) | **266,816** | **91,053,296** | 1.5% / 0.9% | 0.306711 tADA | 2,675 B |
| Revoke (1 input → owner) | **58,066** | **20,275,359** | 0.3% / 0.2% | 0.287364 tADA | — |
| Recover (1 input → owner) | **59,757** | **21,396,440** | 0.3% / 0.2% | 0.278628 tADA | — |

The offline evaluation with Mesh `OfflineEvaluatorScalus` gives the same numbers. In the unit tests, Pay with 2 vault inputs costs about 2× per input, because each input runs the whole-tx check. The off-chain coin selection uses ≤ 4 vault inputs per Pay.

### Demo run (preprod, 2026-10-06/07): `packages/engine/scripts/vault-onchain.ts`

| | |
|---|---|
| Test owner treasury (custodial account `990002'`) | `addr_test1qq7n5dtady4vhcx2mkzdd965yup7mu6thj62m0gmp4n9ydy9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7sur7we9` |
| Captain collateral UTxO (10 tADA) | [`0eec8e12…0ae8#0`](https://preprod.cardanoscan.io/transaction/0eec8e123cf77293094ca01eb69c7641ec94c2378aa819cf457c3ef6a9030ae8) |
| Allowed payee (mock agent #0) | `addr_test1qra72xznumc3fg4qsr8mmdyrzrdw45nh790h2s36pladqn9f65nslquzy5fq66337vv94ef9ayra0h2y2annmjtexresm3787g` |
| Attacker (not allowed) | `addr_test1vq9mt2fmnradv0khu50s2ckwcw3ptjcfsspf5u9zkaealjgwdxprz` |

| Session | Applied script hash | Vault address | Txs |
|---|---|---|---|
| A (expiry +2 h; 5 tUSD / 3 tADA per tx) | `2879e54b7817dbec802a83d607f4dcedbfc81493b4249fa27a5f0087` | [`addr_test1zq58ne2t…yaawx3`](https://preprod.cardanoscan.io/address/addr_test1zq58ne2t0qtahmyq92pavpl5mnkmljq5jw6zf8az0f0sppu9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7syaawx3) | fund [`10b7d485…8e58`](https://preprod.cardanoscan.io/transaction/10b7d485fedab65709c746179d8e8a787a9ddb8a239fa88e48c0587f23658e58) · pay [`d750539b…8e70`](https://preprod.cardanoscan.io/transaction/d750539b5ff48ebacca763297fa2fb0d57ee58406a69a3a6b33669f674ec8e70) · revoke [`52fef766…18b1`](https://preprod.cardanoscan.io/transaction/52fef766ce69be789f5a9f9b3b49c7f805768caa5130f984aa1a22d47ad118b1) |
| B (expiry +5 min) | `96f18337f4bacdd6b537937c460bb3fa786863204abfc3e8472ec281` | [`addr_test1zzt0rqeh…snsqv8x`](https://preprod.cardanoscan.io/address/addr_test1zzt0rqeh7javm444x7fhc3stk0a8s6rryp9tlslgguhv9qv9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7snsqv8x) | fund (same tx as A) · recover [`47e57f25…82bb2`](https://preprod.cardanoscan.io/transaction/47e57f25132472687f95e5f850d02ee01965f3349a1b182e940a2848f0d82bb2), made by a random key |
| attack demo | `298aaf6a9f47267fbdbb569d8976db37bf58f1bcdb47232d72d56364` | [`addr_test1zq5c4tm2…p7943z`](https://preprod.cardanoscan.io/address/addr_test1zq5c4tm2narjvlaahdtfmztkmvmm7k83hnd5wgedwt2kxey9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7sp7943z) | fund [`2739617f…983d`](https://preprod.cardanoscan.io/transaction/2739617fd7e288b94cfca858d5fa93ac3919d0484f533fe337c177ca391f983d) · malicious Pay `40053d2a…5353`, **rejected and never on chain** · revoke [`8f7ef1ae…a0f7`](https://preprod.cardanoscan.io/transaction/8f7ef1aec63f76f7f24e0402903292c922685a334cafd2125fd855860530a0f7) |

The vault addresses all end in the owner's stake credential (`…9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7s…`), which is the same as the test treasury's stake part.
