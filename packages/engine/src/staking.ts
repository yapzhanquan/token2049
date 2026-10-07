// Treasury staking + vote delegation for the acting user (task §2/§3).
//  - Custodial users: StakingService builds, signs (treasury payment + stake keys) and submits.
//  - Self-custody users: StakingService builds the unsigned tx from the wallet address; the SigningBroker
//    parks it as a pending signature (the API answers needsSignature; the browser signs with CIP-30
//    signTx(tx, partialSign=true), which adds payment + stake witnesses) and submits via submitSigned.
// Status is persisted in the `kv` table (key `staking:user:<userId>`, JSON) — no schema change — and merged
// with the live stake-account state from the provider (Blockfrost `accounts/{stake}` / Koios account_info).
import { eq } from "drizzle-orm";
import { kv, users, type DB } from "@bulkhead/db";
import {
  createStakingReadApi,
  parseDRep,
  rewardAddressOf,
  sameDRep,
  stakingServiceFor,
  type Chain,
  type StakeAccountState,
  type StakingService,
  type StakingTxResult,
  type UnsignedStakingTx,
} from "@bulkhead/chain";
import type { StakingActionResponse, StakingSetupBody, StakingStatusDTO, StakingTxRef } from "@bulkhead/shared";
import type { SigningBroker } from "./self-custody";

export interface StakingRecord {
  stakeAddress: string;
  registered: boolean;
  poolId: string | null;
  poolTicker: string | null;
  drep: string | null;
  depositLovelace: string | null;
  txs: StakingTxRef[];
  updatedAt: number;
}

export const stakingKvKey = (userId: string) => `staking:user:${userId}`;

export interface EngineStakingDeps {
  db: DB;
  chain: Chain;
  signing?: SigningBroker;
  env?: NodeJS.ProcessEnv;
  /** Inject (tests). Default: built from the chain (real preprod chain only) + env. */
  service?: StakingService | null;
  now?: () => number;
  log?: (m: string) => void;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export class EngineStaking {
  private svc: StakingService | null | undefined;
  private unavailable: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: EngineStakingDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.service !== undefined) this.svc = deps.service;
  }

  /** The StakingService, or null (FakeChain / no KeyVault) with `unavailable` set. */
  service(): StakingService | null {
    if (this.svc !== undefined) {
      if (!this.svc && !this.unavailable) this.unavailable = "staking is not available on this chain";
      return this.svc;
    }
    const env = this.deps.env ?? process.env;
    try {
      if (env.CHAIN === "fake") throw new Error("staking needs the real preprod chain (CHAIN=fake is an offline demo)");
      this.svc = stakingServiceFor(this.deps.chain as unknown as { provider: Chain["provider"]; keys: unknown; queue: unknown }, createStakingReadApi(env), {
        defaultPoolId: env.STAKE_POOL_ID?.trim() || undefined,
        defaultDRep: parseDRep(env.DREP_ID),
        log: this.deps.log,
      });
    } catch (e) {
      this.svc = null;
      this.unavailable = (e as Error).message;
    }
    return this.svc;
  }

  // ── persistence (kv) ──
  record(userId: string): StakingRecord | null {
    const row = this.deps.db.select().from(kv).where(eq(kv.key, stakingKvKey(userId))).get();
    if (!row) return null;
    try {
      return JSON.parse(row.value) as StakingRecord;
    } catch {
      return null;
    }
  }

  private save(userId: string, r: StakingRecord): void {
    const value = JSON.stringify(r);
    this.deps.db
      .insert(kv)
      .values({ key: stakingKvKey(userId), value })
      .onConflictDoUpdate({ target: kv.key, set: { value } })
      .run();
  }

  private user(userId: string) {
    const u = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!u) throw httpError(404, "unknown user");
    return u;
  }

  private stakeKeyHash(userId: string): { custody: "custodial" | "self"; stakeKeyHash: string | null; address: string } {
    const u = this.user(userId);
    return { custody: u.custody, stakeKeyHash: u.stakeKeyHash ?? null, address: u.treasuryAddress };
  }

  // ── status ──
  async status(userId: string): Promise<StakingStatusDTO> {
    const { custody, stakeKeyHash } = this.stakeKeyHash(userId);
    const rec = this.record(userId);
    const base: StakingStatusDTO = {
      available: false,
      custody,
      stakeAddress: rec?.stakeAddress ?? (stakeKeyHash ? rewardAddressOf(stakeKeyHash) : null),
      registered: rec?.registered ?? false,
      poolId: rec?.poolId ?? null,
      poolTicker: rec?.poolTicker ?? null,
      drep: rec?.drep ?? null,
      depositLovelace: rec?.depositLovelace ?? null,
      rewardsLovelace: "0",
      live: false,
      pending: false,
      txs: rec?.txs ?? [],
      updatedAt: rec?.updatedAt ?? null,
    };
    const svc = this.service();
    if (!svc) return { ...base, reason: this.unavailable ?? "staking unavailable" };
    if (!stakeKeyHash) return { ...base, reason: "the treasury address has no stake credential (enterprise address)" };
    base.available = true;
    let acct: StakeAccountState;
    try {
      acct = await svc.account(base.stakeAddress!);
    } catch (e) {
      return { ...base, reason: `provider unavailable: ${(e as Error).message}` };
    }
    const last = base.txs[base.txs.length - 1];
    // A just-submitted tx: keep showing its intended state until the provider reflects it (or 15 min pass).
    const recent = !!last && !last.confirmed && this.now() - last.at < 15 * 60_000;
    const reflects = last?.kind === "stop" ? !acct.registered : acct.registered && acct.poolId === rec?.poolId && !!rec?.drep && sameDRep(acct.drep, parseDRep(rec.drep));
    if (recent && !reflects) return { ...base, pending: true, live: false, rewardsLovelace: acct.rewardsLovelace.toString() };
    let poolTicker = base.poolTicker;
    if (acct.poolId && acct.poolId !== rec?.poolId) poolTicker = (await svc.read.fetchPool(acct.poolId).catch(() => null))?.ticker ?? null;
    const txs = base.txs.map((t, i) => (i === base.txs.length - 1 && reflects ? { ...t, confirmed: true } : t));
    const merged: StakingStatusDTO = {
      ...base,
      registered: acct.registered,
      poolId: acct.poolId,
      poolTicker: acct.poolId ? poolTicker : null,
      drep: acct.drep,
      depositLovelace: acct.registered ? (acct.depositLovelace?.toString() ?? base.depositLovelace ?? (await svc.keyDeposit().catch(() => null))?.toString() ?? null) : null,
      rewardsLovelace: acct.rewardsLovelace.toString(),
      live: true,
      txs,
    };
    if (rec || acct.registered)
      this.save(userId, {
        stakeAddress: merged.stakeAddress!,
        registered: merged.registered,
        poolId: merged.poolId,
        poolTicker: merged.poolTicker,
        drep: merged.drep,
        depositLovelace: merged.depositLovelace,
        txs,
        updatedAt: this.now(),
      });
    return merged;
  }

  private remember(userId: string, kind: StakingTxRef["kind"], r: Pick<StakingTxResult, "txHash" | "certs" | "feeLovelace" | "depositDeltaLovelace" | "stakeAddress"> & { poolId?: string; poolTicker?: string | null; drep?: string }): StakingTxRef {
    const prev = this.record(userId);
    const tx: StakingTxRef = {
      kind,
      txHash: r.txHash,
      at: this.now(),
      certs: [...r.certs],
      feeLovelace: r.feeLovelace.toString(),
      depositDeltaLovelace: r.depositDeltaLovelace.toString(),
      confirmed: false,
    };
    const stop = kind === "stop";
    this.save(userId, {
      stakeAddress: r.stakeAddress,
      registered: !stop,
      poolId: stop ? null : (r.poolId ?? prev?.poolId ?? null),
      poolTicker: stop ? null : (r.poolTicker ?? prev?.poolTicker ?? null),
      drep: stop ? null : (r.drep ?? prev?.drep ?? null),
      depositLovelace: stop ? null : r.depositDeltaLovelace > 0n ? r.depositDeltaLovelace.toString() : (prev?.depositLovelace ?? null),
      txs: [...(prev?.txs ?? []), tx].slice(-20),
      updatedAt: this.now(),
    });
    return tx;
  }

  private requireService(): StakingService {
    const svc = this.service();
    if (!svc) throw httpError(503, this.unavailable ?? "staking unavailable");
    return svc;
  }

  private async selfSign(userId: string, u: UnsignedStakingTx, purpose: string) {
    if (!this.deps.signing) throw httpError(400, "self-custody signing is not available");
    const tx = await this.deps.signing.requestSignature({ userId, unsigned: { unsignedTx: u.unsignedTx, txHash: u.txHash, feeLovelace: u.feeLovelace }, purpose });
    return { ...u, txHash: tx.txHash };
  }

  /** Register (if needed) + delegate to the pool + delegate the vote, in one tx. */
  async setup(userId: string, body: Pick<StakingSetupBody, "poolId" | "drepId"> = {}): Promise<StakingActionResponse> {
    const svc = this.requireService();
    const { custody, stakeKeyHash, address } = this.stakeKeyHash(userId);
    if (!stakeKeyHash) throw httpError(400, "the treasury address has no stake credential (use a base address wallet)");
    let drep;
    try {
      drep = body.drepId?.trim() ? parseDRep(body.drepId) : null;
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
    const plan = await svc.plan(stakeKeyHash, { poolId: body.poolId, drep });
    if (!plan.register && !plan.poolId && !plan.drep) throw httpError(409, `already staked to ${plan.poolTicker ?? plan.targetPoolId} with vote delegated to ${plan.targetDRep}`);
    let r: StakingTxResult | (UnsignedStakingTx & { txHash: string });
    if (custody === "custodial") r = await svc.setupCustodial({ userId, poolId: body.poolId, drep });
    else {
      const u = await svc.buildSetupUnsigned({ address, stakeKeyHash, poolId: body.poolId, drep });
      r = await this.selfSign(userId, u, `Stake your wallet to ${u.poolTicker ?? u.poolId} and delegate your vote (${u.drep})`);
    }
    const tx = this.remember(userId, "setup", r);
    return { ok: true, tx, status: await this.status(userId) };
  }

  /** Stop staking: withdraw rewards (same tx) + deregister; the deposit is refunded. */
  async stop(userId: string): Promise<StakingActionResponse> {
    const svc = this.requireService();
    const { custody, stakeKeyHash, address } = this.stakeKeyHash(userId);
    if (!stakeKeyHash) throw httpError(400, "the treasury address has no stake credential");
    let r: StakingTxResult | (UnsignedStakingTx & { txHash: string });
    if (custody === "custodial") r = await svc.stopCustodial({ userId });
    else r = await this.selfSign(userId, await svc.buildStopUnsigned({ address, stakeKeyHash }), "Stop staking: deregister your stake key (deposit refunded)");
    const tx = this.remember(userId, "stop", r);
    return { ok: true, tx, status: await this.status(userId) };
  }
}
