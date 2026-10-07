// Staking + vote delegation: offline cert tx builders (fake UTxOs, Mesh offline build), pool picker,
// read-API mapping, StakingService custodial/self-custody flows against a fake provider.
import { beforeAll, describe, expect, it } from "vitest";
import { KeyVault } from "../src/keys";
import { memoryStores } from "../src/store";
import { TreasuryQueue } from "../src/queue";
import { cst, DEFAULT_PROTOCOL_PARAMETERS, type MeshProtocol } from "../src/mesh";
import { buildSessionScript } from "../src/script";
import {
  ALWAYS_ABSTAIN,
  BlockfrostStakingApi,
  KoiosStakingApi,
  StakingService,
  buildStakingSetupTx,
  buildStopStakingTx,
  buildWithdrawRewardsTx,
  certificatesOf,
  parseDRep,
  pickPool,
  rewardAddressOf,
  sameDRep,
  withdrawalsOf,
  type PoolCandidate,
  type StakeAccountState,
  type StakingReadApi,
} from "../src/staking";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, fakeHash, witnesses } from "./helpers";

const ADA = 1_000_000n;
const params = { ...DEFAULT_PROTOCOL_PARAMETERS } as MeshProtocol;
const POOL_HEX = "ab".repeat(28);
const POOL = cst.resolvePoolId(POOL_HEX);
const POOL2 = cst.resolvePoolId("cd".repeat(28));
const DREP = cst.hexToBech32("drep", "ef".repeat(28)); // CIP-105
const DREP_129 = cst.hexToBech32("drep", "22" + "ef".repeat(28)); // CIP-129 (key-hash header 0x22)

class FakeRead implements StakingReadApi {
  readonly name = "blockfrost" as const;
  accounts = new Map<string, StakeAccountState>();
  pools: PoolCandidate[] = [
    { poolId: POOL2, ticker: "SMALL", activeStakeLovelace: 10n * ADA, saturation: 0.01, retiring: false },
    { poolId: POOL, ticker: "BIG", activeStakeLovelace: 9_000n * ADA, saturation: 0.2, retiring: false },
  ];
  async fetchAccount(stakeAddress: string): Promise<StakeAccountState> {
    return this.accounts.get(stakeAddress) ?? { stakeAddress, registered: false, poolId: null, drep: null, rewardsLovelace: 0n, depositLovelace: null };
  }
  async listPools() {
    return this.pools;
  }
  async fetchPool(poolId: string) {
    const p = this.pools.find((x) => x.poolId === poolId);
    return p ? { poolId, ticker: p.ticker, name: null, retired: false } : null;
  }
}

let keys: KeyVault;
let treasury: { address: string; stakeKeyHash: string; keyHash: string };
beforeAll(async () => {
  const stores = memoryStores();
  keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  treasury = await keys.treasury("u-stake", 7);
});

function utxos(address: string, lovelace = 20n * ADA) {
  return [{ txHash: fakeHash(), outputIndex: 0, address, amount: [{ unit: "lovelace", quantity: lovelace.toString() }] }];
}
const outLovelace = (hex: string) => cst.deserializeTx(hex).body().outputs().reduce((s, o) => s + o.amount().coin(), 0n);

describe("reward address + DRep parsing", () => {
  it("derives a preprod stake_test1 address from the treasury stake key", () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    expect(ra).toMatch(/^stake_test1/);
    expect(cst.resolveStakeKeyHash(ra)).toBe(treasury.stakeKeyHash);
    expect(cst.resolveStakeKeyHash(treasury.address)).toBe(treasury.stakeKeyHash);
  });
  it("parses DRep choices", () => {
    expect(parseDRep(undefined)).toEqual(ALWAYS_ABSTAIN);
    expect(parseDRep("always_abstain")).toEqual(ALWAYS_ABSTAIN);
    expect(parseDRep("drep_always_no_confidence")).toEqual({ kind: "always_no_confidence" });
    expect(parseDRep(DREP)).toEqual({ kind: "drep", drepId: DREP });
    expect(() => parseDRep("drep1nope")).toThrow();
    expect(() => parseDRep("pool1xyz")).toThrow(/bech32/);
    expect(sameDRep("always_abstain", ALWAYS_ABSTAIN)).toBe(true);
    expect(sameDRep(null, ALWAYS_ABSTAIN)).toBe(false);
    expect(sameDRep(DREP, { kind: "drep", drepId: DREP })).toBe(true);
    expect(sameDRep(DREP_129, { kind: "drep", drepId: DREP })).toBe(true);
    expect(parseDRep(DREP_129)).toEqual({ kind: "drep", drepId: DREP_129 });
  });
});

describe("cert tx builders (offline, fake UTxOs)", () => {
  it("register + pool delegation + always_abstain vote delegation in ONE tx; deposit = live keyDeposit", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    const ins = utxos(treasury.address);
    const b = await buildStakingSetupTx({ params, utxos: ins, changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, register: true, poolId: POOL, drep: ALWAYS_ABSTAIN, memo: ["test"] });
    expect(b.certs).toEqual(["stake_registration", "stake_delegation", "vote_delegation"]);
    expect(b.depositDeltaLovelace).toBe(BigInt(params.keyDeposit));
    const certs = certificatesOf(b.unsignedTx);
    expect(certs.map((c) => c.kind)).toEqual(["StakeRegistrationCertificate", "StakeDelegationCertificate", "VoteDelegationCertificate"]);
    for (const c of certs) expect(c.stakeKeyHash).toBe(treasury.stakeKeyHash);
    expect(certs[1]!.poolKeyHash).toBeDefined();
    expect(certs[2]!.drep).toMatch(/AlwaysAbstain|abstain/i);
    // value conservation: inputs = outputs + fee + deposit
    expect(20n * ADA).toBe(outLovelace(b.unsignedTx) + b.feeLovelace + BigInt(params.keyDeposit));
  });

  it("the fee covers BOTH witnesses (payment + stake) once signed", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    const b = await buildStakingSetupTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, register: true, poolId: POOL, drep: ALWAYS_ABSTAIN });
    const signed = await keys.signTxWithStakeKey("treasury:u-stake", await keys.signTx("treasury:u-stake", b.unsignedTx));
    const w = witnesses(signed);
    expect(w.map((x) => x.keyHash).sort()).toEqual([treasury.keyHash, treasury.stakeKeyHash].sort());
    expect(w.every((x) => x.valid)).toBe(true);
    const size = signed.length / 2;
    const minFee = BigInt(params.minFeeA) * BigInt(size) + BigInt(params.minFeeB);
    expect(b.feeLovelace).toBeGreaterThanOrEqual(minFee);
  });

  it("a user DRep id produces a key-hash DRep vote delegation", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    const b = await buildStakingSetupTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, register: false, drep: { kind: "drep", drepId: DREP } });
    expect(b.certs).toEqual(["vote_delegation"]);
    expect(b.depositDeltaLovelace).toBe(0n);
    expect(certificatesOf(b.unsignedTx)[0]!.drep).toContain("ef".repeat(28));
  });

  it("withdrawRewards builder: zero and non-zero amounts (Conway: full balance only)", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    const z = await buildWithdrawRewardsTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, amountLovelace: 0n });
    expect(withdrawalsOf(z.unsignedTx)).toEqual({ [ra]: 0n });
    const n = await buildWithdrawRewardsTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, amountLovelace: 1_234_567n });
    expect(withdrawalsOf(n.unsignedTx)).toEqual({ [ra]: 1_234_567n });
    expect(20n * ADA + 1_234_567n).toBe(outLovelace(n.unsignedTx) + n.feeLovelace);
  });

  it("stop staking: withdraw rewards in the same tx + deregister, refunding keyDeposit", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    const b = await buildStopStakingTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, rewardsLovelace: 500_000n });
    expect(certificatesOf(b.unsignedTx).map((c) => c.kind)).toEqual(["StakeDeregistrationCertificate"]);
    expect(withdrawalsOf(b.unsignedTx)).toEqual({ [ra]: 500_000n });
    expect(b.depositDeltaLovelace).toBe(-BigInt(params.keyDeposit));
    expect(20n * ADA + 500_000n + BigInt(params.keyDeposit)).toBe(outLovelace(b.unsignedTx) + b.feeLovelace);
    const zero = await buildStopStakingTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: TIP_SLOT + 900, rewardsLovelace: 0n });
    expect(withdrawalsOf(zero.unsignedTx)).toEqual({});
  });

  it("refuses non-preprod addresses and empty wallets", async () => {
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    await expect(buildStakingSetupTx({ params, utxos: [], changeAddress: treasury.address, rewardAddress: ra, ttlSlot: 1, register: true })).rejects.toThrow(/no UTxOs/);
    await expect(buildStakingSetupTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: "stake1uxyz", ttlSlot: 1, register: true })).rejects.toThrow(/stake_test1/);
    await expect(buildStakingSetupTx({ params, utxos: utxos(treasury.address), changeAddress: treasury.address, rewardAddress: ra, ttlSlot: 1, register: false })).rejects.toThrow(/nothing to do/);
  });
});

describe("pool picker", () => {
  const p = (id: string, stake: bigint, extra: Partial<PoolCandidate> = {}): PoolCandidate => ({ poolId: id, ticker: "T", activeStakeLovelace: stake, saturation: 0.1, retiring: false, ...extra });
  it("picks the most active-stake, non-retiring, unsaturated pool with a ticker", () => {
    expect(pickPool([p("a", 5n), p("b", 50n), p("c", 10n)]).poolId).toBe("b");
    expect(pickPool([p("a", 5n), p("b", 50n, { retiring: true })]).poolId).toBe("a");
    expect(pickPool([p("a", 5n), p("b", 50n, { saturation: 0.95 })]).poolId).toBe("a");
    expect(pickPool([p("a", 5n), p("b", 50n, { ticker: null })]).poolId).toBe("a");
    expect(pickPool([p("b", 50n, { ticker: null })]).poolId).toBe("b");
    expect(() => pickPool([p("a", 0n)])).toThrow(/STAKE_POOL_ID/);
  });
});

describe("read APIs (HTTP mapping)", () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  it("Blockfrost /accounts → registered/pool/drep/rewards; 404 → not registered", async () => {
    const urls: string[] = [];
    const bodies = [
      json({ stake_address: "stake_test1x", active: true, registered: true, pool_id: POOL, drep_id: "drep_always_abstain", withdrawable_amount: "42" }),
      json({ status_code: 404 }, 404),
    ];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return bodies.shift()!;
    }) as unknown as typeof fetch;
    const api = new BlockfrostStakingApi("preprodTEST", { retry: { fetchImpl, retries: 0 } });
    expect(await api.fetchAccount("stake_test1x")).toEqual({ stakeAddress: "stake_test1x", registered: true, poolId: POOL, drep: "always_abstain", rewardsLovelace: 42n, depositLovelace: null });
    expect((await api.fetchAccount("stake_test1y")).registered).toBe(false);
    expect(urls[0]).toBe("https://cardano-preprod.blockfrost.io/api/v0/accounts/stake_test1x");
    expect(() => new BlockfrostStakingApi("mainnetXYZ")).toThrow(/MAINNET/);
  });
  it("Koios /account_info + /pool_list mapping", async () => {
    const bodies = [
      json([{ stake_address: "stake_test1x", status: "registered", delegated_pool: POOL, delegated_drep: DREP, rewards_available: "7", deposit: "2000000" }]),
      json([{ pool_id_bech32: POOL, ticker: "BIG", active_stake: "900", pool_status: "registered" }]),
    ];
    const fetchImpl = (async () => bodies.shift()!) as unknown as typeof fetch;
    const api = new KoiosStakingApi({ retry: { fetchImpl, retries: 0 } });
    expect(await api.fetchAccount("stake_test1x")).toEqual({ stakeAddress: "stake_test1x", registered: true, poolId: POOL, drep: DREP, rewardsLovelace: 7n, depositLovelace: 2_000_000n });
    expect(await api.listPools()).toEqual([{ poolId: POOL, ticker: "BIG", activeStakeLovelace: 900n, saturation: null, retiring: false }]);
  });
});

describe("StakingService (fake provider)", () => {
  async function svc(opts: { defaultPoolId?: string } = {}) {
    const provider = new FakeProvider();
    const read = new FakeRead();
    const s = new StakingService({ provider, keys, queue: new TreasuryQueue(), read, ...opts });
    return { provider, read, s };
  }

  it("custodial setup: picks the default pool, registers + delegates + abstains, signed by payment + stake keys", async () => {
    const { provider, s } = await svc();
    provider.add(treasury.address, 30n * ADA);
    const r = await s.setupCustodial({ userId: "u-stake" });
    expect(r.poolId).toBe(POOL); // BIG has the most active stake
    expect(r.poolTicker).toBe("BIG");
    expect(r.drep).toBe("always_abstain");
    expect(r.certs).toEqual(["stake_registration", "stake_delegation", "vote_delegation"]);
    expect(r.depositDeltaLovelace).toBe(2_000_000n);
    expect(provider.submitted).toHaveLength(1);
    const w = witnesses(provider.submitted[0]!);
    expect(new Set(w.map((x) => x.keyHash))).toEqual(new Set([treasury.keyHash, treasury.stakeKeyHash]));
  });

  it("idempotent planning: registered + same pool → only the missing vote delegation; STAKE_POOL_ID honoured", async () => {
    const { read, s } = await svc({ defaultPoolId: POOL2 });
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL2, drep: null, rewardsLovelace: 0n, depositLovelace: null });
    const plan = await s.plan(treasury.stakeKeyHash);
    expect(plan.register).toBe(false);
    expect(plan.poolId).toBeUndefined();
    expect(plan.drep).toEqual(ALWAYS_ABSTAIN);
    expect(plan.poolTicker).toBe("SMALL");
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL2, drep: "always_abstain", rewardsLovelace: 0n, depositLovelace: null });
    const done = await s.plan(treasury.stakeKeyHash);
    expect(done.poolId ?? done.drep ?? done.register).toBe(false);
  });

  it("self-custody: builds an UNSIGNED setup tx from the wallet's UTxOs (nothing submitted)", async () => {
    const { provider, s } = await svc();
    const wallet = cst.serializeAddress({ pubKeyHash: "11".repeat(28), stakeCredentialHash: "22".repeat(28) }, 0);
    provider.add(wallet, 10n * ADA);
    const u = await s.buildSetupUnsigned({ address: wallet, stakeKeyHash: "22".repeat(28), drep: { kind: "drep", drepId: DREP } });
    expect(u.stakeAddress).toBe(rewardAddressOf("22".repeat(28)));
    expect(u.certs).toEqual(["stake_registration", "stake_delegation", "vote_delegation"]);
    expect(u.drep).toBe(DREP);
    expect(witnesses(u.unsignedTx)).toEqual([]);
    expect(provider.submitted).toHaveLength(0);
  });

  it("stop staking: refuses when unregistered; withdraws rewards + deregisters when vote-delegated", async () => {
    const { provider, read, s } = await svc();
    await expect(s.stopCustodial({ userId: "u-stake" })).rejects.toThrow(/not registered/);
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL, drep: null, rewardsLovelace: 9n, depositLovelace: null });
    await expect(s.stopCustodial({ userId: "u-stake" })).rejects.toThrow(/delegated its vote/);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL, drep: "always_abstain", rewardsLovelace: 9n, depositLovelace: null });
    provider.add(treasury.address, 5n * ADA);
    const r = await s.stopCustodial({ userId: "u-stake" });
    expect(r.certs).toEqual(["stake_deregistration"]);
    expect(r.withdrawalLovelace).toBe(9n);
    expect(withdrawalsOf(provider.submitted[0]!)).toEqual({ [ra]: 9n });
  });

  it("withdrawRewards: requires vote delegation and the exact balance", async () => {
    const { provider, read, s } = await svc();
    const ra = rewardAddressOf(treasury.stakeKeyHash);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL, drep: null, rewardsLovelace: 0n, depositLovelace: null });
    await expect(s.withdrawRewards({ userId: "u-stake" })).rejects.toThrow(/Conway/);
    read.accounts.set(ra, { stakeAddress: ra, registered: true, poolId: POOL, drep: "always_abstain", rewardsLovelace: 3n, depositLovelace: null });
    await expect(s.withdrawRewards({ userId: "u-stake", amountLovelace: 1n })).rejects.toThrow(/full reward balance/);
    provider.add(treasury.address, 5n * ADA);
    const r = await s.withdrawRewards({ userId: "u-stake" });
    expect(r.withdrawalLovelace).toBe(3n);
  });
});

describe("session addresses count toward the owner's stake", () => {
  it("native session script address carries the owner's stake credential", async () => {
    const captain = await keys.captain();
    const sk = await keys.session("s-stake", 4242);
    const s = buildSessionScript({ sessionKeyHash: sk.keyHash, captainKeyHash: captain.keyHash, ownerKeyHash: treasury.keyHash, ownerStakeKeyHash: treasury.stakeKeyHash, expirySlot: TIP_SLOT + 100 });
    expect(cst.resolveStakeKeyHash(s.address)).toBe(treasury.stakeKeyHash);
    expect(rewardAddressOf(cst.resolveStakeKeyHash(s.address))).toBe(rewardAddressOf(treasury.stakeKeyHash));
  });
});
