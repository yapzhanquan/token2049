// Bulkhead Session Vault — Mesh tx builders (pure: no network; the caller passes UTxOs, protocol params,
// cost models and an evaluator).
//
// Shape of every vault tx:
//   inputs      = vault UTxOs only (each: PlutusV3 spend, inline datum present, redeemer, script attached)
//   collateral  = ONE ADA-only UTxO of the collateral provider (captain by default) + collateral return to it
//   outputs     = Pay:     payee output + continuing output back to the vault (inline datum Void)
//                 Revoke:  everything (minus fee) → owner address
//                 Recover: everything (minus fee) → owner address
//   fee         = paid from the vault's lovelace (counted against ada_allowance for Pay)
//   signers     = Pay: session key (required signer); Revoke: captain (required signer);
//                 Recover: nobody required (the collateral provider's key witnesses its collateral input)
//   validity    = Pay: invalidHereafter = ttlSlot (POSIX(ttlSlot) ≤ expiry);  Recover: invalidBefore = slotOf(expiry)+1
//
// Mesh's change-output balancing cannot put an inline datum on the change, so we balance ourselves:
// fixed outputs + one "remainder" output, completeUnbalanced(), and a fee fixpoint using Mesh's own
// fee calculation (mock vkey witnesses + redeemer prices). Exec units come from the evaluator.
import type { Asset, Utxo } from "../types";
import { cst, MeshTxBuilder, SLOT_CONFIG_NETWORK, slotToBeginUnixTime, unixTimeToEnclosingSlot, type MeshProtocol, type MeshTxBuilderT } from "../mesh";
import { VAULT_DATUM_VOID, VaultRedeemer, type AppliedVault, type VaultAction } from "./params";

export interface ExBudget {
  mem: number;
  steps: number;
}

/** Returns one budget per SPEND redeemer, by redeemer index (= position of the input in the sorted input set). */
export type VaultEvaluator = (unsignedTxHex: string, spent: Utxo[], collateral: Utxo[]) => Promise<Array<{ index: number; budget: ExBudget }>>;

/** The script failed (evaluation or submission). `code` = SCRIPT_FAILED. */
export class VaultScriptError extends Error {
  readonly code = "SCRIPT_FAILED";
  constructor(
    msg: string,
    readonly detail?: string,
  ) {
    super(msg);
    this.name = "VaultScriptError";
  }
}

export interface VaultTxResult {
  unsignedTx: string;
  txHash: string;
  feeLovelace: bigint;
  /** Exec units declared per redeemer (index order). */
  exUnits: ExBudget[];
  /** Exec units as measured by the evaluator (before the safety margin), if it ran. */
  measured?: ExBudget[];
  txSizeBytes: number;
  totalCollateral: bigint;
}

export interface VaultBuildCommon {
  vault: AppliedVault;
  /** Vault UTxOs to spend (all must sit at the vault script's payment credential). */
  utxos: Utxo[];
  /** One ADA-only UTxO of the collateral provider (captain by default). Its address gets the collateral return. */
  collateral: Utxo;
  /** Live protocol parameters (Mesh shape). */
  protocolParams: MeshProtocol;
  /** Live cost models [V1, V2, V3] (script integrity hash!). Default: Mesh's built-in lists. */
  costModels?: number[][];
  /** Measures exec units. Required unless `exUnits` is given. */
  evaluate?: VaultEvaluator;
  /** Fixed exec units per input — skips evaluation (used by demo:attack-onchain to build a tx the script rejects). */
  exUnits?: ExBudget;
  /** Upper validity slot (TTL). */
  ttlSlot?: number;
}

export interface BuildVaultPayArgs extends VaultBuildCommon {
  payee: string;
  tusdMicro: bigint;
  /** Lovelace for the payee output beyond its min-ADA. Default 0. */
  lovelace?: bigint;
  memo?: string;
  reference?: string;
  /** Must be the vault address (continuing output). Kept explicit to mirror the spec signature. */
  changeTo?: string;
  ttlSlot: number;
}

export interface Metadata674 {
  session_id: string;
  log_sha256: string;
  handback_sha256: string;
  status: string;
}

export interface BuildVaultRevokeArgs extends VaultBuildCommon {
  ownerAddress: string;
  metadata674: Metadata674;
  /** Extra signer key hashes (e.g. none). The captain key hash is always required. */
  ttlSlot?: number;
}

export interface BuildVaultRecoverArgs extends VaultBuildCommon {
  ownerAddress: string;
  validFromSlot: number;
  metadata674?: Partial<Metadata674> & Record<string, string>;
}

// Mesh deep-clones builder bodies with json-bigint, which rejects a "constructor" key: pass JSON strings.
const VOID_STR = JSON.stringify(VAULT_DATUM_VOID);
const REDEEMER_STR = { Pay: JSON.stringify(VaultRedeemer.Pay), Revoke: JSON.stringify(VaultRedeemer.Revoke), Recover: JSON.stringify(VaultRedeemer.Recover) };
const DEFAULT_EX: ExBudget = { mem: 4_000_000, steps: 1_500_000_000 };
const EX_MARGIN_NUM = 110n; // +10 %
const tusdUnitOf = (v: AppliedVault) => v.params.tusdPolicyId + v.params.tusdAssetNameHex;

/** Slot whose start is ≤ t (POSIX ms). */
export const slotAtOrBefore = (ms: number): number => unixTimeToEnclosingSlot(ms, SLOT_CONFIG_NETWORK.preprod);
export const slotStartMs = (slot: number): number => slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK.preprod);

/** Pay TTL: min(slotOf(expiry), tip + ttlSlots) — the tx upper bound POSIX(ttl) is then ≤ expiry. */
export function vaultPayTtlSlot(expiryMs: number, tipSlot: number, ttlSlots = 900): number {
  const s = Math.min(slotAtOrBefore(expiryMs), tipSlot + ttlSlots);
  if (slotStartMs(s) > expiryMs) throw new Error("internal: pay TTL beyond expiry");
  return s;
}

/** Recover lower bound: first slot whose start is strictly after expiry. */
export function vaultRecoverFromSlot(expiryMs: number): number {
  let s = slotAtOrBefore(expiryMs) + 1;
  while (slotStartMs(s) <= expiryMs) s++;
  return s;
}

function sum(utxos: Utxo[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const u of utxos) for (const a of u.amount) m.set(a.unit, (m.get(a.unit) ?? 0n) + BigInt(a.quantity));
  return m;
}

function sub(m: Map<string, bigint>, assets: Asset[]): Map<string, bigint> {
  const r = new Map(m);
  for (const a of assets) r.set(a.unit, (r.get(a.unit) ?? 0n) - BigInt(a.quantity));
  return r;
}

function toAssets(m: Map<string, bigint>): Asset[] {
  const lovelace = m.get("lovelace") ?? 0n;
  const tokens = [...m.entries()].filter(([u, q]) => u !== "lovelace" && q !== 0n);
  return [{ unit: "lovelace", quantity: lovelace.toString() }, ...tokens.map(([unit, q]) => ({ unit, quantity: q.toString() }))];
}

const sortUtxos = (us: Utxo[]) => [...us].sort((a, b) => (a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1));

/** Split a string into ≤ 64-byte UTF-8 chunks (metadata string limit). */
function chunk64(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, "utf8") > 64) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

interface Spec {
  common: VaultBuildCommon;
  action: VaultAction;
  fixedOutputs: Array<{ address: string; amount: Asset[] }>;
  remainder: { address: string; inlineVoid: boolean };
  requiredSigners: string[];
  invalidBefore?: number;
  invalidHereafter?: number;
  metadata674?: object;
}

function assertVaultUtxos(v: AppliedVault, utxos: Utxo[]): void {
  if (utxos.length === 0) throw new Error("no vault UTxOs to spend");
  for (const u of utxos) {
    let h: string;
    try {
      h = cst.deserializeBech32Address(u.address).scriptHash;
    } catch {
      h = "";
    }
    if (h !== v.scriptHash) throw new Error(`UTxO ${u.txHash}#${u.outputIndex} is not at the vault script ${v.scriptHash}`);
  }
}

function assertCollateral(c: Utxo): void {
  if (c.amount.some((a) => a.unit !== "lovelace")) throw new Error("collateral UTxO must be ADA-only");
}

async function assemble(spec: Spec): Promise<VaultTxResult> {
  const { common } = spec;
  assertVaultUtxos(common.vault, common.utxos);
  assertCollateral(common.collateral);
  const inputs = sortUtxos(common.utxos);
  const pp = common.protocolParams;
  const totalIn = sum(inputs);
  const fixed = spec.fixedOutputs.reduce((m, o) => sub(m, o.amount), totalIn);
  const collateralLovelace = BigInt(common.collateral.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");

  let ex: ExBudget[] = inputs.map(() => common.exUnits ?? DEFAULT_EX);
  let measured: ExBudget[] | undefined;
  let evaluated = !!common.exUnits;
  if (!evaluated && !common.evaluate) throw new Error("buildVault*: pass `evaluate` (or fixed `exUnits`)");
  let fee = 400_000n;

  const build = (feeNow: bigint): { b: MeshTxBuilderT; hex: string; totalCollateral: bigint } => {
    const b = new MeshTxBuilder({ params: pp });
    if (common.costModels) b.setNetwork(common.costModels);
    inputs.forEach((u, i) => {
      b.spendingPlutusScriptV3()
        .txIn(u.txHash, u.outputIndex, u.amount, u.address, 0)
        .txInInlineDatumPresent()
        .txInRedeemerValue(REDEEMER_STR[spec.action], "JSON", ex[i])
        .txInScript(common.vault.scriptCbor);
    });
    for (const o of spec.fixedOutputs) b.txOut(o.address, o.amount);
    const rem = sub(fixed, [{ unit: "lovelace", quantity: feeNow.toString() }]);
    for (const [u, q] of rem) if (q < 0n) throw new Error(`vault UTxOs do not cover the outputs + fee (short ${-q} ${u})`);
    const remAssets = toAssets(rem);
    const remEmpty = remAssets.every((a) => a.quantity === "0");
    if (!remEmpty) {
      b.txOut(spec.remainder.address, remAssets);
      if (spec.remainder.inlineVoid) b.txOutInlineDatumValue(VOID_STR, "JSON");
    }
    const c = common.collateral;
    const totalCollateral = (feeNow * BigInt(pp.collateralPercent) + 99n) / 100n;
    if (collateralLovelace < totalCollateral + 1_000_000n) throw new Error(`collateral UTxO too small (${collateralLovelace} lovelace)`);
    b.txInCollateral(c.txHash, c.outputIndex, c.amount, c.address).setTotalCollateral(totalCollateral.toString()).setCollateralReturnAddress(c.address);
    for (const k of spec.requiredSigners) b.requiredSignerHash(k);
    if (spec.invalidBefore != null) b.invalidBefore(spec.invalidBefore);
    if (spec.invalidHereafter != null) b.invalidHereafter(spec.invalidHereafter);
    if (spec.metadata674) b.metadataValue(674, spec.metadata674);
    b.setFee(feeNow.toString());
    b.changeAddress(spec.remainder.address);
    const hex = b.completeUnbalanced();
    if (!remEmpty) {
      const min = b.calculateMinLovelaceForOutput({
        address: spec.remainder.address,
        amount: remAssets,
        ...(spec.remainder.inlineVoid ? { datum: { type: "Inline" as const, data: { type: "JSON" as const, content: VOID_STR } } } : {}),
      });
      if ((rem.get("lovelace") ?? 0n) < min)
        throw new Error(`remaining vault output would hold ${rem.get("lovelace") ?? 0n} lovelace < min-ADA ${min}; the vault needs more ADA`);
    }
    return { b, hex, totalCollateral };
  };

  for (let iter = 0; iter < 8; iter++) {
    const { b, hex, totalCollateral } = build(fee);
    if (!evaluated) {
      let res: Array<{ index: number; budget: ExBudget }>;
      try {
        res = await common.evaluate!(hex, inputs, [common.collateral]);
      } catch (e) {
        throw new VaultScriptError(`Session Vault script rejected the ${spec.action} tx at evaluation: ${(e as Error).message}`, (e as Error).message);
      }
      measured = inputs.map((_, i) => {
        const r = res.find((x) => x.index === i);
        if (!r) throw new VaultScriptError(`evaluator returned no budget for spend redeemer ${i}`);
        return r.budget;
      });
      ex = measured.map((m) => ({
        mem: Number((BigInt(m.mem) * EX_MARGIN_NUM) / 100n) + 1_000,
        steps: Number((BigInt(m.steps) * EX_MARGIN_NUM) / 100n) + 100_000,
      }));
      evaluated = true;
      fee = b.calculateFee();
      continue;
    }
    const need = b.calculateFee();
    if (need <= fee && fee - need <= 5_000n) {
      return {
        unsignedTx: hex,
        txHash: cst.resolveTxHash(hex),
        feeLovelace: fee,
        exUnits: ex,
        measured,
        txSizeBytes: hex.length / 2,
        totalCollateral,
      };
    }
    fee = need + 300n; // tiny slack so a fee-digit change converges (and never overpay by > 5k)
  }
  throw new Error("vault tx fee did not converge");
}

/** Session key pays an allowed payee; the rest returns to the vault with inline datum Void. */
export async function buildVaultPay(a: BuildVaultPayArgs): Promise<VaultTxResult> {
  const v = a.vault;
  if (a.changeTo && a.changeTo !== v.address) throw new Error("buildVaultPay: changeTo must be the vault address");
  if (a.tusdMicro <= 0n) throw new Error("buildVaultPay: tusdMicro must be > 0");
  if (!/^addr_test1/.test(a.payee)) throw new Error("buildVaultPay: payee must be a preprod address");
  const unit = tusdUnitOf(v);
  const tokens: Asset[] = [{ unit, quantity: a.tusdMicro.toString() }];
  const probe = new MeshTxBuilder({ params: a.protocolParams });
  let lov = 1_000_000n + (a.lovelace ?? 0n);
  for (let i = 0; i < 4; i++) {
    const min = probe.calculateMinLovelaceForOutput({ address: a.payee, amount: [{ unit: "lovelace", quantity: lov.toString() }, ...tokens] });
    const want = min + (a.lovelace ?? 0n);
    if (want === lov) break;
    lov = want;
  }
  const meta = [a.reference, a.memo].filter((s): s is string => !!s).flatMap(chunk64);
  return assemble({
    common: a,
    action: "Pay",
    fixedOutputs: [{ address: a.payee, amount: [{ unit: "lovelace", quantity: lov.toString() }, ...tokens] }],
    remainder: { address: v.address, inlineVoid: true },
    requiredSigners: [v.params.sessionKeyHash],
    invalidHereafter: a.ttlSlot,
    metadata674: meta.length ? { msg: meta } : undefined,
  });
}

function closeMeta(m: Record<string, string> | undefined, title: string): object {
  for (const [k, val] of Object.entries(m ?? {})) if (Buffer.byteLength(val, "utf8") > 64) throw new Error(`metadata field ${k} exceeds 64 bytes`);
  return { msg: [title], ...(m ?? {}) };
}

/** Captain sweeps every given vault UTxO to the owner address (metadata 674 with the close hashes). */
export async function buildVaultRevoke(a: BuildVaultRevokeArgs): Promise<VaultTxResult> {
  if (a.ownerAddress !== a.vault.params.ownerAddress) throw new Error("buildVaultRevoke: ownerAddress must be the vault's owner address");
  return assemble({
    common: a,
    action: "Revoke",
    fixedOutputs: [],
    remainder: { address: a.ownerAddress, inlineVoid: false },
    requiredSigners: [a.vault.params.captainKeyHash],
    invalidHereafter: a.ttlSlot,
    metadata674: closeMeta(a.metadata674 as unknown as Record<string, string>, "Bulkhead session close (vault revoke)"),
  });
}

/** Anyone sweeps the vault to the owner once the tx lower bound is strictly after expiry. */
export async function buildVaultRecover(a: BuildVaultRecoverArgs): Promise<VaultTxResult> {
  if (a.ownerAddress !== a.vault.params.ownerAddress) throw new Error("buildVaultRecover: ownerAddress must be the vault's owner address");
  if (slotStartMs(a.validFromSlot) <= a.vault.params.expiryMs) throw new Error("buildVaultRecover: validFromSlot must start strictly after expiry");
  return assemble({
    common: a,
    action: "Recover",
    fixedOutputs: [],
    remainder: { address: a.ownerAddress, inlineVoid: false },
    requiredSigners: [],
    invalidBefore: a.validFromSlot,
    invalidHereafter: a.ttlSlot,
    metadata674: closeMeta(a.metadata674 as Record<string, string> | undefined, "Bulkhead session recover (vault, after expiry)"),
  });
}

// ── evaluators ───────────────────────────────────────────────────────────────────────────────

/** Adapt ChainProvider.evaluateTx (Blockfrost /utils/txs/evaluate, Ogmios v5 shape) to a VaultEvaluator. */
export function providerEvaluator(evaluateTx: (cbor: string) => Promise<unknown[]>): VaultEvaluator {
  return async (hex) => {
    const rows = (await evaluateTx(hex)) as Array<{ redeemer: string; budget: { memory?: number; mem?: number; steps?: number; cpu?: number } }>;
    return rows
      .filter((r) => /^spend:\d+$/.test(r.redeemer))
      .map((r) => ({ index: Number(r.redeemer.split(":")[1]), budget: { mem: Number(r.budget.memory ?? r.budget.mem), steps: Number(r.budget.steps ?? r.budget.cpu) } }));
  };
}

/**
 * Offline evaluator (Mesh core-cst OfflineEvaluatorScalus): runs the real UPLC with the given UTxOs
 * (vault inputs are assumed to carry inline datum Void). Used by unit tests; no network.
 */
export function offlineEvaluator(costModels?: number[][]): VaultEvaluator {
  return async (hex, spent, collateral) => {
    const fetcher = {
      fetchUTxOs: async () => {
        throw new Error("offlineEvaluator: unknown UTxO");
      },
    } as unknown as ConstructorParameters<typeof cst.OfflineEvaluatorScalus>[0];
    const { slotLength, zeroSlot, zeroTime } = SLOT_CONFIG_NETWORK.preprod;
    const ev = new cst.OfflineEvaluatorScalus(fetcher, "preprod", { slotLength, zeroSlot, zeroTime }, costModels);
    const additional = spent.map((u) => ({
      input: { txHash: u.txHash, outputIndex: u.outputIndex },
      output: { address: u.address, amount: u.amount, plutusData: "d87980" },
    }));
    for (const u of collateral) additional.push({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } } as (typeof additional)[number]);
    const res = await ev.evaluateTx(hex, additional);
    return res.filter((r) => r.tag === "SPEND").map((r) => ({ index: r.index, budget: { mem: Number(r.budget.mem), steps: Number(r.budget.steps) } }));
  };
}
