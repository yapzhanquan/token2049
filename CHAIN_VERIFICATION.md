# Chain verification (preprod)

Every hash below is on Cardano PREPROD; links go to preprod.cardanoscan.io.

## Staking & vote delegation (preprod, 2026-10-07)

Run with `packages/engine/scripts/staking-onchain.ts` (`runStakingOnchain()`, which takes the chain lock). The dedicated custodial test treasury is account `990003'`, signed with the derived payment key (`m/1852'/1815'/990003'/0/0`) and stake key (`…/2/0`).

| | |
|---|---|
| Test treasury | `addr_test1qr8fv0ptfp06757p2yuncen50nf8syzsjel3mwpxqk05ntq5qpngjhh9tvgay2n9cahxhk9q7kxd9spgm2jzeurw39esuq3f8e` |
| Stake address | `stake_test1uq2qqe5ftmj4kywj9fjuwmntmzs0trxjcq5d4fpv7phgjucp66697` |
| Pool | **GRADA** ("GRADA Gratis ADA PreProd"), `pool1nmfr5j5rnqndprtazre802glpc3h865sy50mxdny65kfgf3e5eh` (hex `9ed23a4a839826d08d7d10f277a91f0e2373ea90251fb33664d52c94`). Picked from Blockfrost `pools/extended`: most active stake, not retiring, < 90% saturated (`STAKE_POOL_ID` unset) |
| DRep | `always_abstain` (`DREP_ID` unset) |
| Stake key deposit | 2.000000 tADA (live `key_deposit`) |

| Step | Tx | Notes |
|---|---|---|
| Fund the test treasury from the operator (12 tADA) | [`e30f2579…cc03`](https://preprod.cardanoscan.io/transaction/e30f2579fe8d4b460a093f7163dc6c5a65de4e02238bf55f3f4e7d60e3ddcc03) | block 5261303 |
| Stake registration + pool delegation + vote delegation, in **one** tx | [`5ddaa544…713d`](https://preprod.cardanoscan.io/transaction/5ddaa544b494d1788ccb9f64c1e6defcccceaf3b11b78c99053428403a0c713d) | certs: StakeRegistration, StakeDelegation, VoteDelegation(AlwaysAbstain); deposit 2 tADA; fee 0.180285 tADA; block 5261305 |
| `withdrawRewards(0)`: a zero withdrawal (claims nothing) | [`73691a0f…fc49`](https://preprod.cardanoscan.io/transaction/73691a0f0c408df6c7bd421eb5507d08c9ea63e04fb967fc74f76ed81507fc49) | The ledger accepted it, which shows that withdrawals are allowed once the vote is delegated (Conway). fee 0.175401 tADA |

Provider check (Blockfrost `GET /accounts/stake_test1uq2qqe5ftmj4kywj9fjuwmntmzs0trxjcq5d4fpv7phgjucp66697`, after the setup tx):
`"registered":true, "pool_id":"pool1nmfr5j5rnqndprtazre802glpc3h865sy50mxdny65kfgf3e5eh", "drep_id":"drep_always_abstain", "withdrawable_amount":"0", "active_epoch":317`.

Re-runs are idempotent: they keep the existing pool, verify the account and submit nothing.

Not run on-chain:
- **Claiming non-zero rewards.** Preprod rewards take about 2 epochs (days) to accrue, and the brief says not to claim in the demo. The non-zero path (full balance only) is covered by offline builder tests.
- **"Stop staking" (deregistration + deposit refund).** Running it would undo the delegation the demo shows. It is covered offline: the builder, `StakingService.stopCustodial` and `POST /staking/stop`.
- **The self-custody path (CIP-30 wallet signs the certificate tx).** It is tested offline through the API and SigningBroker with a simulated wallet signature. No browser wallet was used on preprod.

## Vault: Bulkhead Session Vault (Aiken, Plutus V3) — preprod, 2026-10-06/07 (UTC)

The suite is `packages/engine/scripts/vault-onchain.ts` (`runVaultOnchain()`, which takes the chain lock itself). Contract: unapplied hash `edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a`, Aiken v1.1.24, Plutus V3, applied script 2,092 bytes. Full record: [DEPLOYMENTS.md](DEPLOYMENTS.md) and `deployments/preprod.json`.

Owner = the dedicated custodial test treasury, account `990002'`: `addr_test1qq7n5dtady4vhcx2mkzdd965yup7mu6thj62m0gmp4n9ydy9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7sur7we9`. Its funding tx from the operator was [`c4cc674c…f9b0`](https://preprod.cardanoscan.io/transaction/c4cc674c11d83996bc2821379834424acd7986fe26ccb6361db7cb9883a7f9b0). The captain's collateral UTxO (10 tADA) came from [`0eec8e12…0ae8`](https://preprod.cardanoscan.io/transaction/0eec8e123cf77293094ca01eb69c7641ec94c2378aa819cf457c3ef6a9030ae8). Vault A script `2879e54b…0087`, vault B script `96f18337…c281`. Both addresses carry the owner's stake credential.

| Step | Result | Tx |
|---|---|---|
| Fund vaults A + B in one treasury tx (A: 10 tUSD + 6 tADA headroom; B: 3 tUSD + 2 tADA), inline datum `Void` | ✓ confirmed | [`10b7d485…8e58`](https://preprod.cardanoscan.io/transaction/10b7d485fedab65709c746179d8e8a787a9ddb8a239fa88e48c0587f23658e58) |
| A: `Pay` 2 tUSD to the allowed payee, signed by the session key | ✓ confirmed. Exec units 266,816 mem / 91,053,296 steps; fee 0.306711 tADA | [`d750539b…8e70`](https://preprod.cardanoscan.io/transaction/d750539b5ff48ebacca763297fa2fb0d57ee58406a69a3a6b33669f674ec8e70) |
| A: `Pay` 6 tUSD (> `per_tx_max_tusd` 5) | ✓ **rejected by the script** at evaluation: `VaultScriptError`/`SCRIPT_FAILED`, Ogmios 3010/3012 "The machine terminated because of an error" | — (never submitted) |
| A: `Pay` 1 tUSD to the attacker address | ✓ **rejected by the script** at evaluation (same error) | — |
| A: `Revoke` by the captain | ✓ confirmed. 1 output, to the owner (+8 tUSD); vault empty afterwards. Metadata 674 = `{msg:["Bulkhead session close (vault revoke)"], session_id, log_sha256, handback_sha256, status:"REVOKED"}`, read back from Blockfrost `txs/{hash}/metadata`. 58,066 mem / 20,275,359 steps | [`52fef766…18b1`](https://preprod.cardanoscan.io/transaction/52fef766ce69be789f5a9f9b3b49c7f805768caa5130f984aa1a22d47ad118b1) |
| B: a random key gets 6 tADA from the operator for its own collateral | ✓ | [`f1b5b14c…7a65`](https://preprod.cardanoscan.io/transaction/f1b5b14c86ba74186461351a9a43a13365907ecfbf9e9a93857b4733b8297a65) |
| B: `Recover` after expiry by that random in-memory key (it was never persisted or logged). The only witness is the random key's collateral signature: no owner or captain signature, and no required signers | ✓ confirmed. `invalidBefore` = first slot after expiry; 1 output, to the owner (+3 tUSD); vault empty. 59,757 mem / 21,396,440 steps | [`47e57f25…82bb2`](https://preprod.cardanoscan.io/transaction/47e57f25132472687f95e5f850d02ee01965f3349a1b182e940a2848f0d82bb2) |
| Return the random key's tADA to the operator; the key is then discarded | ✓ | [`0c3bd7e1…7b87`](https://preprod.cardanoscan.io/transaction/0c3bd7e17a2a7ea56e43f86e6e6006de3a479f86397844ad4ad4f2fc5dcc7b87) |

An earlier run of the same suite also succeeded on chain, with these txs: fund [`e304abc4…4904`](https://preprod.cardanoscan.io/transaction/e304abc46ffdbde563ea9272fb2267fe1bb42eb9cf11fe6aba1dfd5369ca4904), pay [`64ed49c4…1223`](https://preprod.cardanoscan.io/transaction/64ed49c494236712aafce546cf4d2b16ae6c2dad437e78536f13707491e01223), revoke [`5a4dc3e1…ca40`](https://preprod.cardanoscan.io/transaction/5a4dc3e1c461fc79071b25087d784506a93565305b44a5845f1813d382b4ca40). Its Revoke assertion was marked ✗ only because it read address balances before Blockfrost had indexed the block. The suite now polls until the vault is empty and checks the tx outputs instead.

### On-chain attack proof (`pnpm demo:attack-onchain`, 2026-10-06 17:26 UTC)

A session vault (script `298aaf6a…6364`) was funded with 5 tUSD ([`2739617f…983d`](https://preprod.cardanoscan.io/transaction/2739617fd7e288b94cfca858d5fa93ac3919d0484f533fe337c177ca391f983d)). The demo built a `Pay` of 4 tUSD to the attacker `addr_test1vq9mt2fmnradv0khu50s2ckwcw3ptjcfsspf5u9zkaealjgwdxprz`. The **Signer was bypassed**: the tx was signed directly by the real session key, plus the captain's collateral witness. Tx id `40053d2a3a6d9c13eb4de6ce0c999606c642d6fdaeee3fd3b86c432b53bb5353`.

1. **Evaluate** (Blockfrost `/utils/txs/evaluate`): the script failed. Ogmios v6 returned `{"code":3010,"message":"Some scripts of the transactions terminated with error(s).","data":[{"validator":{"index":0,"purpose":"spend"},"error":{"code":3012,…,"data":{"validationError":"An error has occurred:\nThe machine terminated because of an error, either from a built-in function or from an explicit use of 'error'.\nCaused by: (error)","traces":[]}}}]}`.
2. **Submit anyway** (Blockfrost `/tx/submit`): the node rejected it with HTTP 400 `ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: …")))))`. This happened before inclusion, so the tx never reached a block.
3. **Nothing moved**: the tx is not on chain, the vault still held 5 tUSD, the attacker held 0, and the captain's collateral UTxO `0eec8e12…0ae8#0` was intact, so no collateral was lost.
4. Cleanup: the captain revoked the vault back to the owner ([`8f7ef1ae…a0f7`](https://preprod.cardanoscan.io/transaction/8f7ef1aec63f76f7f24e0402903292c922685a334cafd2125fd855860530a0f7)).

Not verified on preprod (vault):
- `walletMode: "vault"` driven by the engine (SessionManager, Signer, close/kill, `pnpm recover`) is the integration agent's part. These runs drive `TxService.vaultFund/vaultPay/vaultRevoke` and the `buildVaultRecover` builder directly.
- `vaultRecover()` through TxService, with the captain as collateral provider, is covered offline only. The on-chain Recover used the builder with a random key's collateral, which is the stronger "anyone" case.
- Pay with several vault inputs, and the "change to a foreign stake credential" / "extra asset leaving" cases, are covered by Aiken unit and property tests and offline UPLC evaluation, not by preprod txs.

<!-- verify:chain:begin -->
## pnpm verify:chain — summary

Run 2026-10-06T17:48:52.791Z on Cardano **preprod** (sections below/above are written by each suite).

| Suite | Result | Duration |
|---|---|---|
| Session Vault (Aiken, Plutus V3) | PASS | 394 s |
| Staking + vote delegation | PASS | 4 s |

### Session Vault (Aiken, Plutus V3) — PASS

| Step | OK | Detail | Tx |
|---|---|---|---|
| test owner treasury | ✓ | custodial account 990002 → addr_test1qq7n5dtady4vhcx2mkzdd965yup7mu6thj62m0gmp4n9ydy9w8trsr3x7mt0ffgfjgjf5k9c5ldr6geke5umn7uq8p7sur7we9 | — |
| captain collateral UTxO | ✓ | addr_test1qqy805z2u6hc29hh4wyx8mkf03j725pdt2v6xrpnue08hzq37vyd6fr78nt73y7caz0p3z7j9nmzq7l2z9ar3znh3z7qnryqft · 0eec8e123cf77293094ca01eb69c7641ec94c2378aa819cf457c3ef6a9030ae8#0 | — |
| fund vaults A + B (one treasury tx, inline datum Void) | ✓ | A 10 tUSD + 6 tADA headroom, B 3 tUSD + 2 tADA; fee 0.185125 tADA | [1fdf040b7f4f…](https://preprod.cardanoscan.io/transaction/1fdf040b7f4ffdba1911d0a00496f5841a6198ca592047d0509078dd9bed7bdd) |
| A: Pay allowed payee 2 tUSD (session key) | ✓ | fee 0.306711 tADA; exec units measured [{"mem":266816,"steps":91053296}] declared [{"mem":294497,"steps":100258625}]; tx 2675 bytes | [2f862d7c0c01…](https://preprod.cardanoscan.io/transaction/2f862d7c0c016557628247abdc5e120eb5adf1fa2ed408fae5efad4ab3a842d0) |
| A: Pay over the per-tx limit (6 tUSD > 5) | ✓ | rejected by the script (VaultScriptError/SCRIPT_FAILED): Session Vault script rejected the Pay tx at evaluation: evaluateTx failed: {"ScriptFailures":{}} · ogmios v6: {"code":3010,"message":"Some scripts of the transactions terminated with error(s).","data":[{"validator":{"ind | — |
| A: Pay to the attacker address | ✓ | rejected by the script (VaultScriptError/SCRIPT_FAILED): Session Vault script rejected the Pay tx at evaluation: evaluateTx failed: {"ScriptFailures":{}} · ogmios v6: {"code":3010,"message":"Some scripts of the transactions terminated with error(s).","data":[{"validator":{"ind | — |
| A: Revoke (captain) → all to owner, metadata 674 | ✓ | vault now holds 0 UTxOs; tx outputs 1, all to the owner: true (+8 tUSD); 674 = {"msg":["Bulkhead session close (vault revoke)"],"status":"REVOKED","log_sha256":"9038016a3d367014664ac992256581f6be133d19cf4314ec3aafe5db92263d4d","session_id":"vault-test-A-1791308934991","handback_; exec units [{"mem":58066,"steps":20275359}]; fee 0.287364 tADA | [e5f62522d3ef…](https://preprod.cardanoscan.io/transaction/e5f62522d3ef11fc9c107ec682877052e8332cc11c12126eff69af2f46ad28c0) |
| B: give the random key 6 tADA (its collateral) | ✓ | operator → addr_test1vz6ppmza59g7fcncm0hhzrchf77ruzavd8d3ehgjvxtam0q3a256s | [3c60af568e4b…](https://preprod.cardanoscan.io/transaction/3c60af568e4b29f0947c9ece2643e70ff68b5f43d4805f32e91bc85c9c7ad09d) |
| B: Recover after expiry by a random key (no owner/captain signature) | ✓ | invalidBefore slot 135626036 (> expiry 2026-10-06T17:53:55.018Z); witnesses: random key only; vault now holds 0 UTxOs; all 1 outputs to the owner: true (+3 tUSD); exec units [{"mem":59757,"steps":21396440}]; fee 0.278628 tADA | [5393aeb8c742…](https://preprod.cardanoscan.io/transaction/5393aeb8c742ea583ad808ddcc2a08d1f07614dfbb27a22b2bf9f49d1c2cd6ed) |
| B: return the random key's tADA to the operator | ✓ | key discarded (never persisted) | [6653ee0b1808…](https://preprod.cardanoscan.io/transaction/6653ee0b18080518624e682dca84160988691e3c81e5dfab37b333ab079db569) |

### Staking + vote delegation — PASS

| Step | OK | Detail | Tx |
|---|---|---|---|
| test treasury | ✓ | account 990003' → addr_test1qr8fv0ptfp06757p2yuncen50nf8syzsjel3mwpxqk05ntq5qpngjhh9tvgay2n9cahxhk9q7kxd9spgm2jzeurw39esuq3f8e · stake stake_test1uq2qqe5ftmj4kywj9fjuwmntmzs0trxjcq5d4fpv7phgjucp66697 | — |
| fund test treasury | ✓ | already funded: 9.644314 tADA | — |
| pool | ✓ | GRADA pool1nmfr5j5rnqndprtazre802glpc3h865sy50mxdny65kfgf3e5eh (already delegated; kept) | — |
| register + pool delegation + vote delegation (one tx) | ✓ | already on chain (pool pool1nmfr5j5rnqndprtazre802glpc3h865sy50mxdny65kfgf3e5eh, vote always_abstain) | — |
| blockfrost accounts/stake_test1uq2qqe5… | ✓ | registered=true pool_id=pool1nmfr5j5rnqndprtazre802glpc3h865sy50mxdny65kfgf3e5eh drep_id=always_abstain rewards=0 | — |
| withdrawRewards(0) | ✓ | already done earlier (Conway accepted a 0-lovelace withdrawal for the vote-delegated key) | [73691a0f0c40…](https://preprod.cardanoscan.io/transaction/73691a0f0c408df6c7bd421eb5507d08c9ea63e04fb967fc74f76ed81507fc49) |

<!-- verify:chain:end -->

## Self-custody vault (workstream B, CIP-30 signTx) — preprod, 2026-10-07

Self-custody ("Connect wallet") users now get Session Vaults too (the "self-custody always native" restriction is removed
when the chain has `tx.buildUnsignedVaultFunding` + `submitSigned`). The vault owner is the wallet's FULL address
(payment + stake credential), so the vault address = applied script hash + the wallet's stake credential, and
Revoke/Recover return funds to the wallet. Funding: `SigningBroker` intercepts `tx.vaultFund` for self-custody users →
`buildUnsignedVaultFunding` (wallet UTxOs, ONE tx for all sessions of a plan, one output per vault with inline datum Void,
exactly the budget tUSD + min-ADA + ada_allowance headroom, change → wallet) → `needsSignature` → browser
`signTx(tx, true)` → `submitSigned` (witness set attached, signature verified against the wallet's payment key).

Run: `pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/vault-self-custody-onchain.ts`
(under `.chain-lock`). The "browser wallet" is a throwaway in-memory key pair (payment + stake; never persisted or
logged) that signs exactly like CIP-30 `signTx(tx, partialSign=true)` (returns only the witness set).

| Step | Result | Tx |
|---|---|---|
| Operator → throwaway wallet `addr_test1qzpmrds2…e5htqs67mgz` (12 tADA + 2 tUSD, CIP-68 333 unit) | confirmed | [`d9d302df…c133`](https://preprod.cardanoscan.io/transaction/d9d302df530b69d11a7bed63e0fab7215340c3483156812ddfa417e649d9c133) |
| Vault (script `236825f3…e2cf`) at [`addr_test1zq3ksf0n…5q8l02`](https://preprod.cardanoscan.io/address/addr_test1zq3ksf0n9lf0mjkltm5yt9qru3ahknvywyd2j2k67ejw9na4navw0f00pgp7exxq2rh2z4fpvdqfg0x5kz52xc2e5htq5q8l02) — stake part = the wallet's stake key | — | — |
| UNSIGNED vault funding built from the wallet's UTxOs (0 vkey witnesses, inline datum `d87980`, 2 tUSD + 4.219730 tADA), signed by the wallet (witness set), `submitSigned` | confirmed, fee 0.176589 tADA | [`f8b09022…85ba`](https://preprod.cardanoscan.io/transaction/f8b090224f2bfcbb2d63d71f37190d24b29066390fd22a71267360a3229085ba) |
| Pay 0.5 tUSD → allowed payee (mock agent #0), session key + captain collateral | confirmed, fee 0.307503 tADA, mem 294,497 / steps 100,258,625 (declared, +10 %) | [`650ee837…4274`](https://preprod.cardanoscan.io/transaction/650ee8371a9a650ec25107fb84484a1c4dcc5a577f10964f984104a0c0c74274) |
| Revoke (captain) → ONE output to the WALLET address: 1.5 tUSD + 2.451795 tADA, metadata 674 | confirmed | [`16e9fe8c…c05a`](https://preprod.cardanoscan.io/transaction/16e9fe8c833a2d460a84e86702b06c3165a1b022042bb63a82c8a93200b1c05a) |
| Leftovers: throwaway wallet → operator | confirmed | [`9d383bd4…0690`](https://preprod.cardanoscan.io/transaction/9d383bd44471517e1b70cd8f2cbeea34d912e3bf7980b7a774859bc1aca50690) |

Offline coverage: `packages/chain/test/vault-self-custody.test.ts` (Mesh offline builds + real UPLC via
OfflineEvaluatorScalus: unsigned funding → throwaway-wallet witness set → submitSigned → Pay → Revoke to the wallet;
foreign-stake / non-script outputs and wrong signers refused) and `packages/engine/test/self-custody-vault.test.ts`
(API approve → needsSignature → signed approve → vault sessions RUNNING → Pay → kill = Revoke to the wallet, FakeChain).
Not exercised on chain: a real browser extension (Eternl/Lace) signing, and Recover for a self-custody vault (same
builder/owner path as the custodial Recover already proven above).

## tUSD CIP-68 (workstream C) — preprod, 2026-10-06 19:07–19:11 UTC

tUSD is now a **CIP-68 fungible token** under the unchanged operator policy `7704eb3b92e66ff0b5fadcf9ad8db3f1f817cb9ce054d32a5c6eac30`
(native script `sig(operator payment key)`). Asset names follow CIP-67 (label prefix + `74555344` = "tUSD"):

| | asset name | unit | CIP-14 fingerprint |
|---|---|---|---|
| (333) fungible tUSD, what every payment/vault/market now uses | `0014df1074555344` | `7704eb3b…eac30` + `0014df1074555344` | `asset1zrrpqaedkjxymz7qg9jea4yxwkg77q6ru0mp2e` |
| (100) reference NFT, metadata datum, held at the operator address | `000643b074555344` | `7704eb3b…eac30` + `000643b074555344` | `asset1sej532vpu9lz4gx3cz6e7e4n653u90p60j8r9r` |
| deprecated pre-CIP-68 name (read only for migration) | `74555344` | `7704eb3b…eac30` + `74555344` | — |

| Step (`pnpm setup:chain`, under `.chain-lock`) | Result | Tx |
|---|---|---|
| Mint the (100) reference NFT → operator, inline datum = CIP-68 metadata | confirmed, block 5261623, fee 0.188953 tADA | [`86ef5f29…0a5b`](https://preprod.cardanoscan.io/transaction/86ef5f29c0555ba04714b27e4264828f73c3120aed7ceea6118ed22164c20a5b) |
| Operator legacy → 333, 1:1 (burn 999,928.085108 legacy, mint the same in 333; operator signs) | confirmed, block 5261625 | [`85c59c16…ef2c`](https://preprod.cardanoscan.io/transaction/85c59c16ac8040b32bf2cb45bb13e68a3046d3085449fa75f62c649308b6ef2c) |
| Custodial treasury `u_940c22a2…` legacy → 333 (6.978723 tUSD; treasury + operator sign) | confirmed, block 5261627 | [`21843da1…3930`](https://preprod.cardanoscan.io/transaction/21843da1a96a72e09dbc9ef7f4f88106a1a7dc55c93dd9c34a288751f0513930) |
| Re-run of `setup:chain` | idempotent: "already set up", "no legacy left to migrate", no tx | — |

The operator already held 1.5 tUSD-333 from workstream B's run (minted by `operatorSend`), so setup did not mint a fresh
1,000,000 supply; the migrated legacy stock (999,928.085108) became the 333 supply instead. Operator after setup:
999,929.585108 tUSD-333. On-chain 333 total: 999,937.063831 tUSD.

Inline-datum check (`tsx scripts/verify-tusd-cip68.ts`, read-only; Blockfrost `assets/{ref unit}`,
`assets/{ref unit}/addresses`, `addresses/{operator}/utxos/{ref unit}`):

```
reference NFT quantity = 1, held at the operator, UTxO 86ef5f29…0a5b#0
inline_datum d8799fa4446e616d655142756c6b686561642074657374205553444b6465736372697074696f6e5f5840…ff467469636b6572447455534448646563696d616c730601d87980ff
decoded (decodeCip68Datum): Constr 0 [ {name: "Bulkhead test USD", description: "Bulkhead preprod test stablecoin (1 tUSD = 1,000,000 micro). Testnet only, no value.",
          ticker: "tUSD", decimals: 6 (int)}, version 1, extra Constr 0 [] ]
Blockfrost assets/{333 unit}: onchain_metadata_standard = "CIP68v1", onchain_metadata = the same 4 fields
```

Deprecated legacy units still on chain (64.936169 tUSD) sit in wallets that `setup:chain` does not hold keys for in the
`users` table: mock agents #0/#2, the vault demo's test treasury (account 990002'), and `addr_test1qzct74k8…`. They are
testnet leftovers; the engine reports them as `balances.legacyTusdMicro` and never pays with them.
Offline coverage: `packages/chain/test/cip68.test.ts` (CIP-67 vectors, CIP-14 vectors, datum encoding/round trip,
setup mint + migration builds, the reference NFT is never selected by operator txs).

## Finality & ADA Handle (workstream D, 2026-10-07)

Read-only preprod check (no transactions built or submitted), run under the chain lock with
`packages/chain/scripts/check-finality-handles.ts` (Blockfrost preprod):

**Confirmation depth** — `CONFIRMATIONS` (default 2): a tx counts as confirmed only when
`tip height − tx block height + 1 ≥ N`. Observed on tx `9d383bd44471517e1b70cd8f2cbeea34d912e3bf7980b7a774859bc1aca50690`:

| | value |
|---|---|
| tip | height 5261628, slot 135630646 |
| tx block | height 5261618, slot 135630343 |
| depth | 5261628 − 5261618 + 1 = **11** |
| `FinalityProvider(N=2).fetchTxConfirmation` | `{ blockHeight: 5261618, slot: 135630343, confirmations: 11 }` |
| `FinalityProvider(N=1011).fetchTxConfirmation` | `null` (pending) |
| watcher N=2 | `tx_confirmed { slot: 135630343, confirmations: 11 }` |
| watcher N=1011 | `tx_pending { blockHeight: 5261618, confirmations: 11, required: 1011 }` |

**ADA Handles** — resolved on-chain via Blockfrost `GET /assets/{policy+name}/addresses` under policy
`f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a`, both CIP-68 (`000de140` + hex name) and legacy CIP-25
(no prefix) units queried; cross-checked against the public Handle API (`preprod.api.handle.me/handles/<name>`):

| handle | standard / unit | holder (resolved address) | Handle API |
|---|---|---|---|
| `$test` | **legacy CIP-25** · `f0ff48bb…ca0fb9a74657374` | `addr_test1qpz3qjc02ggpq3trzmfmr3rwe208gt35599eu97ezt7n4dr0hgpfq32uq98pgt6j4cqhxm6xwev47gm5g5yegcxkjklqud6xal` | match |
| `$hello` | **CIP-68 (222)** · `f0ff48bb…ca0fb9a000de14068656c6c6f` | `addr_test1qrjp9xgpedxjjvfnmtte207jczmvhktfd34cgqnulxrjm2cu8lkuqhk73jlpvz78czvel0yk7p68ccvsfm9zcn2apuzsm30mej` | match |
| `$zzbulkheadnone` | — | refused: `not_found` "ADA Handle $zzbulkheadnone was not found on preprod" | — |

So preprod has both encodings live; the resolver handles both. Ambiguous holders (>1 address, or CIP-68 and
CIP-25 tokens at different holders) are refused — covered by unit tests with mocked Blockfrost
(`packages/chain/test/handle.test.ts`); rollback before N (polling and Ogmios paths) by
`packages/chain/test/finality.test.ts`; engine waits / planner / mandate edits by
`packages/engine/test/finality-handles.test.ts`.

Not exercised on chain: an actual rollback (cannot be provoked on preprod; covered with a fake provider and
synthetic Ogmios `backward` points), and a payment to a handle-resolved address in a live session.

## Live flow (2026-10-07, flow agent): funding preflight → top-up → real captain plan → auto payment → close

Run against the live engine (`http://localhost:4000`, LLM `openai`, chain `blockfrost`, walletMode `vault`) under
the chain lock (02:34–02:41 UTC). Dedicated custodial test user `u_4e28e5cd-6f11-44f7-beb8-8ce239a359b4`
(`flow-live@bulkhead.test`, treasury account index **990010**, treasury
`addr_test1qza32ly7tf2lsqy9hczxxghj79krpgngvwh82a9nhhec4rnmqycjg80elmsu9sfz253xgec56v06unukm88r0jtzksmqy03fq8`).

| step | result |
|---|---|
| 1. Goal via the REAL captain (`POST /captain/messages`: "Hire the market-research agent … Budget RM30, deadline in 2 hours") | captain called `plan_task` → goal `g_9841cfbf-94c8-41ba-a668-41325a3ef61f`, 1 session `hire_agent`, budget 2 tUSD, per-payment max 2, **approvalThreshold 2 (= per-payment max, new planner default)** |
| 2. Approve with an EMPTY treasury | `409 insufficient_funds`: "Your treasury has 0 tUSD; this plan needs 2 tUSD (≈ RM9.40). Top up first. Your treasury has 0.00 tADA; this plan needs ≈ 4.70 tADA (…). Add tADA from the preprod faucet first." — no raw "UTxO Balance Insufficient"; nothing submitted; session `A hirer` stays AWAITING_APPROVAL, tree line "waiting for funding — approve or top up" |
| 3. Top up RM50 (labelled simulated fiat; real operator transfer) | 10.478723 tUSD + 25 tADA → [1388f4e0…e638cb](https://preprod.cardanoscan.io/transaction/1388f4e00a6514721388a356df7c6b50ccfaf9ffa9763738ac8c75a333e638cb) |
| 4. Approve again | vault funding [8f41e24d…1dac5e](https://preprod.cardanoscan.io/transaction/8f41e24d5886d65916ce1d13eb02b8ffda5d55f6a5729fe44c091ec9221dac5e); FUNDING → RUNNING after ~1m45s |
| 5. Payment (hire market-research, **2 tUSD = exactly the threshold**) | Session Vault `Pay` [bd68315b…cea04b](https://preprod.cardanoscan.io/transaction/bd68315b3de58210e5d3dcc1deab510e545e85d7494e28461f23ed7edbcea04b): events `payment_requested → payment_submitted → payment_confirmed`, **0 decisions** (no `payment_approval_needed`) |
| 6. Handback → close | COMPLETING → CLOSING → CLOSED; close (Revoke) [fb6efb82…dcf327](https://preprod.cardanoscan.io/transaction/fb6efb827761fdf968879c7cc7ce8b9eeb92a329aef16941bbddd29877dcf327); spent 2 tUSD, 0 tUSD left to return |

Not exercised on chain here: the self-custody (CIP-30) variant of the preflight (same code path — the check runs on
the wallet address before the unsigned tx is built; covered by unit tests), and the "Top up RM50" button in the
browser (UI built and typechecked; the API flow it drives is the one above).

## Masumi registration (2026-10-07, masumi-registration agent): "Bulkhead Captain" on the dedicated MPS

Dedicated Masumi Payment Service `http://127.0.0.1:3901` (rev `d569a33`, DB `bulkhead_mps_920528`), Preprod
`Web3CardanoV2` payment source `cmuxiwa720004owvcvkjr2rh3` (contract
`addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`). Registration POST made under the chain lock
(03:22–03:32 UTC); lock released after confirmation. Checkpoint (public fields only):
`apps/sokosumi-worker/.local/registration-state.json`.

| item | value | label |
|---|---|---|
| Seller balance before registration | 700000000 lovelace (Blockfrost HTTP 200, 03:22:27Z) | VERIFIED |
| Registry entry | id `cmuxjl4ij0000v4vcxwbqulbs`, name "Bulkhead Captain", type Standard, Author "Bulkhead team", Tags bulkhead/cardano/vaults/multi-agent/crew/payments | VERIFIED (MPS `GET /registry`) |
| Pricing | `supportedPaymentSources[0].pricing = {"pricingType":"Dynamic"}` → supported source index **0** | VERIFIED |
| State | RegistrationRequested 03:22:42Z → RegistrationInitiated ~03:30Z → **RegistrationConfirmed** 03:32Z | VERIFIED |
| Registration (mint) tx | [768b226e…41f223](https://preprod.cardanoscan.io/transaction/768b226ef8dbe70045abff23a7688c969822c935fd43d95b92ba6bfbf841f223), block 5262941, fee 274626 lovelace | VERIFIED (MPS + Blockfrost `/txs`, HTTP 200) |
| agentIdentifier | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10d33eba055f7a8408ae351621383719ff41089f7fde1e55bb737b67c5000000` | VERIFIED: Blockfrost `/assets` quantity 1, initial mint tx = the tx above, NFT output at the selling wallet `addr_test1qrugzwff…3a3hpx` |
| Seller balance after | 699553889 lovelace (−446111: reg fee 274626 + ≈171485 other, likely collateral setup) | VERIFIED amount; split INFERRED |
| ~7.5 min Requested→Initiated | consistent with collateral creation + MPS 300 s wallet-lock timeout (demo gotcha); no error, no retry | INFERRED |
| apiBaseUrl | `http://127.0.0.1:4200` — loopback, not publicly reachable (fine for a private Coworker); not listening at registration time, MPS did not probe it | VERIFIED value; reachability by outside buyers: none |

Scoped MPS keys (values never printed; files owner-only ACL):

| key | scope | file | check |
|---|---|---|---|
| runtime `cmuxjl84p0003v4vc5xdp8mc9` | ReadAndPay (canAdmin false), usageLimited false, Preprod / `cardano:preprod` only, wallet scope = Selling wallet `cmuxiwa790009owvcaofhehg1` | `apps/sokosumi-worker/.local/mps-runtime.env` (`MPS_RUNTIME_TOKEN`) | VERIFIED `GET /api-key-status` + `GET /payment-source` HTTP 200 |
| buyer `cmuxjl8ed0005v4vcxrhqbopd` | ReadAndPay (canAdmin false), usageLimited false, Preprod only, wallet scope = Purchasing wallet `cmuxiwa790008owvc4fqcegab` | `.local/mps-buyer.env` (`MPS_BUYER_TOKEN`) | VERIFIED same reads |

Purchasing wallet `addr_test1qr0rnnrhe6tlj5cls2xcunaxvl8kgaa6henck5hjd2fvpw073tfdyz2574tg4rnazrw23t2klnd3ldlx22zdf75y7cnqpcvlyj`:
Blockfrost HTTP 404 at 03:32Z = **unmeasured** (never funded), not zero. Needs test ADA (and tUSDM) before Bulkhead
can buy from other Masumi agents.

Not exercised: any paid payment/purchase through these keys; the Standard API on :4200 was not running.

## Sokosumi Coworker E2E (2026-10-07, sokosumi-e2e agent) — details in `docs/e2e-sokosumi.md`

| item | value | label |
|---|---|---|
| Worker treasury top-up (simulated fiat step, labelled) | 10.478723 tUSD + 25 ADA → `addr_test1qrw53vhe…s4zzkgp`, tx [a12118dd…655d78](https://preprod.cardanoscan.io/transaction/a12118dd070887e72a85ee377c7b99bec18ba053153b1baa3a9b501900655d78), block 5262987 | VERIFIED (Blockfrost `/txs` 200) |
| Execution-only Task `01a1147a-0470-7263-b5ee-ef1c0f8cfead` | READY → RUNNING (coworker) → COMPLETED (coworker, event `01a1147c-edd5-704f-ae83-11911ee8fce7`) | VERIFIED (`sokosumi tasks get/events`) |
| Crew session funding | 2 sessions (A researcher, B summariser), tx [6306803c…cf5093](https://preprod.cardanoscan.io/transaction/6306803c40b6e88eeef9a1c8f6a338cf0bf22464d1f9594dc9b63da731cf5093), block 5262995 | VERIFIED (Blockfrost 200) |
| Crew session close | [8a082af3…25e9ce](https://preprod.cardanoscan.io/transaction/8a082af329d19941c352529342d8d026f00e9ed7282bb363e06cf2562b25e9ce), [1545ccee…404d17](https://preprod.cardanoscan.io/transaction/1545cceebecdaa935c89731ddf0dc1908848b8b44fce66c8917787b48d404d17), block 5262997, `valid_contract` true | VERIFIED (Blockfrost 200) |
| Result SHA-256 (raw UTF-8) | `062e0dc760c50700def92f922383d7ce75d19aaa60bfc15206e0a60932ecae44` (5101 B) = saved file = COMPLETED event text | VERIFIED |
| Paid Task `01a1147d-df7e-71db-9aad-2a3d5fb3e1fe` | MPS `POST /payment` HTTP 400 (`sellerReturnAddress` = empty V2 collection address from seed); no payment created (`searchQuery` → `[]`); no escrow, no on-chain tx | VERIFIED; root cause INFERRED from MPS source |
| Escrow / submit-result / withdrawal / seller settlement | not reached | — |

## Masumi buyer path (2026-10-07, masumi-buyer agent): `hire_agent` with `MARKET=masumi`

Code: `packages/engine/src/market-masumi.ts` (+ `test/market-masumi.test.ts`, 25 offline tests),
smoke script `packages/engine/scripts/masumi-hire-smoke.ts`. Sources used: MPS source
`masumi-payment-service/src/routes/api/{purchases,payments,registry,payment-source,wallet}`, payment-core
`blockchain-identifier.ts` / `http-exists-error.ts`, masumi skill `references/masumi-payments.md`,
`agentic-services.md`, `api-debug-recipes.md`, and the bundled cardano-dev-skills doc
`docs/sources/masumi/documentation/technical-documentation/agentic-service-api.mdx` (MIP-003; preferred over the
skill where they differ). **No purchase was made**: the purchasing wallet is unfunded (Blockfrost HTTP 404), so the
pay path is checked against source only. No preprod tx was submitted by this work.

Live reads (dedicated MPS `127.0.0.1:3901`, buyer key, read-only):

| call | result | label |
|---|---|---|
| `GET /health` (no token) | 200 `{status:"success",data:{status:"ok"}}`; any keyed route without `token` → 401 `{status:"error",error:{message}}` | VERIFIED |
| `GET /api-key-status` | `ReadAndPay`, canRead/canPay true, canAdmin false, `NetworkLimit ["Preprod"]`, `ChainIdLimit ["cardano:preprod"]`, wallet scope = purchasing wallet `cmuxiwa790008owvc4fqcegab` (response also echoes the token: never print it) | VERIFIED |
| `GET /wallet/list?walletType=Purchasing` | exactly one wallet, `addr_test1qr0rnnrh…pcvlyj`, vkey `de39cc77…a92c0b9`, `collectionAddress: ""` | VERIFIED |
| `GET /payment-source` | one source: Preprod `Web3CardanoV2`, policyId `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`, contract `addr_test1wzs4e6wc95…ftgn37w4g` | VERIFIED |
| `GET /registry?network=Preprod[&filterPaymentSourceType=Web3CardanoV2]` | `Assets: []` — MPS lists only agents minted by its own (in-scope) wallets; the buyer key does not even see Bulkhead's own agent | VERIFIED |
| `GET /registry/agent-identifier?…` (Bulkhead Captain) | 404 "Agent not found" (same wallet scoping) | VERIFIED |
| `GET /purchase?network=Preprod&filterPaymentSourceType=Web3CardanoV2` | `Purchases: []` | VERIFIED |
| `POST /purchase/resolve-blockchain-identifier` (unknown id) | 404 "Purchase not found" — the market treats 404 as "no purchase exists" | VERIFIED |
| `GET /utxos?address=<purchasing wallet>` | 404 "Address not found" (unfunded) | VERIFIED |
| Blockfrost `/assets/policy/67ab0c92…` + `/assets/{unit}` | 93 live registry NFTs (CIP-25 `metadata_version 2`, `supported_payment_sources[].settlement.address` = the same V2 contract) → the smoke preflight lists **27 hireable / 73 excluded** | VERIFIED |
| Third-party sellers `GET /availability`, `/input_schema` | e.g. `expert-travel-advisor-eve.vercel.app` → `{status:"available",type:"masumi-agent",…}`, input `request` (string); Kodosumi agents use `type:"none"` info fields; one registered `apiBaseUrl` answers HTML with HTTP 200 | VERIFIED |

What changed in `market-masumi.ts` and why:

| change | basis | label |
|---|---|---|
| Discovery reads the on-chain registry (Blockfrost, `BLOCKFROST_PREPROD_PROJECT_ID`; `MASUMI_AGENT_IDS` pins ids) instead of relying on MPS `GET /registry` | live: buyer-scoped `/registry` is empty | VERIFIED |
| Only agents purchasable on this MPS are listed: registry policy = an MPS payment-source `policyId`, and for V2 the seller's settlement contract = that source's `smartContractAddress` | `purchases/index.ts`: else 404 "No (V2) payment source found" | VERIFIED (source) |
| CIP-25 chunked strings joined; V1 `agentPricing.fixedPricing` and V2 `supported_payment_sources[].pricing.fixed[{asset,amount}]` both mapped; first Cardano source used (as MPS does without an index) | `registry/metadata-schema.ts`, payment-core `payment-source.ts` | VERIFIED (source + live metadata) |
| `/availability` must be JSON `status:"available"` (HTML 200 now refused); `type:"none"` schema fields skipped; `input_groups` flattened | live sellers + bundled MIP-003 doc | VERIFIED |
| `POST /purchase` body: `blockchainIdentifier, network, inputHash, sellerVkey, agentIdentifier, Amounts, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime` (unix-ms strings), `identifierFromPurchaser` (our 20-hex nonce), `buyerReturnAddress` (always the purchasing wallet — its `collectionAddress` is `""`, and V2 uses `?? collectionAddress`), `metadata`, plus the seller's `paymentSourceType`, `supportedPaymentSourceIndex`, `paymentForceLayer`, and now **`sellerReturnAddress`** | `purchases/schemas.ts createPurchaseInitSchemaInput`; `shared.ts` re-derives the seller-signed payload incl. sellerReturnAddress / paymentForceLayer / index | VERIFIED (source); not yet posted live |
| MPS timing rules checked before funding and again before posting (payBy ≤ submit−5 min; submit ≥ now+15 min; unlock ≥ submit+15 min; dispute ≥ unlock+15 min) | `shared.ts resolvePurchaseCreationContext` | VERIFIED (source) |
| Seller-forced `paymentForceLayer` other than null/`L1` refused (Hydra needs an open head) | `purchases/index.ts` | VERIFIED (source) |
| 409 "Purchase exists" carries `{id, object}` → purchase id kept | payment-core `http-exists-error.ts` + endpoint-factory | VERIFIED (source) |
| Purchase status via `POST /purchase/resolve-blockchain-identifier` → `onChainState` (`FundsLocked…RefundWithdrawn/DisputedWithdrawn`), `NextAction {requestedAction, errorType, errorNote}`, `CurrentTransaction.status`, `resultHash`, `WithdrawnForBuyer` | `purchases/schemas.ts purchaseResponseSchema` | VERIFIED (source; 404 shape live) |
| Lock never happened (no/failed lock tx after payByTime + 15 min) → funding returned (`funding_unused` → sweep) | `PurchasingAction` / `TransactionStatus` enums | INFERRED policy |
| MIP-004 check: `sha256(nonce;result)` vs the seller's `/status` hash and the on-chain `resultHash` (64 hex: MPS `submit-result` only accepts 64 hex, so the skill's 128-hex "decision hash" is stale); `/status` `result` or `output` accepted; seller `failed`/`refunded` → refund request (same key that purchased — MPS requires `requestedById`) | `payments/submit-result`, `purchases/request-refund` | VERIFIED (source) |
| Seller `start_job` response field names (`id`/`job_id`, `blockchainIdentifier`, `sellerVKey`, four times, `identifierFromPurchaser`, `input_hash`, Dynamic `amounts`) | bundled MIP-003 doc + Bulkhead's own seller; no third-party `start_job` was called (it would create a payment request on someone else's MPS) | REPORTED (doc) / INFERRED for third parties |

Money path reminder (unchanged): in the engine, a Session Vault `Pay` funds the purchasing wallet with tUSD (cap =
session mandate + `MASUMI_MAX_PRICE_TUSD`); MPS then locks the agent's own unit (tUSDM) from the wallet's float
("equivalent" funding). Refund sweeps need an MPS admin key; without it refunds stay in the purchasing wallet
(`unswept`) — INFERRED design, offline-tested only.

Ready-to-run smoke (`masumi-hire-smoke.ts`, default `preflight` is read-only — VERIFIED run 2026-10-07: health ok,
key scope ok, balance "unfunded", 27 hireable, picked "Hotel book expert" 1 tUSDM, availability ok):

```
pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/masumi-hire-smoke.ts preflight
pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/masumi-hire-smoke.ts quote --agent <agentIdentifier> --input "<text>"
pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/masumi-hire-smoke.ts buy --confirm-purchase --max 1 --agent <agentIdentifier> --input "<text>"
```

Funding needed before `buy` (send to the purchasing wallet
`addr_test1qr0rnnrhe6tlj5cls2xcunaxvl8kgaa6henck5hjd2fvpw073tfdyz2574tg4rnazrw23t2klnd3ldlx22zdf75y7cnqpcvlyj`):
**≥ 20 tADA** (lock tx = escrow min-UTxO, returned at settlement + 5 ADA collateral splitter self-output + fees;
MPS `PREP_TX_MIN_LOVELACE` 7 ADA, `WALLET_SPLITTER_LOVELACE` 5 ADA) **and ≥ the price in tUSDM**, unit
`16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` (MPS
`frontend/src/lib/constants/defaultWallets.ts` `PREPROD_USDM_CONFIG`). Suggested: 25 tADA + 2 tUSDM. The script
refuses `buy` below `MASUMI_SMOKE_MIN_ADA` (20) or below the price.

Not exercised: `POST /purchase`, escrow lock, seller result on-chain, refund, sweep — all pending funding.

### Standard API (MIP-003) conformance check, `127.0.0.1:4200`

Live (read-only / 4xx only; no valid `start_job` was sent to the running server): `/availability` 200
`{status:"available",type:"masumi-agent",message}`; `/input_schema` 200 flat `input_data` (`goal`, string, min 1 /
max 500); `/status` without `job_id` 400, unknown id 404; `/provide_input` unknown job 404; `/start_job` bad nonce
400, array `input_data` 400; `/demo` 200 — VERIFIED, all match the bundled MIP-003 doc (`input_data` is an object
there; the skill's `[{key,value}]` array form is older). MIP-004 hashes (`input_hash` = sha256(nonce;JCS(input)),
`output_hash`/`result_hash` = sha256(nonce;result), 64-hex `submitResultHash`) — VERIFIED against MPS
`submit-result` schema (64 hex) and `@bulkhead/shared/mip004` test vectors.

Fixed in `standard-api.ts` (tests in `test/standard-api.test.ts`): the `start_job` quote now also returns the MPS
`RequestedFunds` as `amounts`, and non-null `sellerReturnAddress` / `forceLayer` (as `paymentForceLayer`). Bulkhead
Captain is registered **Dynamic**, and MPS `POST /purchase` requires the Dynamic `Amounts` (they are inside the
seller signature), so without this no outside buyer could purchase from it — VERIFIED from source. **The running
:4200 process still serves the old code: restart it to pick this up** (not restarted here). Also: MPS `POST /payment`
for a Dynamic agent requires `RequestedFunds` (`payments/index.ts`, VERIFIED source), i.e. paid mode needs
`STANDARD_MPS_PRICE_UNIT` + `STANDARD_MPS_PRICE_AMOUNT`; whether the running server sets them was not checked.

## Settlement asset switch to tUSDM (2026-10-07)

Bulkhead's settlement asset is now configurable (`SETTLEMENT_ASSET` / `SETTLEMENT_UNIT`, default **tUSDM**; see DEPLOYMENTS.md "Settlement asset").

| Check | Result | Label |
|---|---|---|
| tUSDM unit `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`, CIP68v1, decimals 6, fingerprint `asset1mtjjpvfgtuxq3n872ptulrs25j0k4t8nd2pp2k` | Blockfrost `/assets/{unit}` | VERIFIED |
| Balances at 2026-10-07T03:59:42Z (Blockfrost `/addresses/{addr}`) | operator `addr_test1qp7fqfzm…xmwku6`: 442.181738 tADA, 999,866.712770 tUSD, **0 tUSDM** · Sokosumi coworker custodial treasury `addr_test1qrw53vhedg…s4zzkgp` (user `u_4ff72b9a…`): 24.239663 tADA, 10.478723 tUSD, **0 tUSDM** · self-custody wallet `addr_test1qpyurdf6…8hmyt5`: 854.600006 tADA, 41.914892 tUSD, **2,100 tUSDM** | VERIFIED |
| tUSDM vault: apply + fund → Pay (UPLC) → Revoke, self-custody unsigned funding in tUSDM | offline only (`packages/chain/test/settlement.test.ts`, Mesh offline evaluator) | VERIFIED offline |
| tUSDM funding + Pay + Revoke on preprod | **not run**: the custodial treasury holds 0 tUSDM | NOT RUN |

## Sokosumi credits hire (2026-10-07, sokosumi-market agent): `hire_agent` with `MARKET=sokosumi` — details in `docs/e2e-sokosumi.md`

**Off-chain:** Sokosumi credits are platform credits, not a Cardano asset. Nothing in this section is on-chain and no tx hash exists.

| claim | evidence | label |
|---|---|---|
| Job `01a114e1-8fb6-760a-a9e6-e67b40278cd8` ("Expose: Advanced Web Research", 1 credit, maxCredits 2) was created in the TOKEN2049 Origins Hackathon org (`01a109d1-…87cd`, slug `token2049-origins-hackathon-2026-nws2r7`) | 201 response `organizationId` = the org id; request carried `X-Organization-Slug` | VERIFIED |
| Hackathon org credits 58,700 → 58,699; personal 3,250 → 3,250; Bulkhead org 250 → 250 | org-scoped + personal-scope + other-org balance reads before/after creation | VERIFIED (org pool is shared, so Δ is attributed by timing only: INFERRED that the −1 is ours) |
| Job result + sha256(raw UTF-8 result) | status **completed**, 6,348-char result, sha256 `d44732fbdb07a5143aa39503371d8bdf3789b64366598ec1a87db304252615c0` (read 2026-10-07 after the API key was replaced; credits are off-chain) | VERIFIED |
| Engine path (credit payment row, `agent_job_paid` kind credits, DoD on jobId + resultHash, incidents, cap) | `packages/engine/test/market-sokosumi.test.ts` (10 tests, offline fake API) | VERIFIED offline |
