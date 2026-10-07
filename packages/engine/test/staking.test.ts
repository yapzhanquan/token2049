// Staking routes (api-staking.ts) + EngineStaking, offline: a real StakingService/KeyVault/TreasuryQueue
// over an in-memory fake preprod provider + fake read API (nothing touches the network or the chain).
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { closeDb, users, type DB } from "@bulkhead/db";
import {
  KeyVault,
  assertPoolId,
  parseTx,
  MeshTxService,
  StakingService,
  TreasuryQueue,
  memoryStores,
  rewardAddressOf,
  type Chain,
  type ChainProvider,
  type PoolCandidate,
  type StakeAccountState,
  type StakingReadApi,
  type Utxo,
} from "@bulkhead/chain";
import { drepDisplay, StakingSetupBodySchema, StakingStopBodySchema, type NeedsSignatureResponse, type StakingActionResponse, type StakingStatusDTO } from "@bulkhead/shared";
import { createStakingRoutes } from "../src/api-staking";
import { EngineStaking } from "../src/staking";
import { SigningBroker } from "../src/self-custody";
import { freshDb } from "./captain/helpers";

const MASTER = "5e".repeat(32);
const ADA = 1_000_000n;

class Provider implements ChainProvider {
  readonly name = "blockfrost" as const;
  readonly network = "preprod" as const;
  utxos = new Map<string, Utxo[]>();
  submitted: string[] = [];
  n = 0;
  add(address: string, lovelace: bigint) {
    const u: Utxo = { txHash: (++this.n).toString(16).padStart(64, "a"), outputIndex: 0, address, amount: [{ unit: "lovelace", quantity: lovelace.toString() }] };
    this.utxos.set(address, [...(this.utxos.get(address) ?? []), u]);
  }
  async fetchUtxos(a: string) {
    return this.utxos.get(a) ?? [];
  }
  async fetchTip() {
    return { slot: 110_000_000, time: Date.now(), height: 1 };
  }
  async fetchProtocolParameters() {
    return PARAMS;
  }
  async submitTx(cbor: string) {
    this.submitted.push(cbor);

    return parseTx(cbor).txHash;
  }
  async fetchTxConfirmation() {
    return null;
  }
}

// Preprod-like protocol parameters (Mesh castProtocol shape; keyDeposit 2 ADA).
const PARAMS = {
  epoch: 0, coinsPerUtxoSize: 4310, priceMem: 0.0577, priceStep: 0.0000721, minFeeA: 44, minFeeB: 155381, keyDeposit: 2000000,
  maxTxSize: 16384, maxValSize: 5000, poolDeposit: 500000000, maxCollateralInputs: 3, decentralisation: 0, maxBlockSize: 98304,
  collateralPercent: 150, maxBlockHeaderSize: 1100, minPoolCost: "340000000", maxTxExMem: "16000000", maxTxExSteps: "10000000000",
  maxBlockExMem: "80000000", maxBlockExSteps: "40000000000", minFeeRefScriptCostPerByte: 15,
};

class Read implements StakingReadApi {
  readonly name = "blockfrost" as const;
  accounts = new Map<string, StakeAccountState>();
  constructor(public pools: PoolCandidate[]) {}
  async fetchAccount(s: string) {
    return this.accounts.get(s) ?? { stakeAddress: s, registered: false, poolId: null, drep: null, rewardsLovelace: 0n, depositLovelace: null };
  }
  async listPools() {
    return this.pools;
  }
  async fetchPool(poolId: string) {
    const p = this.pools.find((x) => x.poolId === poolId);
    return p ? { poolId, ticker: p.ticker, name: null, retired: false } : null;
  }
}

afterAll(() => closeDb());

function insertUser(db: DB, id: string, custody: "custodial" | "self", accountIndex: number, address: string, keyHash: string, stakeKeyHash: string) {
  db.insert(users).values({ id, email: `${id}@t.local`, name: id, custody, accountIndex, treasuryAddress: address, ownerKeyHash: keyHash, stakeKeyHash, createdAt: Date.now() }).run();
}

describe("staking API (offline)", () => {
  it("custodial setup → status → stop; self-custody setup waits for the wallet signature", async () => {
    const db = freshDb();
    const stores = memoryStores();
    const keys = new KeyVault({ masterSecret: MASTER, repo: stores.keys, kv: stores.kv });
    const provider = new Provider();
    const queue = new TreasuryQueue();
    const poolId = assertPoolId("ab".repeat(28));
    const read = new Read([{ poolId, ticker: "BHPOOL", activeStakeLovelace: 5_000n * ADA, saturation: 0.1, retiring: false }]);
    const service = new StakingService({ provider, keys, queue, read });

    // custodial user
    const t = await keys.treasury("u_c", 3);
    insertUser(db, "u_c", "custodial", 3, t.address, t.keyHash, t.stakeKeyHash);
    provider.add(t.address, 20n * ADA);
    // self-custody user: a "browser wallet" whose keys we hold here only to simulate CIP-30 signing
    const w = await keys.treasury("wallet", 4);
    insertUser(db, "u_s", "self", 4, w.address, w.keyHash, w.stakeKeyHash);
    provider.add(w.address, 20n * ADA);

    const txService = new MeshTxService({ provider, keys, sessions: () => null, queue });
    const signing = new SigningBroker({ db }).bind({ tx: txService } as unknown as Chain);
    const staking = new EngineStaking({ db, chain: {} as Chain, signing, service });
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", c.req.header("x-user-id")!);
      return next();
    });
    app.route("/", createStakingRoutes({ db, chain: {} as Chain, signing, staking }));
    const call = async <T = any>(method: string, path: string, user: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "x-user-id": user, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as T };
    };

    // GET before setup
    const s0 = await call<StakingStatusDTO>("GET", "/staking", "u_c");
    expect(s0.body).toMatchObject({ available: true, registered: false, poolId: null, drep: null, stakeAddress: rewardAddressOf(t.stakeKeyHash), live: true });

    // custodial setup: one tx with registration + pool + always_abstain
    const r = await call<StakingActionResponse>("POST", "/staking/setup", "u_c", {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tx.certs).toEqual(["stake_registration", "stake_delegation", "vote_delegation"]);
    expect(r.body.tx.depositDeltaLovelace).toBe("2000000");
    expect(provider.submitted).toHaveLength(1);
    // provider has not caught up yet → pending, showing the intended state
    expect(r.body.status).toMatchObject({ pending: true, registered: true, poolId, poolTicker: "BHPOOL", drep: "always_abstain" });
    expect(drepDisplay(r.body.status.drep)).toBe("Always abstain");

    // provider catches up → live + confirmed
    const ra = rewardAddressOf(t.stakeKeyHash);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId, drep: "always_abstain", rewardsLovelace: 0n, depositLovelace: null });
    const s1 = await call<StakingStatusDTO>("GET", "/staking", "u_c");
    expect(s1.body).toMatchObject({ live: true, pending: false, registered: true, poolTicker: "BHPOOL", drep: "always_abstain", depositLovelace: "2000000" });
    expect(s1.body.txs[0]).toMatchObject({ kind: "setup", confirmed: true, txHash: r.body.tx.txHash });

    // already staked → 409
    expect((await call("POST", "/staking/setup", "u_c", {})).status).toBe(409);
    // bad DRep / missing confirm → 400
    expect((await call("POST", "/staking/setup", "u_c", { drepId: "nope" })).status).toBe(400);
    expect((await call("POST", "/staking/stop", "u_c", {})).status).toBe(400);

    // stop staking (confirm) → deregistration refunding the deposit
    provider.utxos.set(t.address, []);
    provider.add(t.address, 10n * ADA);
    const stop = await call<StakingActionResponse>("POST", "/staking/stop", "u_c", { confirm: true });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body.tx).toMatchObject({ kind: "stop", certs: ["stake_deregistration"], depositDeltaLovelace: "-2000000" });

    // self-custody: needsSignature first, nothing submitted
    const before = provider.submitted.length;
    const first = await call<NeedsSignatureResponse>("POST", "/staking/setup", "u_s", {});
    expect(first.body).toMatchObject({ ok: false, needsSignature: true });
    expect(provider.submitted).toHaveLength(before);
    // asking again returns the same pending tx
    expect((await call<NeedsSignatureResponse>("POST", "/staking/setup", "u_s", {})).body.pendingId).toBe(first.body.pendingId);
    // the wallet signs (payment + stake key, as CIP-30 partialSign does) and posts back
    const signed = await keys.signTxWithStakeKey("treasury:wallet", await keys.signTx("treasury:wallet", first.body.unsignedTx));
    const done = await call<StakingActionResponse>("POST", "/staking/setup", "u_s", { pendingId: first.body.pendingId, signedTx: signed });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.tx).toMatchObject({ kind: "setup", txHash: first.body.txHash });
    expect(provider.submitted).toHaveLength(before + 1);
  });

  it("DTO schemas", () => {
    expect(StakingSetupBodySchema.safeParse({}).success).toBe(true);
    expect(StakingSetupBodySchema.safeParse({ drepId: "always_abstain" }).success).toBe(true);
    expect(StakingSetupBodySchema.safeParse({ poolId: "xyz" }).success).toBe(false);
    expect(StakingStopBodySchema.safeParse({ confirm: true }).success).toBe(true);
    expect(StakingStopBodySchema.safeParse({ confirm: false }).success).toBe(false);
    expect(drepDisplay(null)).toBe("not delegated");
    expect(drepDisplay("always_no_confidence")).toBe("Always no confidence");
  });

  it("unavailable on a chain without a KeyVault (FakeChain)", async () => {
    const db = freshDb();
    insertUser(db, "u_x", "custodial", 1, "addr_test1qx", "00".repeat(28), "11".repeat(28));
    const s = new EngineStaking({ db, chain: { provider: { network: "preprod" } } as unknown as Chain, env: { CHAIN: "fake" } });
    const st = await s.status("u_x");
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(/real preprod chain/);
    await expect(s.setup("u_x")).rejects.toMatchObject({ status: 503 });
  });
});
