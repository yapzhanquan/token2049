// Bulkhead Session Vault — parameters, applied script, redeemers, datum (docs/VAULT-SPEC.md).
//
// Parameters are applied off-chain per session with Mesh applyParamsToScript (type "JSON" Plutus data),
// IN THE BLUEPRINT ORDER: owner, captain_vkh, session_vkh, expiry, payees, per_tx_max_tusd,
// ada_allowance, tusd_policy, tusd_name. Vault address = applied script hash (payment) + the OWNER's
// stake credential (enterprise script address if the owner address has none). Network id 0 (preprod).
import { cst } from "../mesh";
import { VAULT_BLUEPRINT } from "./blueprint.generated";

/** Bump together with UNAPPLIED_VAULT_HASH whenever contracts/validators/session_vault.ak changes. */
export const VAULT_SCRIPT_VERSION = "1.0.0";
/** Unapplied validator hash of session_vault.session_vault.spend (contracts/plutus.json). Pinned by a test. */
export const UNAPPLIED_VAULT_HASH = "edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a";
export const VAULT_PLUTUS_VERSION = "V3" as const;
export const VAULT_AIKEN_VERSION: string = VAULT_BLUEPRINT.preamble.compiler.version;
export const MAX_VAULT_PAYEES = 10;

export interface VaultParams {
  ownerAddress: string; // bech32 addr_test1… (payment key + optional stake key)
  captainKeyHash: string; // hex 28 bytes
  sessionKeyHash: string; // hex 28 bytes
  expiryMs: number;
  payees: string[]; // bech32 addr_test1… — their PAYMENT credential is used (≤ 10)
  perTxMaxTusdMicro: bigint;
  adaAllowanceLovelace: bigint;
  tusdPolicyId: string;
  tusdAssetNameHex: string; // "0014df1074555344" (CIP-68 333 tUSD; legacy "74555344" deprecated)
}

export interface AppliedVault {
  scriptCbor: string; // applied script, double-CBOR (what Mesh txInScript takes)
  scriptHash: string;
  address: string;
  /** The 9 parameters as Mesh JSON Plutus data, in blueprint order. */
  paramsJson: unknown;
  /** The typed parameters this vault was built from. */
  params: VaultParams;
  /** Size in bytes of the applied (flat, single-CBOR-wrapped) script, as it appears in the witness set. */
  scriptSizeBytes: number;
}

/** JSON Plutus data (Mesh "JSON" builder type). */
export type PlutusJson =
  | { constructor: number; fields: PlutusJson[] }
  | { bytes: string }
  | { int: number | bigint }
  | { list: PlutusJson[] }
  | { map: Array<{ k: PlutusJson; v: PlutusJson }> };

/** Redeemers: type VaultAction { Pay | Revoke | Recover } → Constr 0/1/2 []. JSON Plutus data. */
export const VaultRedeemer = {
  Pay: { constructor: 0, fields: [] },
  Revoke: { constructor: 1, fields: [] },
  Recover: { constructor: 2, fields: [] },
} as const satisfies Record<string, PlutusJson>;
export type VaultAction = keyof typeof VaultRedeemer;

/** Inline datum on every vault output: Void (unit) = Constr 0 []. */
export const VAULT_DATUM_VOID = { constructor: 0, fields: [] } as const satisfies PlutusJson;

const HASH28 = /^[0-9a-f]{56}$/;
const HEX = /^([0-9a-f]{2})*$/;
const PREPROD_ADDR = /^addr_test1[02-9ac-hj-np-z]+$/;

export class VaultParamsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "VaultParamsError";
  }
}

interface Creds {
  payment: { type: "key" | "script"; hash: string };
  stake: { type: "key" | "script"; hash: string } | null;
}

/** Payment + stake credentials of a preprod Shelley address. */
export function addressCredentials(address: string): Creds {
  if (!PREPROD_ADDR.test(address)) throw new VaultParamsError(`not a preprod (addr_test1…) address: ${address.slice(0, 24)}…`);
  const d = cst.deserializeBech32Address(address);
  const payment = d.pubKeyHash ? { type: "key" as const, hash: d.pubKeyHash } : d.scriptHash ? { type: "script" as const, hash: d.scriptHash } : null;
  if (!payment) throw new VaultParamsError(`address has no payment credential: ${address.slice(0, 24)}…`);
  const stake = d.stakeCredentialHash
    ? { type: "key" as const, hash: d.stakeCredentialHash }
    : d.stakeScriptCredentialHash
      ? { type: "script" as const, hash: d.stakeScriptCredentialHash }
      : null;
  return { payment, stake };
}

const credJson = (c: { type: "key" | "script"; hash: string }): PlutusJson => ({ constructor: c.type === "key" ? 0 : 1, fields: [{ bytes: c.hash }] });

/** cardano/address.Address as JSON Plutus data: Constr 0 [Credential, Option<Referenced<Credential>>]. */
export function addressToPlutusJson(address: string): PlutusJson {
  const { payment, stake } = addressCredentials(address);
  const stakeJson: PlutusJson = stake
    ? { constructor: 0, fields: [{ constructor: 0, fields: [credJson(stake)] }] } // Some(Inline(cred))
    : { constructor: 1, fields: [] }; // None
  return { constructor: 0, fields: [credJson(payment), stakeJson] };
}

export function validateVaultParams(p: VaultParams): void {
  if (!PREPROD_ADDR.test(p.ownerAddress)) throw new VaultParamsError("ownerAddress must be a preprod addr_test1… address");
  for (const [k, v] of [
    ["captainKeyHash", p.captainKeyHash],
    ["sessionKeyHash", p.sessionKeyHash],
    ["tusdPolicyId", p.tusdPolicyId],
  ] as const)
    if (!HASH28.test(v)) throw new VaultParamsError(`${k} must be 28 bytes of lowercase hex`);
  if (!HEX.test(p.tusdAssetNameHex) || p.tusdAssetNameHex.length > 64) throw new VaultParamsError("tusdAssetNameHex must be ≤ 32 bytes of hex");
  if (!Number.isSafeInteger(p.expiryMs) || p.expiryMs <= 0) throw new VaultParamsError("expiryMs must be a positive integer (POSIX ms)");
  if (!Array.isArray(p.payees) || p.payees.length === 0) throw new VaultParamsError("payees must be a non-empty list");
  if (p.payees.length > MAX_VAULT_PAYEES) throw new VaultParamsError(`at most ${MAX_VAULT_PAYEES} payees`);
  for (const a of p.payees) addressCredentials(a);
  if (typeof p.perTxMaxTusdMicro !== "bigint" || p.perTxMaxTusdMicro < 0n) throw new VaultParamsError("perTxMaxTusdMicro must be a bigint ≥ 0");
  if (typeof p.adaAllowanceLovelace !== "bigint" || p.adaAllowanceLovelace < 0n) throw new VaultParamsError("adaAllowanceLovelace must be a bigint ≥ 0");
}

/** The 9 validator parameters as JSON Plutus data, in blueprint order. */
export function vaultParamsToPlutusJson(p: VaultParams): PlutusJson[] {
  validateVaultParams(p);
  // Distinct payment credentials, in the given order (duplicates add cost, not permissions).
  const seen = new Set<string>();
  const payees: PlutusJson[] = [];
  for (const a of p.payees) {
    const c = addressCredentials(a).payment;
    const k = `${c.type}:${c.hash}`;
    if (!seen.has(k)) {
      seen.add(k);
      payees.push(credJson(c));
    }
  }
  return [
    addressToPlutusJson(p.ownerAddress),
    { bytes: p.captainKeyHash },
    { bytes: p.sessionKeyHash },
    { int: p.expiryMs },
    { list: payees },
    { int: p.perTxMaxTusdMicro },
    { int: p.adaAllowanceLovelace },
    { bytes: p.tusdPolicyId },
    { bytes: p.tusdAssetNameHex },
  ];
}

/** Applied script → (double-CBOR) scriptCbor + hash + address. */
export function applyVaultParams(p: VaultParams): AppliedVault {
  const paramsJson = vaultParamsToPlutusJson(p);
  // applyParamsToScript takes the blueprint's compiledCode and returns the double-CBOR applied script.
  // Mesh's JSON → PlutusData conversion takes number | bigint for `int`.
  const scriptCbor = cst.applyParamsToScript(VAULT_BLUEPRINT.compiledCode, paramsJson as object[], "JSON");
  const script = cst.deserializePlutusScript(scriptCbor, VAULT_PLUTUS_VERSION);
  const scriptHash = script.hash().toString();
  const stake = addressCredentials(p.ownerAddress).stake;
  const address = cst.serializeAddress(
    stake == null
      ? { scriptHash }
      : stake.type === "key"
        ? { scriptHash, stakeCredentialHash: stake.hash }
        : { scriptHash, stakeScriptCredentialHash: stake.hash },
    0,
  );
  const scriptSizeBytes = cst.normalizePlutusScript(scriptCbor, "SingleCBOR").length / 2;
  return { scriptCbor, scriptHash, address, paramsJson, params: { ...p, payees: [...p.payees] }, scriptSizeBytes };
}

/** Hash of the embedded, unapplied blueprint script (must equal UNAPPLIED_VAULT_HASH). */
export function unappliedVaultHash(): string {
  return cst.deserializePlutusScript(cst.normalizePlutusScript(VAULT_BLUEPRINT.compiledCode, "DoubleCBOR"), VAULT_PLUTUS_VERSION).hash().toString();
}

// ── persistence (sessions.script_json): VaultParams with bigints as decimal strings ─────────────
export type VaultParamsJson = Omit<VaultParams, "perTxMaxTusdMicro" | "adaAllowanceLovelace"> & {
  perTxMaxTusdMicro: string;
  adaAllowanceLovelace: string;
};

export function vaultParamsToJson(p: VaultParams): VaultParamsJson {
  return { ...p, payees: [...p.payees], perTxMaxTusdMicro: p.perTxMaxTusdMicro.toString(), adaAllowanceLovelace: p.adaAllowanceLovelace.toString() };
}

/** Parse VaultParams from a JSON string or object (bigints as decimal strings or numbers). */
export function vaultParamsFromJson(raw: string | Record<string, unknown>): VaultParams {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const big = (v: unknown, k: string): bigint => {
    if (typeof v === "bigint") return v;
    if ((typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v))) return BigInt(v);
    throw new VaultParamsError(`vault params: ${k} must be a decimal integer`);
  };
  const p: VaultParams = {
    ownerAddress: String(o.ownerAddress ?? ""),
    captainKeyHash: String(o.captainKeyHash ?? ""),
    sessionKeyHash: String(o.sessionKeyHash ?? ""),
    expiryMs: Number(o.expiryMs),
    payees: Array.isArray(o.payees) ? o.payees.map(String) : [],
    perTxMaxTusdMicro: big(o.perTxMaxTusdMicro, "perTxMaxTusdMicro"),
    adaAllowanceLovelace: big(o.adaAllowanceLovelace, "adaAllowanceLovelace"),
    tusdPolicyId: String(o.tusdPolicyId ?? ""),
    tusdAssetNameHex: String(o.tusdAssetNameHex ?? ""),
  };
  validateVaultParams(p);
  return p;
}

/** True if `x` looks like serialized VaultParams (used to tell vault rows from native-script rows). */
export function isVaultParamsJson(x: unknown): boolean {
  try {
    const o = typeof x === "string" ? JSON.parse(x) : x;
    return !!o && typeof o === "object" && "sessionKeyHash" in o && "perTxMaxTusdMicro" in o && "payees" in o;
  } catch {
    return false;
  }
}
