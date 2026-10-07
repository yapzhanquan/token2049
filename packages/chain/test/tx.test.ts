// TxService against a fake provider + Mesh offline builds (no network).
import { beforeAll, describe, expect, it } from "vitest";
import { KeyVault } from "../src/keys";
import { memoryStores, type SessionWalletInfo } from "../src/store";
import { MeshTxService, NotYetExpiredError, NothingToSweepError, SessionExpiredError, parseTx } from "../src/tx";
import { buildSessionScript } from "../src/script";
import { FakeProvider, metadataOf, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, witnesses } from "./helpers";
import { DEFAULT_PROTOCOL_PARAMETERS } from "../src/mesh";

const ADA = 1_000_000n;

async function setup() {
  const provider = new FakeProvider();
  const sessions = new Map<string, SessionWalletInfo>();
  const stores = memoryStores((id) => sessions.get(id) ?? null);
  const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
  const unit = await tx.tusdUnitAsync();
  const treasury = await keys.treasury("user1", 1);
  const captain = await keys.captain();
  const op = await keys.operator();
  async function newSession(id: string, keyIndex: number, expirySlot: number, tusd: bigint, lovelace = 5n * ADA) {
    const sk = await keys.session(id, keyIndex);
    const s = buildSessionScript({
      sessionKeyHash: sk.keyHash,
      captainKeyHash: captain.keyHash,
      ownerKeyHash: treasury.keyHash,
      ownerStakeKeyHash: treasury.stakeKeyHash,
      expirySlot,
    });
    sessions.set(id, { sessionId: id, userId: "user1", address: s.address, scriptCbor: s.scriptCbor, expirySlot });
    provider.add(s.address, lovelace, { [unit]: tusd });
    return { ...s, sessionKeyHash: sk.keyHash };
  }
  return { provider, keys, tx, unit, treasury, captain, op, newSession };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});

describe("fundSessions / previewFunding", () => {
  it("one tx, many outputs: exact tUSD + min-ADA from protocol params (+extra), signed by the treasury key", async () => {
    const { provider, tx, unit, treasury } = env;
    provider.add(treasury.address, 100n * ADA, { [unit]: 50_000_000n });
    const outs = [
      { address: (await env.newSession("f1", 101, TIP_SLOT + 3600, 0n, 0n)).address, tusdMicro: 5_000_000n },
      { address: (await env.newSession("f2", 102, TIP_SLOT + 3600, 0n, 0n)).address, tusdMicro: 7_000_000n, extraLovelace: 2n * ADA },
      { address: (await env.newSession("f3", 103, TIP_SLOT + 3600, 0n, 0n)).address, tusdMicro: 1_500_000n },
    ];
    const preview = await tx.previewFunding({ userId: "user1", outputs: outs });
    expect(provider.submitted).toHaveLength(0);
    expect(preview.totalTusdMicro).toBe(13_500_000n);

    const r = await tx.fundSessions({ userId: "user1", outputs: outs, metadata: { msg: ["bulkhead funding"] } });
    expect(provider.submitted).toHaveLength(1);
    const p = parseTx(r.cborHex);
    expect(p.txHash).toBe(r.txHash);
    expect(r.feeLovelace).toBe(p.fee);
    expect(r.feeLovelace).toBeGreaterThan(150_000n);
    for (const o of outs) {
      const out = p.outputs.find((x) => x.address === o.address)!;
      expect(out.amount.find((a) => a.unit === unit)!.quantity).toBe(o.tusdMicro.toString());
      const lovelace = BigInt(out.amount.find((a) => a.unit === "lovelace")!.quantity);
      // min-ADA = (160 + size) * coinsPerUtxoSize — strictly positive, and extra on top for f2
      expect(lovelace).toBeGreaterThan(BigInt(DEFAULT_PROTOCOL_PARAMETERS.coinsPerUtxoSize) * 160n);
      if (o.extraLovelace) expect(lovelace).toBeGreaterThan(2n * ADA + 900_000n);
    }
    // change back to the treasury
    expect(p.outputs.some((x) => x.address === treasury.address)).toBe(true);
    expect(p.ttl).toBe(TIP_SLOT + 900);
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: treasury.keyHash, valid: true }]);
    expect(metadataOf(r.cborHex)["674"]).toEqual({ msg: ["bulkhead funding"] });
  });

  it("refuses non-preprod addresses", async () => {
    await expect(
      env.tx.fundSessions({ userId: "user1", outputs: [{ address: "addr1qxyz", tusdMicro: 1n }] }),
    ).rejects.toThrow(/preprod/);
  });
});

describe("sessionPay", () => {
  it("spends the native-script input with the session key, TTL ≤ expiry, CIP-20 reference + memo", async () => {
    const { provider, tx, unit } = env;
    const expiry = TIP_SLOT + 600;
    const s = await env.newSession("p1", 201, expiry, 10_000_000n, 5n * ADA);
    const payee = env.treasury.address; // any preprod address
    const ref = "bhm-" + "ab".repeat(12);
    const r = await tx.sessionPay({ sessionId: "p1", payee, tusdMicro: 3_000_000n, memo: "market-research job", reference: ref });
    const p = parseTx(r.cborHex);
    expect(p.ttl).toBeLessThanOrEqual(expiry);
    expect(p.ttl).toBe(expiry); // min(expiry, tip + 900)
    expect(p.validityStart).toBeUndefined();
    const toPayee = p.outputs.find((o) => o.address === payee)!;
    expect(toPayee.amount.find((a) => a.unit === unit)!.quantity).toBe("3000000");
    const change = p.outputs.find((o) => o.address === s.address)!;
    expect(change.amount.find((a) => a.unit === unit)!.quantity).toBe("7000000");
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: s.sessionKeyHash, valid: true }]);
    expect(metadataOf(r.cborHex)["674"]).toEqual({ msg: [ref, "market-research job"] });
    // native script witness is included
    expect(provider.submitted.at(-1)).toContain(s.scriptCbor);
  });

  it("chains a second payment on the in-flight change (no input reuse)", async () => {
    const r1 = await env.tx.sessionPay({ sessionId: "p1", payee: env.treasury.address, tusdMicro: 1_000_000n, memo: "second" });
    const all = env.provider.submitted.map(parseTx).filter((p) => p.outputs.some((o) => o.address === env.treasury.address));
    const ins = all.flatMap((p) => p.inputs.map((i) => `${i.txHash}#${i.outputIndex}`));
    expect(new Set(ins).size).toBe(ins.length);
    // the only spendable input is the in-flight change of the first payment
    const first = all.at(-2)!;
    expect(parseTx(r1.cborHex).inputs.map((i) => i.txHash)).toEqual([first.txHash]);
  });

  it("refuses once the tip reached expiry", async () => {
    await env.newSession("p2", 202, TIP_SLOT, 1_000_000n);
    await expect(env.tx.sessionPay({ sessionId: "p2", payee: env.treasury.address, tusdMicro: 1n, memo: "" })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe("sweep", () => {
  const meta = { session_id: "s-sweep", log_sha256: "a".repeat(64), handback_sha256: "b".repeat(64), status: "CLOSED" };

  it("captain path: ALL session UTxOs → owner, metadata 674, captain witness, no validity start", async () => {
    const { provider, tx, unit } = env;
    const s = await env.newSession("w1", 301, TIP_SLOT + 10_000, 4_000_000n);
    provider.add(s.address, 3n * ADA, { [unit]: 1_000_000n }); // second UTxO
    const r = await tx.sweep({ sessionId: "w1", signer: "captain", toAddress: env.treasury.address, metadata674: meta });
    const p = parseTx(r.cborHex);
    expect(p.inputs).toHaveLength(2);
    expect(p.outputs).toHaveLength(1);
    expect(p.outputs[0]!.address).toBe(env.treasury.address);
    expect(p.outputs[0]!.amount.find((a) => a.unit === unit)!.quantity).toBe("5000000");
    expect(BigInt(p.outputs[0]!.amount.find((a) => a.unit === "lovelace")!.quantity) + p.fee).toBe(8n * ADA);
    expect(p.validityStart).toBeUndefined();
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: env.captain.keyHash, valid: true }]);
    expect(metadataOf(r.cborHex)["674"]).toEqual({ msg: ["Bulkhead session close"], ...meta });
  });

  it("owner path fails clearly before expiry, works after with invalidBefore = expirySlot", async () => {
    const { provider, tx } = env;
    const expiry = TIP_SLOT + 50;
    await env.newSession("w2", 302, expiry, 2_000_000n);
    await expect(tx.sweep({ sessionId: "w2", signer: "owner", toAddress: env.treasury.address, metadata674: meta })).rejects.toBeInstanceOf(
      NotYetExpiredError,
    );
    provider.tipSlot = expiry + 1;
    try {
      const r = await tx.sweep({ sessionId: "w2", signer: "owner", toAddress: env.treasury.address, metadata674: meta });
      const p = parseTx(r.cborHex);
      expect(p.validityStart).toBe(expiry);
      expect(witnesses(r.cborHex)).toEqual([{ keyHash: env.treasury.keyHash, valid: true }]);
    } finally {
      provider.tipSlot = TIP_SLOT;
    }
  });

  it("empty session wallet → NothingToSweepError", async () => {
    const s = await env.newSession("w3", 303, TIP_SLOT + 100, 0n, 0n);
    env.provider.utxos.set(s.address, []);
    await expect(env.tx.sweep({ sessionId: "w3", signer: "captain", toAddress: env.treasury.address, metadata674: meta })).rejects.toBeInstanceOf(
      NothingToSweepError,
    );
  });

  it("rejects metadata strings over 64 bytes", async () => {
    await expect(
      env.tx.sweep({ sessionId: "w1", signer: "captain", toAddress: env.treasury.address, metadata674: { ...meta, status: "x".repeat(65) } }),
    ).rejects.toThrow(/64 bytes/);
  });
});

describe("operator: mintTusd / operatorSend", () => {
  it("mintTusd mints under sig(operator) policy with 6-decimal micro units", async () => {
    const { provider, tx, op, unit } = env;
    provider.add(op.address, 50n * ADA);
    const r = await tx.mintTusd({ tusdMicro: 1_000_000_000_000n });
    const p = parseTx(r.cborHex);
    const out = p.outputs.find((o) => o.address === op.address)!;
    expect(out.amount.find((a) => a.unit === unit)!.quantity).toBe("1000000000000");
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: op.keyHash, valid: true }]);
  });

  it("operatorSend sends tUSD + ADA with a 674 reference, minting the shortfall", async () => {
    const { tx, unit } = env;
    const r = await tx.operatorSend({ toAddress: env.treasury.address, tusdMicro: 10_000_000n, lovelace: 2n * ADA, reference: "topup-123" });
    const p = parseTx(r.cborHex);
    const out = p.outputs.find((o) => o.address === env.treasury.address)!;
    expect(out.amount.find((a) => a.unit === unit)!.quantity).toBe("10000000");
    expect(out.amount.find((a) => a.unit === "lovelace")!.quantity).toBe("2000000");
    expect(metadataOf(r.cborHex)["674"]).toEqual({ msg: ["Bulkhead top-up (testnet simulation)", "topup-123"] });
    // the operator still has the in-flight 1,000,000 tUSD from the mint tx → chained, no new mint
    expect(cstMintOf(r.cborHex)).toBe(0n);
    expect(parseTx(r.cborHex).inputs.map((i) => i.txHash)).toContain(parseTx(env.provider.submitted.at(-2)!).txHash);
  });

  it("operatorSend mints the shortfall in the same tx when the operator lacks tUSD", async () => {
    const fresh = await setup();
    fresh.provider.add(fresh.op.address, 20n * ADA);
    const r = await fresh.tx.operatorSend({ toAddress: fresh.treasury.address, tusdMicro: 10_000_000n, lovelace: 2n * ADA, reference: "topup-9" });
    expect(cstMintOf(r.cborHex)).toBe(10_000_000n);
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: fresh.op.keyHash, valid: true }]);
  });

  it("balanceOf sums lovelace and tUSD", async () => {
    const b = await env.tx.balanceOf(env.treasury.address);
    expect(b.tusdMicro).toBe(50_000_000n);
    expect(b.utxoCount).toBe(1);
  });
});

import { cst } from "../src/mesh";
function cstMintOf(hex: string): bigint {
  const mint = cst.deserializeTx(hex).body().mint();
  if (!mint) return 0n;
  let s = 0n;
  for (const [, q] of mint) s += BigInt(q);
  return s;
}
