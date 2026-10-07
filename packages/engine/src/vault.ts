// Engine-side adapter for the Bulkhead Session Vault (walletMode "vault", docs/VAULT-SPEC.md).
// The engine never depends on the vault client's concrete types: it asks the Chain for these ops
// (chain.applyVaultParams + chain.tx.vaultFund/vaultPay/vaultRevoke/vaultRecover) and fails loudly when
// vault mode is requested on a chain that does not provide them. FakeChain (tests) and the real
// @bulkhead/chain client (wired in wire.ts) both satisfy this shape.
import type { Chain, FundingOutput, TxResult } from "@bulkhead/chain";
import type { WalletMode } from "@bulkhead/shared";

export interface VaultParamsInput {
  ownerAddress: string;
  captainKeyHash: string;
  sessionKeyHash: string;
  expiryMs: number;
  payees: string[];
  perTxMaxTusdMicro: bigint;
  adaAllowanceLovelace: bigint;
  tusdPolicyId: string;
  tusdAssetNameHex: string;
}
export interface AppliedVaultLike {
  scriptCbor: string;
  scriptHash: string;
  address: string;
}
export interface Metadata674 {
  session_id: string;
  log_sha256: string;
  /** sha256(utf8(handback text)) — the session's result, anchored on-chain (trust receipts). */
  handback_sha256: string;
  status: string;
  /** The session's goal id (trust receipts). */
  goal_id?: string;
}

export interface VaultOps {
  apply(p: VaultParamsInput): AppliedVaultLike;
  /** ONE treasury tx, one output per vault (inline datum Void); the builder adds min-ADA. */
  fund(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult>;
  /** Optional dedicated preview; else TxService.previewFunding is used (same totals). */
  preview?(args: { userId: string; outputs: FundingOutput[] }): Promise<{ feeLovelace: bigint; totalLovelace: bigint; totalTusdMicro: bigint }>;
  pay(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }): Promise<TxResult>;
  revoke(args: { sessionId: string; toAddress: string; metadata674: Metadata674 }): Promise<TxResult>;
  recover(args: { sessionId: string; signerKeyId?: string; metadata674?: Metadata674 }): Promise<TxResult>;
}

/** Hard cap from the spec (payees list is a plain list on-chain). */
export const MAX_VAULT_PAYEES = 10;
/** Fallback ada_allowance when protocol parameters are unavailable: 3 tADA. */
export const DEFAULT_ADA_ALLOWANCE = 3_000_000n;

type AnyFn = (...a: unknown[]) => unknown;
const fnOf = (o: unknown, k: string): AnyFn | null => {
  const v = o ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "function" ? (v as AnyFn).bind(o) : null;
};

/** The vault ops of a chain, or null when the chain has no Session Vault client. */
export function vaultOps(chain: Chain): VaultOps | null {
  const apply = fnOf(chain, "applyVaultParams");
  const fund = fnOf(chain.tx, "vaultFund");
  const pay = fnOf(chain.tx, "vaultPay");
  const revoke = fnOf(chain.tx, "vaultRevoke");
  const recover = fnOf(chain.tx, "vaultRecover");
  if (!apply || !fund || !pay || !revoke || !recover) return null;
  const preview = fnOf(chain.tx, "previewVaultFunding");
  return {
    apply: (p) => apply(p) as AppliedVaultLike,
    fund: (a) => fund(a) as Promise<TxResult>,
    ...(preview ? { preview: (a: { userId: string; outputs: FundingOutput[] }) => preview(a) as ReturnType<NonNullable<VaultOps["preview"]>> } : {}),
    pay: (a) => pay(a) as Promise<TxResult>,
    revoke: (a) => revoke(a) as Promise<TxResult>,
    recover: (a) => recover(a) as Promise<TxResult>,
  };
}

export function requireVault(chain: Chain): VaultOps {
  // Vault txs need script evaluation / cost models: Blockfrost (or Ogmios) only — Koios lacks fetchCostModels.
  if (chain.provider.name === "koios") throw new Error("walletMode \"vault\" needs Blockfrost (BLOCKFROST_PREPROD_PROJECT_ID): the Koios provider cannot evaluate Plutus scripts (no cost models)");
  const v = vaultOps(chain);
  if (!v) throw new Error("walletMode \"vault\" requested but this chain has no Session Vault client (applyVaultParams / tx.vaultFund/vaultPay/vaultRevoke/vaultRecover)");
  return v;
}

/** Can a self-custody (CIP-30) user get a Session Vault on this chain? Needs the vault client plus an unsigned
 * vault-funding builder and submitSigned (the browser wallet signs the funding tx). */
export function canSelfFundVaults(chain: Chain): boolean {
  return chain.provider.name !== "koios" && !!vaultOps(chain) && typeof chain.tx.buildUnsignedVaultFunding === "function" && typeof chain.tx.submitSigned === "function";
}

/** WALLET_MODE env → default mode for new sessions ("vault" unless set to "native"). */
export function walletModeFromEnv(env: NodeJS.ProcessEnv = process.env): WalletMode {
  return env.WALLET_MODE?.trim().toLowerCase() === "native" ? "native" : "vault";
}

/**
 * ada_allowance: the max lovelace that may leave a vault in ONE Pay tx. A Pay tx moves out the payee
 * output's min-ADA (an output with tUSD) plus the tx fee (paid from the vault; the captain only provides
 * collateral). From live protocol params:
 *   minAdaPayee   = coinsPerUtxoSize × (160 + 250)        (≈ 1.77 tADA at 4310: generous for addr + tUSD + datumless)
 *   feeHeadroom   = minFeeA × 16 384 + minFeeB            (fee of a max-size tx, ≈ 0.88 tADA)
 *   execHeadroom  = 0.35 tADA                              (Plutus ex-units of one validator run, well above measured)
 * → ≈ 3.0 tADA on preprod today. Fallback: 3 tADA. Rounded up to a whole 0.1 tADA.
 */
export function adaAllowanceFrom(params: unknown): bigint {
  const p = (params ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = Number(p[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return NaN;
  };
  const coins = num("coinsPerUtxoSize", "coins_per_utxo_size", "coinsPerUtxoByte");
  const a = num("minFeeA", "min_fee_a");
  const b = num("minFeeB", "min_fee_b");
  if (!Number.isFinite(coins) || !Number.isFinite(a) || !Number.isFinite(b)) return DEFAULT_ADA_ALLOWANCE;
  const total = coins * (160 + 250) + a * 16_384 + b + 350_000;
  const rounded = BigInt(Math.ceil(total / 100_000) * 100_000);
  return rounded < 2_000_000n ? 2_000_000n : rounded;
}

export function splitTusdUnit(unit: string): { policyId: string; assetNameHex: string } {
  return { policyId: unit.slice(0, 56), assetNameHex: unit.slice(56) };
}

/** VaultParams as stored in sessions.script_json (bigints as decimal strings). */
export function vaultParamsJson(p: VaultParamsInput): string {
  return JSON.stringify({ ...p, perTxMaxTusdMicro: p.perTxMaxTusdMicro.toString(), adaAllowanceLovelace: p.adaAllowanceLovelace.toString() });
}
export function parseVaultParams(json: string | null | undefined): VaultParamsInput | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (typeof o.ownerAddress !== "string" || o.perTxMaxTusdMicro === undefined) return null;
    return { ...(o as unknown as VaultParamsInput), perTxMaxTusdMicro: BigInt(String(o.perTxMaxTusdMicro)), adaAllowanceLovelace: BigInt(String(o.adaAllowanceLovelace)) };
  } catch {
    return null;
  }
}

/** A script failure from the Session Vault validator (evaluation or submission), as opposed to a build/network error. */
export function isScriptFailure(e: unknown): boolean {
  const x = e as { name?: string; code?: string; message?: string } | null;
  if (!x) return false;
  if (x.name === "VaultScriptError" || x.code === "SCRIPT_FAILED") return true;
  return /script|evaluat|validator|plutus|ExUnits|redeemer/i.test(String(x.message ?? ""));
}

/** vaultRecover only (scripts/recover.ts: no applyVaultParams needed — the vault is rebuilt from the DB row). */
export function vaultRecoverOf(chain: Chain): VaultOps["recover"] | null {
  const f = fnOf(chain.tx, "vaultRecover");
  return f ? (a) => f(a) as Promise<TxResult> : null;
}
