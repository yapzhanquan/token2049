// Read-side staking data from the preprod provider: stake account state (registered / pool / DRep /
// rewards) and the pool list (to pick a default pool). Blockfrost when BLOCKFROST_PREPROD_PROJECT_ID is
// set, else Koios (keyless). Preprod only.
import { fetchWithRetry, type RetryOptions } from "../providers/http";
import { normaliseProviderDRep } from "./builders";

export interface StakeAccountState {
  stakeAddress: string;
  registered: boolean;
  /** bech32 pool1… or null. */
  poolId: string | null;
  /** "always_abstain" | "always_no_confidence" | drep1… | null. */
  drep: string | null;
  /** Withdrawable rewards. */
  rewardsLovelace: bigint;
  /** Deposit recorded by the provider, when it reports one (Koios). */
  depositLovelace: bigint | null;
}

export interface PoolCandidate {
  poolId: string; // bech32
  ticker: string | null;
  name?: string | null;
  activeStakeLovelace: bigint;
  /** 0..1+ (live saturation), when known. */
  saturation: number | null;
  retiring: boolean;
}

export interface PoolInfo {
  poolId: string;
  ticker: string | null;
  name: string | null;
  retired: boolean;
}

export interface StakingReadApi {
  readonly name: "blockfrost" | "koios";
  fetchAccount(stakeAddress: string): Promise<StakeAccountState>;
  listPools(): Promise<PoolCandidate[]>;
  fetchPool(poolId: string): Promise<PoolInfo | null>;
}

/** Choose a default pool: active (not retiring), has a ticker, not saturated (< 90 %), most active stake. */
export function pickPool(pools: PoolCandidate[]): PoolCandidate {
  const ok = pools
    .filter((p) => !p.retiring && p.activeStakeLovelace > 0n && (p.saturation == null || p.saturation < 0.9))
    .sort((a, b) => (a.ticker ? 0 : 1) - (b.ticker ? 0 : 1) || (b.activeStakeLovelace > a.activeStakeLovelace ? 1 : b.activeStakeLovelace < a.activeStakeLovelace ? -1 : 0) || a.poolId.localeCompare(b.poolId));
  const best = ok[0];
  if (!best) throw new Error("no active, unsaturated preprod stake pool found (set STAKE_POOL_ID)");
  return best;
}

const big = (v: unknown): bigint => {
  try {
    return v == null || v === "" ? 0n : BigInt(String(v));
  } catch {
    return 0n;
  }
};

export class BlockfrostStakingApi implements StakingReadApi {
  readonly name = "blockfrost" as const;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(
    projectId: string,
    private readonly opts: { baseUrl?: string; retry?: RetryOptions } = {},
  ) {
    if (!projectId) throw new Error("BlockfrostStakingApi: empty project id");
    if (/^mainnet/i.test(projectId)) throw new Error("BlockfrostStakingApi: refusing a MAINNET project id (preprod only)");
    this.base = (opts.baseUrl ?? "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/+$/, "");
    this.headers = { project_id: projectId };
  }
  private async get<T>(path: string): Promise<T | null> {
    const res = await fetchWithRetry(`${this.base}${path}`, { headers: this.headers }, this.opts.retry ?? {});
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }
  async fetchAccount(stakeAddress: string): Promise<StakeAccountState> {
    const j = await this.get<Record<string, unknown>>(`/accounts/${stakeAddress}`);
    if (!j) return { stakeAddress, registered: false, poolId: null, drep: null, rewardsLovelace: 0n, depositLovelace: null };
    const registered = typeof j.registered === "boolean" ? j.registered : !!j.active;
    return {
      stakeAddress,
      registered,
      poolId: registered && typeof j.pool_id === "string" ? j.pool_id : null,
      drep: registered ? normaliseProviderDRep(j.drep_id) : null,
      rewardsLovelace: big(j.withdrawable_amount),
      depositLovelace: null,
    };
  }
  async listPools(): Promise<PoolCandidate[]> {
    const retiring = new Set(((await this.get<Array<{ pool_id: string }>>(`/pools/retiring?count=100`)) ?? []).map((p) => p.pool_id));
    const out: PoolCandidate[] = [];
    for (let page = 1; page <= 3; page++) {
      const rows = await this.get<Array<{ pool_id: string; active_stake: string; live_saturation?: number; metadata?: { ticker?: string | null; name?: string | null } | null }>>(
        `/pools/extended?count=100&page=${page}`,
      );
      if (!rows?.length) break;
      for (const r of rows)
        out.push({
          poolId: r.pool_id,
          ticker: r.metadata?.ticker ?? null,
          name: r.metadata?.name ?? null,
          activeStakeLovelace: big(r.active_stake),
          saturation: typeof r.live_saturation === "number" ? r.live_saturation : null,
          retiring: retiring.has(r.pool_id),
        });
      if (rows.length < 100) break;
    }
    return out;
  }
  async fetchPool(poolId: string): Promise<PoolInfo | null> {
    const p = await this.get<{ pool_id: string; retirement?: string[] }>(`/pools/${poolId}`);
    if (!p) return null;
    const md = await this.get<{ ticker?: string | null; name?: string | null }>(`/pools/${poolId}/metadata`).catch(() => null);
    return { poolId: p.pool_id, ticker: md?.ticker ?? null, name: md?.name ?? null, retired: false };
  }
}

export class KoiosStakingApi implements StakingReadApi {
  readonly name = "koios" as const;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(private readonly opts: { token?: string; baseUrl?: string; retry?: RetryOptions } = {}) {
    this.base = (opts.baseUrl ?? "https://preprod.koios.rest/api/v1").replace(/\/+$/, "");
    if (/\/\/api\.koios\.rest/.test(this.base)) throw new Error("KoiosStakingApi: refusing the MAINNET endpoint (preprod only)");
    this.headers = { Accept: "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  }
  private async req<T>(path: string, body?: unknown): Promise<T> {
    const init: RequestInit = body === undefined ? { headers: this.headers } : { method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetchWithRetry(`${this.base}${path}`, init, this.opts.retry ?? {});
    if (res.status === 404) throw new Error(`koios: 404 ${path}`);
    return (await res.json()) as T;
  }
  async fetchAccount(stakeAddress: string): Promise<StakeAccountState> {
    const rows = await this.req<Array<Record<string, unknown>>>(`/account_info`, { _stake_addresses: [stakeAddress] });
    const j = rows[0];
    const registered = j?.status === "registered";
    if (!j) return { stakeAddress, registered: false, poolId: null, drep: null, rewardsLovelace: 0n, depositLovelace: null };
    return {
      stakeAddress,
      registered,
      poolId: registered && typeof j.delegated_pool === "string" ? j.delegated_pool : null,
      drep: registered ? normaliseProviderDRep(j.delegated_drep) : null,
      rewardsLovelace: big(j.rewards_available),
      depositLovelace: j.deposit != null ? big(j.deposit) : null,
    };
  }
  async listPools(): Promise<PoolCandidate[]> {
    const rows = await this.req<Array<{ pool_id_bech32: string; ticker: string | null; active_stake: string | null; pool_status: string }>>(
      `/pool_list?pool_status=eq.registered&select=pool_id_bech32,ticker,active_stake,pool_status&order=active_stake.desc.nullslast&limit=200`,
    );
    return rows.map((r) => ({ poolId: r.pool_id_bech32, ticker: r.ticker, activeStakeLovelace: big(r.active_stake), saturation: null, retiring: r.pool_status !== "registered" }));
  }
  async fetchPool(poolId: string): Promise<PoolInfo | null> {
    const rows = await this.req<Array<{ pool_id_bech32: string; pool_status: string; meta_json?: { ticker?: string; name?: string } | null }>>(`/pool_info`, { _pool_bech32_ids: [poolId] });
    const r = rows[0];
    return r ? { poolId: r.pool_id_bech32, ticker: r.meta_json?.ticker ?? null, name: r.meta_json?.name ?? null, retired: r.pool_status === "retired" } : null;
  }
}

export function createStakingReadApi(env: { BLOCKFROST_PREPROD_PROJECT_ID?: string; KOIOS_API_TOKEN?: string } = process.env, retry?: RetryOptions): StakingReadApi {
  const bf = env.BLOCKFROST_PREPROD_PROJECT_ID?.trim();
  if (bf) return new BlockfrostStakingApi(bf, { retry });
  return new KoiosStakingApi({ token: env.KOIOS_API_TOKEN?.trim() || undefined, retry });
}
