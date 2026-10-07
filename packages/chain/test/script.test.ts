import { describe, expect, it } from "vitest";
import { buildSessionScript, sessionNativeScript, tusdPolicy, TUSD_ASSET_NAME_HEX } from "../src/script";
import { cst } from "../src/mesh";

const S = "11".repeat(28);
const C = "22".repeat(28);
const O = "33".repeat(28);
const STAKE = "44".repeat(28);

describe("session native script (spec §3.2)", () => {
  it("has exactly the any[ all[sig(session), before], sig(captain), all[sig(owner), after] ] shape", () => {
    expect(sessionNativeScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 120_000_000 })).toEqual({
      type: "any",
      scripts: [
        { type: "all", scripts: [{ type: "sig", keyHash: S }, { type: "before", slot: "120000000" }] },
        { type: "sig", keyHash: C },
        { type: "all", scripts: [{ type: "sig", keyHash: O }, { type: "after", slot: "120000000" }] },
      ],
    });
  });

  it("encodes before → invalid_hereafter (tag 5) and after → invalid_before (tag 4)", () => {
    const s = buildSessionScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 120_000_000 });
    // 120000000 = 0x07270e00 → 1a07270e00
    expect(s.scriptCbor).toBe(
      "8202" + "83" +
        "8201" + "82" + "8200581c" + S + "82051a07270e00" +
        "8200581c" + C +
        "8201" + "82" + "8200581c" + O + "82041a07270e00",
    );
  });

  it("hash is stable and matches the CBOR", () => {
    const p = { sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 120_000_000 };
    const a = buildSessionScript(p);
    const b = buildSessionScript({ ...p });
    expect(a.scriptHash).toBe(b.scriptHash);
    expect(a.scriptHash).toMatch(/^[0-9a-f]{56}$/);
    expect(cst.deserializeNativeScript(a.scriptCbor).hash().toString()).toBe(a.scriptHash);
    expect(buildSessionScript({ ...p, expirySlot: 120_000_001 }).scriptHash).not.toBe(a.scriptHash);
    expect(buildSessionScript({ ...p, sessionKeyHash: "55".repeat(28) }).scriptHash).not.toBe(a.scriptHash);
  });

  it("address = script payment credential + owner stake key (preprod)", () => {
    const s = buildSessionScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 1000, ownerStakeKeyHash: STAKE });
    expect(s.address.startsWith("addr_test1z")).toBe(true); // header type 1: script payment, key stake, testnet
    const d = cst.deserializeBech32Address(s.address);
    expect(d.scriptHash).toBe(s.scriptHash);
    expect(d.stakeCredentialHash).toBe(STAKE);
    expect(d.pubKeyHash).toBe("");
  });

  it("address without owner stake = enterprise script address", () => {
    const s = buildSessionScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 1000, ownerStakeKeyHash: null });
    expect(s.address.startsWith("addr_test1w")).toBe(true);
    expect(cst.deserializeBech32Address(s.address).scriptHash).toBe(s.scriptHash);
  });

  it("rejects malformed key hashes / slots", () => {
    expect(() => buildSessionScript({ sessionKeyHash: "zz", captainKeyHash: C, ownerKeyHash: O, expirySlot: 1 })).toThrow();
    expect(() => buildSessionScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 0 })).toThrow();
    expect(() => buildSessionScript({ sessionKeyHash: S, captainKeyHash: C, ownerKeyHash: O, expirySlot: 5, ownerStakeKeyHash: "12" })).toThrow();
  });

  it("tUSD policy = sig(operator), asset name CIP-68 (333) 'tUSD'", () => {
    const p = tusdPolicy(O);
    expect(p.scriptJson).toEqual({ type: "sig", keyHash: O });
    expect(p.scriptCbor).toBe("8200581c" + O);
    expect(TUSD_ASSET_NAME_HEX).toBe("0014df1074555344");
  });
});
