# Bulkhead

**Parallel, isolated AI agent sessions with their own Cardano wallets — on preprod, end to end.**

You sign in, top up, and give one AI **captain** a goal. The captain plans sub-tasks and runs several
specialised sub-agent **sessions at the same time**. Each session has its own isolated process, its own
native-script Cardano wallet holding exactly its budget, its own mandate (budget, allowed payees,
per-payment max, approval threshold, expiry) and a task type with a definition of done. You watch every
session live in a **session tree**, message any session, and approve or reject what needs you. When a
session ends, every leftover token returns to your treasury on-chain, and a hash of its log is anchored in
the close transaction's metadata.

> Testnet only (Cardano **preprod**). Nothing on-chain is faked. The only simulated step is fiat → crypto:
> a Stripe test payment triggers an operator transfer instead of a licensed on-ramp.

## Architecture

```
 Browser (Next.js)          Engine (Node, :4000)                                   Cardano preprod
 ┌──────────────┐  HTTP/SSE ┌──────────────────────────────────────────────┐      ┌───────────────┐
 │ Session tree │◄─────────►│ API (Hono) ─ Notifier (SSE)                   │      │ Blockfrost    │
 │ Agent map    │  (proxied │                                              │      │ (Koios fallbk)│
 │ Decisions    │  w/ token)│ Captain (LLM agent, 10 tools)                │      └──────▲────────┘
 │ Top up       │           │   ▲ woken only for actionable events         │             │
 └──────┬───────┘           │ Wake filter ◄── EventBus ──► events table    │             │
        │ CIP-30            │   (routine events absorbed, 0 LLM calls)     │             │
        ▼ (self-custody)    │                                              │             │
 ┌──────────────┐           │ SessionManager ─ state machine ─ supervisor  │  Mesh tx    │
 │ Lace/Eternl… │           │ SiloRunner ──IPC──► silo A │ silo B │ silo C │─────────────┤
 └──────────────┘           │   (child processes: no keys, no secrets,     │             │
                            │    per-task-type tool allow-list)            │             │
 Stripe (test) ──webhook──► │ Signer (policy) ─ DecisionLedger             │             │
                            │ TxService ─ TreasuryQueue ─ KeyStore (AES-GCM)│─────────────┤
                            │ ChainWatcher (poll 10 s / Ogmios)            │◄────────────┘
                            └───────────────────────┬──────────────────────┘
                                                    │ Masumi-style jobs, paid on-chain in tUSD
                                          ┌─────────▼──────────┐
                                          │ Mock agent market   │ (:4100)
                                          └────────────────────┘
```

Repo layout (pnpm monorepo):

| Path | What |
|---|---|
| `packages/shared` | Contracts: money units, session state machine, mandate/plan/handback schemas, task types + definitions of done, events, silo IPC, decisions, captain wake rules, tree DTOs |
| `packages/db` | SQLite via Drizzle (one file, migrates itself on open) |
| `packages/chain` | Providers (Blockfrost, Koios, NOWNodes mainnet-only), key derivation + encryption, native-script session wallets, Mesh transaction service, TreasuryQueue, ChainWatcher |
| `packages/engine` | Captain, wake filter, SessionManager, SiloRunner + silo runtime, Signer, DecisionLedger, on-ramp simulator, API, scripts |
| `apps/web` | Next.js UI: Session Tree, Agent Map, panels, decisions, top-up, sign-in |
| `apps/mock-market` | Three paid agents with a Masumi-style job API |

## Setup

Requires Node 20.19+ and pnpm 10.

```bash
pnpm install
pnpm gen:env          # creates .env with fresh secrets (never printed); prints the operator address
```

1. Fund the printed **operator address** from the
   [Cardano testnet faucet](https://docs.cardano.org/cardano-testnets/tools/faucet) (preprod).
2. Put a free [Blockfrost](https://blockfrost.io) **preprod** project id in `.env` as
   `BLOCKFROST_PREPROD_PROJECT_ID`. (Without it the app falls back to Koios' rate-limited public tier.)
3. Mint the test stablecoin and create the agent wallets:

```bash
pnpm setup:chain      # checks operator balance, mints tUSD, prints addresses + explorer links
pnpm dev              # web :3000 + engine :4000 + mock market :4100
```

Open http://localhost:3000 and use **Demo login** (or Google, if configured). Everything else is optional:

| Optional | Without it |
|---|---|
| `GOOGLE_CLIENT_ID/SECRET` | "Demo login" (labelled testnet demo) |
| `STRIPE_SECRET_KEY/WEBHOOK_SECRET` | A labelled simulated checkout that triggers the same real on-chain top-up |
| `ANTHROPIC_API_KEY` | A deterministic MockLLM drives the captain and sub-agents |
| `OGMIOS_URL` | The watcher polls every 10 s |
| `NOWNODES_API_KEY` | No mainnet dashboard reads (NOWNodes serves Cardano mainnet only) |

All variables are documented in [.env.example](.env.example). `pnpm stripe:listen` forwards Stripe test
webhooks locally.

### Scripts

| Command | What it does |
|---|---|
| `pnpm gen:env` | Create `.env` with secrets; print the operator address to fund |
| `pnpm setup:chain` | Check operator balance, mint initial tUSD, derive agent wallets, print explorer links |
| `pnpm dev` | Run web + engine + watcher + mock market |
| `pnpm recover --session <id>` | Owner sweep of a session wallet after its expiry (works with the app down) |
| `pnpm test` | Unit tests across packages |
| `pnpm e2e:preprod` | The acceptance test on preprod; prints explorer links |

## What is simulated, and what is custodial (testnet MVP)

- **Simulated:** only the fiat → crypto conversion. A Stripe **test** payment makes the operator wallet
  send real preprod tUSD + tADA to your treasury. In production a licensed on-ramp would do this.
- **Custodial on testnet:** Google / Demo-login users' treasury and session keys are derived on the server
  from `MASTER_SECRET` and stored AES-256-GCM-encrypted. "Connect wallet" users are self-custodial: their
  wallet is the treasury and they sign funding in the browser.
- Sub-agents never receive keys. Session payments are signed only by the Signer, after policy checks.

## On-chain enforcement: the Bulkhead Session Vault

Every new custodial session (default `WALLET_MODE=vault`) gets its own **Aiken Session Vault** — a
parameterised Plutus V3 validator (`contracts/validators/session_vault.ak`, blueprint `contracts/plutus.json`,
unapplied hash `edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a`). The chain, not the server,
enforces the payee allowlist, the per-transaction tUSD and lovelace caps and the expiry:

| Redeemer | Who | What the validator allows |
|---|---|---|
| `Pay` | session key, before expiry | only to allow-listed payees, within the per-tx caps, change stays at the exact vault address |
| `Revoke` | captain, any time | everything back to the owner (session close / kill, metadata 674 hashes) |
| `Recover` | **anyone**, after expiry | everything back to the owner — works even if Bulkhead is offline (`pnpm recover`) |

`pnpm demo:attack-onchain` signs a `Pay` to an attacker with a real session key, bypassing the Signer: the
node rejects it (`PlutusFailure`), nothing lands on-chain and no collateral is lost. The approval threshold
stays off-chain (Signer + decision ledger). `WALLET_MODE=native` keeps the earlier native-script wallets as a
fallback. Self-custody users get vaults too — their CIP-30 wallet signs the vault funding and Revoke/Recover return to it. Vault transactions need Blockfrost (live Plutus cost
models). Evidence: [DEPLOYMENTS.md](DEPLOYMENTS.md), [CHAIN_VERIFICATION.md](CHAIN_VERIFICATION.md),
`pnpm verify:chain`.

## Roadmap (after the MVP — deliberately not built)

- CIP-68 mandate token pair + period (rolling) limits and an on-chain pause/quarantine status read from a
  reference input (the rest of spec §3.3 Tier 2; the per-session vault is built).
- Hierarchical mandates (sub-session vaults whose limits are bounded by the parent's on-chain).
- Merkle-tree payee allowlists (today a plain list of ≤ 10 credentials) and a shared reference script.
- Vault mode for self-custody users (browser-signed vault funding).
- CIP-8 `signData` proof of wallet ownership when linking a self-custody wallet.
- Multi-block confirmation depth before treating a payment as final.
- Egress policy: treat a *blocked* fetch as a denied tool call instead of a quarantine (nothing was read).
- Real agent marketplace: a `SokosumiMarket` adapter and Masumi registry/escrow instead of the mock market.
- Cloud runners / a second machine ("secondmates") for long tasks while keys stay with the user.
- Docker / VM isolation for silos (the `SiloRunner` interface already allows another runner).

## Treasury staking and vote delegation

Each treasury's stake credential can be registered and delegated to a preprod stake pool. The pool comes from `STAKE_POOL_ID`, or else Bulkhead picks the active preprod pool with the most stake that is not retiring and under 90% saturation. The vote is delegated in the same transaction: `always_abstain` by default, or a DRep from `DREP_ID` or the treasury card. Custodial treasuries are signed with the derived payment and stake keys. Self-custody users sign the same unsigned transaction in their CIP-30 wallet. "Stop staking" deregisters the stake key and refunds the deposit; any rewards are withdrawn in the same transaction. Session addresses carry the owner's stake credential, so session budgets count toward the owner's stake. Engine routes: `GET /staking`, `POST /staking/setup {poolId?, drepId?}`, `POST /staking/stop {confirm: true}`. On-chain check: `packages/engine/scripts/staking-onchain.ts` (`runStakingOnchain()`).

### Why vote delegation?

Since the Conway era (CIP-1694, enforced from protocol version 10), a reward withdrawal from a key-based stake credential is rejected unless that credential has delegated its voting power, to a DRep or to one of the predefined options `always_abstain` / `always_no_confidence`. Without a vote delegation, rewards still accumulate but cannot be withdrawn, and a stake key can't be deregistered while it holds rewards. So Bulkhead adds a vote-delegation certificate with every staking setup. The default is `always_abstain`, which takes no governance position: the stake is not counted toward any vote. Users who want a representative can choose a DRep instead.
