# Task: make Bulkhead Cardano-native where it matters (round 3)

User request (2026-10-07): "using these skills improve and make things work on my idea rn, a lot of things are not
really fully cardano yet where necessary" + standing rule: ALWAYS use the cardano-dev-skills skills (Skill tool),
the bundled docs (C:/Users/zhan quan/.claude/cardano-dev-skills/docs/sources/) and the project SDKs (Mesh 1.9.1 —
verify every API in node_modules/@meshsdk/*/dist/index.d.ts; Mesh 2.0 names are wrong here; @meshsdk/core loads
through packages/chain/src/mesh.ts).

Rules (unchanged): docs/TEAM-BRIEF.md (no pnpm install/add — ask the lead; never print keys/mnemonics; preprod only;
NOWNodes untouched), docs/VAULT-SPEC.md chain-lock protocol for ANY preprod submission (mkdir bulkhead/.chain-lock),
keep every existing test passing (chain 94, engine 67+, market 16, web build). Don't run `pnpm dev` (the lead
restarts it). Dev servers are stopped during this round.

## Workstreams (one agent each)
A. Wallet identity — CIP-30 signData / CIP-8 COSE_Sign1:
   - "Sign in with Cardano wallet" (Auth.js credentials provider "wallet"): server issues a one-time nonce
     (stored with expiry), browser signs it with CIP-30 signData (Mesh wallet.signData), server verifies with Mesh
     checkSignature against the claimed address, then upserts the engine user by a wallet-derived identity
     (`wallet:<stake_test1…>`), custody "self".
   - Linking a wallet as self-custody treasury (POST /api/custody) REQUIRES the same nonce+signature proof (today any
     addr_test1 is accepted — fix that).
   - Decision approvals by self-custody users: the browser signs a canonical payload
     ({decisionId, kind, sessionId, amount, payee, status, nonce, at}) with signData; the engine verifies and stores the
     COSE signature + key with the decision (evidence), shown in the Decisions list ("signed by wallet"). Custodial users
     keep click-to-approve.
   - Owns: apps/web/auth.ts, apps/web/app/login/**, apps/web/app/api/custody/**, apps/web/app/api/wallet-auth/**,
     apps/web/components/WalletConnect.tsx, the Decisions UI, packages/engine/src/api-wallet.ts (new; one mount line
     in api.ts), decision-evidence storage (kv table, or a new db column — tell the lead).
B. Self-custody vault — CIP-30 signTx:
   - Vault mode for self-custody users: build the vault funding tx UNSIGNED from the user's wallet address UTxOs
     (owner = the wallet's full address incl. its stake credential), send it to the browser through the existing
     SigningBroker / needsSignature flow, assemble + submit via chain.tx.submitSigned. Revoke/Recover return funds to the
     wallet address. Remove the "self-custody always native" restriction once it works.
   - Owns: packages/chain/src/vault/** additions (e.g. buildUnsignedVaultFunding), the vault section of
     packages/chain/src/tx.ts, packages/engine/src/self-custody.ts, packages/engine/src/vault.ts, the funding branch of
     packages/engine/src/sessions.ts.
C. tUSD as a CIP-68 fungible token (333) + CIP-14:
   - New asset name = CIP-67 label 333 prefix (0014df10) + "tUSD"; reference NFT (label 100, 000643b0 + "tUSD") with
     inline datum CIP-68 metadata { name: "Bulkhead test USD", ticker: "tUSD", decimals: 6, description } held at the
     operator address (document: production would lock it at a script). Same operator policy.
   - Migrate: setup-chain mints the reference token once + the 333 supply; tUSD unit resolution (tusdUnit(),
     TUSD_UNIT, vault params tusd_name, market matching, e2e, UI) uses the new unit; the legacy unit is documented as
     deprecated. Show the CIP-14 asset fingerprint (asset1…) on the treasury card.
   - Owns: the tUSD parts of packages/chain/src/script.ts, tusdUnit/operatorInfo in the chain index, the tUSD part of
     setup-chain.ts, the mock-market tUSD unit, a new CIP-68 helper module, the TreasuryCard fingerprint line.
D. Chain finality + ADA Handle payees:
   - CONFIRMATIONS env (default 2): a payment / funding / close counts as confirmed only after N blocks on top
     (watcher + confirmation waits); rollback safety: if a tx disappears before N, treat it as pending again.
   - Payees may be written as `$handle` (ADA Handle, CIP-68 user token 000de140 under policy
     f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a on preprod): resolve to the current holder address via
     Blockfrost assets/{unit}/addresses at plan time; store both the handle and the resolved address; show the handle in
     the UI.
   - Owns: packages/chain/src/watcher.ts, confirmation helpers in packages/engine/src/sessions-store.ts, a new
     packages/chain/src/handle.ts, the payee-resolution step in packages/engine/src/planner.ts.

## Evidence
Each workstream appends a section to CHAIN_VERIFICATION.md (append only) with preprod tx hashes where applicable.
