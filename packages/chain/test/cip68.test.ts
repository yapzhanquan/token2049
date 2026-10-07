// tUSD as a CIP-68 fungible token: CIP-67 labels, CIP-68 datum encoding, CIP-14 fingerprints, and the offline
// builds of the CIP-68 setup mint / legacy migration (fake provider, no network).
import { describe, expect, it } from "vitest";
import {
  assetFingerprint,
  cip67Label,
  cip68AssetName,
  cip68DatumCbor,
  cip68DatumJson,
  CIP67_LABEL,
  decodeCip68Datum,
  meshCip68,
  parseCip67,
} from "../src/cip68";
import {
  LEGACY_TUSD_ASSET_NAME_HEX,
  normalizeTusdUnit,
  TUSD_ASSET_NAME_HEX,
  TUSD_CONTENT_HEX,
  TUSD_METADATA,
  TUSD_REF_ASSET_NAME_HEX,
} from "../src/script";
import { KeyVault } from "../src/keys";
import { memoryStores } from "../src/store";
import { MeshTxService, NothingToMigrateError, parseTx } from "../src/tx";
import { cst } from "../src/mesh";
import { operatorInfo, tusdUnit } from "../src/index";
import { FakeProvider, metadataOf, TEST_MASTER, TEST_MNEMONIC, witnesses } from "./helpers";

const ADA = 1_000_000n;

describe("CIP-67 asset name labels", () => {
  it("matches the CIP-67 test vectors", () => {
    const vectors: Record<number, string> = {
      0: "00000000", 1: "00001070", 23: "00017650", 99: "000632e0", 533: "00215410",
      2000: "007d0550", 4567: "011d7690", 11111: "02b670b0", 49328: "0c0b0f40", 65535: "0ffff240",
    };
    for (const [n, hex] of Object.entries(vectors)) expect(cip67Label(Number(n))).toBe(hex);
  });

  it("CIP-68 labels: 100 / 222 / 333 / 444, consistent with Mesh CIP68_100 / CIP68_222", () => {
    expect(cip67Label(CIP67_LABEL.REFERENCE_NFT)).toBe("000643b0");
    expect(cip67Label(CIP67_LABEL.NFT)).toBe("000de140");
    expect(cip67Label(CIP67_LABEL.FT)).toBe("0014df10");
    expect(cip67Label(CIP67_LABEL.RFT)).toBe("001bc280");
    expect(cip68AssetName(100, "abcd")).toBe(meshCip68.CIP68_100("abcd"));
    expect(cip68AssetName(222, "abcd")).toBe(meshCip68.CIP68_222("abcd"));
  });

  it("tUSD asset names: 333 user token + 100 reference NFT, legacy name deprecated", () => {
    expect(TUSD_CONTENT_HEX).toBe("74555344");
    expect(TUSD_ASSET_NAME_HEX).toBe("0014df1074555344");
    expect(TUSD_REF_ASSET_NAME_HEX).toBe("000643b074555344");
    expect(LEGACY_TUSD_ASSET_NAME_HEX).toBe("74555344");
    expect(parseCip67(TUSD_ASSET_NAME_HEX)).toEqual({ label: 333, contentHex: "74555344" });
    expect(parseCip67(TUSD_REF_ASSET_NAME_HEX)).toEqual({ label: 100, contentHex: "74555344" });
    expect(parseCip67(LEGACY_TUSD_ASSET_NAME_HEX)).toBeNull();
    expect(parseCip67("0014df20aa")).toBeNull(); // bad checksum
  });

  it("enforces the 32-byte limit including the prefix", () => {
    expect(cip68AssetName(333, "aa".repeat(28)).length).toBe(64);
    expect(() => cip68AssetName(333, "aa".repeat(29))).toThrow(/32 bytes/);
    expect(() => cip67Label(70000)).toThrow();
  });

  it("normalizeTusdUnit upgrades a legacy unit to the 333 unit of the same policy only", () => {
    const pol = "ab".repeat(28);
    expect(normalizeTusdUnit(pol + "74555344")).toBe(pol + "0014df1074555344");
    expect(normalizeTusdUnit(pol + "0014df1074555344")).toBe(pol + "0014df1074555344");
    expect(normalizeTusdUnit("ab")).toBe("ab");
  });
});

describe("CIP-68 datum", () => {
  it("encodes #6.121([{bytes: bytes|int}, 1, #6.121([])]) with UTF-8 byte keys/values and int decimals", () => {
    const j = cip68DatumJson(TUSD_METADATA) as any;
    expect(j.constructor).toBe(0);
    expect(j.fields[1]).toEqual({ int: 1 });
    expect(j.fields[2]).toEqual({ constructor: 0, fields: [] });
    const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
    expect(j.fields[0].map).toEqual([
      { k: { bytes: hex("name") }, v: { bytes: hex("Bulkhead test USD") } },
      { k: { bytes: hex("description") }, v: { bytes: hex(TUSD_METADATA.description) } },
      { k: { bytes: hex("ticker") }, v: { bytes: hex("tUSD") } },
      { k: { bytes: hex("decimals") }, v: { int: 6 } },
    ]);
  });

  it("CBOR starts with tag 121 (d879) and round-trips through decodeCip68Datum", () => {
    const cbor = cip68DatumCbor(TUSD_METADATA);
    expect(cbor.startsWith("d8799f") || cbor.startsWith("d87983")).toBe(true);
    const d = decodeCip68Datum(cbor);
    expect(d.version).toBe(1);
    expect(d.metadata).toEqual({ name: "Bulkhead test USD", description: TUSD_METADATA.description, ticker: "tUSD", decimals: 6n });
  });

  it("hex-looking strings stay UTF-8 bytes (Mesh 'cafe' pitfall)", () => {
    const d = decodeCip68Datum(cip68DatumCbor({ name: "cafe", description: "x" }));
    expect(d.metadata.name).toBe("cafe");
  });

  it("rejects non-CIP-68 data", () => {
    expect(() => decodeCip68Datum("d87980")).toThrow(/CIP-68/);
  });
});

describe("CIP-14 asset fingerprint", () => {
  it("matches the CIP-14 test vectors", () => {
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "")).toBe("asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3");
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "504154415445")).toBe("asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92");
    expect(assetFingerprint("1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373")).toBe(
      "asset1aqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f",
    );
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "00".repeat(32))).toBe("asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w");
  });

  it("333 and 100 tUSD tokens have distinct fingerprints", () => {
    const pol = "ab".repeat(28);
    const a = assetFingerprint(pol, TUSD_ASSET_NAME_HEX);
    expect(a).toMatch(/^asset1[02-9ac-hj-np-z]{38}$/);
    expect(a).not.toBe(assetFingerprint(pol, TUSD_REF_ASSET_NAME_HEX));
    expect(a).not.toBe(assetFingerprint(pol, LEGACY_TUSD_ASSET_NAME_HEX));
  });
});

async function setup() {
  const provider = new FakeProvider();
  const stores = memoryStores(() => null);
  const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
  const op = await keys.operator();
  const info = await tx.tusdTokenInfo();
  return { provider, keys, tx, op, info };
}

describe("tUSD unit resolution", () => {
  it("tusdUnit / operatorInfo / TxService all use the CIP-68 (333) unit", async () => {
    const { tx, info } = await setup();
    const oi = await operatorInfo({ OPERATOR_MNEMONIC: TEST_MNEMONIC });
    expect(oi.tusdUnit).toBe(oi.policyId + "0014df1074555344");
    expect(oi.tusdReferenceUnit).toBe(oi.policyId + "000643b074555344");
    expect(oi.legacyTusdUnit).toBe(oi.policyId + "74555344");
    expect(oi.tusdFingerprint).toBe(assetFingerprint(oi.policyId, "0014df1074555344"));
    expect(await tusdUnit({ OPERATOR_MNEMONIC: TEST_MNEMONIC })).toBe(oi.tusdUnit);
    expect(await tusdUnit({ TUSD_UNIT: oi.legacyTusdUnit })).toBe(oi.tusdUnit); // legacy env value upgraded
    expect(tx.tusdUnit()).toBe(oi.tusdUnit);
    expect(info).toMatchObject({ standard: "CIP-68 (333)", unit: oi.tusdUnit, referenceUnit: oi.tusdReferenceUnit, fingerprint: oi.tusdFingerprint, legacyUnit: oi.legacyTusdUnit });
  });
});

describe("CIP-68 setup mint (offline build)", () => {
  it("mints (100) ref NFT with the inline metadata datum to the operator + (333) supply, signed by the operator", async () => {
    const { provider, tx, op, info } = await setup();
    provider.add(op.address, 50n * ADA);
    const r = await tx.mintTusdCip68({ supplyMicro: 1_000_000_000_000n, mintReference: true });
    const t = cst.deserializeTx(r.cborHex);
    const mint = cst.fromValue(new cst.Value(0n, t.body().mint())) as Array<{ unit: string; quantity: string }>;
    expect(mint).toEqual(
      expect.arrayContaining([
        { unit: info.referenceUnit, quantity: "1" },
        { unit: info.unit, quantity: "1000000000000" },
      ]),
    );
    const outs = t.body().outputs();
    const refOut = outs.find((o) => (cst.fromValue(o.amount()) as Array<{ unit: string }>).some((a) => a.unit === info.referenceUnit))!;
    expect(refOut.address().toBech32().toString()).toBe(op.address);
    const datumCbor = refOut.datum()!.asInlineData()!.toCbor().toString();
    expect(decodeCip68Datum(datumCbor).metadata).toEqual({ ...TUSD_METADATA, decimals: 6n });
    // the 333 supply lands in the operator change
    const p = parseTx(r.cborHex);
    const supply = p.outputs.flatMap((o) => o.amount).filter((a) => a.unit === info.unit);
    expect(supply.reduce((s, a) => s + BigInt(a.quantity), 0n)).toBe(1_000_000_000_000n);
    expect(witnesses(r.cborHex)).toEqual([{ keyHash: op.keyHash, valid: true }]);
    expect(metadataOf(r.cborHex)["674"].msg[0]).toMatch(/CIP-68/);
  });

  it("refuses a second reference NFT; operator txs never spend the reference NFT UTxO", async () => {
    const { provider, tx, op, info, keys } = await setup();
    provider.add(op.address, 3n * ADA, { [info.referenceUnit]: 1n }); // the ref NFT UTxO
    provider.add(op.address, 40n * ADA);
    await expect(tx.mintTusdCip68({ supplyMicro: 1n, mintReference: true })).rejects.toThrow(/already exists/);
    const t = await keys.treasury("u1", 1);
    const r = await tx.operatorSend({ toAddress: t.address, tusdMicro: 5_000_000n, lovelace: 2n * ADA, reference: "topup-x" });
    const p = parseTx(r.cborHex);
    const refUtxo = provider.utxos.get(op.address)![0]!;
    expect(p.inputs.some((i) => i.txHash === refUtxo.txHash && i.outputIndex === refUtxo.outputIndex)).toBe(false);
    expect(p.outputs.find((o) => o.address === t.address)!.amount).toContainEqual({ unit: info.unit, quantity: "5000000" });
  });
});

describe("legacy tUSD migration (offline build)", () => {
  it("burns legacy and mints the same amount of 333 to the wallet, signed by wallet + operator", async () => {
    const { provider, tx, keys, op, info } = await setup();
    const t = await keys.treasury("u2", 2);
    provider.add(t.address, 5n * ADA, { [info.legacyUnit]: 7_000_000n });
    provider.add(t.address, 10n * ADA);
    const before = await tx.balanceOf(t.address);
    expect(before.tusdMicro).toBe(0n);
    expect(before.legacyTusdMicro).toBe(7_000_000n);
    const r = await tx.migrateLegacyTusd({ keyId: "treasury:u2" });
    expect(r.migratedMicro).toBe(7_000_000n);
    const t2 = cst.deserializeTx(r.cborHex);
    const mint = cst.fromValue(new cst.Value(0n, t2.body().mint())) as Array<{ unit: string; quantity: string }>;
    expect(mint).toEqual(expect.arrayContaining([{ unit: info.legacyUnit, quantity: "-7000000" }, { unit: info.unit, quantity: "7000000" }]));
    const p = parseTx(r.cborHex);
    expect(p.outputs.every((o) => o.address === t.address)).toBe(true);
    expect(p.outputs.flatMap((o) => o.amount).filter((a) => a.unit === info.unit)).toEqual([{ unit: info.unit, quantity: "7000000" }]);
    expect(p.outputs.flatMap((o) => o.amount).some((a) => a.unit === info.legacyUnit)).toBe(false);
    expect(new Set(witnesses(r.cborHex).map((w) => w.keyHash))).toEqual(new Set([t.keyHash, op.keyHash]));
    await expect(tx.migrateLegacyTusd({ keyId: "treasury:u2" })).rejects.toBeInstanceOf(NothingToMigrateError);
  });
});
