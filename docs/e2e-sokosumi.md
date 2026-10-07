# Sokosumi Coworker end-to-end proof (preprod, 2026-10-07)

Labels: **VERIFIED** = observed by us in this run (CLI output, Core events, MPS response, Blockfrost);
**REPORTED** = stated by another component without our independent check; **INFERRED** = our reading.
Sources consulted: `docs/SOKOSUMI-PROTOCOL.md`, installed Sokosumi CLI 1.0.0 source
(`$(npm root -g)/sokosumi/dist/src/cli/**`, `coworker/runtime-task.js`), the `masumi` skill, the
`query-chain` skill (Blockfrost `/txs/{hash}`), and the MPS source (`masumi-payment-service/src/routes/api/payments`, `wallet`).

## Setup

| item | value | label |
|---|---|---|
| Sokosumi CLI | 1.0.0 (global). `tasks *` take `--organization-slug` and **reject** `--organization-id`/`--workspace-id`; `runtime start/complete` require `--coworker-id` + `--organization-id` | VERIFIED (CLI source `cli/index.js:339-348`, `cli/commands/runtime.js`) |
| Organization / Workspace | `01a1146d-87ef-77d5-8020-bc21a58620dc`, slug `bulkhead-3qb9jz`, `taskSeatEligible: true` | VERIFIED (`workspaces list`, `workspaces check`) |
| Coworker | "Bulkhead Captain" `01a11474-5240-74ee-acc6-89cdaa039e95` | VERIFIED (Task assignee) |
| Worker config | `apps/sokosumi-worker/.env` (gitignored: `git check-ignore` → `apps/sokosumi-worker/.gitignore:2:.env`); non-secret values only. MPS token read from `.local/mps-runtime.env`; Coworker key in the CLI OS vault | VERIFIED |
| Worker fix for CLI 1.0.0 | `tasks list` now passes `--organization-slug` (`SOKOSUMI_ORGANIZATION_SLUG`); runtime keeps `--organization-id` | VERIFIED (tests + live run) |
| Standard API (MIP-003) | `127.0.0.1:4200`, paid mode (MPS Preprod), `/availability` → `available` | VERIFIED (listener 127.0.0.1 only, HTTP 200) |
| Engine user for the worker | `sokosumi-coworker@bulkhead.local` = `u_4ff72b9a-a8a6-4828-b243-84d44b5d9a36` (custodial), treasury `addr_test1qrw53vhedgt07xr8sv84sw05u0zfw6lcd0vu7q3mdyk5zxe3r7n72nj7w6yc3pefqjs86k2eke33app7yersgs8rqxts4zzkgp` | VERIFIED (engine `POST /users`, `GET /me`) |
| Treasury float top-up | `top_72f7c0500cfb491c`, 50 MYR (simulated fiat step, labelled) → 10.478723 tUSD + 25 ADA; tx [`a12118dd…655d78`](https://preprod.cardanoscan.io/transaction/a12118dd070887e72a85ee377c7b99bec18ba053153b1baa3a9b501900655d78) block 5262987 | VERIFIED (Blockfrost 200, `GET /me` balance) |

## 1. Execution-only Task — COMPLETED

Created with `sokosumi --preprod tasks create --organization-slug bulkhead-3qb9jz --coworker-id 01a11474-… --name "Bulkhead e2e: execution-only" --status READY --description "Goal: … Budget: 2 tUSDM / Deadline: 45m"` while the worker ran with paid Tasks off.

| step | evidence | label |
|---|---|---|
| Task | `01a1147a-0470-7263-b5ee-ef1c0f8cfead`, org `01a1146d-…`, credits 0 | VERIFIED (`tasks get`) |
| Claim (`runtime start`) | event `01a1147a-0c10-7389-a601-fc5948c8b636` RUNNING, actor coworker, 03:48:25Z (2 s after READY) | VERIFIED (`tasks events`) |
| Bulkhead goal | `g_844d6715-6b57-481b-aec6-555fcb56cc37`, quote 2.5 tUSDM = crew 2 + fee 0.5 (not charged: execution-only) | VERIFIED (journal) |
| Crew (2 sessions) | A researcher `ses_de6206b2d6a04271`, B summariser `ses_dacd28003c434aaf`; both CLOSED; budgets 0.4 + 0.3 tUSD; spent 0; refunded 0.7 tUSD | VERIFIED (engine `/goals/:id/tree`) |
| Session funding tx | [`6306803c…cf5093`](https://preprod.cardanoscan.io/transaction/6306803c40b6e88eeef9a1c8f6a338cf0bf22464d1f9594dc9b63da731cf5093) block 5262995, fee 185345 | VERIFIED (Blockfrost 200) |
| Session close txs | [`8a082af3…25e9ce`](https://preprod.cardanoscan.io/transaction/8a082af329d19941c352529342d8d026f00e9ed7282bb363e06cf2562b25e9ce), [`1545ccee…404d17`](https://preprod.cardanoscan.io/transaction/1545cceebecdaa935c89731ddf0dc1908848b8b44fce66c8917787b48d404d17), block 5262997, fee 287496 each, `valid_contract: true` | VERIFIED (Blockfrost 200) |
| Completion (`runtime complete --result-file`) | event `01a1147c-edd5-704f-ae83-11911ee8fce7` COMPLETED, actor coworker, 03:51:34Z; Task status COMPLETED | VERIFIED |
| Result hash (SHA-256 of raw UTF-8 bytes) | `062e0dc760c50700def92f922383d7ce75d19aaa60bfc15206e0a60932ecae44`, 5101 bytes — identical for the saved file `.local/tasks/01a1147a-….result.txt` and the COMPLETED event comment | VERIFIED (recomputed both) |
| Human comment → captain | user comment `01a11484-c59b-7031-b2df-43059eb8bcd2` (04:00:08Z) → worker `captain` intent → engine `POST /captain/messages` → Coworker reply `01a11484-cff2-71d7-a471-14def27833ec` "Passed to the Bulkhead captain." (04:00:10Z) | VERIFIED (events + journal `comments`); captain's handling of the message REPORTED (engine 2xx only) |

## 2. Paid Task — BLOCKED before the payment request (needs one MPS admin fix)

Task `01a1147d-df7e-71db-9aad-2a3d5fb3e1fe` ("Bulkhead e2e: paid crew", Budget 2 tUSDM, Deadline 40m), worker with
`PAID_TASKS_ENABLED=true`.

| step | evidence | label |
|---|---|---|
| Claim | event `01a1147d-e9ee-7316-ba12-c90952a8ac5d` RUNNING 03:52:38Z | VERIFIED |
| Mode | paid (gate ready: flag, MPS URL, registration confirmed, token file, seller identity) | VERIFIED (worker log) |
| Quote | 2.5 tUSDM (2 crew + 0.5 fee) = `RequestedFunds [{2500000, 16a55b2a…44d}]`, inputHash `12656255…6d9709` (raw UTF-8 of the started description) | VERIFIED (journal request) |
| MPS `POST /payment` | **HTTP 400** `sellerReturnAddress must be a Cardano base or enterprise address with a payment key credential` | VERIFIED (same request replayed by us; MPS error body) |
| Root cause | MPS seed: `COLLECTION_WALLET_V2_PREPROD_ADDRESS=""` → `?? fallback` keeps the empty string, so the V2 Selling wallet's `collectionAddress` is `""` (not null). `payments/index.ts:290` uses it as `sellerReturnAddress` and rejects it (`:292`). | INFERRED from source (`prisma/seed.ts:236-237`, MPS `.env` shows the variable set to an empty quoted value); the wallet row itself was not read (admin read not performed) |
| Nothing created | `GET /payment?searchQuery=<inputHash>` → `Payments: []` | VERIFIED |
| Worker outcome | inspection → "did not apply" → re-quote → deterministic MPS refusal → Task marked failed locally, Coworker comment `01a11484-4218-7769-992b-8fb45b87d345` "Bulkhead stopped working on this Task: … nothing was charged". Sokosumi Task stays RUNNING (no Core endpoint used to fail it) | VERIFIED |
| Escrow, crew, attack, submit-result, settlement | not reached | — |

### Fix needed (user action, admin key)

The fix needs the MPS admin key, so the agent did not run it. Clear the empty override so the signed terms carry
`sellerReturnAddress: null`, which Core Task events require. With the override cleared, MPS withdraws to the Selling
wallet itself, and the settlement check measures that wallet:

```sh
# admin token from masumi-payment-service/.env (ADMIN_KEY); do not echo it
curl -s -X PATCH http://127.0.0.1:3901/api/v1/wallet \
  -H "token: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"id":"cmuxiwa790009owvcaofhehg1","newCollectionAddress":null}'
```

Also set `COLLECTION_WALLET_V2_PREPROD_ADDRESS` to a real address or delete the line in `masumi-payment-service/.env`
so a reseed doesn't bring the empty string back. Then create a new paid Task (same command as above with a new name).
The worker is already running with paid Tasks on.

### What the paid path will need after the fix (INFERRED, not yet observed)

- Escrow: Sokosumi Core is the buyer for direct Task payments (`SOKOSUMI-PROTOCOL.md` §7). Whether Core funds escrow
  automatically or needs a click in the Sokosumi web UI (Task page → payment request → pay) hasn't been observed yet.
  The worker waits `PAY_BY_MINUTES=20` for a confirmed `FundsLocked`.
- Crew asset: Bulkhead crews are funded in Bulkhead tUSD (`7704eb3b…0014df1074555344`), while Masumi escrow pays tUSDM
  (`16a55b2a…0014df10745553444d`). Another workstream is making the engine's settlement asset configurable (default
  tUSDM). The worker's treasury currently holds only tUSD (10.478723) and 25 tADA, so a tUSDM-denominated crew
  needs tUSDM in that treasury.
- On-chain-rejected attack: no engine goal triggers it. The proof script is `pnpm demo:attack-onchain`, which takes the
  chain lock itself. It hasn't been run as part of a Sokosumi Task.

## Worker changes in this run (typecheck + 58 tests green)

- `sokosumi.ts`/`config.ts`/`main.ts`: `SOKOSUMI_ORGANIZATION_SLUG` → `tasks list --organization-slug`. `MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX` is accepted as an alias of `MASUMI_PAYMENT_SOURCE_INDEX`, and both are integer-validated.
- `payment-gate.ts`: `MpsHttpError` carries the MPS validation message (clipped, never the token). New read-only `findPayments(inputHash)`.
- `task-runner.ts`: if MPS refuses `POST /payment` with a 4xx, the `terms-pending` marker rolls back. A deterministic refusal (400/404/409/422) then fails the Task with the reason. A `terms-pending` marker found later is resolved by inspection after a 2-minute grace period: if MPS has the payment, the worker adopts it; if MPS has none, it re-quotes. It is never blindly retried.
- Float and reimbursement bridge: when settlement is verified (Core receipt, a confirmed MPS withdrawal with the same tx, and a positive Blockfrost net at the seller), the journal ledger gets a `reimbursementEntry` (`float-reimbursement`, tUSDM unit, atomic amount, tx, margin, `onChainTransferToTreasury: false`). This is accounting only: the funds stay in the MPS Selling wallet, and the worker never touches its keys.
- Tests: `test/config.test.ts`, `test/terms-recovery.test.ts`, `test/reimbursement.test.ts`, plus a CLI 1.0.0 argv case in `test/sokosumi.test.ts`.

## Running processes (loopback)

| process | listener / PID | logs |
|---|---|---|
| Standard API | 127.0.0.1:4200 | `apps/sokosumi-worker/.local/standard-api.log`, `.err.log` |
| Sokosumi worker | see final report (node PID in the first log line) | `apps/sokosumi-worker/.local/worker.log`, `.err.log`; earlier runs `worker.exec-only.log`, `worker.paid-run1.log` |
