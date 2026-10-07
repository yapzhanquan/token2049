# Sokosumi / Masumi protocol notes for Bulkhead

Research date: 2026-10-07. Read-only study of the TOKEN2049 demo repository
(`demo-agent-token2049`, no LICENSE: reference only, nothing copied beyond short
command and JSON shapes). Everything below is a description in our own words.

Sources and their standing:

| Tag | Source | Standing |
| --- | --- | --- |
| `LIVE` | `origin/live-demo-name-finder` @ `ff35ea7`, dir `live-team-names-20261006/` plus root `AGENTS.md` (guide commit `781b93d`) | VERIFIED live demo (Hackathon Team Name Finder, 2026-10-06) |
| `GUIDE` | `origin/feat/token2049-event-guide` @ `25844b9`, `docs/*.md` | REPORTED earlier reference (TOKEN2049 Event Guide, 2026-10-05) |
| `SKILL` | `.claude/skills/masumi/references/*.md` | Generic Masumi reference, cross-check only |

Line references are `file:line` inside `LIVE` unless prefixed with `GUIDE:` or `AGENTS.md`.
Labels used in this document: **VERIFIED** (the demo recorded an observation),
**REPORTED** (the demo cites someone else or an older branch), **INFERRED** (our reading or
the demo's own assumption), **UNTESTED** (implemented but never exercised live).

---

## 0. Architecture of the demo in one picture

```
Sokosumi Core (preprod)                      this machine (all loopback)
 Task READY ──tasks list (CLI, OAuth)──▶ worker.mjs (single lock .local/worker.lock)
            ◀─runtime start/complete (CLI, Coworker key from OS vault)
            ◀─POST /v1/tasks/{id}/events (Coworker HTTP client: masumiPayment, COMPLETED, comments)
            ─▶GET /v1/tasks/{id}/receipt, /events
                                              │
                                              ├─ eve agent  127.0.0.1:21949 (model turns, sessions)
                                              ├─ MPS        127.0.0.1:38127 (dedicated DB + wallets)
                                              │     token: ReadAndPay key from .local/mps-runtime.env
                                              └─ agent-api.mjs 127.0.0.1:21950 (MIP-003 Standard API)
Blockfrost preprod  ◀── independent settlement check (txs/{hash}/utxos)
```

---

## 1. Sokosumi CLI usage

### 1.1 Version

- VERIFIED (`README.md:7`, `AGENTS.md:284`): demo used **Sokosumi CLI 1.0.4**.
- Observed on this machine (2026-10-07): installed `sokosumi` is **1.0.0**; `npm view @masumi_network/sokosumi version` reports `1.0.4`.
  - 1.0.0 has no `sokosumi skills path` (the demo's runtime loader depends on it, `sokosumi-runtime.mjs:6`).
  - 1.0.0 help says `runtime start|complete|run` require `--coworker-id ID --organization-id ID`; 1.0.4 accepts `--personal` (GUIDE `bugs.md:41`). **Upgrade to 1.0.4 before building Bulkhead's worker.**

### 1.2 Global conventions

- Every call is `sokosumi --preprod <group> <command> ... --json` (worker wraps it this way, `worker.mjs:11`; 30 s timeout, 4 MiB buffer, `execFileSync` with an argv array, never a shell string).
- `SOKOSUMI_API_KEY` / `SOKOSUMI_AUTH_TOKEN` in the environment override the saved OAuth login (CLI help; `AGENTS.md:200`). Check for overrides (names only) before trusting `whoami`.

### 1.3 Preflight (read-only) — `AGENTS.md:187-195`

```sh
sokosumi --version
sokosumi --preprod auth whoami --json
sokosumi --preprod vendors me --json
sokosumi --preprod coworkers list --scope owned --json
sokosumi --preprod workspaces list --personal --json
sokosumi skills
```

- `AUTH_REQUIRED` from `whoami` = record authentication blocked; do not auto-login. Human action: `https://preprod.sokosumi.com/signup` then `sokosumi --preprod auth login` (`AGENTS.md:203-204`).

### 1.4 Vendor + Coworker creation — `AGENTS.md:270-274`

```sh
sokosumi --preprod vendors create --name "NAME" --slug SLUG --json
sokosumi --preprod coworkers register --vendor-id VENDOR_ID \
  --name "NAME" --capability tasks --personal --json
```

- Save returned IDs immediately (`docs/setup-state.json` holds `vendorId`, `coworkerId`). On resume reconnect, never re-register (`AGENTS.md:276-278`).
- Gotcha VERIFIED: `vendors create` can fail with *"Creating a vendor requires an organization workspace. Create or join an organization first."* (HTTP 403, GUIDE `decisions.md:22`). CLI 1.0.4 has no `workspaces create`; organizations are created in the Web UI. Fallback rule in `AGENTS.md:18`: reuse the account's existing admin Vendor if Core rejects another Vendor because of an account limit. The live demo's `vendorId` `01a1067b-…` predates the run (INFERRED: it reused an existing Vendor).
- VERIFIED (`status.md:3`): Coworker shows `GRANTED` access to the Personal Workspace. GUIDE `interfaces.md:28-34`: a personal Coworker is `isShown: false`, `isWhitelisted: false`; Personal Workspace access does not imply public catalog visibility or access from other Workspaces.

### 1.5 Runtime credential import (vault) — `AGENTS.md:290-299`

```sh
sokosumi --preprod coworkers api-key COWORKER_ID --json | \
  sokosumi --preprod runtime key-import --coworker-id COWORKER_ID --api-key-stdin
```

- The Coworker key goes straight from one CLI process into the OS credential vault via stdin. It must never be printed, put in `.env`, source, model context, or a Task. No shell tracing (`set -x`).
- The worker never reads the vault directly; it uses the CLI's own credential interface (`readRuntimeCredential(coworkerId)` from the installed CLI package, see §2.6).
- The user's OAuth token is **never** the runtime credential (`AGENTS.md:299`, `README.md:14`).

### 1.6 Task commands used by the worker

| Purpose | Command (as used) | Credential |
| --- | --- | --- |
| Poll | `sokosumi --preprod tasks list --coworker-id ID --json` → `.tasks[]` (`worker.mjs:17`) | OAuth (account) |
| Claim | `sokosumi --preprod runtime start TASK_ID --personal --coworker-id ID --json` → `.description` is the authoritative input (`worker.mjs:22`) | Coworker key (vault) |
| Finish | `sokosumi --preprod runtime complete TASK_ID --personal --coworker-id ID --result-file PATH --json` (`worker.mjs:32`) | Coworker key (vault) |

- VERIFIED gotcha (GUIDE `bugs.md:39-43`, `AGENTS.md:394`): `tasks list` **rejects `--personal`** in 1.0.4. Only `coworkers register/connect`, `tasks create`, `workspaces list`, `runtime start/complete/run` accept it.
- Also available in the CLI (not used by the demo's worker): `tasks get`, `tasks events`, `tasks comment`, `tasks create`, `runtime run`. The demo reads events and posts comments through the Coworker HTTP client instead (§5), because those must act as the Coworker, not the user.

### 1.7 Security rules (consolidated)

- One config file `.env` (mode 600); `.env.example` is the full variable contract with empty credential fields (`AGENTS.md:127-141`). Entry points run as `node --env-file-if-exists=.env ENTRY` (`package.json:9-12`).
- `.gitignore` must cover `.env`, `.env.*` (except example), `.postgres.env`, `.local/`, `node_modules/`, `.eve/`, `.workflow/`, `.output/`, `dist/` before any secret exists (`AGENTS.md:167-180`).
- Private dirs 700, secret files 600 (`AGENTS.md:182`); every journal write in the demo uses mode `0o600`.
- `.local/mps.env` = generated MPS node secrets; `.local/mps-runtime.env` = `MPS_RUNTIME_TOKEN=` scoped ReadAndPay key (`AGENTS.md:139`, `payment-registration.mjs:17`). Admin key is setup-only.
- All services bind `127.0.0.1` and the binding is verified with the actual listener (`lsof`/netstat), since `PORT` alone does not prove loopback (`AGENTS.md:359-363`, `status.md:11`).
- Never print env dumps, wallet/admin/api-key responses, or seed output; extract public fields in a private script (`AGENTS.md:183, 370`).

---

## 2. Worker

### 2.1 Loop — `worker.mjs:15-40`

1. Acquire single-executor lock (2.2), check eve health, build paid adapter.
2. Forever: `tasks list --coworker-id`, keep only `t.coworkerId === id`.
3. For each Task, inside its **own try/catch** (`worker.mjs:19,36`): run the phase machine. A failure logs `Task blocked <id>` (first 200 chars) and moves to the next Task.
4. Outer try/catch around the list read (`worker.mjs:38`): transient read failure logs and keeps polling.
5. Sleep 5 s, repeat. Continuous polling is mandatory; a one-pass worker does not count (`AGENTS.md:386`).

### 2.2 Lock file / single executor — `worker-lock.mjs`

- Lock path `.local/worker.lock` (dir created 700, file 600), content = owner PID.
- Acquire: first create a guard file `worker.lock.recovery` with exclusive create (`wx`); if the guard exists, refuse ("recovery in progress"). Then exclusive-create the lock. If the lock exists: parse PID (must be a positive safe integer, else refuse and require inspection — empty, `0`, or garbage are never auto-removed); probe with signal 0; only on `ESRCH` (owner confirmed dead) delete and recreate. Live owner = "Worker already running".
- Release only if the file is still the same inode/device and still contains our PID (a replacement lock is never deleted). Released on `exit`, `SIGINT`, `SIGTERM`.
- Tests prove: exactly one of 4 concurrent starters wins, both from empty and from a stale dead-PID lock (`worker-lock.test.mjs:19-24`).
- Rule (`AGENTS.md:114, 387-388`): never two Coworker executors; recover locks only when the owner is confirmed dead. The same lock also covers comment replies (GUIDE `interfaces.md:149`).
- Windows note (INFERRED): `process.kill(pid, 0)` works on Windows in Node, but inode identity (`ino`) semantics differ; test the release path on Windows.

### 2.3 Journals and state files (all under `.local/`, mode 600)

| File | Content |
| --- | --- |
| `.local/<taskId>.json` | Task journal: `phase` (`starting` → `started` → `model-pending` → `result-saved` → `complete-pending` → `completed`), `input`, `completion`, and for paid Tasks a `paid` sub-object (§3) |
| `.local/<taskId>.txt` | Exact UTF-8 result bytes (written before any completion or hash submission) |
| `.local/<taskId>-session.json` | eve `sessionId` saved **before** the model send, then `phase: answered` + result (`client.mjs:7,11`) |
| `.local/<taskId>-comments.json` | per-event reply progress (§5) |
| `.local/standard-jobs/<uuid>.json` + `.txt` | Standard API jobs (§6) |
| `docs/setup-state.json`, `docs/payment-state.json`, `docs/registration-state.json` | non-secret setup records with VERIFIED/REPORTED/INFERRED provenance |

### 2.4 Phase machine and restart safety — `worker.mjs:22-35`

- Start: only when `status === 'READY'` and no saved phase. Write `phase: starting` **before** `runtime start`; afterwards save `phase: started` with `input = started.description`.
- Model: write `model-pending` before calling eve; then write `.txt`, then `result-saved`.
- Completion: write `complete-pending` before `runtime complete --result-file`; then `completed` with the CLI response.
- Restart: a Task whose journal says `starting`, `model-pending`, or `complete-pending` matches no branch and is silently left alone (the uncertain-write rule: an unknown outcome is never retried automatically; a human inspects). A `result-saved` Task resumes at completion using the saved file (safe execution-only completion reuses the saved result, `AGENTS.md:389`).
- After `completed`, the worker keeps calling `reply(taskId)` every pass for comments.

### 2.5 Authoritative input

- Use the `description` returned by `runtime start`, not the earlier `tasks list` snapshot (`AGENTS.md:396`, `worker.mjs:22`). The paid path refuses to run without it (`paid-task.mjs:53`).
- GUIDE variant: new Tasks include existing human comments in their first input (`interfaces.md:36,151`).
- Input bounds: 1-16000 characters (`client.mjs:5`).

### 2.6 Coworker HTTP client (non-CLI calls)

- `sokosumi-runtime.mjs` finds the installed CLI package via `sokosumi skills path` (must be absolute, end in `/skills`), then imports `dist/src/coworker/runtime-credentials.js`, `dist/src/api/http-client.js`, `dist/src/api/services/task-service.js`.
- Uses `createCoworkerHttpClient({apiKey: readRuntimeCredential(COWORKER_ID)})`, plus `fetchTaskEvents` / `createTaskEvent`. These are internal modules of the CLI package (INFERRED: not a stable public API; pin the CLI version).
- VERIFIED gotcha (GUIDE `bugs.md:45-56`, D7): Core rejected a payment event with HTTP 422 *"Only the assigned coworker can set masumiPayment on task events"* when the client sent a `contextUserId` header (acting for the user). Payment and completion events must be sent as the Coworker with no user-context header.

### 2.7 Error handling summary

- One failing Task never blocks the others; one failing read never stops polling (`worker.mjs:36,38`; GUIDE D10/D11).
- Messages are truncated to 200 chars and never include secrets.
- Unknown writes stay `*-pending`; recovery is manual after inspection (`README.md:25`).

---

## 3. Paid Tasks (direct Sokosumi Task payments) — `paid-task.mjs`

### 3.1 Gate

- `PAID_TASKS_ENABLED=true` in env **and** `docs/registration-state.json` says `RegistrationConfirmed` **and** `.local/mps-runtime.env` exists (`paid-task.mjs:27-31`, `worker.mjs:23-24`). Only Tasks in `started` phase enter the paid path; a Task already marked paid waits if the flag is later turned off.

### 3.2 Unit and quote

- Token: test USDM on Preprod, unit (policy id + asset name hex) `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` (`paid-task.mjs:7`, `AGENTS.md:436`).
- Amounts are strings of atomic units, 6 decimals: 1 tUSDM = `"1000000"`.
- The demo hard-codes one quote (1 tUSDM) and rejects any signed terms that differ (`paid-task.mjs:18`). Bulkhead's quote (crew budget + fee, capped) would be computed per Task, then validated the same way against the signed response.

### 3.3 Stage machine (`state.paid.stage`)

| Stage | Action | Persist before the external write |
| --- | --- | --- |
| *(none)* | Build terms request; random 10-byte hex nonce; `inputHash = sha256(input)` raw; deadlines from now: payBy +5 min, submitResult +20, unlock +36, externalDisputeUnlock +52; `metadata = {"taskId": ...}` | `terms-pending` (with nonce + request body) |
| → | `POST {MPS}/api/v1/payment` → save full signed response | `terms-saved` |
| `terms-saved` | Validate (3.4), check `payByTime` not passed, build `masumiPayment` payload | `purchase-pending` |
| → | Core `POST /v1/tasks/{id}/events` body `{comment: "Payment requested: 1 test USDM.", masumiPayment: payload}` as Coworker; save `eventId` | `awaiting-escrow` |
| `awaiting-escrow` | `POST /api/v1/payment/resolve-blockchain-identifier` `{network, blockchainIdentifier, includeHistory:"true"}`; require `onChainState === FundsLocked` **and** a **Confirmed** transaction whose `newOnChainState` is `FundsLocked` (3.5). Check `submitResultTime` after the read and again right before the model send | `model-pending` |
| → | eve turn (with deadline); non-empty string required; write `.local/<id>.txt`; `resultHash = sha256(result)` raw | `result-saved` |
| `result-saved` | Check deadline; `POST /api/v1/payment/submit-result` `{network, blockchainIdentifier, submitResultHash}` | `submit-pending` → `awaiting-result` |
| `awaiting-result` | Poll resolve; require `observed.resultHash === saved hash`, confirmed `ResultSubmitted` | `complete-ready` |
| `complete-ready` | Core `POST /v1/tasks/{id}/events` `{status:"COMPLETED", comment: <exact result>}` | `complete-pending` → Task `phase: completed`, stage `awaiting-withdrawal` |
| `awaiting-withdrawal` | When `onChainState` ∈ {`Withdrawn`,`DisputedWithdrawn`} run settlement verification (3.7) | `settled` once verified |
| any `*-pending` on re-entry | throw "Uncertain … automatic retry disabled" | — |

Order that matters: **escrow confirmed → model → save exact result → submit hash → wait confirmed ResultSubmitted with matching hash → complete Task → wait for withdrawal → verify settlement**. The paid result and its hash are never changed after completion; comment replies are separate events (`README.md:26`).

Note: the paid path completes via a Core event (`status: COMPLETED`, `comment: result`) through the Coworker HTTP client, not via `runtime complete --result-file` (that CLI command is used for execution-only Tasks). INFERRED: either path should be acceptable as long as the posted text equals the hashed bytes; the demo verified the event path (`docs/paid-smoke.json`).

### 3.4 Signed terms: preserve, never rewrite — `paid-task.mjs:14-26`

The `masumiPayment` payload is built only from the signed MPS response, field for field:
`blockchainIdentifier`, `agentIdentifier`, `sellerVkey` (= `SmartContractWallet.walletVkey`), `submitResultTime`, `payByTime`, `unlockTime`, `externalDisputeUnlockTime`, `inputHash`, `identifierFromPurchaser` (the nonce), `paymentSourceType: "Web3CardanoV2"`, `supportedPaymentSourceIndex`, `Amounts: [{amount, unit}]`, `PaymentSource: {network:"Preprod", smartContractAddress, policyId}`.

Rejected before posting:
- `sellerReturnAddress` not null, or `forceLayer` present and not null (Core Task events cannot carry those overrides). Null overrides are fine; an absent `forceLayer` is accepted because the running MPS build does not sign it (`paid-task.mjs:12-13,47`).
- Payment source not Preprod / Web3CardanoV2.
- `SmartContractWallet.id` differs from the dedicated seller wallet.
- `RequestedFunds` not exactly one entry of the expected unit and amount.
- The signed quote is persisted *before* validation, so a rejected payload never loses a successful quote (`paid-task.test.mjs:39-45`).
- Deadlines: MPS returns them as millisecond-epoch strings (`Number(p.payment.payByTime)`); GUIDE notes public Standard responses there used Unix **seconds** while saved signed terms kept milliseconds (`interfaces.md:53`). The LIVE Standard API returns the numbers unchanged (ms). INFERRED: confirm the unit expected by each consumer.

### 3.5 Escrow confirmation check — `paid-task.mjs:9-11`

`confirmedState(payment, X)` is true only if `CurrentTransaction.status === "Confirmed"` with `newOnChainState === X`, or any `TransactionHistory` entry is Confirmed with that `newOnChainState`. An unrelated confirmed transaction (e.g., `Withdrawn`) does not prove `FundsLocked` (`paid-task.test.mjs:35-49`). `onChainState === FundsLocked` alone is insufficient.

### 3.6 Identifiers

| Identifier | Origin | Use |
| --- | --- | --- |
| `agentIdentifier` | MPS registry after `RegistrationConfirmed` (policy id + asset name, long hex) | payment request, payload |
| `supportedPaymentSourceIndex` | index into the registration's `supportedPaymentSources` (demo: `0`) | payment request, payload |
| `identifierFromPurchaser` | seller-generated random hex nonce (10 bytes = 20 hex) for Task path; buyer-supplied for Standard path (14-26 hex) | input/result hashes, payload |
| `blockchainIdentifier` | returned by `POST /payment` (signed) | every later MPS call, Core receipt match |
| `eventId`, `completionEventId` | Core event IDs | evidence |
| Core receipt `txHash` vs MPS `TransactionHistory[].txHash` | withdrawal transaction | settlement match |

### 3.7 Settlement verification — `settlement.mjs`

1. Core `GET /v1/tasks/{id}/receipt` (Coworker client). Not settled or no `txHash` → not verified yet.
2. `receipt.blockchainIdentifier` must equal the MPS payment's, else hard error.
3. Find an MPS transaction (current or history) that is Confirmed, `newOnChainState` ∈ {Withdrawn, DisputedWithdrawn}, and whose `txHash === receipt.txHash`.
4. Blockfrost `GET https://cardano-preprod.blockfrost.io/api/v0/txs/{txHash}/utxos` with header `project_id: BLOCKFROST_API_KEY_PREPROD`.
5. Net seller receipt = sum of the unit in **outputs** at the seller address minus sum in **inputs** at the seller address (change does not count as income, `settlement.test.mjs`). `verified` only if net > 0. Record `txHash`, `netAtomicUnits`, method.

Why `withdrawnForSeller` is not proof (VERIFIED, GUIDE `bugs.md:58-69`, D8): an ordinary `Withdrawn` receipt can be `settled: true` with `withdrawnForSeller: []`; that field is a disputed-payout summary only. Conversely, Task `COMPLETED`, workspace credit debit (`totalCredits: 100`), and `claimStatus: PURCHASED` do not prove seller receipt either (`AGENTS.md:444-445`, GUIDE `bugs.md:56`). GUIDE's proof also excluded collateral and reference inputs and recorded confirmations (`interfaces.md:116-118`).

Funding facts: seller needs test ADA for registration, collateral and settlement fees; Core supplies the buyer's escrow funds, so the seller does not need tUSDM for the normal Sokosumi path (`AGENTS.md:377-379`). Blockfrost HTTP 404 on an address means "not determined", never zero (`AGENTS.md:376`, `docs/payment-state.json`).

### 3.8 Demo's paid evidence (what it actually proved)

- VERIFIED: paid Task `01a10ef7-…` `COMPLETED` after confirmed `ResultSubmitted` (result tx `b96438fd…`), stage `awaiting-withdrawal`; **seller receipt pending** (`docs/paid-smoke.json`). Later `status.md:33`: paid automatic advancement disabled; "No paid receipt claimed".
- REPORTED (GUIDE, different hashing, §6.4): seller collection fully verified, 1000000 net units, tx `64a9b1a0…`, 39 confirmations.

---

## 4. MPS (Masumi Payment Service) calls

Base `MPS_URL` + `/api/v1`, header `token: <key>`, `Content-Type: application/json`; success means HTTP 2xx **and** body `status: "success"`, payload in `data` (`paid-task.mjs:46`). Requests use `redirect: "error"` and 30 s timeouts.

### 4.1 Dedicated node setup — `AGENTS.md:302-373`

- Own PostgreSQL database + role (safe identifier = normalized slug + random suffix, never raw user text in SQL), own `ENCRYPTION_KEY`, own `ADMIN_KEY`, own wallets. Never reuse another project's key or wallets.
- Config names: `DATABASE_URL`, `ENCRYPTION_KEY` (≥32 chars), `ADMIN_KEY` (≥32), `BLOCKFROST_API_KEY_PREPROD`, `PORT`, `SEED_ONLY_IF_EMPTY=true`, `AUTO_WITHDRAW_PAYMENTS=true`; mainnet/mnemonic/override fields empty.
- Migrate the dedicated DB, then seed **once** with the service's own seed script, stdout+stderr redirected into a pre-created 600 file under `.local/` that is never read (it contains mnemonics). One seed process per DB; on timeout inspect process/DB state before retry.
- Health: `GET /api/v1/health` → `status: success`, `data.status: ok`. Fetch `/api-docs` for live schemas.
- VERIFIED gotcha (`status.md:27-28`, `docs/payment-state.json`): health OK and registry confirmation did not prove payments work; the old built binary queried a column missing from the migrated schema (`PaymentRequest.cardanoFeeAccountingVersion`). Fix was rebuilding the current source; no reseed.

### 4.2 Routes used

| Route | Key | Purpose / body |
| --- | --- | --- |
| `GET /payment-source?take=100` | admin | find the seeded Preprod `Web3CardanoV2` source → `smartContractAddress` |
| `GET /wallet?walletType=Selling&id=WALLET_ID` | admin (runtime key gets 401) | `walletVkey`, `walletAddress` |
| `POST /registry` | admin | register agent (4.3) |
| `GET /registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=100` | admin | poll for `state: RegistrationConfirmed`, `agentIdentifier`, `CurrentTransaction` |
| `POST /api-key` | admin | create scoped runtime key (4.4) |
| `GET /api-key-status` | runtime | verify runtime auth (200) |
| `GET /payment?network=Preprod&limit=100` | runtime | read check (VERIFIED 200) |
| `POST /payment` | runtime | signed terms (seller payment request) |
| `POST /payment/resolve-blockchain-identifier` | runtime | `{network, blockchainIdentifier, includeHistory:"true"}` |
| `POST /payment/submit-result` | runtime | `{network, blockchainIdentifier, submitResultHash}` |

`POST /payment` body used (`paid-task.mjs:55-57`, `agent-api.mjs:39`): `network`, `agentIdentifier`, `paymentSourceType: "Web3CardanoV2"`, `supportedPaymentSourceIndex`, `inputHash`, `identifierFromPurchaser`, `RequestedFunds: [{amount, unit}]`, `payByTime`, `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime` (ISO strings), optional `metadata` (string).

### 4.3 Registration with Dynamic pricing — `payment-registration.mjs:26`

Shape (values from the demo's saved request):

```json
{"network":"Preprod","type":"Standard","sellingWalletVkey":"<vkey>",
 "supportedPaymentSources":[{"chain":"Cardano","network":"Preprod","paymentSourceType":"Web3CardanoV2",
   "address":"<smartContractAddress>","pricing":{"pricingType":"Dynamic"}}],
 "ExampleOutputs":[],"Tags":["..."],"name":"...","description":"...",
 "Capability":{"name":"<model>","version":"1"},"Author":{"name":"..."},
 "apiBaseUrl":"http://127.0.0.1:<AGENT_API_PORT>"}
```

- Note: pricing sits in `supportedPaymentSources[].pricing`, **not** the older top-level `AgentPricing` (SKILL `masumi-payments.md` still shows `AgentPricing` and requires ≥1 `ExampleOutputs`; the live MPS accepted an empty list and returned `AgentPricing: null`).
- `apiBaseUrl` is loopback, validated as an integer port (`registration-config.mjs`). INFERRED: fine for private Sokosumi Tasks; external buyers cannot reach it.
- Sanity checks before the write: wallet address equals the saved seller address; source id equals the saved source.
- Write discipline: `registrationWritePending=true` saved before POST; a pending flag on restart means "inspect registry before retry".
- Wait for `RegistrationConfirmed` (VERIFIED tx `4391dc1b…`, fee 270578 lovelace, ~7 min after request). Supported source index used afterwards: `0`.
- REPORTED gotcha (`docs/registration-state.json` `collateralEvidence`): collateral was on-chain but MPS kept the wallet locked until its wallet-lock timeout (default 300 s) passed.

### 4.4 Scoped ReadAndPay key — `payment-registration.mjs:14`

Body: `usageLimited:"false"`, `UsageCredits:[]`, `NetworkLimit:["Preprod"]`, `ChainIdLimit:[]`, `canRead:true`, `canPay:true`, `canAdmin:false`, `walletScopeEnabled:true`, `WalletScopeHotWalletIds:[<selling wallet id>]`, `x402WalletScopeEnabled:true`, `X402WalletScopeEvmWalletIds:[]`.

- Result VERIFIED: `permission: ReadAndPay`, `ChainIdLimit: ["cardano:preprod"]`, one wallet scope.
- Token written straight to `.local/mps-runtime.env` as `MPS_RUNTIME_TOKEN=…` (600). If the returned token is masked (`*****…`) keep the key id and use the supported update path; a masked/missing token file = "recovery required" (`registration-config.mjs:7-11`).
- VERIFIED gotcha: server default flipped `usageLimited` on update; a PATCH with explicit `usageLimited: false` corrected it.
- `keyWritePending` guard exactly like registration.

---

## 5. Human comments — `comments.mjs` (LIVE), `task-comments.mjs` (GUIDE)

- Run for every `completed` Task on each pass, under the same worker lock.
- Read events through the Coworker client. Core route: `GET /v1/tasks/{id}/events?limit=100`, oldest first, follow `meta.pagination.nextCursor` until null (GUIDE `interfaces.md:144-146`). GUIDE D12: a missing `nextCursor` must not be taken as end-of-history; require string or null. LIVE relies on the CLI's `fetchTaskEvents` to page (INFERRED; not re-verified).
- Eligible event: `actor.type === "user"` and non-empty `comment` (not deprecated user-id fields on bot events; Coworker/bot events ignored to avoid loops).
- Per event id, journal `model-pending` → send to the **same saved eve session** (`sessionId` from `.local/<task>-session.json`, input capped 16000 chars) → `post-pending` → `POST /v1/tasks/{id}/events` with only `{comment}` as Coworker → `posted`.
- Idempotency: Core has no documented idempotency key (GUIDE `interfaces.md:152`). Any event already in the journal is skipped (so an uncertain send/post is never repeated). GUIDE recovers an uncertain post only by finding a Coworker event whose text equals the saved reply.
- Replies never complete the Task, never resubmit hashes, never touch `.txt` or the paid journal.
- GUIDE boundary rule: for legacy Tasks, comments up to the completion event are "already seen"; new Tasks fold existing comments into the first input.
- LIVE status: implemented, **no human-comment smoke test** (`docs/setup-state.json` `commentLimit`). GUIDE: one live reply VERIFIED.

---

## 6. Standard API (MIP-003) and MIP-004 hashing

### 6.1 Endpoints in LIVE `agent-api.mjs` (loopback `127.0.0.1:AGENT_API_PORT`, default 21950)

| Route | Behaviour |
| --- | --- |
| `GET /availability` | `{"status":"available","type":"masumi-agent"}` (GUIDE also required registration confirmed + model health, and disabled new paid jobs after 3 poll failures) |
| `GET /input_schema` | `{"input_data":[{"id":"prompt","type":"string","name":"…","data":{"description":"…"},"validations":[{"validation":"min","value":"1"},{"validation":"max","value":"16000"}]}]}` (Sokosumi typed-array style) |
| `POST /start_job` | body ≤ 20000 bytes; requires `identifier_from_purchaser` (or `identifierFromPurchaser`) matching `^[a-fA-F0-9]{14,26}$` and `input_data` with only `prompt` (1-16000 chars); 503 if registration not confirmed |
| `GET /status?job_id=<uuid>` | `{id, status, result?}`; result only when `completed` |
| `POST /provide_input` | **not implemented** in either branch (MIP-003 optional) |

`/start_job` flow: dedupe on `sha256(nonce)`; same nonce + same input returns the saved response, same nonce + different input → 409; job saved with `phase: payment-pending` **before** `POST /payment` (payBy +10 min, submitResult +20, unlock +36, dispute +52). Response: `id`, `input_hash`, `identifierFromPurchaser`, `blockchainIdentifier`, `agentIdentifier`, `sellerVKey`, `paymentSourceType`, `supportedPaymentSourceIndex`, `payByTime`, `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime`. Errors return a generic 500 "inspect saved job state" (no stack, no secrets).

Background poller (5 s, non-reentrant): `waiting-payment` → confirmed `FundsLocked` → refuse if `submitResultTime` is within 2 minutes (`deadline-blocked`, `failed`) → `model-pending` → save `.txt` → `resultHash` → `submit-pending` → `submit-result` → `awaiting-result` → confirmed `ResultSubmitted` with matching hash → `completed`. Per-job try/catch.

Deviations from canonical MIP-003 (INFERRED, from SKILL `agentic-services.md`): response uses `id` (MIP-003 uses `job_id`), `/status` does not return `input_hash`/`output_hash`, statuses are `awaiting_payment`/`running`/`completed`/`failed`. VERIFIED smoke: `/start_job` HTTP 200 with signed quote only, no purchase (`docs/standard-smoke.json`).

### 6.2 Hash algorithms

| Path | Input hash | Result hash |
| --- | --- | --- |
| **Standard API** (LIVE `standard-hash.mjs`) | `sha256_utf8(nonce + ";" + JSON.stringify({prompt}))` — canonical JSON only valid because the shape is one fixed string key; general inputs need RFC 8785 / sorted-key canonical JSON (GUIDE `payment.ts` sorts keys) | `sha256_utf8(nonce + ";" + result)` raw bytes, real newlines |
| **Direct Sokosumi Task payment** (LIVE `paid-task.mjs:8`) | `sha256_utf8(started description)` — no nonce, no JSON | `sha256_utf8(result)` — no nonce, no escaping |
| Direct Task payment, GUIDE (earlier) | `sha256(nonce + ";" + canonicalJson({taskId, name, description}))` | `sha256(nonce + ";" + JSON.stringify(result).slice(1,-1))` (JSON-escaped body) |

MIP-004 per spec: `identifier_from_purchaser + ";" + output`, raw UTF-8 (GUIDE `payment-hashing.md:3`). MPS `submit-result` only receives a 64-hex digest and cannot tell which pre-image was used (GUIDE `payment-hashing.md:14`).
SKILL disagreement: SKILL says `submitResultHash = inputHash + outputHash` (128 hex). Neither demo branch does that; both submit the 64-hex result hash alone and LIVE observed it confirmed as `ResultSubmitted`.

### 6.3 Test vectors (all recomputed locally on 2026-10-07 and matching)

| Case | Pre-image | SHA-256 |
| --- | --- | --- |
| Task path, `taskHash("abc")` | `abc` | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| Task path newline vs escaped | `a` LF `b` vs `a\nb` (backslash-n) | `7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78` vs `b5b65540b7c88230a6d62d928cd450d3be458c25e870d4750f754404324797b4` (must differ) |
| Standard input | nonce `aabbccddeeff0011`, `{"prompt":"Cardano payments"}` → `aabbccddeeff0011;{"prompt":"Cardano payments"}` | `25f3afe66b39b0582711c9faf53930c7b6a6feffd10294750ec77be47fd63080` |
| Standard result | `aabbccddeeff0011;Line 1` LF `Line 2` | `6fa3bfa69364318f78619b87652c725d705c90f18f8bdcb5d7041c17b73ea57a` |
| Standard result, escaped (must differ) | `aabbccddeeff0011;Line 1\nLine 2` (backslash-n) | `85ba9cdbfafd6984e7a57a04c2e0fe378f48b998e327aa851b4e5459b990fb19` |
| GUIDE vector, result = `line` LF `"next"` `\` `end` (15 chars), nonce `01234567890123456789` | Core-compatible (escaped) | `36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3` |
| same | MIP-004 raw | `7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd` |
| same | raw, no nonce (LIVE Task rule) | `70e5c09899daacf6f01610cf34fc57f7bbed37a21cf3e81bd2f17bec7ca52393` (our computation) |

Live sample hashes: Standard smoke input hash `0fb65a65…76d1` (input not recorded); LIVE paid Task result hash `edad5b4b…68a1`.

### 6.4 Conflict to resolve before Bulkhead relies on it

The two branches disagree on the direct Task payment hash:
- LIVE (2026-10-06): raw `sha256(text)`; VERIFIED up to `ResultSubmitted` + Task `COMPLETED`; **seller withdrawal never verified**.
- GUIDE (2026-10-05): nonce + JSON-escaped body, based on reading Sokosumi source `hash.ts:76` / `verification.ts:66`; **seller collection VERIFIED** (1 tUSDM net).
Core's verification behaviour decides which one survives dispute/withdrawal. The user brief adopts the LIVE rule (raw UTF-8 SHA-256). Treat it as REPORTED-by-LIVE, and prove withdrawal end to end before calling it settled. Keep the hash function swappable and journal the pre-image rule used per Task.

---

## 7. Masumi purchases (buyer side)

- **Not present** in either demo branch: no call to `POST /purchase`. In the Task path, Sokosumi Core is the buyer: the seller posts `masumiPayment` on a Task event and Core funds escrow.
- The `masumiPayment` payload (§3.4) has the same field set as an MPS purchase request (INFERRED from the shape; SKILL lists `GET|POST /purchase`, `/purchase/resolve-blockchain-identifier`, `/purchase/request-refund`, `/purchase/cancel-refund-request`, `/purchase/spending`, `/purchase/error-state-recovery`).
- INFERRED buyer flow for Bulkhead sub-agents hiring registry agents (needs the live MPS `/api-docs` to confirm the exact body):
  1. Discover the agent (registry search, `agentIdentifier`, `apiBaseUrl`, pricing).
  2. `GET {apiBaseUrl}/input_schema`, `GET /availability`.
  3. Generate our own hex nonce (14-26 chars), compute our input hash, journal `purchase-pending`, `POST {apiBaseUrl}/start_job`.
  4. Validate the seller's response: our input hash equals `input_hash`, amount/unit ≤ mandate cap, deadlines sane, seller vkey/agentIdentifier match the registry entry.
  5. `POST /api/v1/purchase` with the seller's signed fields unchanged (`blockchainIdentifier`, `agentIdentifier`, `sellerVkey`, all four times, `inputHash`, `identifierFromPurchaser`, `paymentSourceType`, `supportedPaymentSourceIndex`, `Amounts`, `PaymentSource`), using a key with `canPay` scoped to our **purchasing** wallet (the demo key is scoped to the selling wallet only).
  6. Poll `/status`; on completion recompute `sha256(nonce + ";" + output)` and compare with on-chain `resultHash` (`/purchase/resolve-blockchain-identifier`); mismatch → `/purchase/request-refund` before `unlockTime`.
  7. Never repost an uncertain purchase; budget cap enforced before step 5.

---

## 8. Brief → demo mechanism → status checklist

| Bulkhead requirement | Demo mechanism | Demo status |
| --- | --- | --- |
| Private Coworker "Bulkhead Captain" | `coworkers register --vendor-id … --capability tasks --personal --json` | VERIFIED (Coworker GRANTED in Personal Workspace) |
| Vendor "Bulkhead" | `vendors create --name --slug --json`; org-workspace prerequisite; fallback reuse admin Vendor | VERIFIED error text (GUIDE 403); LIVE reused an existing Vendor (INFERRED) |
| Runtime key in vault | `coworkers api-key … --json \| runtime key-import --coworker-id … --api-key-stdin` | VERIFIED ("CLI stored runtime key in OS vault") |
| Dedicated MPS (own DB/role/keys) | new DB `team_names_<rand>`, own ENCRYPTION_KEY/ADMIN_KEY | VERIFIED |
| Seed once privately | seed script → 600 file, never read; one process | VERIFIED (seedExit 0) |
| Loopback | eve, MPS, agent API on 127.0.0.1, checked by listener | VERIFIED (lsof) |
| Preprod Web3CardanoV2 selling wallet | seeded source + Selling wallet read via admin API | VERIFIED |
| Paid Tasks Dynamic pricing in tUSDM | registry `supportedPaymentSources[].pricing.pricingType: Dynamic`; per-request `RequestedFunds` in unit `16a55b…44d` | VERIFIED (RegistrationConfirmed) |
| ReadAndPay token in `.local/mps-runtime.env` | `POST /api-key` scoped Preprod + selling wallet | VERIFIED |
| One continuous restart-safe worker | `worker.mjs` + `worker-lock.mjs` + per-Task journals | VERIFIED (running PID, lock tests 6/6) |
| Task → captain mapping | Task `description` from `runtime start` → eve session | VERIFIED execution-only Task completed |
| Quote = crew budget + fee, capped | demo fixes 1 tUSDM and rejects any other signed amount | not in demo (Bulkhead design) |
| Wait for confirmed escrow | `confirmedState(...,'FundsLocked')` + deadline rechecks | VERIFIED in tests; VERIFIED live up to ResultSubmitted |
| Vault-mode sessions / auto-approve within quote | eve session saved before send; turn rejected if `inputRequests` non-empty | partial: demo has no approval flow (INFERRED) |
| Float + reimbursement via settlement check | Core receipt ↔ MPS tx hash ↔ Blockfrost net seller units | LIVE: UNTESTED live (receipt pending); GUIDE: VERIFIED once |
| Save exact result bytes | `.local/<id>.txt` written before submit/complete | VERIFIED |
| Raw UTF-8 SHA-256 for direct Task payments | `taskHash = sha256(text)` | LIVE VERIFIED to ResultSubmitted; conflicts with GUIDE (§6.4) |
| Complete via runtime | execution-only: `runtime complete --result-file`; paid: Coworker event `status: COMPLETED` | VERIFIED both |
| Human comments → captain | events `actor.type: user` → same session → `{comment}` as Coworker | LIVE implemented, not smoke-tested; GUIDE VERIFIED one reply |
| Never change paid result after completion | comment replies are separate events; journal/hash untouched | GUIDE VERIFIED (SHA-256 compare of journal/result/proof) |
| Standard API MIP-003 + MIP-004 nonce hashes on loopback | `agent-api.mjs` + `standard-hash.mjs` | VERIFIED quote only; model/submit path UNTESTED live (GUIDE: escrow path VERIFIED, settlement untested) |
| Sub-agents hire registry agents via MPS purchases capped by mandate | none | not in demo (INFERRED design, §7) |
| End-to-end proof with labels | `docs/*.json`, `status.md` with VERIFIED/REPORTED/INFERRED, corrections kept separate | VERIFIED practice |

---

## 9. Rules to carry into Bulkhead (short list)

1. Persist `*-pending` before every external write; a `*-pending` found on restart is never retried automatically.
2. Use the started Task description as the only input; save the result file before any hash or completion; post exactly those bytes.
3. Escrow proof = `FundsLocked` **plus** a Confirmed transaction to `FundsLocked`; recheck `submitResultTime` after every async read and right before the model send.
4. Preserve signed terms verbatim; refuse non-null `sellerReturnAddress`/`forceLayer`; save quote before validating.
5. Payment and completion events go out as the Coworker without user-context headers.
6. Settlement proof = Core receipt + matching MPS withdrawal tx + Blockfrost net seller gain; not `withdrawnForSeller`, not COMPLETED, not credits, not PURCHASED.
7. One executor, PID lock with guard file, remove only a lock whose owner is confirmed dead.
8. `tasks list` without `--personal`; `runtime start/complete` with `--personal --coworker-id`; CLI ≥ 1.0.4.
