// StakingService: register + delegate (pool) + delegate the vote (DRep / always_abstain) for a user
// treasury, stop staking (deregister, refund), and withdraw rewards. Preprod only.
//  - Custodial: built here, signed with the treasury PAYMENT key (fee/deposit inputs) and STAKE key
//    (certificate / withdrawal witness) from KeyVault, submitted through the TreasuryQueue.
//  - Self-custody: build*Unsigned() returns the unsigned tx for the browser wallet (CIP-30 signTx with
//    partialSign=true signs with payment + stake keys); submit with TxService.submitSigned.
import type { ChainProvider, Utxo } from "../types";
import type { KeyVault } from "../keys";
import type { TreasuryQueue } from "../queue";
import { cst, type MeshProtocol } from "../mesh";
import { parseTx } from "../tx";
import {
  ALWAYS_ABSTAIN,
  assertPoolId,
  buildStakingSetupTx,
  buildStopStakingTx,
  buildWithdrawRewardsTx,
  drepLabel,
  sameDRep,
  rewardAddressOf,
  type BuiltStakingTx,
  type DRepChoice,
} from "./builders";
import { pickPool, type StakeAccountState, type StakingReadApi } from "./account";

export interface StakingServiceOptions {
  provider: ChainProvider;
  keys: KeyVault;
  queue: TreasuryQueue;
  read: StakingReadApi;
  /** TTL in slots (default 900). */
  ttlSlots?: number;
  /** STAKE_POOL_ID (bech32 or hex); else a pool is picked from the provider's pool list. */
  defaultPoolId?: string;
  /** DREP_ID; else always_abstain. */
  defaultDRep?: DRepChoice;
  log?: (msg: string) => void;
}

export interface StakingPlan {
  stakeAddress: string;
  register: boolean;
  poolId?: string;
  poolTicker: string | null;
  drep?: DRepChoice;
  /** What the account will be after the tx. */
  targetPoolId: string;
  targetDRep: string;
}

export interface StakingTxResult extends Omit<BuiltStakingTx, "unsignedTx"> {
  stakeAddress: string;
  cborHex: string;
  poolId?: string;
  poolTicker?: string | null;
  drep?: string;
}

export interface UnsignedStakingTx extends BuiltStakingTx {
  stakeAddress: string;
  ttlSlot: number;
  poolId?: string;
  poolTicker?: string | null;
  drep?: string;
}

export class StakingService {
  private readonly ttlSlots: number;
  private poolCache: { poolId: string; ticker: string | null; at: number } | null = null;

  constructor(private readonly o: StakingServiceOptions) {
    if (o.provider.network !== "preprod") throw new Error("StakingService is preprod only");
    this.ttlSlots = o.ttlSlots ?? 900;
  }

  get read(): StakingReadApi {
    return this.o.read;
  }

  rewardAddressFor(stakeKeyHash: string): string {
    return rewardAddressOf(stakeKeyHash);
  }

  account(stakeAddress: string): Promise<StakeAccountState> {
    return this.o.read.fetchAccount(stakeAddress);
  }

  /** Live protocol params; keyDeposit is the current stake-key deposit. */
  async params(): Promise<MeshProtocol> {
    const p = (await this.o.provider.fetchProtocolParameters()) as MeshProtocol;
    if (!p || p.keyDeposit == null) throw new Error("provider returned protocol parameters without keyDeposit");
    return p;
  }

  async keyDeposit(): Promise<bigint> {
    return BigInt((await this.params()).keyDeposit);
  }

  /** Explicit pool → validated (+ticker); else STAKE_POOL_ID; else the best active preprod pool (cached 1 h). */
  async resolvePool(poolId?: string | null): Promise<{ poolId: string; ticker: string | null; source: "request" | "env" | "picked" }> {
    const explicit = poolId?.trim() || null;
    const want = explicit ?? this.o.defaultPoolId?.trim() ?? null;
    if (want) {
      const id = assertPoolId(want);
      const info = await this.o.read.fetchPool(id).catch(() => null);
      if (info?.retired) throw new Error(`pool ${id} is retired`);
      return { poolId: id, ticker: info?.ticker ?? null, source: explicit ? "request" : "env" };
    }
    if (this.poolCache && Date.now() - this.poolCache.at < 3_600_000) return { poolId: this.poolCache.poolId, ticker: this.poolCache.ticker, source: "picked" };
    const best = pickPool(await this.o.read.listPools());
    this.poolCache = { poolId: best.poolId, ticker: best.ticker, at: Date.now() };
    this.o.log?.(`[staking] default pool picked from ${this.o.read.name}: ${best.ticker ?? "?"} ${best.poolId}`);
    return { poolId: best.poolId, ticker: best.ticker, source: "picked" };
  }

  /** Which certificates are still needed (idempotent: re-running after success is a no-op error). */
  async plan(stakeKeyHash: string, req: { poolId?: string | null; drep?: DRepChoice | null } = {}): Promise<StakingPlan> {
    const stakeAddress = rewardAddressOf(stakeKeyHash);
    const [acct, pool] = await Promise.all([this.account(stakeAddress), this.resolvePool(req.poolId)]);
    const drep = req.drep ?? this.o.defaultDRep ?? ALWAYS_ABSTAIN;
    const plan: StakingPlan = { stakeAddress, register: !acct.registered, poolTicker: pool.ticker, targetPoolId: pool.poolId, targetDRep: drepLabel(drep) };
    if (!acct.registered || acct.poolId !== pool.poolId) plan.poolId = pool.poolId;
    if (!acct.registered || !sameDRep(acct.drep, drep)) plan.drep = drep;
    return plan;
  }

  private async treasury(userId: string): Promise<{ keyId: string; address: string; stakeKeyHash: string }> {
    const keyId = `treasury:${userId}`;
    const info = await this.o.keys.publicInfo(keyId);
    if (!info.address || !info.stakeKeyHash) throw new Error(`No custodial treasury (with a stake key) for ${userId}`);
    return { keyId, address: info.address, stakeKeyHash: info.stakeKeyHash };
  }

  /** Build under the address's queue lock with live UTxOs/tip/params; optionally sign+submit (custodial). */
  private async withWallet<T>(
    address: string,
    build: (ctx: { utxos: Utxo[]; params: MeshProtocol; ttlSlot: number }) => Promise<BuiltStakingTx>,
    then: (built: BuiltStakingTx, ttlSlot: number, reserve: (signed: string) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    return this.o.queue.run(address, async (ctx) => {
      const [chainUtxos, tip, params] = await Promise.all([this.o.provider.fetchUtxos(address), this.o.provider.fetchTip(), this.params()]);
      const ttlSlot = tip.slot + this.ttlSlots;
      // Prefer confirmed UTxOs; fall back to in-flight change (chained) only if those are insufficient.
      const confirmed = ctx.available(chainUtxos, { tipSlot: tip.slot });
      const all = ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot });
      let built: BuiltStakingTx;
      try {
        built = await build({ utxos: confirmed, params, ttlSlot });
      } catch (e) {
        if (all.length === confirmed.length) throw e;
        built = await build({ utxos: all, params, ttlSlot });
      }
      return then(built, ttlSlot, async (signed) => {
        const parsed = parseTx(signed);
        if (parsed.txHash !== built.txHash) throw new Error("internal: tx body changed while signing");
        let h: string;
        try {
          h = await this.o.provider.submitTx(signed);
        } catch (e) {
          throw new Error(`Submit failed via ${this.o.provider.name}: ${(e as Error).message}`);
        }
        if (h && h !== parsed.txHash) throw new Error(`Provider returned tx hash ${h}, expected ${parsed.txHash}`);
        ctx.reserve(parsed.txHash, parsed.inputs, parsed.outputs.filter((o) => o.address === address), ttlSlot);
        return parsed.txHash;
      });
    });
  }

  private async signCustodial(keyId: string, hex: string): Promise<string> {
    const withPayment = await this.o.keys.signTx(keyId, hex);
    return this.o.keys.signTxWithStakeKey(keyId, withPayment);
  }

  private result(built: BuiltStakingTx, signed: string, stakeAddress: string, extra: Partial<StakingTxResult>): StakingTxResult {
    const { unsignedTx: _u, ...rest } = built;
    return { ...rest, ...extra, stakeAddress, cborHex: signed };
  }

  // ── setup: register + pool delegation + vote delegation ──────────────────────────────────
  async setupCustodial(args: { userId: string; poolId?: string | null; drep?: DRepChoice | null; memo?: string[] }): Promise<StakingTxResult> {
    const t = await this.treasury(args.userId);
    const plan = await this.plan(t.stakeKeyHash, args);
    return this.withWallet(
      t.address,
      ({ utxos, params, ttlSlot }) =>
        buildStakingSetupTx({ params, utxos, changeAddress: t.address, rewardAddress: plan.stakeAddress, ttlSlot, register: plan.register, poolId: plan.poolId, drep: plan.drep, memo: args.memo ?? ["Bulkhead treasury staking setup"] }),
      async (built, _ttl, submit) => {
        const signed = await this.signCustodial(t.keyId, built.unsignedTx);
        await submit(signed);
        return this.result(built, signed, plan.stakeAddress, { poolId: plan.targetPoolId, poolTicker: plan.poolTicker, drep: plan.targetDRep });
      },
    );
  }

  async buildSetupUnsigned(args: { address: string; stakeKeyHash: string; poolId?: string | null; drep?: DRepChoice | null; memo?: string[] }): Promise<UnsignedStakingTx> {
    const plan = await this.plan(args.stakeKeyHash, args);
    return this.withWallet(
      args.address,
      ({ utxos, params, ttlSlot }) =>
        buildStakingSetupTx({ params, utxos, changeAddress: args.address, rewardAddress: plan.stakeAddress, ttlSlot, register: plan.register, poolId: plan.poolId, drep: plan.drep, memo: args.memo ?? ["Bulkhead treasury staking setup"] }),
      async (built, ttlSlot) => ({ ...built, stakeAddress: plan.stakeAddress, ttlSlot, poolId: plan.targetPoolId, poolTicker: plan.poolTicker, drep: plan.targetDRep }),
    );
  }

  // ── stop: withdraw rewards (same tx) + deregister ────────────────────────────────────────
  private async stopChecks(stakeKeyHash: string): Promise<{ stakeAddress: string; rewards: bigint }> {
    const stakeAddress = rewardAddressOf(stakeKeyHash);
    const acct = await this.account(stakeAddress);
    if (!acct.registered) throw new Error("the stake credential is not registered — nothing to stop");
    if (acct.rewardsLovelace > 0n && !acct.drep)
      throw new Error("rewards must be withdrawn before deregistering, and Conway only allows withdrawals after the stake credential has delegated its vote — run staking setup (vote delegation) first");
    return { stakeAddress, rewards: acct.rewardsLovelace };
  }

  async stopCustodial(args: { userId: string }): Promise<StakingTxResult> {
    const t = await this.treasury(args.userId);
    const { stakeAddress, rewards } = await this.stopChecks(t.stakeKeyHash);
    return this.withWallet(
      t.address,
      ({ utxos, params, ttlSlot }) => buildStopStakingTx({ params, utxos, changeAddress: t.address, rewardAddress: stakeAddress, ttlSlot, rewardsLovelace: rewards, memo: ["Bulkhead treasury: stop staking"] }),
      async (built, _ttl, submit) => {
        const signed = await this.signCustodial(t.keyId, built.unsignedTx);
        await submit(signed);
        return this.result(built, signed, stakeAddress, {});
      },
    );
  }

  async buildStopUnsigned(args: { address: string; stakeKeyHash: string }): Promise<UnsignedStakingTx> {
    const { stakeAddress, rewards } = await this.stopChecks(args.stakeKeyHash);
    return this.withWallet(
      args.address,
      ({ utxos, params, ttlSlot }) => buildStopStakingTx({ params, utxos, changeAddress: args.address, rewardAddress: stakeAddress, ttlSlot, rewardsLovelace: rewards, memo: ["Bulkhead treasury: stop staking"] }),
      async (built, ttlSlot) => ({ ...built, stakeAddress, ttlSlot }),
    );
  }

  // ── withdraw rewards ─────────────────────────────────────────────────────────────────────
  private async withdrawChecks(stakeKeyHash: string, amount?: bigint): Promise<{ stakeAddress: string; amount: bigint }> {
    const stakeAddress = rewardAddressOf(stakeKeyHash);
    const acct = await this.account(stakeAddress);
    if (!acct.registered) throw new Error("the stake credential is not registered");
    if (!acct.drep) throw new Error("Conway: reward withdrawals require the stake credential to have delegated its vote (DRep / always_abstain) — run staking setup first");
    const amt = amount ?? acct.rewardsLovelace;
    if (amt !== acct.rewardsLovelace) throw new Error(`a withdrawal must take the full reward balance (${acct.rewardsLovelace} lovelace), not ${amt}`);
    return { stakeAddress, amount: amt };
  }

  /** Withdraw the full reward balance (the ledger requires the exact balance; 0 is valid when it is 0). */
  async withdrawRewards(args: { userId: string; amountLovelace?: bigint }): Promise<StakingTxResult> {
    const t = await this.treasury(args.userId);
    const { stakeAddress, amount } = await this.withdrawChecks(t.stakeKeyHash, args.amountLovelace);
    return this.withWallet(
      t.address,
      ({ utxos, params, ttlSlot }) => buildWithdrawRewardsTx({ params, utxos, changeAddress: t.address, rewardAddress: stakeAddress, ttlSlot, amountLovelace: amount, memo: ["Bulkhead treasury: withdraw staking rewards"] }),
      async (built, _ttl, submit) => {
        const signed = await this.signCustodial(t.keyId, built.unsignedTx);
        await submit(signed);
        return this.result(built, signed, stakeAddress, {});
      },
    );
  }

  async buildWithdrawUnsigned(args: { address: string; stakeKeyHash: string; amountLovelace?: bigint }): Promise<UnsignedStakingTx> {
    const { stakeAddress, amount } = await this.withdrawChecks(args.stakeKeyHash, args.amountLovelace);
    return this.withWallet(
      args.address,
      ({ utxos, params, ttlSlot }) => buildWithdrawRewardsTx({ params, utxos, changeAddress: args.address, rewardAddress: stakeAddress, ttlSlot, amountLovelace: amount, memo: ["Bulkhead treasury: withdraw staking rewards"] }),
      async (built, ttlSlot) => ({ ...built, stakeAddress, ttlSlot }),
    );
  }
}

/** Wire a StakingService from a createChain() result (needs the real KeyVault + queue). */
export function stakingServiceFor(
  chain: { provider: ChainProvider; keys: unknown; queue: unknown },
  read: StakingReadApi,
  opts: { defaultPoolId?: string; defaultDRep?: DRepChoice; ttlSlots?: number; log?: (m: string) => void } = {},
): StakingService {
  const keys = chain.keys as KeyVault;
  if (typeof (keys as Partial<KeyVault>).signTxWithStakeKey !== "function") throw new Error("this chain has no KeyVault (staking needs the real preprod chain)");
  return new StakingService({ provider: chain.provider, keys, queue: chain.queue as TreasuryQueue, read, ...opts });
}

/** Stake key hash of a stake_test1… reward address. */
export const stakeKeyHashOfRewardAddress = (addr: string): string => cst.resolveStakeKeyHash(addr);
