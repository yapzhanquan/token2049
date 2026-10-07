// Staking + vote delegation on PREPROD for a dedicated custodial test treasury (account 990003):
//   1. acquire the chain lock (bulkhead/.chain-lock — one preprod submitter at a time);
//   2. fund the test treasury from the operator if it is low (~12 tADA: fees + the 2 tADA key deposit);
//   3. ONE tx: stake registration + pool delegation (STAKE_POOL_ID or an active preprod pool) +
//      vote delegation (DREP_ID or always_abstain), signed by the treasury payment + stake keys; confirm;
//   4. verify through the provider (Blockfrost accounts/{stake_address}) that pool_id and drep_id show;
//   5. withdraw ZERO rewards (claims nothing; proves the Conway rule "withdrawals need a vote delegation"
//      is satisfied) — only when the reward balance is exactly 0;
//   6. release the lock. Idempotent: re-runs skip what is already on chain and just verify.
// Never prints keys or mnemonics. Run: pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/staking-onchain.ts
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChain, createStakingReadApi, drepLabel, parseDRep, rewardAddressOf, stakingServiceFor, type BulkheadChain } from "@bulkhead/chain";
import { explorerTx } from "@bulkhead/shared";

export const STAKING_TEST_ACCOUNT = 990_003;
export const STAKING_TEST_USER = "staking-test-990003";
const FUND_LOVELACE = 12_000_000n; // ~10 tADA + the 2 tADA stake key deposit
const MIN_LOVELACE = 4_000_000n;
const LOCK_DIR = fileURLToPath(new URL("../../../.chain-lock", import.meta.url));
const KV_KEY = "staking:onchain-test";

export interface StakingStep {
  name: string;
  ok: boolean;
  detail: string;
  txHash?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} tADA`;

async function acquireLock(log: (s: string) => void, maxWaitMs = 40 * 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(resolve(LOCK_DIR, "owner"), `staking agent (staking-onchain.ts) pid ${process.pid} at ${new Date().toISOString()}\n`);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() - t0 > maxWaitMs) throw new Error(`chain lock ${LOCK_DIR} still held after ${Math.round(maxWaitMs / 60000)} min`);
      let age = "";
      try {
        age = ` (held ${Math.round((Date.now() - statSync(LOCK_DIR).mtimeMs) / 1000)} s)`;
      } catch {
        /* released meanwhile */
      }
      log(`chain lock busy${age}; retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

function releaseLock(): void {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

async function waitConfirmed(chain: BulkheadChain, txHash: string, log: (s: string) => void, timeoutMs = 300_000): Promise<{ blockHeight: number; slot: number } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await chain.provider.fetchTxConfirmation(txHash).catch(() => null);
    if (c) return c;
    log(`  … waiting for ${txHash.slice(0, 12)}… (${Math.round((Date.now() - t0) / 1000)} s)`);
    await sleep(10_000);
  }
  return null;
}

export async function runStakingOnchain(opts: { log?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; steps: StakingStep[] }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const env = opts.env ?? process.env;
  const steps: StakingStep[] = [];
  const step = (s: StakingStep) => {
    steps.push(s);
    log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}${s.txHash ? `\n    ${explorerTx(s.txHash)}` : ""}`);
  };
  if (/mainnet/i.test(env.NETWORK ?? "")) throw new Error("preprod only");
  for (const k of ["MASTER_SECRET", "OPERATOR_MNEMONIC"] as const) if (!env[k]?.trim()) return { ok: false, steps: [{ name: "env", ok: false, detail: `${k} is not set` }] };

  await acquireLock(log);
  try {
    const chain = await createChain({ env });
    const read = createStakingReadApi(env);
    const staking = stakingServiceFor(chain, read, { defaultPoolId: env.STAKE_POOL_ID?.trim() || undefined, defaultDRep: parseDRep(env.DREP_ID), log });
    log(`Network: PREPROD · tx provider ${chain.provider.name} · staking reads ${read.name}`);

    // 1. test treasury (custodial, account 990003)
    const t = await chain.keys.treasury(STAKING_TEST_USER, STAKING_TEST_ACCOUNT);
    const stakeAddress = rewardAddressOf(t.stakeKeyHash);
    step({ name: "test treasury", ok: true, detail: `account ${STAKING_TEST_ACCOUNT}' → ${t.address} · stake ${stakeAddress}` });

    // 2. fund if low
    let bal = await chain.tx.balanceOf(t.address);
    if (bal.lovelace < MIN_LOVELACE) {
      const r = await chain.tx.operatorSend({ toAddress: t.address, tusdMicro: 0n, lovelace: FUND_LOVELACE, reference: "Bulkhead staking test treasury funding" });
      const c = await waitConfirmed(chain, r.txHash, log);
      step({ name: "fund test treasury", ok: !!c, detail: c ? `${ada(FUND_LOVELACE)} from operator, block ${c.blockHeight}` : "submitted, not confirmed in time", txHash: r.txHash });
      if (!c) return { ok: false, steps };
      bal = await chain.tx.balanceOf(t.address);
    } else step({ name: "fund test treasury", ok: true, detail: `already funded: ${ada(bal.lovelace)}` });

    // 3. pool + plan
    // Keep an existing delegation stable across re-runs (the "best pool" pick can change over time).
    const current = await staking.account(stakeAddress);
    const keep = !env.STAKE_POOL_ID?.trim() && current.registered && current.poolId ? current.poolId : undefined;
    const pool = await staking.resolvePool(keep);
    const deposit = await staking.keyDeposit();
    step({ name: "pool", ok: true, detail: `${pool.ticker ?? "(no ticker)"} ${pool.poolId} (${pool.source === "env" ? "STAKE_POOL_ID" : keep ? "already delegated; kept" : `picked from ${read.name} pools/extended: most active stake, not retiring, < 90% saturated`})` });
    const plan = await staking.plan(t.stakeKeyHash, { poolId: pool.poolId });
    let setupTx: string | undefined;
    if (plan.register || plan.poolId || plan.drep) {
      const r = await staking.setupCustodial({ userId: STAKING_TEST_USER, poolId: pool.poolId, memo: ["Bulkhead staking test: register + delegate + vote"] });
      setupTx = r.txHash;
      const c = await waitConfirmed(chain, r.txHash, log);
      step({
        name: "register + pool delegation + vote delegation (one tx)",
        ok: !!c,
        detail: `certs [${r.certs.join(", ")}], deposit ${ada(r.depositDeltaLovelace)} (live keyDeposit ${ada(deposit)}), fee ${ada(r.feeLovelace)}${c ? `, block ${c.blockHeight}` : ", NOT confirmed in time"}`,
        txHash: r.txHash,
      });
      if (!c) return { ok: false, steps };
    } else step({ name: "register + pool delegation + vote delegation (one tx)", ok: true, detail: `already on chain (pool ${plan.targetPoolId}, vote ${plan.targetDRep})` });

    // 4. provider shows pool + DRep
    const wantDRep = drepLabel(parseDRep(env.DREP_ID));
    let acct = await staking.account(stakeAddress);
    for (let i = 0; i < 18 && !(acct.registered && acct.poolId === pool.poolId && acct.drep === wantDRep); i++) {
      log(`  … provider not yet showing the delegation (registered=${acct.registered}, pool=${acct.poolId}, drep=${acct.drep}); retry in 10 s`);
      await sleep(10_000);
      acct = await staking.account(stakeAddress);
    }
    const shown = acct.registered && acct.poolId === pool.poolId && acct.drep === wantDRep;
    step({ name: `${read.name} accounts/${stakeAddress.slice(0, 18)}…`, ok: shown, detail: `registered=${acct.registered} pool_id=${acct.poolId} drep_id=${acct.drep} rewards=${acct.rewardsLovelace}` });

    // 5. zero withdrawal (claims nothing) — proves withdrawals are allowed now that the vote is delegated
    let withdrawTx: string | undefined;
    if (shown && acct.rewardsLovelace === 0n && env.STAKING_SKIP_WITHDRAW_ZERO !== "1") {
      const prev = (await import("@bulkhead/db")).rawSqlite().prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY) as { value: string } | undefined;
      const prevWithdraw = prev ? (JSON.parse(prev.value) as { withdrawTx?: string }).withdrawTx : undefined;
      if (prevWithdraw && (await chain.provider.fetchTxConfirmation(prevWithdraw))) {
        withdrawTx = prevWithdraw;
        step({ name: "withdrawRewards(0)", ok: true, detail: "already done earlier (Conway accepted a 0-lovelace withdrawal for the vote-delegated key)", txHash: prevWithdraw });
      } else {
        try {
          const w = await staking.withdrawRewards({ userId: STAKING_TEST_USER, amountLovelace: 0n });
          withdrawTx = w.txHash;
          const c = await waitConfirmed(chain, w.txHash, log);
          step({ name: "withdrawRewards(0)", ok: !!c, detail: c ? `0-lovelace withdrawal accepted (nothing claimed), fee ${ada(w.feeLovelace)}` : "submitted, not confirmed in time", txHash: w.txHash });
        } catch (e) {
          step({ name: "withdrawRewards(0)", ok: false, detail: (e as Error).message });
        }
      }
    }

    const rec = { stakeAddress, treasury: t.address, poolId: pool.poolId, poolTicker: pool.ticker, drep: acct.drep, depositLovelace: deposit.toString(), setupTx: setupTx ?? null, withdrawTx: withdrawTx ?? null, at: new Date().toISOString() };
    const prevRaw = (await import("@bulkhead/db")).rawSqlite().prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY) as { value: string } | undefined;
    const prev = prevRaw ? (JSON.parse(prevRaw.value) as typeof rec) : null;
    if (!rec.setupTx && prev?.setupTx) rec.setupTx = prev.setupTx;
    (await import("@bulkhead/db")).rawSqlite().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KV_KEY, JSON.stringify(rec));
    if (rec.setupTx && !setupTx) log(`  (setup tx from an earlier run: ${explorerTx(rec.setupTx)})`);
    log(`balance after: ${ada((await chain.tx.balanceOf(t.address)).lovelace)}`);
    return { ok: steps.every((s) => s.ok), steps };
  } catch (e) {
    step({ name: "error", ok: false, detail: (e as Error).message });
    return { ok: false, steps };
  } finally {
    releaseLock();
  }
}

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  runStakingOnchain()
    .then((r) => {
      console.log(r.ok ? "\nSTAKING ON-CHAIN: OK" : "\nSTAKING ON-CHAIN: FAILED");
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
