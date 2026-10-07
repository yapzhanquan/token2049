// Self-custody Session Vault (CIP-30 signTx) — offline: FakeProvider + Mesh offline builds + the real UPLC
// (OfflineEvaluatorScalus). An in-memory throwaway "browser wallet" (random payment + stake key, base address)
// signs like CIP-30 signTx(tx, true) → witness set. Path: unsigned vault funding from the wallet's UTxOs →
// wallet witness → submitSigned → Pay (session key) → Revoke (captain) back to the wallet address.
import { beforeAll, describe, expect, it } from "vitest";
import { cst, ensureCryptoReady } from "../src/mesh";
import { KeyVault } from "../src/keys";
import { memoryStores, type SessionWalletInfo } from "../src/store";
import { MeshTxService, parseTx } from "../src/tx";
import { timeFromSlot } from "../src/index";
import { applyVaultParams, createThrowawayWallet, vaultParamsToJson, type ThrowawayWallet, type VaultParams } from "../src/vault";
import type { Utxo } from "../src/types";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, metadataOf, witnesses } from "./helpers";

const ADA = 1_000_000n;
const PAYEE = cst.serializeAddress({ pubKeyHash: "15".repeat(28), stakeCredentialHash: "25".repeat(28) }, 0);
const EXPIRY = timeFromSlot(TIP_SLOT + 3600) + 400;

async function setup() {
  await ensureCryptoReady();
  const provider = new FakeProvider();
  const sessions = new Map<string, SessionWalletInfo>();
  const stores = memoryStores((id) => sessions.get(id) ?? null);
  const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
  const unit = await tx.tusdUnitAsync();
  const captain = await keys.captain();
  provider.add(captain.address, 10n * ADA); // collateral
  const wallet: ThrowawayWallet = await createThrowawayWallet();
  provider.add(wallet.address, 40n * ADA, { [unit]: 25_000_000n });
  provider.add(wallet.address, 8n * ADA);
  async function newVault(id: string, keyIndex: number) {
    const sk = await keys.session(id, keyIndex);
    const p: VaultParams = {
      ownerAddress: wallet.address, // the wallet's FULL address (payment + stake credential)
      captainKeyHash: captain.keyHash,
      sessionKeyHash: sk.keyHash,
      expiryMs: EXPIRY,
      payees: [PAYEE],
      perTxMaxTusdMicro: 5_000_000n,
      adaAllowanceLovelace: 3_000_000n,
      tusdPolicyId: unit.slice(0, 56),
      tusdAssetNameHex: unit.slice(56),
    };
    const v = applyVaultParams(p);
    sessions.set(id, { sessionId: id, userId: "self1", address: v.address, scriptCbor: v.scriptCbor, expirySlot: TIP_SLOT + 3600, walletMode: "vault", scriptJson: JSON.stringify(vaultParamsToJson(p)), scriptHash: v.scriptHash });
    return { v, sessionKeyHash: sk.keyHash };
  }
  return { provider, keys, tx, unit, captain, wallet, newVault };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});

/** Apply a submitted tx to the FakeProvider's UTxO set (spent inputs removed, outputs added). */
function settle(provider: FakeProvider, signedHex: string) {
  const p = parseTx(signedHex);
  const spent = new Set(p.inputs.map((i) => `${i.txHash}#${i.outputIndex}`));
  for (const [a, list] of provider.utxos) provider.utxos.set(a, list.filter((u) => !spent.has(`${u.txHash}#${u.outputIndex}`)));
  for (const o of p.outputs) provider.utxos.set(o.address, [...(provider.utxos.get(o.address) ?? []), o as Utxo]);
}

describe("self-custody Session Vault: unsigned funding → CIP-30 witness → submitSigned → Pay → Revoke to the wallet", () => {
  it("the throwaway wallet has a base address (payment + stake) and signs like CIP-30 (witness set only)", () => {
    const d = cst.deserializeBech32Address(env.wallet.address);
    expect(d.pubKeyHash).toBe(env.wallet.paymentKeyHash);
    expect(d.stakeCredentialHash).toBe(env.wallet.stakeKeyHash);
  });

  it("vault addresses owned by the wallet carry the wallet's stake credential", async () => {
    const { v } = await env.newVault("sv0", 400);
    const d = cst.deserializeBech32Address(v.address);
    expect(d.scriptHash).toBe(v.scriptHash);
    expect(d.stakeCredentialHash).toBe(env.wallet.stakeKeyHash);
  });

  it("full path, ONE funding tx for all sessions of a plan", async () => {
    const { provider, tx, unit, captain, wallet, newVault } = env;
    const a = await newVault("sv1", 401);
    const b = await newVault("sv2", 402);
    const outs = [
      { address: a.v.address, tusdMicro: 10_000_000n, extraLovelace: 3n * ADA },
      { address: b.v.address, tusdMicro: 4_000_000n, extraLovelace: 3n * ADA },
    ];
    const u = await tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: outs, metadata: { 674: { msg: ["bulkhead: fund session vaults"] } } });
    // Unsigned, nothing submitted, inputs only from the wallet, change back to the wallet.
    expect(witnesses(u.unsignedTx)).toEqual([]);
    expect(provider.submitted).toHaveLength(0);
    const parsed = parseTx(u.unsignedTx);
    const walletRefs = new Set((provider.utxos.get(wallet.address) ?? []).map((x) => `${x.txHash}#${x.outputIndex}`));
    expect(parsed.inputs.every((i) => walletRefs.has(`${i.txHash}#${i.outputIndex}`))).toBe(true);
    expect(parsed.outputs.some((o) => o.address === wallet.address)).toBe(true);
    expect(u.totalTusdMicro).toBe(14_000_000n);
    expect(u.ttlSlot).toBe(TIP_SLOT + 900);
    expect(metadataOf(u.unsignedTx)["674"]).toEqual({ msg: ["bulkhead: fund session vaults"] });
    const body = cst.deserializeTx(u.unsignedTx).body();
    for (const o of outs) {
      const out = body.outputs().find((x) => x.address().toBech32().toString() === o.address)!;
      expect(out.datum()?.asInlineData()?.toCbor()).toBe("d87980"); // inline datum Void
      expect(cst.fromValue(out.amount()).filter((x) => x.unit !== "lovelace")).toEqual([{ unit, quantity: o.tusdMicro.toString() }]); // exactly the budget
      const lov = BigInt(out.amount().coin());
      expect(lov).toBeGreaterThan(o.extraLovelace + 900_000n); // min-ADA + ada_allowance headroom
      expect(lov).toBeLessThan(o.extraLovelace + 2n * ADA);
    }

    // The browser wallet signs (CIP-30 signTx(tx, true) → witness set); the engine attaches + verifies + submits.
    const ws = wallet.signTx(u.unsignedTx);
    const r = await tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: ws, requiredKeyHash: wallet.paymentKeyHash });
    expect(r.txHash).toBe(u.txHash);
    expect(provider.submitted).toHaveLength(1);
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: wallet.paymentKeyHash, valid: true }]);
    tx.queue.release(r.txHash);
    settle(provider, r.cborHex);
    // The on-chain vault UTxOs need the inline datum the offline evaluator assumes (d87980): proven above.

    // Pay from vault A: session key signs, captain provides collateral; the script runs (offline UPLC).
    const pay = await tx.vaultPay({ sessionId: "sv1", payee: PAYEE, tusdMicro: 3_000_000n, memo: "self-custody vault pay" });
    expect(witnesses(pay.cborHex).map((w) => w.keyHash).sort()).toEqual([a.sessionKeyHash, captain.keyHash].sort());
    const pp = parseTx(pay.cborHex);
    expect(pp.outputs.find((o) => o.address === PAYEE)?.amount.find((x) => x.unit === unit)?.quantity).toBe("3000000");
    expect(pp.outputs.find((o) => o.address === a.v.address)?.amount.find((x) => x.unit === unit)?.quantity).toBe("7000000");
    expect(pay.exUnits[0]!.mem).toBeGreaterThan(0);
    tx.queue.release(pay.txHash);
    settle(provider, pay.cborHex);

    // Revoke A: captain signs; everything goes back to the WALLET address (the vault owner).
    const meta = { session_id: "sv1", log_sha256: "aa".repeat(32), handback_sha256: "bb".repeat(32), status: "CLOSED" };
    const rv = await tx.vaultRevoke({ sessionId: "sv1", toAddress: wallet.address, metadata674: meta });
    const pr = parseTx(rv.cborHex);
    expect(pr.outputs.map((o) => o.address)).toEqual([wallet.address]);
    expect(pr.outputs[0]!.amount.find((x) => x.unit === unit)?.quantity).toBe("7000000");
    expect(witnesses(rv.cborHex).map((w) => w.keyHash)).toEqual([captain.keyHash]);
    // Revoke to anyone else is refused before building (and the script would reject it).
    await expect(tx.vaultRevoke({ sessionId: "sv2", toAddress: PAYEE, metadata674: { ...meta, session_id: "sv2" } })).rejects.toThrow(/owner address/);
  });

  it("refuses a vault output that is not owned by the wallet (other stake credential) or not a script address", async () => {
    const { tx, wallet, keys, captain, unit } = env;
    const other = await createThrowawayWallet();
    const sk = await keys.session("sv-other", 410);
    const foreign = applyVaultParams({
      ownerAddress: other.address,
      captainKeyHash: captain.keyHash,
      sessionKeyHash: sk.keyHash,
      expiryMs: EXPIRY,
      payees: [PAYEE],
      perTxMaxTusdMicro: 5_000_000n,
      adaAllowanceLovelace: 3_000_000n,
      tusdPolicyId: unit.slice(0, 56),
      tusdAssetNameHex: unit.slice(56),
    });
    await expect(tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: foreign.address, tusdMicro: 1_000_000n }] })).rejects.toThrow(/stake credential/);
    await expect(tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: PAYEE, tusdMicro: 1_000_000n }] })).rejects.toThrow(/not a script/);
    await expect(tx.buildUnsignedVaultFunding({ fromAddress: "addr1qxyz", outputs: [] })).rejects.toThrow(/preprod/);
  });

  it("a witness from another key is refused (requiredKeyHash = the wallet's payment key)", async () => {
    const { tx, wallet, newVault } = env;
    const c = await newVault("sv3", 403);
    const u = await tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: c.v.address, tusdMicro: 1_000_000n, extraLovelace: 3n * ADA }] });
    const intruder = await createThrowawayWallet();
    await expect(tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: intruder.signTx(u.unsignedTx), requiredKeyHash: wallet.paymentKeyHash })).rejects.toThrow(/not signed by the wallet/);
  });
});
