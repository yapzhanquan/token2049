// Session wallet = native-script address (spec §3.2, Tier 1).
//
//   any[
//     all[ sig(session), before(expirySlot) ],   // session spends only while tx TTL ≤ expirySlot
//     sig(captain),                              // orchestrator can revoke/sweep any time
//     all[ sig(owner),   after(expirySlot)  ]    // owner recovers once tx validity start ≥ expirySlot
//   ]
//
// Cardano timelock semantics (Allegra+), which the builder must respect:
//   {type:"before", slot:s}  = RequireTimeExpire s  (CBOR tag 5, "invalid_hereafter"): satisfied iff the tx
//                              sets invalidHereafter (TTL) and TTL ≤ s.  → sessionPay sets TTL ≤ expirySlot.
//   {type:"after",  slot:s}  = RequireTimeStart s   (CBOR tag 4, "invalid_before"): satisfied iff the tx sets
//                              invalidBefore and invalidBefore ≥ s.      → owner sweep sets invalidBefore = expirySlot
//                              and can only be submitted once the chain tip has reached it.
// Address = script payment credential + the owner's stake KEY credential (when present), so idle funds
// stay delegated to the owner. Network id 0 (preprod).
import type { SessionScript, SessionScriptParams } from "./types";
import { cst, type MeshNativeScript } from "./mesh";
import { cip68AssetName, CIP67_LABEL } from "./cip68";

const HASH28 = /^[0-9a-f]{56}$/;

export function sessionNativeScript(p: SessionScriptParams): MeshNativeScript {
  for (const [k, v] of [
    ["sessionKeyHash", p.sessionKeyHash],
    ["captainKeyHash", p.captainKeyHash],
    ["ownerKeyHash", p.ownerKeyHash],
  ] as const) {
    if (!HASH28.test(v)) throw new Error(`${k} must be a 28-byte lowercase hex key hash`);
  }
  if (!Number.isSafeInteger(p.expirySlot) || p.expirySlot <= 0) throw new Error("expirySlot must be a positive integer slot");
  const slot = String(p.expirySlot);
  return {
    type: "any",
    scripts: [
      { type: "all", scripts: [{ type: "sig", keyHash: p.sessionKeyHash }, { type: "before", slot }] },
      { type: "sig", keyHash: p.captainKeyHash },
      { type: "all", scripts: [{ type: "sig", keyHash: p.ownerKeyHash }, { type: "after", slot }] },
    ],
  };
}

export function buildSessionScript(p: SessionScriptParams): SessionScript {
  const scriptJson = sessionNativeScript(p);
  if (p.ownerStakeKeyHash != null && p.ownerStakeKeyHash !== "" && !HASH28.test(p.ownerStakeKeyHash))
    throw new Error("ownerStakeKeyHash must be a 28-byte lowercase hex key hash");
  const scriptCbor = cst.toNativeScript(scriptJson).toCbor().toString();
  const scriptHash = cst.resolveNativeScriptHash(scriptJson);
  const address = cst.serializeAddress(
    p.ownerStakeKeyHash ? { scriptHash, stakeCredentialHash: p.ownerStakeKeyHash } : { scriptHash },
    0,
  );
  return { scriptJson, scriptCbor, scriptHash, address };
}

/** Native minting policy for tUSD: sig(operator). Ongoing supply controlled by the operator key. */
export function tusdPolicy(operatorKeyHash: string): { scriptJson: MeshNativeScript; scriptCbor: string; policyId: string } {
  if (!HASH28.test(operatorKeyHash)) throw new Error("operatorKeyHash must be a 28-byte hex key hash");
  const scriptJson: MeshNativeScript = { type: "sig", keyHash: operatorKeyHash };
  return { scriptJson, scriptCbor: cst.toNativeScript(scriptJson).toCbor().toString(), policyId: cst.resolveNativeScriptHash(scriptJson) };
}

// ── tUSD = CIP-68 fungible token (label 333) + its reference NFT (label 100), same operator policy ─────────
// Asset names (CIP-67 prefix + content "tUSD" = 74555344):
//   user token (the fungible supply everything pays with)  0014df10 74555344
//   reference NFT (inline-datum metadata, at the operator)  000643b0 74555344
// The reference NFT is held at the OPERATOR address (demo simplification): production would lock it at a script
// (e.g. an always-fail script for immutable metadata, or an update validator). See packages/chain/src/cip68.ts.
export const TUSD_ASSET_NAME = "tUSD"; // ticker / display name (the CIP-68 content part)
export const TUSD_CONTENT_HEX = Buffer.from(TUSD_ASSET_NAME, "utf8").toString("hex"); // 74555344
export const TUSD_ASSET_NAME_HEX = cip68AssetName(CIP67_LABEL.FT, TUSD_CONTENT_HEX); // 0014df1074555344
export const TUSD_REF_ASSET_NAME_HEX = cip68AssetName(CIP67_LABEL.REFERENCE_NFT, TUSD_CONTENT_HEX); // 000643b074555344
/**
 * @deprecated Pre-CIP-68 tUSD asset name (plain "tUSD", no label). Only read to report / migrate balances minted
 * before the switch (Balance.legacyTusdMicro, MeshTxService.migrateLegacyTusd). Never minted or paid any more.
 */
export const LEGACY_TUSD_ASSET_NAME_HEX = TUSD_CONTENT_HEX;
/** CIP-68 (333) metadata carried by the reference NFT's inline datum. */
export const TUSD_METADATA = {
  name: "Bulkhead test USD",
  description: "Bulkhead preprod test stablecoin (1 tUSD = 1,000,000 micro). Testnet only, no value.",
  ticker: "tUSD",
  decimals: 6,
} as const;

/** policyId + legacy name → policyId + CIP-68 (333) name; any other unit is returned unchanged. */
export function normalizeTusdUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (/^[0-9a-f]{56}$/.test(u.slice(0, 56)) && u.slice(56) === LEGACY_TUSD_ASSET_NAME_HEX) return u.slice(0, 56) + TUSD_ASSET_NAME_HEX;
  return unit.trim();
}
