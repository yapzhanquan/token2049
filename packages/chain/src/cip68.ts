// CIP-67 asset-name labels, CIP-68 datum metadata and CIP-14 asset fingerprints (Mesh 1.9.1).
//
//  CIP-67: asset_name = [0000 | 16-bit label | CRC-8(label) | 0000] ++ content. 100 → 000643b0 (reference NFT),
//          222 → 000de140 (NFT), 333 → 0014df10 (FT), 444 → 001bc280 (RFT).
//          Mesh 1.9.1 ships CIP68_100 / CIP68_222 only (no 333), so the prefix is computed here and tested
//          against both Mesh helpers and the CIP-67 test vectors.
//  CIP-68: the reference NFT (100) sits in an output whose INLINE datum is
//          #6.121([metadata, version, extra]) — metadata keys/values UTF-8 bytes, `decimals` an int,
//          extra = Constr 0 [] (unit). The 333 user token (fungible supply) shares the policy + content name.
//  CIP-14: asset fingerprint = bech32("asset", blake2b-160(policyId ++ assetName)) — Mesh resolveFingerprint.
//
// Mesh 1.9.1 caveat: metadataToCip68() returns { alternative: 0, fields: [Map, 1] } ("Mesh" Data). Passing that to
// txOutInlineDatumValue crashes complete() (the builder JSON-clones outputs for min-ADA and loses the JS Map;
// hex-looking strings are also read as raw hex). So the entries are re-emitted as explicit JSON Plutus data
// conStr0([assocMap(...), integer(version), conStr0([])]) — same workaround as the playground's mint-cip68.ts — and
// then serialised to CBOR (cip68DatumCbor): in this workspace Mesh's JSON datum path also trips over the `constructor`
// key ("Object contains forbidden constructor property"), so the tx builder receives the datum as CBOR.
import { createRequire } from "node:module";
import type * as MeshCore from "@meshsdk/core";
import { cst } from "./mesh";

const localRequire = createRequire(import.meta.url);
const meshRequire = createRequire(localRequire.resolve("@meshsdk/core"));
const common = meshRequire("@meshsdk/common") as Pick<
  typeof MeshCore,
  "metadataToCip68" | "resolveFingerprint" | "CIP68_100" | "CIP68_222" | "conStr0" | "assocMap" | "byteString" | "integer"
>;

export const CIP67_LABEL = { REFERENCE_NFT: 100, NFT: 222, FT: 333, RFT: 444 } as const;

// CRC-8, polynomial 0x07, init 0 (the CIP-67 lookup table is exactly this polynomial).
function crc8(bytes: Uint8Array): number {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

/** CIP-67 4-byte label prefix (hex), e.g. 333 → "0014df10". */
export function cip67Label(label: number): string {
  if (!Number.isInteger(label) || label < 0 || label > 65535) throw new Error(`CIP-67 label out of range: ${label}`);
  const num = label.toString(16).padStart(4, "0");
  const check = crc8(Buffer.from(num, "hex")).toString(16).padStart(2, "0");
  return `0${num}${check}0`;
}

/** Parse a CIP-67 label off an asset name (hex). null when the name carries no valid label. */
export function parseCip67(assetNameHex: string): { label: number; contentHex: string } | null {
  const h = assetNameHex.toLowerCase();
  if (h.length < 8 || h[0] !== "0" || h[7] !== "0") return null;
  const label = parseInt(h.slice(1, 5), 16);
  if (Number.isNaN(label) || cip67Label(label) !== h.slice(0, 8)) return null;
  return { label, contentHex: h.slice(8) };
}

/** label prefix + content (hex); enforces the 32-byte asset-name limit (the prefix counts). */
export function cip68AssetName(label: number, contentHex: string): string {
  if (!/^([0-9a-f]{2})*$/.test(contentHex)) throw new Error("contentHex must be lowercase hex");
  const name = cip67Label(label) + contentHex;
  if (name.length > 64) throw new Error(`asset name exceeds 32 bytes (${name.length / 2})`);
  return name;
}

export type Cip68Value = string | number | bigint;
export type Cip68Metadata = Record<string, Cip68Value>;

/** JSON Plutus data for the CIP-68 reference datum: Constr 0 [Map<bytes, bytes|int>, Int version, Constr 0 []]. */
export function cip68DatumJson(metadata: Cip68Metadata, version = 1): object {
  // metadataToCip68 → { alternative 0, fields: [Map, 1] }; re-emit its entries as explicit JSON Plutus data.
  const map = (common.metadataToCip68(metadata) as unknown as { fields: [Map<string, Cip68Value>, number] }).fields[0];
  const entries = [...map.entries()].map(([k, v]) => {
    const key = common.byteString(Buffer.from(k, "utf8").toString("hex"));
    if (typeof v === "number" || typeof v === "bigint") {
      if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`CIP-68 metadata ${k}: integers only`);
      return [key, common.integer(v)];
    }
    if (typeof v !== "string") throw new Error(`CIP-68 metadata ${k}: only string / integer values are supported`);
    return [key, common.byteString(Buffer.from(v, "utf8").toString("hex"))];
  }) as [ReturnType<typeof common.byteString>, ReturnType<typeof common.byteString>][];
  return common.conStr0([common.assocMap(entries), common.integer(version), common.conStr0([])]);
}

/** CBOR hex of the CIP-68 datum (what ends up as the output's inline datum). */
export function cip68DatumCbor(metadata: Cip68Metadata, version = 1): string {
  return cst.fromJsonToPlutusData(cip68DatumJson(metadata, version)).toCbor().toString();
}

/** Decode a CIP-68 inline datum (CBOR hex, e.g. Blockfrost `inline_datum`) back to { metadata, version }. */
export function decodeCip68Datum(cborHex: string): { metadata: Record<string, string | bigint>; version: number; extra: unknown } {
  const j = cst.fromPlutusDataToJson(cst.deserializePlutusData(cborHex)) as {
    constructor?: number | bigint;
    fields?: Array<{ map?: Array<{ k: { bytes?: string }; v: { bytes?: string; int?: number | bigint } }>; int?: number | bigint } & Record<string, unknown>>;
  };
  if (j.constructor === undefined || Number(j.constructor) !== 0 || !Array.isArray(j.fields) || j.fields.length < 2)
    throw new Error("not a CIP-68 datum (expected Constr 0 [metadata, version, extra])");
  const [m, v, extra] = j.fields;
  if (!m || !Array.isArray(m.map)) throw new Error("CIP-68 datum: metadata is not a map");
  const metadata: Record<string, string | bigint> = {};
  for (const { k, v: val } of m.map) {
    if (k.bytes === undefined) throw new Error("CIP-68 datum: non-bytes key");
    const key = Buffer.from(k.bytes, "hex").toString("utf8");
    if (val.bytes !== undefined) metadata[key] = Buffer.from(val.bytes, "hex").toString("utf8");
    else if (val.int !== undefined) metadata[key] = BigInt(val.int);
  }
  return { metadata, version: Number(v?.int ?? NaN), extra };
}

/** CIP-14 asset fingerprint (asset1…). */
export function assetFingerprint(policyId: string, assetNameHex: string): string {
  if (!/^[0-9a-f]{56}$/.test(policyId)) throw new Error("policyId must be 28-byte hex");
  if (!/^([0-9a-f]{2}){0,32}$/.test(assetNameHex)) throw new Error("assetNameHex must be ≤ 32 bytes of hex");
  return common.resolveFingerprint(policyId, assetNameHex);
}

/** Describe a tUSD unit for UIs: standard (CIP-68 333 or the deprecated plain name), CIP-14 fingerprint, ref NFT. */
export function tusdTokenFromUnit(unit: string): {
  unit: string;
  policyId: string;
  assetNameHex: string;
  standard: "CIP-68 (333)" | "legacy";
  fingerprint: string;
  referenceUnit?: string;
} {
  const u = unit.toLowerCase();
  const policyId = u.slice(0, 56);
  const assetNameHex = u.slice(56);
  const parsed = parseCip67(assetNameHex);
  const isFt = parsed?.label === CIP67_LABEL.FT;
  return {
    unit: u,
    policyId,
    assetNameHex,
    standard: isFt ? "CIP-68 (333)" : "legacy",
    fingerprint: assetFingerprint(policyId, assetNameHex),
    ...(isFt ? { referenceUnit: policyId + cip68AssetName(CIP67_LABEL.REFERENCE_NFT, parsed!.contentHex) } : {}),
  };
}

/** Mesh helpers re-exported for cross-checks in tests. */
export const meshCip68 = { CIP68_100: common.CIP68_100, CIP68_222: common.CIP68_222 };
