// Settlement asset: the one stablecoin unit every budget, funding output, vault param (tusd_policy / tusd_name),
// payment and balance in Bulkhead is denominated in. Pure TypeScript (no Node / Cardano imports) so the web UI can
// use it too.
//
// Default = Masumi/Sokosumi preprod tUSDM, so money earned on Sokosumi (paid by Masumi in tUSDM) can fund crews.
//   unit      16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde 0014df10 745553444d   (CIP-68 (333) "tUSDM")
//   decimals  6 (Blockfrost /assets onchain_metadata, CIP68v1; masumi-payment-service PREPROD_USDM_CONFIG)
// Fallback   = Bulkhead's self-minted tUSD (operator policy, CIP-68 (333) "tUSD"), SETTLEMENT_ASSET=tusd.
//
// The internal "micro" helpers (tusdToMicro / microToTusd, `tusdMicro` fields) keep their names: they mean
// "micro-units of the settlement asset". Every supported asset must have 6 decimals.

export const SETTLEMENT_DECIMALS = 6;

export type SettlementKind = "tusdm" | "tusd" | "custom";

export interface SettlementAsset {
  kind: SettlementKind;
  /** Display ticker ("tUSDM", "tUSD", …). */
  ticker: string;
  /** policyId (56 hex) + asset name hex. */
  unit: string;
  policyId: string;
  assetNameHex: string;
  decimals: number;
  /** True only for Bulkhead's own tUSD: the operator key can mint it on top-up. Every other asset must be held. */
  operatorMintable: boolean;
}

/** Masumi / Sokosumi preprod test stablecoin (Moneta tUSDM). VERIFIED on Blockfrost preprod (asset metadata decimals 6). */
export const TUSDM_PREPROD = {
  ticker: "tUSDM",
  policyId: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde",
  assetNameHex: "0014df10745553444d",
  unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d",
  fingerprint: "asset1mtjjpvfgtuxq3n872ptulrs25j0k4t8nd2pp2k",
  decimals: 6,
} as const;

export const DEFAULT_SETTLEMENT_TICKER = TUSDM_PREPROD.ticker;

export interface SettlementEnv {
  /** "tusdm" (default) | "tusd". */
  SETTLEMENT_ASSET?: string;
  /** Explicit unit override (policyId + asset name hex). Wins over SETTLEMENT_ASSET. */
  SETTLEMENT_UNIT?: string;
  /** Display ticker for a custom SETTLEMENT_UNIT. */
  SETTLEMENT_TICKER?: string;
}

const UNIT_RE = /^[0-9a-f]{56}[0-9a-f]{0,64}$/;

function splitUnit(unit: string): { policyId: string; assetNameHex: string } {
  return { policyId: unit.slice(0, 56), assetNameHex: unit.slice(56) };
}

function tusdAsset(tusdUnit: string): SettlementAsset {
  const unit = tusdUnit.trim().toLowerCase();
  if (!UNIT_RE.test(unit)) throw new Error("settlement: the tUSD unit is not a valid policyId+assetName hex unit");
  return { kind: "tusd", ticker: "tUSD", unit, ...splitUnit(unit), decimals: SETTLEMENT_DECIMALS, operatorMintable: true };
}

export function tusdmAsset(): SettlementAsset {
  return {
    kind: "tusdm",
    ticker: TUSDM_PREPROD.ticker,
    unit: TUSDM_PREPROD.unit,
    policyId: TUSDM_PREPROD.policyId,
    assetNameHex: TUSDM_PREPROD.assetNameHex,
    decimals: TUSDM_PREPROD.decimals,
    operatorMintable: false,
  };
}

/** Which asset kind the env selects, without needing the tUSD unit (cheap; usable in the browser). */
export function settlementKindFromEnv(env: SettlementEnv): SettlementKind {
  const unit = env.SETTLEMENT_UNIT?.trim().toLowerCase();
  if (unit) return unit === TUSDM_PREPROD.unit ? "tusdm" : "custom";
  const k = (env.SETTLEMENT_ASSET ?? "").trim().toLowerCase();
  if (k === "" || k === "tusdm") return "tusdm";
  if (k === "tusd") return "tusd";
  throw new Error(`SETTLEMENT_ASSET must be "tusdm" or "tusd" (got "${env.SETTLEMENT_ASSET}")`);
}

/** Display ticker for the configured settlement asset. */
export function settlementTickerFromEnv(env: SettlementEnv): string {
  const kind = settlementKindFromEnv(env);
  if (kind === "tusdm") return TUSDM_PREPROD.ticker;
  if (kind === "tusd") return "tUSD";
  return env.SETTLEMENT_TICKER?.trim() || "units";
}

/**
 * Resolve the settlement asset. `tusdUnit` is Bulkhead's own tUSD unit (operator policy); it is only needed when the
 * env selects tUSD (SETTLEMENT_ASSET=tusd, or a SETTLEMENT_UNIT equal to it).
 */
export function settlementAssetFromEnv(env: SettlementEnv, opts: { tusdUnit?: string | null } = {}): SettlementAsset {
  const kind = settlementKindFromEnv(env);
  if (kind === "tusdm") return tusdmAsset();
  if (kind === "tusd") {
    if (!opts.tusdUnit) throw new Error("SETTLEMENT_ASSET=tusd needs the tUSD unit (TUSD_UNIT or OPERATOR_MNEMONIC)");
    return tusdAsset(opts.tusdUnit);
  }
  const unit = env.SETTLEMENT_UNIT!.trim().toLowerCase();
  if (!UNIT_RE.test(unit)) throw new Error("SETTLEMENT_UNIT must be policyId (56 hex) + asset name hex");
  if (opts.tusdUnit && unit === opts.tusdUnit.trim().toLowerCase()) return tusdAsset(unit);
  return { kind: "custom", ticker: env.SETTLEMENT_TICKER?.trim() || "units", unit, ...splitUnit(unit), decimals: SETTLEMENT_DECIMALS, operatorMintable: false };
}
