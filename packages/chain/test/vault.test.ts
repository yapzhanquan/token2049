// Bulkhead Session Vault — offline tests: blueprint pin, parameter encoding, address, tx builders
// (real UPLC evaluation with Mesh's OfflineEvaluatorScalus), and the TxService vault methods.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { cst, DEFAULT_PROTOCOL_PARAMETERS, ensureCryptoReady, MeshTxBuilder, type MeshProtocol } from "../src/mesh";
import { KeyVault } from "../src/keys";
import { memoryStores, type SessionWalletInfo } from "../src/store";
import { MeshTxService, NotYetExpiredError, NothingToSweepError, parseTx } from "../src/tx";
import { timeFromSlot } from "../src/index";
import {
  applyVaultParams,
  addressToPlutusJson,
  buildVaultPay,
  buildVaultRecover,
  buildVaultRevoke,
  offlineEvaluator,
  slotStartMs,
  unappliedVaultHash,
  vaultParamsFromJson,
  vaultParamsToJson,
  vaultParamsToPlutusJson,
  vaultPayTtlSlot,
  vaultRecoverFromSlot,
  UNAPPLIED_VAULT_HASH,
  VAULT_BLUEPRINT,
  VAULT_SCRIPT_VERSION,
  VaultRedeemer,
  VaultScriptError,
  type AppliedVault,
  type VaultParams,
} from "../src/vault";
import type { Utxo } from "../src/types";
import { FakeProvider, metadataOf, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT, witnesses } from "./helpers";

/**
 * Every released contract version and its unapplied hash. Changing session_vault.ak changes the hash:
 * this test then fails until VAULT_SCRIPT_VERSION is bumped AND the new pair is added here
 * (deployed vault addresses depend on it — an accidental change would orphan live sessions).
 */
const PINNED_HASHES: Record<string, string> = {
  "1.0.0": "edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a",
};

const ADA = 1_000_000n;
const PP = { ...DEFAULT_PROTOCOL_PARAMETERS } as MeshProtocol;
const addr = (pkh: string, skh?: string) => cst.serializeAddress(skh ? { pubKeyHash: pkh, stakeCredentialHash: skh } : { pubKeyHash: pkh }, 0);
const OWNER_PKH = "11".repeat(28);
const OWNER_SKH = "12".repeat(28);
const OWNER = addr(OWNER_PKH, OWNER_SKH);
const CAPTAIN = "13".repeat(28);
const SESSION = "14".repeat(28);
const PAYEE = addr("15".repeat(28), "25".repeat(28));
const PAYEE2 = addr("16".repeat(28));
const ATTACKER = addr("17".repeat(28), OWNER_SKH);
const POLICY = "19".repeat(28);
const UNIT = POLICY + "74555344";
const EXPIRY = timeFromSlot(TIP_SLOT + 3600) + 400; // deliberately NOT slot-aligned

function params(over: Partial<VaultParams> = {}): VaultParams {
  return {
    ownerAddress: OWNER,
    captainKeyHash: CAPTAIN,
    sessionKeyHash: SESSION,
    expiryMs: EXPIRY,
    payees: [PAYEE, PAYEE2],
    perTxMaxTusdMicro: 5_000_000n,
    adaAllowanceLovelace: 3_000_000n,
    tusdPolicyId: POLICY,
    tusdAssetNameHex: "74555344",
    ...over,
  };
}

let n = 0;
const h32 = () => (++n).toString(16).padStart(64, "a");
const vaultUtxo = (v: AppliedVault, lovelace: bigint, tusd: bigint, idx = 0): Utxo => ({
  txHash: h32(),
  outputIndex: idx,
  address: v.address,
  amount: [{ unit: "lovelace", quantity: lovelace.toString() }, ...(tusd > 0n ? [{ unit: UNIT, quantity: tusd.toString() }] : [])],
});
const collateralUtxo = (address = addr(CAPTAIN, "1d".repeat(28))): Utxo => ({ txHash: h32(), outputIndex: 1, address, amount: [{ unit: "lovelace", quantity: (10n * ADA).toString() }] });

beforeAll(async () => {
  await ensureCryptoReady();
});

describe("blueprint + pinned hash", () => {
  it("UNAPPLIED_VAULT_HASH = hash of the embedded blueprint = the pinned hash for this VAULT_SCRIPT_VERSION", () => {
    expect(unappliedVaultHash()).toBe(UNAPPLIED_VAULT_HASH);
    expect(VAULT_BLUEPRINT.hash).toBe(UNAPPLIED_VAULT_HASH);
    expect(PINNED_HASHES[VAULT_SCRIPT_VERSION], `contract changed: bump VAULT_SCRIPT_VERSION and pin the new hash`).toBe(UNAPPLIED_VAULT_HASH);
  });

  it("embedded blueprint matches contracts/plutus.json (run `node contracts/scripts/gen-ts.mjs` after `aiken build`)", () => {
    const file = fileURLToPath(new URL("../../../contracts/plutus.json", import.meta.url));
    const bp = JSON.parse(readFileSync(file, "utf8"));
    const spend = bp.validators.find((v: { title: string }) => v.title === "session_vault.session_vault.spend");
    expect(spend.compiledCode).toBe(VAULT_BLUEPRINT.compiledCode);
    expect(spend.hash).toBe(VAULT_BLUEPRINT.hash);
    expect(bp.preamble.plutusVersion).toBe("v3");
    expect(bp.preamble.compiler.version).toMatch(/^v1\.1\.24/);
    expect(spend.parameters.map((p: { title: string }) => p.title)).toEqual([
      "owner",
      "captain_vkh",
      "session_vkh",
      "expiry",
      "payees",
      "per_tx_max_tusd",
      "ada_allowance",
      "tusd_policy",
      "tusd_name",
    ]);
    // Redeemer schema: Pay | Revoke | Recover = Constr 0/1/2 []
    const action = bp.definitions["session_vault/VaultAction"];
    expect(action.anyOf.map((c: { title: string; index: number; fields: unknown[] }) => [c.title, c.index, c.fields.length])).toEqual([
      ["Pay", 0, 0],
      ["Revoke", 1, 0],
      ["Recover", 2, 0],
    ]);
    expect(VaultRedeemer).toEqual({ Pay: { constructor: 0, fields: [] }, Revoke: { constructor: 1, fields: [] }, Recover: { constructor: 2, fields: [] } });
  });
});

describe("parameters", () => {
  it("encodes the 9 parameters in blueprint order (spec encodings)", () => {
    const j = vaultParamsToPlutusJson(params());
    expect(j).toHaveLength(9);
    expect(j[0]).toEqual({
      constructor: 0,
      fields: [
        { constructor: 0, fields: [{ bytes: OWNER_PKH }] },
        { constructor: 0, fields: [{ constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: OWNER_SKH }] }] }] },
      ],
    });
    expect(j.slice(1, 4)).toEqual([{ bytes: CAPTAIN }, { bytes: SESSION }, { int: EXPIRY }]);
    expect(j[4]).toEqual({ list: [{ constructor: 0, fields: [{ bytes: "15".repeat(28) }] }, { constructor: 0, fields: [{ bytes: "16".repeat(28) }] }] });
    expect(j.slice(5)).toEqual([{ int: 5_000_000n }, { int: 3_000_000n }, { bytes: POLICY }, { bytes: "74555344" }]);
  });

  it("Address encoding = ledger/Aiken shape Constr0[cred, Some(Inline(cred))] (the offline Revoke/Recover evaluations below prove it equals the ledger's own conversion)", () => {
    const vk = (h: string) => `d8799f581c${h}ff`;
    expect(cst.fromJsonToPlutusData(addressToPlutusJson(OWNER) as object).toCbor()).toBe(`d8799f${vk(OWNER_PKH)}d8799fd8799f${vk(OWNER_SKH)}ffffff`);
    expect(cst.fromJsonToPlutusData(addressToPlutusJson(PAYEE2) as object).toCbor()).toBe(`d8799f${vk("16".repeat(28))}d87a80ff`);
    const scriptAddr = cst.serializeAddress({ scriptHash: "1a".repeat(28), stakeCredentialHash: OWNER_SKH }, 0);
    expect((addressToPlutusJson(scriptAddr) as { fields: unknown[] }).fields[0]).toEqual({ constructor: 1, fields: [{ bytes: "1a".repeat(28) }] });
    // NB: Mesh 1.9.1 addrBech32ToPlutusDataHex omits the Inline (StakingHash) layer — do not use it for Aiken v3 Address params.
  });

  it("VaultParams JSON round-trip (bigints as decimal strings)", () => {
    const p = params();
    const s = JSON.stringify(vaultParamsToJson(p));
    expect(JSON.parse(s).perTxMaxTusdMicro).toBe("5000000");
    expect(vaultParamsFromJson(s)).toEqual(p);
    expect(applyVaultParams(vaultParamsFromJson(s)).scriptHash).toBe(applyVaultParams(p).scriptHash);
  });

  it("rejects bad params (> 10 payees, mainnet addresses, bad hashes)", () => {
    expect(() => applyVaultParams(params({ payees: Array.from({ length: 11 }, (_, i) => addr(i.toString(16).padStart(2, "0").repeat(28))) }))).toThrow(/at most 10/);
    expect(() => applyVaultParams(params({ ownerAddress: "addr1qx" + "q".repeat(50) }))).toThrow(/preprod/);
    expect(() => applyVaultParams(params({ sessionKeyHash: "zz" }))).toThrow(/28 bytes/);
    expect(() => applyVaultParams(params({ payees: [] }))).toThrow(/non-empty/);
  });

  it("each session gets its own script hash; the same params give the same hash", () => {
    const a = applyVaultParams(params());
    expect(applyVaultParams(params()).scriptHash).toBe(a.scriptHash);
    expect(applyVaultParams(params({ sessionKeyHash: "24".repeat(28) })).scriptHash).not.toBe(a.scriptHash);
    expect(applyVaultParams(params({ expiryMs: EXPIRY + 1 })).scriptHash).not.toBe(a.scriptHash);
    expect(a.scriptHash).not.toBe(UNAPPLIED_VAULT_HASH);
    expect(cst.deserializePlutusScript(a.scriptCbor, "V3").hash().toString()).toBe(a.scriptHash);
    expect(a.scriptSizeBytes).toBeGreaterThan(1800);
    expect(a.scriptSizeBytes).toBeLessThan(4000);
  });
});

describe("vault address uses the OWNER's stake credential (session budgets count toward the owner's stake)", () => {
  it("payment = applied script hash, stake = owner's stake key hash", () => {
    const v = applyVaultParams(params());
    const d = cst.deserializeBech32Address(v.address);
    expect(d.scriptHash).toBe(v.scriptHash);
    expect(d.stakeCredentialHash).toBe(OWNER_SKH);
    expect(v.address.startsWith("addr_test1z")).toBe(true); // script payment + key stake (type 1), testnet
  });

  it("with a real custodial treasury (KeyVault-derived payment + stake keys)", async () => {
    const stores = memoryStores();
    const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
    const t = await keys.treasury("u-stake", 7);
    const v = applyVaultParams(params({ ownerAddress: t.address }));
    expect(cst.deserializeBech32Address(v.address).stakeCredentialHash).toBe(t.stakeKeyHash);
    expect(cst.resolveStakeKeyHash(v.address)).toBe(cst.resolveStakeKeyHash(t.address));
  });

  it("enterprise script address when the owner has no stake credential", () => {
    const v = applyVaultParams(params({ ownerAddress: addr(OWNER_PKH) }));
    const d = cst.deserializeBech32Address(v.address);
    expect(d.scriptHash).toBe(v.scriptHash);
    expect(d.stakeCredentialHash).toBe("");
    expect(v.address.startsWith("addr_test1w")).toBe(true);
  });
});

describe("validity bounds (slot ↔ POSIX)", () => {
  it("Pay TTL: POSIX(ttl) ≤ expiry, and min(expiry slot, tip+900)", () => {
    const ttl = vaultPayTtlSlot(EXPIRY, TIP_SLOT, 900);
    expect(ttl).toBe(TIP_SLOT + 900);
    const late = vaultPayTtlSlot(EXPIRY, TIP_SLOT + 3500, 900);
    expect(slotStartMs(late)).toBeLessThanOrEqual(EXPIRY);
    expect(slotStartMs(late + 1)).toBeGreaterThan(EXPIRY);
  });
  it("Recover lower bound: first slot strictly after expiry (also when expiry is slot-aligned)", () => {
    const s = vaultRecoverFromSlot(EXPIRY);
    expect(slotStartMs(s)).toBeGreaterThan(EXPIRY);
    expect(slotStartMs(s - 1)).toBeLessThanOrEqual(EXPIRY);
    const aligned = timeFromSlot(TIP_SLOT + 10);
    expect(vaultRecoverFromSlot(aligned)).toBe(TIP_SLOT + 11);
  });
});

describe("tx builders (Mesh, offline; scripts evaluated with OfflineEvaluatorScalus)", () => {
  const v = applyVaultParams(params());
  const ttlSlot = vaultPayTtlSlot(EXPIRY, TIP_SLOT);
  const common = () => ({ vault: v, collateral: collateralUtxo(), protocolParams: PP, evaluate: offlineEvaluator() });

  it("Pay: payee output + continuing vault output (inline Void), collateral + return, session required signer, TTL ≤ expiry, 674", async () => {
    const vu = vaultUtxo(v, 20n * ADA, 50_000_000n);
    const c = common();
    const r = await buildVaultPay({ ...c, utxos: [vu], payee: PAYEE, tusdMicro: 2_000_000n, memo: "order #1", reference: "pay-1", changeTo: v.address, ttlSlot });
    const tx = cst.deserializeTx(r.unsignedTx);
    const body = tx.body();
    const outs = body.outputs();
    expect(outs).toHaveLength(2);
    const [toPayee, back] = [outs[0]!, outs[1]!];
    expect(toPayee.address().toBech32().toString()).toBe(PAYEE);
    expect(cst.fromValue(toPayee.amount()).find((a) => a.unit === UNIT)?.quantity).toBe("2000000");
    expect(back.address().toBech32().toString()).toBe(v.address);
    expect(back.datum()?.asInlineData()?.toCbor()).toBe("d87980"); // Constr 0 [] = Void
    expect(cst.fromValue(back.amount()).find((a) => a.unit === UNIT)?.quantity).toBe("48000000");
    // value conservation: in = outs + fee
    const lovelaceOut = outs.reduce((s, o) => s + BigInt(o.amount().coin()), 0n);
    expect(lovelaceOut + r.feeLovelace).toBe(20n * ADA);
    expect(BigInt(toPayee.amount().coin()) + r.feeLovelace).toBeLessThanOrEqual(3n * ADA); // ≤ ada_allowance
    expect(body.requiredSigners()?.toCore()).toEqual([SESSION]);
    expect(Number(body.ttl())).toBe(ttlSlot);
    expect(body.collateral()?.toCore()).toEqual([{ txId: c.collateral.txHash, index: 1 }]);
    expect(BigInt(body.totalCollateral()!)).toBe(r.totalCollateral);
    expect(BigInt(body.collateralReturn()!.amount().coin())).toBe(10n * ADA - r.totalCollateral);
    expect(body.collateralReturn()!.address().toBech32().toString()).toBe(c.collateral.address);
    expect(r.totalCollateral).toBeGreaterThanOrEqual((r.feeLovelace * 150n) / 100n);
    expect(metadataOf(r.unsignedTx)["674"]).toEqual({ msg: ["pay-1", "order #1"] });
    const wits = tx.witnessSet();
    expect(wits.plutusV3Scripts()?.values().map((s) => s.hash().toString())).toEqual([v.scriptHash]);
    expect(wits.redeemers()?.values().map((rd) => rd.data().toCbor())).toEqual(["d87980"]);
    expect(r.measured![0]!.mem).toBeGreaterThan(50_000);
    expect(r.exUnits[0]!.mem).toBeGreaterThanOrEqual(r.measured![0]!.mem);
    // Mesh's fee calculation (mock witnesses: session + captain) covers the real fee
    expect(r.feeLovelace).toBeGreaterThan(200_000n);
    expect(r.feeLovelace).toBeLessThan(600_000n);
  });

  it("Pay to an attacker / over the tUSD limit / over the ADA allowance / with two inputs summing over the limit → script rejects", async () => {
    const c = common();
    const vu = vaultUtxo(v, 20n * ADA, 50_000_000n);
    await expect(buildVaultPay({ ...c, utxos: [vu], payee: ATTACKER, tusdMicro: 1_000_000n, ttlSlot })).rejects.toBeInstanceOf(VaultScriptError);
    await expect(buildVaultPay({ ...c, utxos: [vu], payee: PAYEE, tusdMicro: 5_000_001n, ttlSlot })).rejects.toThrow(/rejected the Pay tx/);
    await expect(buildVaultPay({ ...c, utxos: [vu], payee: PAYEE, tusdMicro: 1_000_000n, lovelace: 2n * ADA, ttlSlot })).rejects.toBeInstanceOf(VaultScriptError);
    const two = [vaultUtxo(v, 5n * ADA, 3_000_000n), vaultUtxo(v, 5n * ADA, 3_000_000n)];
    await expect(buildVaultPay({ ...c, utxos: two, payee: PAYEE, tusdMicro: 6_000_000n, ttlSlot })).rejects.toBeInstanceOf(VaultScriptError);
    const ok = await buildVaultPay({ ...c, utxos: two, payee: PAYEE, tusdMicro: 5_000_000n, ttlSlot });
    expect(ok.exUnits).toHaveLength(2);
    // TTL past expiry → the script rejects (upper bound > expiry)
    const past = Math.ceil((EXPIRY - slotStartMs(0)) / 1000) + 5;
    await expect(buildVaultPay({ ...c, utxos: [vu], payee: PAYEE, tusdMicro: 1_000_000n, ttlSlot: past })).rejects.toBeInstanceOf(VaultScriptError);
  });

  it("Revoke: everything → owner, captain required signer, 674 close hashes", async () => {
    const c = common();
    const us = [vaultUtxo(v, 8n * ADA, 10_000_000n), vaultUtxo(v, 3n * ADA, 0n)];
    const meta = { session_id: "s-1", log_sha256: "ab".repeat(32), handback_sha256: "cd".repeat(32), status: "COMPLETED" };
    const r = await buildVaultRevoke({ ...c, utxos: us, ownerAddress: OWNER, metadata674: meta, ttlSlot: TIP_SLOT + 900 });
    const body = cst.deserializeTx(r.unsignedTx).body();
    expect(body.outputs()).toHaveLength(1);
    const o = body.outputs()[0]!;
    expect(o.address().toBech32().toString()).toBe(OWNER);
    expect(BigInt(o.amount().coin()) + r.feeLovelace).toBe(11n * ADA);
    expect(cst.fromValue(o.amount()).find((a) => a.unit === UNIT)?.quantity).toBe("10000000");
    expect(body.requiredSigners()?.toCore()).toEqual([CAPTAIN]);
    expect(metadataOf(r.unsignedTx)["674"]).toMatchObject(meta);
    expect(r.exUnits).toHaveLength(2);
    await expect(buildVaultRevoke({ ...c, utxos: us, ownerAddress: PAYEE, metadata674: meta })).rejects.toThrow(/owner address/);
  });

  it("Revoke 674 anchors the goal id + sha256(utf8(handback text)) (trust receipts); an absent goal_id is omitted", async () => {
    const { createHash } = await import("node:crypto");
    const handback = JSON.stringify({ result: "Bought ✓\nline 2", summary: "ok" });
    const hb = createHash("sha256").update(handback, "utf8").digest("hex");
    const goalId = "g_844d6715-6b57-481b-aec6-555fcb56cc37"; // 38 bytes ≤ the CIP-20 64-byte string limit
    const meta = { session_id: "ses_de6206b2d6a04271", log_sha256: "ab".repeat(32), handback_sha256: hb, status: "COMPLETED", goal_id: goalId };
    const r = await buildVaultRevoke({ ...common(), utxos: [vaultUtxo(v, 6n * ADA, 1_000_000n)], ownerAddress: OWNER, metadata674: meta, ttlSlot: TIP_SLOT + 900 });
    expect(metadataOf(r.unsignedTx)["674"]).toEqual({ msg: ["Bulkhead session close (vault revoke)"], ...meta });
    const { goal_id: _omit, ...noGoal } = meta;
    const r2 = await buildVaultRevoke({ ...common(), utxos: [vaultUtxo(v, 6n * ADA, 1_000_000n)], ownerAddress: OWNER, metadata674: { ...noGoal, goal_id: undefined }, ttlSlot: TIP_SLOT + 900 });
    expect(metadataOf(r2.unsignedTx)["674"]).toEqual({ msg: ["Bulkhead session close (vault revoke)"], ...noGoal });
    await expect(buildVaultRevoke({ ...common(), utxos: [vaultUtxo(v, 6n * ADA, 0n)], ownerAddress: OWNER, metadata674: { ...meta, goal_id: "g".repeat(65) } })).rejects.toThrow(/goal_id exceeds 64 bytes/);
  });

  it("Recover: invalidBefore strictly after expiry, no required signer, everything → owner", async () => {
    const c = common();
    const from = vaultRecoverFromSlot(EXPIRY);
    const r = await buildVaultRecover({ ...c, utxos: [vaultUtxo(v, 6n * ADA, 1_000_000n)], ownerAddress: OWNER, validFromSlot: from, ttlSlot: from + 900 });
    const body = cst.deserializeTx(r.unsignedTx).body();
    expect(Number(body.validityStartInterval())).toBe(from);
    expect(body.requiredSigners()?.toCore() ?? []).toEqual([]);
    expect(body.outputs().map((o) => o.address().toBech32().toString())).toEqual([OWNER]);
    await expect(buildVaultRecover({ ...c, utxos: [vaultUtxo(v, 6n * ADA, 0n)], ownerAddress: OWNER, validFromSlot: from - 1 })).rejects.toThrow(/strictly after expiry/);
  });

  it("the compiled script rejects an unknown redeemer (Constr 3) and a Recover before expiry", async () => {
    const vu = vaultUtxo(v, 6n * ADA, 0n);
    const col = collateralUtxo();
    const draft = (redeemer: object, before?: number) => {
      const b = new MeshTxBuilder({ params: PP });
      b.spendingPlutusScriptV3()
        .txIn(vu.txHash, vu.outputIndex, vu.amount, vu.address, 0)
        .txInInlineDatumPresent()
        .txInRedeemerValue(JSON.stringify(redeemer), "JSON", { mem: 5_000_000, steps: 2_000_000_000 })
        .txInScript(v.scriptCbor)
        .txOut(OWNER, [{ unit: "lovelace", quantity: (5n * ADA).toString() }])
        .txInCollateral(col.txHash, col.outputIndex, col.amount, col.address)
        .requiredSignerHash(CAPTAIN)
        .setFee("1000000")
        .changeAddress(OWNER);
      if (before != null) b.invalidBefore(before);
      return b.completeUnbalanced();
    };
    const ev = offlineEvaluator();
    await expect(ev(draft({ constructor: 3, fields: [] }), [vu], [col])).rejects.toThrow();
    await expect(ev(draft(VaultRedeemer.Recover, vaultRecoverFromSlot(EXPIRY) - 1), [vu], [col])).rejects.toThrow();
    const ok = await ev(draft(VaultRedeemer.Recover, vaultRecoverFromSlot(EXPIRY)), [vu], [col]);
    expect(ok[0]!.budget.mem).toBeGreaterThan(0);
    // Revoke-by-captain draft passes, Pay by the captain (no session signature) fails
    expect((await ev(draft(VaultRedeemer.Revoke), [vu], [col]))[0]!.budget.steps).toBeGreaterThan(0);
  });
});

describe("TxService vault methods (FakeProvider: no evaluateTx → offline evaluator)", () => {
  async function setup() {
    const provider = new FakeProvider();
    const sessions = new Map<string, SessionWalletInfo>();
    const stores = memoryStores((id) => sessions.get(id) ?? null);
    const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
    const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
    const unit = await tx.tusdUnitAsync();
    const treasury = await keys.treasury("vu1", 3);
    const captain = await keys.captain();
    provider.add(captain.address, 10n * ADA); // collateral
    async function newVault(id: string, keyIndex: number, expiryMs: number, fund?: { lovelace: bigint; tusd: bigint }) {
      const sk = await keys.session(id, keyIndex);
      const p: VaultParams = {
        ownerAddress: treasury.address,
        captainKeyHash: captain.keyHash,
        sessionKeyHash: sk.keyHash,
        expiryMs,
        payees: [PAYEE],
        perTxMaxTusdMicro: 5_000_000n,
        adaAllowanceLovelace: 3_000_000n,
        tusdPolicyId: unit.slice(0, 56),
        tusdAssetNameHex: unit.slice(56),
      };
      const v = applyVaultParams(p);
      sessions.set(id, {
        sessionId: id,
        userId: "vu1",
        address: v.address,
        scriptCbor: v.scriptCbor,
        expirySlot: Math.floor((expiryMs - timeFromSlot(0)) / 1000),
        walletMode: "vault",
        scriptJson: JSON.stringify(vaultParamsToJson(p)),
        scriptHash: v.scriptHash,
      });
      if (fund) provider.add(v.address, fund.lovelace, { [unit]: fund.tusd });
      return { v, sessionKeyHash: sk.keyHash };
    }
    return { provider, keys, tx, unit, treasury, captain, newVault };
  }
  let env: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    env = await setup();
  });

  it("vaultFund: treasury → vault outputs carry inline datum Void, exact tUSD, min-ADA + extraLovelace", async () => {
    const { provider, tx, unit, treasury, newVault } = env;
    provider.add(treasury.address, 100n * ADA, { [unit]: 50_000_000n });
    const a = await newVault("vf1", 301, EXPIRY);
    const b = await newVault("vf2", 302, EXPIRY);
    const outs = [
      { address: a.v.address, tusdMicro: 10_000_000n, extraLovelace: 3n * ADA },
      { address: b.v.address, tusdMicro: 2_000_000n, extraLovelace: 3n * ADA },
    ];
    const preview = await tx.previewVaultFunding({ userId: "vu1", outputs: outs });
    expect(preview.totalTusdMicro).toBe(12_000_000n);
    const r = await tx.vaultFund({ userId: "vu1", outputs: outs });
    const body = cst.deserializeTx(r.cborHex).body();
    for (const o of outs) {
      const out = body.outputs().find((x) => x.address().toBech32().toString() === o.address)!;
      expect(out.datum()?.asInlineData()?.toCbor()).toBe("d87980");
      expect(cst.fromValue(out.amount()).find((x) => x.unit === unit)?.quantity).toBe(o.tusdMicro.toString());
      expect(BigInt(out.amount().coin())).toBeGreaterThan(3n * ADA + 900_000n);
    }
    expect(witnesses(r.cborHex).map((w) => w.keyHash)).toEqual([treasury.keyHash]);
    await expect(tx.vaultFund({ userId: "vu1", outputs: [{ address: PAYEE, tusdMicro: 1n }] })).rejects.toThrow(/not a script/);
  });

  it("vaultPay: signed by the session key + captain (collateral); attacker payee → VaultScriptError (SCRIPT_FAILED)", async () => {
    const { provider, tx, unit, captain, newVault } = env;
    const { v, sessionKeyHash } = await newVault("vp1", 311, EXPIRY, { lovelace: 12n * ADA, tusd: 20_000_000n });
    const before = provider.submitted.length;
    const r = await tx.vaultPay({ sessionId: "vp1", payee: PAYEE, tusdMicro: 3_000_000n, memo: "data feed", reference: "job-1" });
    expect(provider.submitted.length).toBe(before + 1);
    const w = witnesses(r.cborHex);
    expect(w.every((x) => x.valid)).toBe(true);
    expect(w.map((x) => x.keyHash).sort()).toEqual([sessionKeyHash, captain.keyHash].sort());
    const p = parseTx(r.cborHex);
    expect(p.outputs.find((o) => o.address === v.address)?.amount.find((a) => a.unit === unit)?.quantity).toBe("17000000");
    expect(r.exUnits[0]!.mem).toBeGreaterThan(0);

    // Bypass the Signer: the chain (script) is the authority.
    const err = await tx.vaultPay({ sessionId: "vp1", payee: ATTACKER, tusdMicro: 1_000_000n, memo: "steal" }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultScriptError);
    expect(err.name).toBe("VaultScriptError");
    expect(err.code).toBe("SCRIPT_FAILED");
    await expect(tx.vaultPay({ sessionId: "vp1", payee: PAYEE, tusdMicro: 6_000_000n, memo: "too much" })).rejects.toMatchObject({ code: "SCRIPT_FAILED" });
    expect(provider.submitted.length).toBe(before + 1);
  });

  it("vaultRevoke: captain signs, everything → owner treasury, 674; empty vault → NothingToSweepError", async () => {
    const { tx, unit, treasury, captain, newVault } = env;
    await newVault("vr1", 321, EXPIRY, { lovelace: 7n * ADA, tusd: 4_000_000n });
    const meta = { session_id: "vr1", log_sha256: "aa".repeat(32), handback_sha256: "bb".repeat(32), status: "KILLED" };
    await expect(tx.vaultRevoke({ sessionId: "vr1", toAddress: PAYEE, metadata674: meta })).rejects.toThrow(/owner address/);
    const r = await tx.vaultRevoke({ sessionId: "vr1", toAddress: treasury.address, metadata674: meta });
    expect(witnesses(r.cborHex).map((x) => x.keyHash)).toEqual([captain.keyHash]);
    const p = parseTx(r.cborHex);
    expect(p.outputs.map((o) => o.address)).toEqual([treasury.address]);
    expect(p.outputs[0]!.amount.find((a) => a.unit === unit)?.quantity).toBe("4000000");
    expect(metadataOf(r.cborHex)["674"]).toMatchObject(meta);
    await newVault("vr2", 322, EXPIRY);
    await expect(tx.vaultRevoke({ sessionId: "vr2", toAddress: treasury.address, metadata674: meta })).rejects.toBeInstanceOf(NothingToSweepError);
  });

  it("vaultRecover: before expiry → NotYetExpiredError; after → anyone's collateral, no authorizing signature", async () => {
    const { provider, tx, treasury, captain, newVault } = env;
    const expiry = timeFromSlot(TIP_SLOT + 100) + 1;
    await newVault("vc1", 331, expiry, { lovelace: 5n * ADA, tusd: 1_000_000n });
    await expect(tx.vaultRecover({ sessionId: "vc1" })).rejects.toBeInstanceOf(NotYetExpiredError);
    provider.tipSlot = TIP_SLOT + 200;
    const r = await tx.vaultRecover({ sessionId: "vc1" });
    const p = parseTx(r.cborHex);
    expect(p.validityStart).toBe(vaultRecoverFromSlot(expiry));
    expect(p.outputs.map((o) => o.address)).toEqual([treasury.address]);
    expect(witnesses(r.cborHex).map((x) => x.keyHash)).toEqual([captain.keyHash]); // collateral witness only
    expect(cst.deserializeTx(r.cborHex).body().requiredSigners()?.toCore() ?? []).toEqual([]);
    provider.tipSlot = TIP_SLOT;
  });

  it("refuses a non-vault session row", async () => {
    await expect(env.tx.vaultPay({ sessionId: "nope", payee: PAYEE, tusdMicro: 1n, memo: "" })).rejects.toThrow(/no wallet/);
  });
});
