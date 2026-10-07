// Self-custody (CIP-30) funding: build unsigned from a wallet address's UTxOs, the "browser wallet"
// signs (witness set OR full tx), the engine attaches + verifies + submits through TreasuryQueue.
// Offline: FakeProvider + Mesh offline builds. A KeyVault-derived key stands in for the browser wallet.
import { beforeAll, describe, expect, it } from "vitest";
import { KeyVault } from "../src/keys";
import { memoryStores } from "../src/store";
import { MeshTxService, addressKeyHashes, attachSignature, parseTx } from "../src/tx";
import { cst } from "../src/mesh";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, metadataOf, witnesses } from "./helpers";

const ADA = 1_000_000n;

async function setup() {
  const provider = new FakeProvider();
  const stores = memoryStores(() => null);
  const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
  const unit = await tx.tusdUnitAsync();
  // "Browser wallet": a key the engine would never hold for a self-custody user (used here only to sign).
  const wallet = await keys.treasury("wallet-user", 7);
  const other = await keys.treasury("someone-else", 8);
  const dest1 = (await keys.treasury("dest1", 9)).address;
  const dest2 = (await keys.treasury("dest2", 10)).address;
  provider.add(wallet.address, 60n * ADA, { [unit]: 30_000_000n });
  return { provider, keys, tx, unit, wallet, other, dest1, dest2 };
}

/** What CIP-30 signTx(tx, true) returns: only the witness set. */
async function walletWitnessSet(keys: KeyVault, keyId: string, unsignedTx: string): Promise<string> {
  const full = await keys.signTx(keyId, unsignedTx);
  return cst.deserializeTx(full).witnessSet().toCbor();
}

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});

describe("addressKeyHashes", () => {
  it("returns the payment + stake key hashes of a base address", () => {
    const h = addressKeyHashes(env.wallet.address);
    expect(h.paymentKeyHash).toBe(env.wallet.keyHash);
    expect(h.stakeKeyHash).toBe(env.wallet.stakeKeyHash);
  });
  it("refuses mainnet addresses", () => {
    expect(() => addressKeyHashes("addr1qxyz")).toThrow(/preprod/);
  });
});

describe("buildUnsignedFunding → submitSigned", () => {
  it("builds unsigned from the wallet's UTxOs, nothing submitted or signed", async () => {
    const { tx, provider, wallet, dest1, dest2, unit } = env;
    const u = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest1, tusdMicro: 5_000_000n }, { address: dest2, tusdMicro: 2_500_000n }], metadata: { 674: { msg: ["bulkhead: fund sessions"] } } });
    expect(provider.submitted).toHaveLength(0);
    expect(witnesses(u.unsignedTx)).toEqual([]);
    const p = parseTx(u.unsignedTx);
    expect(p.txHash).toBe(u.txHash);
    expect(p.inputs.length).toBeGreaterThan(0);
    expect(p.outputs.find((o) => o.address === dest1)!.amount.find((a) => a.unit === unit)!.quantity).toBe("5000000");
    expect(p.outputs.some((o) => o.address === wallet.address)).toBe(true); // change back to the wallet
    expect(u.totalTusdMicro).toBe(7_500_000n);
    expect(u.feeLovelace).toBe(p.fee);
    expect(u.ttlSlot).toBe(TIP_SLOT + 900);
    expect(metadataOf(u.unsignedTx)["674"]).toEqual({ msg: ["bulkhead: fund sessions"] });
  });

  it("accepts a CIP-30 witness set: attaches, verifies, submits, reserves inputs", async () => {
    const { tx, provider, keys, wallet, dest1 } = env;
    const u = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest1, tusdMicro: 1_000_000n }] });
    const ws = await walletWitnessSet(keys, wallet.keyId, u.unsignedTx);
    const before = provider.submitted.length;
    const r = await tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: ws, requiredKeyHash: wallet.keyHash });
    expect(r.txHash).toBe(u.txHash);
    expect(provider.submitted).toHaveLength(before + 1);
    expect(witnesses(provider.submitted.at(-1)!)).toEqual([{ keyHash: wallet.keyHash, valid: true }]);
    expect(tx.queue.pending(wallet.address)).toContain(u.txHash);

    // The same inputs cannot be submitted twice (reserved in TreasuryQueue).
    await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: ws })).rejects.toThrow(/already spent or reserved/);
    tx.queue.release(u.txHash);
  });

  it("accepts a full signed tx with the same body", async () => {
    const { tx, keys, wallet, dest2 } = env;
    const u = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest2, tusdMicro: 1_000_000n }] });
    const full = await keys.signTx(wallet.keyId, u.unsignedTx);
    const r = await tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: full, requiredKeyHash: wallet.keyHash });
    expect(r.txHash).toBe(u.txHash);
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: wallet.keyHash, valid: true }]);
    tx.queue.release(u.txHash);
  });

  it("rejects a tx whose body differs, a wrong signer, and garbage", async () => {
    const { tx, keys, wallet, other, dest1, dest2 } = env;
    const u = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest1, tusdMicro: 1_000_000n }] });
    const u2 = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest2, tusdMicro: 9_000_000n }] });
    const tampered = await keys.signTx(wallet.keyId, u2.unsignedTx);
    expect(() => attachSignature(u.unsignedTx, tampered)).toThrow(/different body/);
    const wrong = await walletWitnessSet(keys, other.keyId, u.unsignedTx);
    await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: wrong, requiredKeyHash: wallet.keyHash })).rejects.toThrow(/not signed by the wallet/);
    await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: "zz" })).rejects.toThrow(/CBOR hex/);
    await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: "a0" })).rejects.toThrow(/no vkey witness/);
  });

  it("rejects a signed tx whose TTL has passed", async () => {
    const { tx, keys, wallet, dest1, provider } = env;
    const u = await tx.buildUnsignedFunding({ fromAddress: wallet.address, outputs: [{ address: dest1, tusdMicro: 1_000_000n }] });
    const ws = await walletWitnessSet(keys, wallet.keyId, u.unsignedTx);
    provider.tipSlot = TIP_SLOT + 10_000;
    try {
      await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: ws })).rejects.toThrow(/expired/);
    } finally {
      provider.tipSlot = TIP_SLOT;
    }
  });
});
