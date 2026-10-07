import { describe, expect, it } from "vitest";
import { settlementAssetFromEnv, settlementKindFromEnv, settlementTickerFromEnv, TUSDM_PREPROD } from "../src/index";

const TUSD = "7704eb3b92e66ff0b5fadcf9ad8db3f1f817cb9ce054d32a5c6eac30" + "0014df1074555344";

describe("settlement asset", () => {
  it("defaults to tUSDM (6 decimals, not operator-mintable)", () => {
    expect(settlementKindFromEnv({})).toBe("tusdm");
    expect(settlementTickerFromEnv({})).toBe("tUSDM");
    expect(settlementAssetFromEnv({})).toMatchObject({ kind: "tusdm", unit: TUSDM_PREPROD.unit, decimals: 6, operatorMintable: false });
  });
  it("tusd fallback needs the tUSD unit and is operator-mintable", () => {
    expect(settlementTickerFromEnv({ SETTLEMENT_ASSET: "TUSD" })).toBe("tUSD");
    expect(settlementAssetFromEnv({ SETTLEMENT_ASSET: "tusd" }, { tusdUnit: TUSD })).toMatchObject({ kind: "tusd", unit: TUSD, policyId: TUSD.slice(0, 56), operatorMintable: true });
    expect(() => settlementAssetFromEnv({ SETTLEMENT_ASSET: "tusd" })).toThrow(/tUSD unit/);
  });
  it("SETTLEMENT_UNIT wins; equal to tUSDM / tUSD maps to those kinds", () => {
    expect(settlementAssetFromEnv({ SETTLEMENT_ASSET: "tusd", SETTLEMENT_UNIT: TUSDM_PREPROD.unit.toUpperCase() }).kind).toBe("tusdm");
    expect(settlementAssetFromEnv({ SETTLEMENT_UNIT: TUSD }, { tusdUnit: TUSD }).kind).toBe("tusd");
    expect(() => settlementAssetFromEnv({ SETTLEMENT_UNIT: "xyz" })).toThrow(/SETTLEMENT_UNIT/);
    expect(() => settlementKindFromEnv({ SETTLEMENT_ASSET: "usdc" })).toThrow();
  });
});
