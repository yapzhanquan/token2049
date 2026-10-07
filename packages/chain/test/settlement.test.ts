// Settlement asset (default tUSDM, tUSD fallback): one source of truth from env → MeshTxService.tusdUnit() →
// balances, funding outputs, vault params (tusd_policy / tusd_name), Pay / Revoke and operator top-ups.
// The Session Vault is the SAME unapplied validator for both assets (parameterised; no contract change):
// the Pay below runs the real UPLC through Mesh's offline evaluator (FakeProvider has no evaluateTx).
import { beforeAll, describe, expect, it } from "vitest";
import { settlementAssetFromEnv, TUSDM_PREPROD } from "@bulkhead/shared";
import { cst } from "../src/mesh";
import { KeyVault } from "../src/keys";
import { memoryStores, type SessionWalletInfo } from "../src/store";
import { MeshTxService, parseTx } from "../src/tx";
import { assetFingerprint } from "../src/cip68";
import { createChain, settlementAsset, timeFromSlot } from "../src/index";
import { applyVaultParams, unappliedVaultHash, UNAPPLIED_VAULT_HASH, vaultParamsToJson, type VaultParams } from "../src/vault";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, witnesses } from "./helpers";

const ADA = 1_000_000n;
const addr = (pkh: string, skh?: string) => cst.serializeAddress(skh ? { pubKeyHash: pkh, stakeCredentialHash: skh } : { pubKeyHash: pkh }, 0);
const PAYEE = addr("15".repeat(28), "25".repeat(28));
const EXPIRY = timeFromSlot(TIP_SLOT + 3600) + 400;

describe("settlement asset resolution", () => {
  it("tUSDM constant matches the Blockfrost-verified unit, CIP-68 (333) name and CIP-14 fingerprint", () => {
    expect(TUSDM_PREPROD.unit).toBe(TUSDM_PREPROD.policyId + TUSDM_PREPROD.assetNameHex);
    expect(TUSDM_PREPROD.assetNameHex).toBe("0014df10" + Buffer.from("tUSDM").toString("hex"));
    expect(assetFingerprint(TUSDM_PREPROD.policyId, TUSDM_PREPROD.assetNameHex)).toBe(TUSDM_PREPROD.fingerprint);
    expect(TUSDM_PREPROD.decimals).toBe(6);
  });

  it("defaults to tUSDM; SETTLEMENT_ASSET=tusd falls back to the operator tUSD; SETTLEMENT_UNIT overrides", async () => {
    expect((await settlementAsset({})).unit).toBe(TUSDM_PREPROD.unit);
    // TUSD_UNIT alone does not switch the settlement asset.
    const tusd = "aa".repeat(28) + "0014df1074555344";
    expect((await settlementAsset({ TUSD_UNIT: tusd })).kind).toBe("tusdm");
    const fb = await settlementAsset({ SETTLEMENT_ASSET: "tusd", TUSD_UNIT: tusd });
    expect(fb).toMatchObject({ kind: "tusd", ticker: "tUSD", unit: tusd, operatorMintable: true });
    // a legacy (pre-CIP-68) TUSD_UNIT is upgraded
    expect((await settlementAsset({ SETTLEMENT_ASSET: "tusd", TUSD_UNIT: "aa".repeat(28) + "74555344" })).unit).toBe(tusd);
    const op = await settlementAsset({ SETTLEMENT_ASSET: "tusd", OPERATOR_MNEMONIC: TEST_MNEMONIC });
    expect(op.unit).toMatch(/^[0-9a-f]{56}0014df1074555344$/);
    expect(settlementAssetFromEnv({ SETTLEMENT_UNIT: "bb".repeat(28) + "01", SETTLEMENT_TICKER: "X" })).toMatchObject({ kind: "custom", ticker: "X", operatorMintable: false });
    expect(() => settlementAssetFromEnv({ SETTLEMENT_ASSET: "usdc" })).toThrow(/SETTLEMENT_ASSET/);
    await expect(settlementAsset({ SETTLEMENT_ASSET: "tusd" })).rejects.toThrow(/tUSD unit/);
  });

  it("createChain wires the settlement unit into tx.tusdUnit() (default tUSDM, tusd fallback)", async () => {
    const mk = (extra: Record<string, string>) =>
      createChain({ env: { MASTER_SECRET: TEST_MASTER, OPERATOR_MNEMONIC: TEST_MNEMONIC, ...extra }, provider: new FakeProvider(), mainnetProvider: null, stores: memoryStores(() => null), handles: null });
    const a = await mk({});
    expect(a.tx.tusdUnit()).toBe(TUSDM_PREPROD.unit);
    expect(a.settlement.ticker).toBe("tUSDM");
    const b = await mk({ SETTLEMENT_ASSET: "tusd" });
    expect(b.tx.tusdUnit()).toBe(await b.tx.operatorTusdUnitAsync());
    expect(b.settlement.ticker).toBe("tUSD");
    await a.watcher.stop();
    await b.watcher.stop();
  });

  it("the same unapplied validator, parameterised with tUSDM, applies to a distinct script / address", () => {
    expect(unappliedVaultHash()).toBe(UNAPPLIED_VAULT_HASH);
    const base: VaultParams = {
      ownerAddress: addr("11".repeat(28), "12".repeat(28)),
      captainKeyHash: "13".repeat(28),
      sessionKeyHash: "14".repeat(28),
      expiryMs: EXPIRY,
      payees: [PAYEE],
      perTxMaxTusdMicro: 5_000_000n,
      adaAllowanceLovelace: 3_000_000n,
      tusdPolicyId: TUSDM_PREPROD.policyId,
      tusdAssetNameHex: TUSDM_PREPROD.assetNameHex,
    };
    const m = applyVaultParams(base);
    const t = applyVaultParams({ ...base, tusdPolicyId: "aa".repeat(28), tusdAssetNameHex: "0014df1074555344" });
    expect(m.scriptHash).toMatch(/^[0-9a-f]{56}$/);
    expect(m.scriptHash).not.toBe(t.scriptHash);
    expect(m.address.startsWith("addr_test1z")).toBe(true);
  });
});

for (const kind of ["tusdm", "tusd"] as const) {
  describe(`TxService with settlement = ${kind} (offline build + offline UPLC evaluation)`, () => {
    async function setup() {
      const provider = new FakeProvider();
      const sessions = new Map<string, SessionWalletInfo>();
      const stores = memoryStores((id) => sessions.get(id) ?? null);
      const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
      const tx = new MeshTxService({ provider, keys, sessions: stores.sessions, settlementUnit: kind === "tusdm" ? TUSDM_PREPROD.unit : null });
      const unit = await tx.tusdUnitAsync();
      const treasury = await keys.treasury("su1", 3);
      const captain = await keys.captain();
      const operator = await keys.operator();
      provider.add(captain.address, 10n * ADA);
      async function newVault(id: string, keyIndex: number) {
        const sk = await keys.session(id, keyIndex);
        const p: VaultParams = {
          ownerAddress: treasury.address,
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
        sessions.set(id, {
          sessionId: id,
          userId: "su1",
          address: v.address,
          scriptCbor: v.scriptCbor,
          expirySlot: Math.floor((EXPIRY - timeFromSlot(0)) / 1000),
          walletMode: "vault",
          scriptJson: JSON.stringify(vaultParamsToJson(p)),
          scriptHash: v.scriptHash,
        });
        return { v, sessionKeyHash: sk.keyHash };
      }
      return { provider, tx, unit, treasury, captain, operator, newVault };
    }
    let env: Awaited<ReturnType<typeof setup>>;
    beforeAll(async () => {
      env = await setup();
    });

    it("tusdUnit() is the configured asset", async () => {
      if (kind === "tusdm") expect(env.unit).toBe(TUSDM_PREPROD.unit);
      else expect(env.unit).toBe(await env.tx.operatorTusdUnitAsync());
    });

    it("balanceOf counts only the settlement unit", async () => {
      const { provider, tx, unit } = env;
      const a = addr("31".repeat(28));
      const other = kind === "tusdm" ? await tx.operatorTusdUnitAsync() : TUSDM_PREPROD.unit;
      provider.add(a, 5n * ADA, { [unit]: 7_000_000n, [other]: 9_000_000n });
      expect((await tx.balanceOf(a)).tusdMicro).toBe(7_000_000n);
    });

    it("vaultFund → vaultPay → vaultRevoke move the settlement unit", async () => {
      const { provider, tx, unit, treasury, captain, newVault } = env;
      provider.add(treasury.address, 100n * ADA, { [unit]: 20_000_000n });
      const { v, sessionKeyHash } = await newVault(`s-${kind}`, 401);
      const fund = await tx.vaultFund({ userId: "su1", outputs: [{ address: v.address, tusdMicro: 6_000_000n, extraLovelace: 6n * ADA }] });
      const out = parseTx(fund.cborHex).outputs.find((o) => o.address === v.address)!;
      expect(out.amount.find((a) => a.unit === unit)?.quantity).toBe("6000000");
      // make the vault UTxO "confirmed" for the next builds
      provider.utxos.set(v.address, [{ ...out }]);

      const pay = await tx.vaultPay({ sessionId: `s-${kind}`, payee: PAYEE, tusdMicro: 2_000_000n, memo: "settlement test" });
      const pp = parseTx(pay.cborHex);
      expect(pp.outputs.find((o) => o.address === PAYEE)?.amount.find((a) => a.unit === unit)?.quantity).toBe("2000000");
      expect(pp.outputs.find((o) => o.address === v.address)?.amount.find((a) => a.unit === unit)?.quantity).toBe("4000000");
      expect(witnesses(pay.cborHex).map((w) => w.keyHash).sort()).toEqual([sessionKeyHash, captain.keyHash].sort());
      expect(pay.exUnits[0]!.mem).toBeGreaterThan(0);
      provider.utxos.set(v.address, pp.outputs.filter((o) => o.address === v.address));

      const rv = await tx.vaultRevoke({
        sessionId: `s-${kind}`,
        toAddress: treasury.address,
        metadata674: { session_id: `s-${kind}`, log_sha256: "aa".repeat(32), handback_sha256: "bb".repeat(32), status: "KILLED" },
      });
      const rp = parseTx(rv.cborHex);
      expect(rp.outputs.map((o) => o.address)).toEqual([treasury.address]);
      expect(rp.outputs[0]!.amount.find((a) => a.unit === unit)?.quantity).toBe("4000000");
    });

    it("operatorSend: tUSD is minted on demand; tUSDM is never minted and must be held", async () => {
      const { provider, tx, unit, operator } = env;
      provider.add(operator.address, 50n * ADA);
      const to = addr("41".repeat(28));
      if (kind === "tusd") {
        const r = await tx.operatorSend({ toAddress: to, tusdMicro: 3_000_000n, lovelace: 2n * ADA, reference: "t1" });
        expect(cst.deserializeTx(r.cborHex).body().mint()).toBeTruthy();
        return;
      }
      await expect(tx.operatorSend({ toAddress: to, tusdMicro: 3_000_000n, lovelace: 2n * ADA, reference: "t1" })).rejects.toThrow(/cannot be minted/);
      provider.add(operator.address, 5n * ADA, { [unit]: 10_000_000n });
      const r = await tx.operatorSend({ toAddress: to, tusdMicro: 3_000_000n, lovelace: 2n * ADA, reference: "t2" });
      expect(cst.deserializeTx(r.cborHex).body().mint()).toBeFalsy();
      expect(parseTx(r.cborHex).outputs.find((o) => o.address === to)?.amount.find((a) => a.unit === unit)?.quantity).toBe("3000000");
    });
  });
}

describe("self-custody (CIP-30) wallet holding ONLY tUSDM → unsigned vault funding in tUSDM", () => {
  it("builds the unsigned funding tx from tUSDM, the wallet signs, submitSigned; Pay from the tUSDM vault runs the real UPLC", async () => {
    const { createThrowawayWallet } = await import("../src/vault");
    const provider = new FakeProvider();
    const sessions = new Map<string, SessionWalletInfo>();
    const stores = memoryStores((id) => sessions.get(id) ?? null);
    const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
    const tx = new MeshTxService({ provider, keys, sessions: stores.sessions, settlementUnit: TUSDM_PREPROD.unit });
    const captain = await keys.captain();
    provider.add(captain.address, 10n * ADA);
    const wallet = await createThrowawayWallet();
    // like the user's Eternl wallet: tADA + tUSDM, NO Bulkhead tUSD
    provider.add(wallet.address, 40n * ADA, { [TUSDM_PREPROD.unit]: 600_000_000n });
    const sk = await keys.session("sc-m1", 501);
    const p: VaultParams = {
      ownerAddress: wallet.address,
      captainKeyHash: captain.keyHash,
      sessionKeyHash: sk.keyHash,
      expiryMs: EXPIRY,
      payees: [PAYEE],
      perTxMaxTusdMicro: 5_000_000n,
      adaAllowanceLovelace: 3_000_000n,
      tusdPolicyId: TUSDM_PREPROD.policyId, // vault params tusd_policy / tusd_name = tUSDM
      tusdAssetNameHex: TUSDM_PREPROD.assetNameHex,
    };
    const v = applyVaultParams(p);
    sessions.set("sc-m1", { sessionId: "sc-m1", userId: "self-m", address: v.address, scriptCbor: v.scriptCbor, expirySlot: TIP_SLOT + 3600, walletMode: "vault", scriptJson: JSON.stringify(vaultParamsToJson(p)), scriptHash: v.scriptHash });

    const u = await tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: v.address, tusdMicro: 14_000_000n, extraLovelace: 3n * ADA }] });
    expect(u.totalTusdMicro).toBe(14_000_000n);
    const parsed = parseTx(u.unsignedTx);
    const vo = parsed.outputs.find((o) => o.address === v.address)!;
    expect(vo.amount.filter((a) => a.unit !== "lovelace")).toEqual([{ unit: TUSDM_PREPROD.unit, quantity: "14000000" }]);
    expect(parsed.outputs.find((o) => o.address === wallet.address)?.amount.find((a) => a.unit === TUSDM_PREPROD.unit)?.quantity).toBe("586000000");

    const r = await tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: wallet.signTx(u.unsignedTx), requiredKeyHash: wallet.paymentKeyHash });
    expect(r.txHash).toBe(u.txHash);
    provider.utxos.set(v.address, [{ ...vo }]);
    tx.queue.release(r.txHash);

    const pay = await tx.vaultPay({ sessionId: "sc-m1", payee: PAYEE, tusdMicro: 2_000_000n, memo: "tUSDM pay" });
    expect(parseTx(pay.cborHex).outputs.find((o) => o.address === PAYEE)?.amount.find((a) => a.unit === TUSDM_PREPROD.unit)?.quantity).toBe("2000000");
    expect(pay.exUnits[0]!.mem).toBeGreaterThan(0);
  });

  it("the same wallet with the tUSD fallback configured cannot fund (it holds no tUSD)", async () => {
    const { createThrowawayWallet } = await import("../src/vault");
    const provider = new FakeProvider();
    const stores = memoryStores(() => null);
    const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
    const tx = new MeshTxService({ provider, keys, sessions: stores.sessions }); // tUSD
    const wallet = await createThrowawayWallet();
    provider.add(wallet.address, 40n * ADA, { [TUSDM_PREPROD.unit]: 600_000_000n });
    const vaultAddr = cst.serializeAddress({ scriptHash: "ab".repeat(28), stakeCredentialHash: wallet.stakeKeyHash }, 0);
    await expect(tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: vaultAddr, tusdMicro: 1_000_000n, extraLovelace: 3n * ADA }] })).rejects.toThrow();
  });
});
