// Independent trust-receipt verifier. Runs IN THE BROWSER and does not trust the engine:
//   1. recomputes the applied Session Vault script hash + address from the proof's typed params with Mesh
//      applyParamsToScript over the compiled code of OUR OWN copy of the blueprint (contracts/plutus.json,
//      bundled at build time) — never a hash the engine reports;
//   2. reads the chain directly (Blockfrost, through the read-only /api/chain proxy that only adds the key);
//   3. compares, client-side, every claim in VERIFY_CLAIMS (@bulkhead/shared proof.ts).
//
// References: Mesh `applyParamsToScript(compiledCode, params, "JSON")` (cardano-dev-skills docs/sources/mesh-sdk/
// aiken/transactions.mdx); Blockfrost GET /txs/{hash}, /txs/{hash}/utxos, /txs/{hash}/redeemers,
// /txs/{hash}/metadata, /addresses/{address}/transactions, /addresses/{address}/utxos (docs/sources/
// blockfrost-openapi/src/paths/api/txs/**); CIP-20 label 674 (docs/sources/cips/CIP-0020); CIP-57 blueprint
// parameters in order (docs/sources/cips/CIP-0057). Parameter encoding mirrors docs/VAULT-SPEC.md.
//
// The Mesh dependency is injected (`CstLike` = the subset of @meshsdk/core's `cst` we use) so the same logic
// runs in the browser (lib/verify-proof-browser.ts lazily imports @meshsdk/core) and in Node tests / scripts.
// This file is environment-agnostic (no DOM / window); browser-only glue lives in verify-proof-browser.ts.
import blueprint from "../../../contracts/plutus.json";
import {
  EMPTY_SHA256,
  TUSDM_PREPROD,
  VERIFY_CLAIMS,
  explorerAddress,
  explorerTx,
  microToTusd,
  type ClaimResult,
  type ClaimStatus,
  type GoalProofDTO,
  type ProofLink,
  type SessionProofDTO,
  type SessionVerification,
  type VaultParamsDTO,
  type VerifyClaimId,
} from "@bulkhead/shared";

// ───────────────────────────── Mesh (injected) ─────────────────────────────
/** The subset of Mesh core-cst (`import { cst } from "@meshsdk/core"`) the verifier needs. */
export interface CstLike {
  applyParamsToScript(rawScript: string, params: object[], type?: "Mesh" | "JSON" | "CBOR"): string;
  normalizePlutusScript(plutusScript: string, encoding: "SingleCBOR" | "DoubleCBOR" | "PurePlutusScriptBytes"): string;
  deserializePlutusScript(plutusScript: string, version: "V1" | "V2" | "V3"): { hash(): { toString(): string } };
  serializeAddress(address: { pubKeyHash?: string; scriptHash?: string; stakeCredentialHash?: string; stakeScriptCredentialHash?: string }, networkId?: number): string;
  deserializeBech32Address(bech32: string): { pubKeyHash: string; scriptHash: string; stakeCredentialHash: string; stakeScriptCredentialHash: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveNativeScriptHash(script: any): string;
}

// ───────────────────────────── chain reader ─────────────────────────────
export interface ChainReader {
  /** GET a Blockfrost path ("/txs/…"). null = 404 (not found / no data). Throws on other errors. */
  get<T>(path: string): Promise<T | null>;
}

/** Blockfrost-shaped reader with a per-instance cache. Browser: base "/api/chain" (server proxy adds the key). */
export function blockfrostReader(opts: { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch }): ChainReader {
  const f = opts.fetch ?? fetch;
  const cache = new Map<string, Promise<unknown>>();
  const once = async (path: string): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${opts.baseUrl}${path}`, { headers: opts.headers });
      if (res.status === 404) return null;
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`chain read ${path.split("?")[0]} failed: HTTP ${res.status}`);
      return res.json();
    }
  };
  return {
    get<T>(path: string): Promise<T | null> {
      let p = cache.get(path);
      if (!p) {
        p = once(path);
        p.catch(() => cache.delete(path));
        cache.set(path, p);
      }
      return p as Promise<T | null>;
    },
  };
}
export const proxyReader = (): ChainReader => blockfrostReader({ baseUrl: "/api/chain" });

// Blockfrost response shapes (blockfrost-openapi src/schemas/txs/*).
interface BfAmount {
  unit: string;
  quantity: string;
}
interface BfTx {
  hash: string;
  block_height: number | null;
  slot: number;
  valid_contract: boolean;
  invalid_hereafter: string | null;
  invalid_before: string | null;
}
interface BfIn {
  address: string;
  amount: BfAmount[];
  tx_hash: string;
  output_index: number;
  collateral: boolean;
  reference?: boolean;
}
interface BfOut {
  address: string;
  amount: BfAmount[];
  output_index: number;
  inline_datum: string | null;
  collateral?: boolean;
}
interface BfUtxos {
  hash: string;
  inputs: BfIn[];
  outputs: BfOut[];
}
interface BfRedeemer {
  tx_index: number;
  purpose: string;
  script_hash: string;
  redeemer_data_hash: string;
}
interface BfMeta {
  label: string;
  json_metadata: unknown;
}
interface BfAddrTx {
  tx_hash: string;
  block_height: number;
}

// ───────────────────────────── vault recomputation ─────────────────────────────
type PJ = { constructor: number; fields: PJ[] } | { bytes: string } | { int: number | bigint } | { list: PJ[] };

interface BlueprintValidator {
  title: string;
  hash: string;
  compiledCode: string;
  parameters?: { title: string }[];
}
const BP = blueprint as unknown as { preamble: { compiler: { version: string } }; validators: BlueprintValidator[] };
export const VAULT_VALIDATOR_TITLE = "session_vault.session_vault.spend";
const SPEND = BP.validators.find((v) => v.title === VAULT_VALIDATOR_TITLE)!;
export const BUNDLED_BLUEPRINT = { title: SPEND.title, hash: SPEND.hash, compiler: BP.preamble.compiler.version, parameters: (SPEND.parameters ?? []).map((p) => p.title) };

/** Redeemer data hashes (blake2b-256 of the CBOR): Pay = Constr0[], Revoke = Constr1[], Recover = Constr2[]. */
export const REDEEMER_HASH = {
  Pay: "923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec",
  Revoke: "8392f0c940435c06888f9bdb8c74a95dc69f156367d6a089cf008ae05caae01e",
  Recover: "ff5f5c41a5884f08c6e2055d2c44d4b2548b5fc30b47efaa7d337219190886c5",
} as const;
const VOID_DATUM = "d87980";

type Cred = { type: "key" | "script"; hash: string };
function creds(cst: CstLike, address: string): { payment: Cred; stake: Cred | null } {
  const d = cst.deserializeBech32Address(address);
  const payment: Cred | null = d.pubKeyHash ? { type: "key", hash: d.pubKeyHash } : d.scriptHash ? { type: "script", hash: d.scriptHash } : null;
  if (!payment) throw new Error(`address has no payment credential: ${address.slice(0, 24)}…`);
  const stake: Cred | null = d.stakeCredentialHash ? { type: "key", hash: d.stakeCredentialHash } : d.stakeScriptCredentialHash ? { type: "script", hash: d.stakeScriptCredentialHash } : null;
  return { payment, stake };
}
const credPJ = (c: Cred): PJ => ({ constructor: c.type === "key" ? 0 : 1, fields: [{ bytes: c.hash }] });
const credKey = (c: Cred) => `${c.type}:${c.hash}`;

/** The 9 vault parameters as Mesh JSON Plutus data, in blueprint order (owner … tusd_name). Independent of the engine. */
export function vaultPlutusParams(cst: CstLike, p: VaultParamsDTO): PJ[] {
  const owner = creds(cst, p.ownerAddress);
  const ownerPJ: PJ = {
    constructor: 0,
    fields: [credPJ(owner.payment), owner.stake ? { constructor: 0, fields: [{ constructor: 0, fields: [credPJ(owner.stake)] }] } : { constructor: 1, fields: [] }],
  };
  const seen = new Set<string>();
  const payees: PJ[] = [];
  for (const a of p.payees) {
    const c = creds(cst, a).payment;
    if (!seen.has(credKey(c))) {
      seen.add(credKey(c));
      payees.push(credPJ(c));
    }
  }
  return [
    ownerPJ,
    { bytes: p.captainKeyHash },
    { bytes: p.sessionKeyHash },
    { int: p.expiryMs },
    { list: payees },
    { int: BigInt(p.perTxMaxTusdMicro) },
    { int: BigInt(p.adaAllowanceLovelace) },
    { bytes: p.tusdPolicyId },
    { bytes: p.tusdAssetNameHex },
  ];
}

export interface RecomputedVault {
  unappliedHash: string;
  scriptHash: string;
  address: string;
  plutusParams: PJ[];
}

/** applyParamsToScript(bundled compiledCode, params) → applied script hash → address (+ owner's stake credential). */
export function recomputeVault(cst: CstLike, p: VaultParamsDTO): RecomputedVault {
  const plutusParams = vaultPlutusParams(cst, p);
  const unappliedHash = cst.deserializePlutusScript(cst.normalizePlutusScript(SPEND.compiledCode, "DoubleCBOR"), "V3").hash().toString();
  const applied = cst.applyParamsToScript(SPEND.compiledCode, plutusParams as object[], "JSON");
  const scriptHash = cst.deserializePlutusScript(applied, "V3").hash().toString();
  const stake = creds(cst, p.ownerAddress).stake;
  const address = cst.serializeAddress(
    stake == null ? { scriptHash } : stake.type === "key" ? { scriptHash, stakeCredentialHash: stake.hash } : { scriptHash, stakeScriptCredentialHash: stake.hash },
    0,
  );
  return { unappliedHash, scriptHash, address, plutusParams };
}

// ───────────────────────────── helpers ─────────────────────────────
/** Owner key of a Bulkhead native session script: the `sig` inside the `all` branch that carries an `after` lock. */
export function nativeOwnerKeyHash(script: unknown): string | null {
  const s = script as { type?: string; scripts?: Array<{ type?: string; keyHash?: string; scripts?: Array<{ type?: string; keyHash?: string }> }> } | null;
  for (const b of s?.scripts ?? []) {
    if (b.type !== "all" || !b.scripts?.some((x) => x.type === "after")) continue;
    const sig = b.scripts.find((x) => x.type === "sig")?.keyHash;
    if (sig) return sig;
  }
  return null;
}

/** Preprod slot → POSIX ms (Mesh SLOT_CONFIG_NETWORK.preprod: zeroTime 1655769600000, zeroSlot 86400, 1 s slots). */
export const preprodSlotToMs = (slot: number) => 1_655_769_600_000 + (slot - 86_400) * 1_000;

export async function sha256Utf8(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const qty = (amount: BfAmount[], unit: string) => amount.reduce((s, a) => (a.unit === unit ? s + BigInt(a.quantity) : s), 0n);
const sumQty = (xs: { amount: BfAmount[] }[], unit: string) => xs.reduce((s, x) => s + qty(x.amount, unit), 0n);
const short = (h: string, n = 8) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-4)}` : h);
const ada = (lovelace: bigint) => `${(Number(lovelace) / 1e6).toFixed(2)} ADA`;
export function tickerOf(unit: string): string {
  if (unit === TUSDM_PREPROD.unit) return "tUSDM";
  if (unit.endsWith("0014df1074555344") || unit.endsWith("74555344")) return "tUSD";
  return "units";
}
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : typeof x === "number" ? String(x) : x));
const txLink = (label: string, h: string): ProofLink => ({ label, url: explorerTx(h) });

export interface VerifyDeps {
  reader: ChainReader;
  cst: CstLike;
  sha256?: (text: string) => Promise<string>;
  now?: () => number;
}

class Claims {
  readonly list: ClaimResult[] = [];
  add(id: VerifyClaimId, status: ClaimStatus, detail: string, links: ProofLink[] = [], statement = VERIFY_CLAIMS[id]) {
    this.list.push({ id, statement, status, detail, links });
  }
}

interface TxView {
  hash: string;
  tx: BfTx | null;
  utxos: BfUtxos | null;
}

// ───────────────────────────── verify one session ─────────────────────────────
export async function verifySession(p: SessionProofDTO, deps: VerifyDeps): Promise<SessionVerification> {
  const { reader, cst } = deps;
  const sha = deps.sha256 ?? sha256Utf8;
  const now = deps.now ?? Date.now;
  const c = new Claims();
  const vaultMode = p.walletMode === "vault";
  const m = p.mandate;
  let unit = m?.assetUnit ?? "";
  let tk = tickerOf(unit);
  const amt = (micro: bigint) => `${microToTusd(micro)} ${tk}`;
  let recomputed: SessionVerification["recomputed"] = null;
  let addr: string | null = null;

  // 1 + 2. contract + vault address (pure, no chain)
  if (vaultMode && p.vault) {
    try {
      const r = recomputeVault(cst, p.vault.params);
      recomputed = { scriptHash: r.scriptHash, address: r.address, unappliedHash: r.unappliedHash };
      addr = r.address;
      const okUnapplied = r.unappliedHash === SPEND.hash && r.unappliedHash === p.vault.unappliedValidatorHash;
      c.add(
        "contract",
        okUnapplied ? "pass" : "fail",
        okUnapplied
          ? `Validator ${SPEND.title} (Plutus V3, Aiken ${BP.preamble.compiler.version}) · unapplied hash ${short(r.unappliedHash)} recomputed from the bundled plutus.json = pinned v${p.vault.scriptVersion}.`
          : `Unapplied hash mismatch: bundled blueprint ${short(r.unappliedHash)} / blueprint field ${short(SPEND.hash)} vs engine ${short(p.vault.unappliedValidatorHash)}.`,
      );
      const vp = p.vault.params;
      const mandateOk =
        !!m &&
        m.ownerAddress === vp.ownerAddress &&
        m.perTxMaxMicro === vp.perTxMaxTusdMicro &&
        m.assetUnit === vp.tusdPolicyId + vp.tusdAssetNameHex &&
        m.expiresAt === vp.expiryMs &&
        canonical(m.payees) === canonical(vp.payees);
      const paramsMatch = p.vault.plutusParams.length === 0 || canonical(p.vault.plutusParams) === canonical(r.plutusParams);
      const ok = r.scriptHash === p.vault.appliedScriptHash && r.address === p.vault.address && mandateOk && paramsMatch;
      const why = [
        r.scriptHash !== p.vault.appliedScriptHash ? `script hash ${short(r.scriptHash)} ≠ engine ${short(p.vault.appliedScriptHash)}` : "",
        r.address !== p.vault.address ? "address differs from the engine's" : "",
        !mandateOk ? "displayed mandate differs from the applied params" : "",
        !paramsMatch ? "engine's Plutus params JSON differs from ours" : "",
      ].filter(Boolean);
      c.add(
        "vault_address",
        ok ? "pass" : "fail",
        ok
          ? `applyParamsToScript(9 params) → script ${short(r.scriptHash)} → ${short(r.address, 14)} (owner stake credential) — matches the engine.`
          : `Recomputed ${short(r.scriptHash)} / ${short(r.address, 14)}: ${why.join("; ")}.`,
        [{ label: "vault", url: explorerAddress(r.address) }],
      );
    } catch (e) {
      c.add("contract", "fail", `Could not recompute the vault: ${(e as Error).message}`);
      c.add("vault_address", "fail", "Parameters could not be applied to the bundled blueprint.");
    }
  } else if (p.native) {
    addr = p.native.address;
    try {
      const h = cst.resolveNativeScriptHash(p.native.script);
      const payCred = addr ? cst.deserializeBech32Address(addr).scriptHash : "";
      const ok = h === payCred && (p.native.scriptHash == null || h === p.native.scriptHash);
      c.add(
        "contract",
        ok ? "pass" : "fail",
        ok
          ? `Native script (session key before expiry | captain | owner after expiry) hash ${short(h)} = the wallet address's payment credential${p.native.scriptHash == null ? " (engine recorded no hash)" : ""}.`
          : `Native script hash ${short(h)} ≠ engine ${short(p.native.scriptHash ?? "?")} / address credential ${short(payCred || "?")}.`,
        addr ? [{ label: "wallet", url: explorerAddress(addr) }] : [],
        "The session wallet is exactly the native script shown (multisig + time-lock).",
      );
    } catch (e) {
      c.add("contract", "fail", `Could not hash the native script: ${(e as Error).message}`);
    }
    c.add("vault_address", "skip", "Native-script fallback: payees and per-tx caps are enforced by the engine, not by a contract.");
  } else {
    c.add("contract", "skip", "No session wallet yet.");
    c.add("vault_address", "skip", "No session wallet yet.");
  }

  if (!addr || !m) {
    for (const id of ["funding", "payments", "history", "close", "handback"] as const) c.add(id, "skip", "No session wallet yet.");
    return finish(p, c, recomputed, now());
  }
  const sessionAddr = addr;
  const owner = vaultMode && p.vault ? p.vault.params.ownerAddress : (p.close?.toAddress ?? m.ownerAddress);
  // Native fallback: the script's own owner branch (sig + after expiry) also identifies the owner — the user's
  // treasury may have changed since (custody switch). Vault: strictly the owner address baked into the params.
  const nativeOwnerKey = !vaultMode && p.native ? nativeOwnerKeyHash(p.native.script) : null;
  const isOwner = (a: string) => {
    if (a === owner) return true;
    if (!nativeOwnerKey) return false;
    try {
      return cst.deserializeBech32Address(a).pubKeyHash === nativeOwnerKey;
    } catch {
      return false;
    }
  };

  const view = async (hash: string): Promise<TxView> => {
    const [tx, utxos] = await Promise.all([reader.get<BfTx>(`/txs/${hash}`), reader.get<BfUtxos>(`/txs/${hash}/utxos`)]);
    return { hash, tx, utxos };
  };
  const vaultInputs = (v: TxView) => (v.utxos?.inputs ?? []).filter((i) => i.address === sessionAddr && !i.collateral && !i.reference);
  const realOutputs = (v: TxView) => (v.utxos?.outputs ?? []).filter((o) => !o.collateral);
  const scriptRan = async (hash: string, expect: string[]): Promise<{ ok: boolean; detail: string }> => {
    if (!vaultMode || !recomputed) return { ok: true, detail: "" };
    const rs = (await reader.get<BfRedeemer[]>(`/txs/${hash}/redeemers`)) ?? [];
    const mine = rs.filter((r) => r.purpose === "spend" && r.script_hash === recomputed!.scriptHash);
    const ok = mine.length > 0 && mine.every((r) => expect.includes(r.redeemer_data_hash));
    const names = mine.map((r) => Object.entries(REDEEMER_HASH).find(([, h]) => h === r.redeemer_data_hash)?.[0] ?? "?");
    return { ok, detail: mine.length ? `validator ran (${names.join(", ")})` : "no spend redeemer of this vault script" };
  };

  // 3. funding
  const fundings = p.fundings.filter((f) => !f.address || f.address === sessionAddr);
  if (fundings.length === 0) {
    c.add("funding", ["PLANNED", "AWAITING_APPROVAL"].includes(p.status) ? "skip" : "fail", "No funding tx reported for this address.");
  } else {
    const bad: string[] = [];
    const good: string[] = [];
    for (const f of fundings) {
      const v = await view(f.txHash);
      if (!v.tx || !v.utxos || v.tx.block_height == null) {
        bad.push(`${short(f.txHash)} not found on-chain`);
        continue;
      }
      const outs = v.utxos.outputs.filter((o) => o.address === sessionAddr);
      if (!vaultMode && sumQty(outs, unit) === 0n) {
        // Native fallback: the settlement asset is not part of the script; take it from the funding output.
        const tokens = [...new Set(outs.flatMap((o) => o.amount.map((a) => a.unit)).filter((u) => u !== "lovelace"))];
        if (tokens.length === 1) {
          unit = tokens[0]!;
          tk = tickerOf(unit);
        }
      }
      const got = sumQty(outs, unit);
      const lov = sumQty(outs, "lovelace");
      if (outs.length === 0) bad.push(`${short(f.txHash)} pays nothing to this address`);
      else if (f.amountMicro != null && got !== BigInt(f.amountMicro)) bad.push(`${short(f.txHash)} put ${amt(got)}, expected ${amt(BigInt(f.amountMicro))}`);
      else if (vaultMode && outs.some((o) => o.inline_datum !== VOID_DATUM)) bad.push(`${short(f.txHash)}: vault output without inline datum Void (unspendable)`);
      else good.push(`${f.kind} ${short(f.txHash)}: ${amt(got)} + ${ada(lov)}`);
    }
    c.add("funding", bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : `${good.join("; ")}${vaultMode ? " · inline datum Void" : ""}.`, fundings.map((f) => txLink(`fund ${f.kind}`, f.txHash)));
  }

  // 5 (first: it discovers unreported spends). history = every tx that ever touched the address
  const known = new Set<string>([...p.fundings.map((f) => f.txHash), ...p.payments.map((x) => x.txHash), ...(p.close ? [p.close.txHash] : [])]);
  for (const r of p.rotations) for (const h of [r.revokeTx, r.fundTx]) if (h) known.add(h);
  const history: string[] = [];
  let historyComplete = true;
  for (let page = 1; page <= 10; page++) {
    const rows = await reader.get<BfAddrTx[]>(`/addresses/${sessionAddr}/transactions?order=asc&count=100&page=${page}`);
    if (!rows) break;
    for (const r of rows) if (!history.includes(r.tx_hash)) history.push(r.tx_hash);
    if (rows.length < 100) break;
    if (page === 10) historyComplete = false;
  }
  const unreportedSpends: TxView[] = [];
  const deposits: string[] = [];
  let discoveredClose: TxView | null = null;
  for (const h of history.filter((x) => !known.has(x))) {
    const v = await view(h);
    if (vaultInputs(v).length === 0) {
      deposits.push(h);
      continue;
    }
    const outs = realOutputs(v);
    if (outs.every((o) => isOwner(o.address)) && !p.close && !discoveredClose) discoveredClose = v; // e.g. a Recover the engine did not record
    else unreportedSpends.push(v);
  }
  // Reported txs that must appear in this address's history (payments of a rotated session may predate this vault).
  const reportedHere = [...fundings.map((f) => f.txHash), ...(p.rotations.length ? [] : p.payments.map((x) => x.txHash)), ...(p.close ? [p.close.txHash] : [])];
  const missing = [...new Set(reportedHere)].filter((h) => !history.includes(h));
  {
    const issues = [
      unreportedSpends.length ? `${unreportedSpends.length} spend(s) the engine did not report: ${unreportedSpends.map((v) => short(v.hash)).join(", ")}` : "",
      missing.length ? `reported tx(s) not seen at this address: ${missing.map((h) => short(h)).join(", ")}` : "",
      !historyComplete ? "more than 1000 txs — history truncated" : "",
    ].filter(Boolean);
    const notes = [deposits.length ? `${deposits.length} third-party deposit(s) (harmless)` : "", discoveredClose ? `close ${short(discoveredClose.hash)} found on-chain (not recorded by the engine)` : ""].filter(Boolean);
    if (history.length === 0 && fundings.length === 0) c.add("history", "skip", "Nothing has touched this address yet.");
    else c.add(
      "history",
      issues.length ? "fail" : history.length === 0 ? "fail" : "pass",
      issues.length ? `${issues.join("; ")}.` : history.length === 0 ? "No tx ever touched this address." : `${history.length} tx(s) at the address, all accounted for${notes.length ? ` (${notes.join("; ")})` : ""}.`,
      [{ label: "address history", url: explorerAddress(sessionAddr) }],
    );
  }

  // 4. payments (reported + any unreported spend)
  {
    const allowed = new Set<string>();
    for (const a of m.payees) {
      try {
        allowed.add(credKey(creds(cst, a).payment));
      } catch {
        /* not a real address: never matches */
      }
    }
    const cap = BigInt(m.perTxMaxMicro);
    const allowance = m.adaAllowanceLovelace != null ? BigInt(m.adaAllowanceLovelace) : null;
    const expiry = m.expiresAt;
    const items: Array<{ hash: string; claimed: { payee: string; amountMicro: string } | null }> = [
      ...p.payments.map((x) => ({ hash: x.txHash, claimed: { payee: x.payee, amountMicro: x.amountMicro } })),
      ...unreportedSpends.map((v) => ({ hash: v.hash, claimed: null })),
    ];
    const bad: string[] = [];
    const good: string[] = [];
    const notes: string[] = [];
    for (const it of items) {
      const v = await view(it.hash);
      if (!v.tx || !v.utxos) {
        bad.push(`${short(it.hash)} not found on-chain`);
        continue;
      }
      const vin = vaultInputs(v);
      if (vin.length === 0) {
        if (p.rotations.length) notes.push(`${short(it.hash)} paid from an earlier (rotated) vault`);
        else bad.push(`${short(it.hash)} did not spend from this ${vaultMode ? "vault" : "wallet"}`);
        continue;
      }
      if (!v.tx.valid_contract) {
        bad.push(`${short(it.hash)}: script validation failed (collateral consumed)`);
        continue;
      }
      const back = v.utxos.outputs.filter((o) => o.address === sessionAddr);
      const leaving = sumQty(vin, unit) - sumQty(back, unit);
      const lovLeaving = sumQty(vin, "lovelace") - sumQty(back, "lovelace");
      const payOuts = realOutputs(v).filter((o) => o.address !== sessionAddr && qty(o.amount, unit) > 0n);
      const strangers = payOuts.filter((o) => {
        try {
          return !allowed.has(credKey(creds(cst, o.address).payment));
        } catch {
          return true;
        }
      });
      const errs: string[] = [];
      if (strangers.length) errs.push(`paid a non-allowed address ${short(strangers[0]!.address, 12)}`);
      if (leaving > cap) errs.push(`${amt(leaving)} left the vault > cap ${amt(cap)}`);
      if (vaultMode && allowance != null && lovLeaving > allowance) errs.push(`${ada(lovLeaving)} left > ADA allowance ${ada(allowance)}`);
      if (vaultMode) {
        const ttl = v.tx.invalid_hereafter != null ? preprodSlotToMs(Number(v.tx.invalid_hereafter)) : null;
        if (ttl == null || ttl > expiry) errs.push("validity upper bound is after the expiry");
        const ran = await scriptRan(it.hash, [REDEEMER_HASH.Pay]);
        if (!ran.ok) errs.push(ran.detail);
      }
      const toPayee = it.claimed ? sumQty(payOuts.filter((o) => o.address === it.claimed!.payee), unit) : leaving;
      if (it.claimed && toPayee !== BigInt(it.claimed.amountMicro)) errs.push(`engine reported ${amt(BigInt(it.claimed.amountMicro))}, chain shows ${amt(toPayee)}`);
      if (!it.claimed) errs.push("not reported by the engine");
      if (errs.length) bad.push(`${short(it.hash)}: ${errs.join(", ")}`);
      else good.push(`${amt(leaving)} → ${short(payOuts[0]?.address ?? "?", 12)} (≤ ${amt(cap)})`);
    }
    const links = items.map((it, i) => txLink(`payment ${i + 1}`, it.hash));
    const statement = vaultMode ? VERIFY_CLAIMS.payments : "Every payment left the session wallet only to an allowed payee, at most perTxMax per tx (engine-enforced in native mode).";
    if (items.length === 0) c.add("payments", "pass", `No payments: nothing left the ${vaultMode ? "vault" : "wallet"} before the close${history.length ? " (address history confirms)" : ""}.`, links, statement);
    else if (bad.length) c.add("payments", "fail", `${bad.join("; ")}.`, links, statement);
    else if (good.length === 0) c.add("payments", "skip", `${notes.join("; ")}.`, links, statement);
    else c.add("payments", "pass", `${good.length} payment(s): ${good.join("; ")}${vaultMode ? " · validator ran with Pay, TTL ≤ expiry" : ""}${notes.length ? ` (${notes.join("; ")})` : ""}.`, links, statement);
  }

  // 6. close
  const closeHash = p.close?.txHash ?? discoveredClose?.hash ?? null;
  let closeMeta: Record<string, unknown> | null = null;
  if (!closeHash) {
    const left = (await reader.get<BfIn[]>(`/addresses/${sessionAddr}/utxos`)) ?? [];
    if (p.status === "CLOSED" && left.length === 0) c.add("close", "pass", `Closed with nothing to return; the ${vaultMode ? "vault" : "wallet"} holds no UTxOs.`, [{ label: "address", url: explorerAddress(sessionAddr) }]);
    else if (p.status === "CLOSED") c.add("close", "fail", `Session reported CLOSED but the address still holds ${left.length} UTxO(s).`, [{ label: "address", url: explorerAddress(sessionAddr) }]);
    else c.add("close", "skip", `Session is ${p.status}: not closed yet.`);
  } else {
    const v = discoveredClose?.hash === closeHash ? discoveredClose : await view(closeHash);
    const links = [txLink("close", closeHash), { label: "owner", url: explorerAddress(owner) }];
    if (!v.tx || !v.utxos) c.add("close", "fail", `Close tx ${short(closeHash)} not found on-chain.`, links);
    else {
      const vin = vaultInputs(v);
      const outs = realOutputs(v);
      const tokIn = sumQty(vin, unit);
      const ownerOuts = outs.filter((o) => isOwner(o.address));
      const toOwner = sumQty(ownerOuts, unit);
      const others = outs.filter((o) => !isOwner(o.address));
      const ownerShown = ownerOuts[0]?.address ?? owner;
      const left = (await reader.get<BfIn[]>(`/addresses/${sessionAddr}/utxos`)) ?? [];
      const errs: string[] = [];
      if (vin.length === 0) errs.push("spends nothing from this address");
      if (others.length) errs.push(`${others.length} output(s) not to the owner`);
      if (toOwner !== tokIn) errs.push(`returned ${amt(toOwner)} of ${amt(tokIn)}`);
      if (p.close?.refundMicro != null && BigInt(p.close.refundMicro) !== toOwner) errs.push(`engine reported ${amt(BigInt(p.close.refundMicro))} returned`);
      if (left.length) errs.push(`address still holds ${left.length} UTxO(s)`);
      let ran = { ok: true, detail: "" };
      if (vaultMode) {
        ran = await scriptRan(closeHash, [REDEEMER_HASH.Revoke, REDEEMER_HASH.Recover]);
        if (!ran.ok) errs.push(ran.detail);
      }
      c.add(
        "close",
        errs.length ? "fail" : "pass",
        errs.length
          ? `Close ${short(closeHash)}: ${errs.join(", ")}.`
          : `Close ${short(closeHash)} returned ${amt(toOwner)} + ${ada(sumQty(ownerOuts, "lovelace"))} to the owner ${short(ownerShown, 12)}${ownerShown !== owner ? " (the owner key in the script)" : ""}${ran.detail ? ` · ${ran.detail}` : ""}; the ${vaultMode ? "vault" : "wallet"} is now empty.`,
        links,
      );
      const md = (await reader.get<BfMeta[]>(`/txs/${closeHash}/metadata`)) ?? [];
      const m674 = md.find((x) => x.label === "674")?.json_metadata;
      closeMeta = m674 && typeof m674 === "object" ? (m674 as Record<string, unknown>) : null;
    }
  }

  // 7. handback anchor (CIP-20 674 on the close tx)
  if (!closeHash) c.add("handback", "skip", "No close tx yet: the handback hash is anchored at close.");
  else if (!closeMeta) c.add("handback", "fail", `Close tx ${short(closeHash)} carries no CIP-20 (674) metadata.`, [txLink("close metadata", closeHash)]);
  else {
    const text = p.handback.text ?? "";
    const computed = await sha(text);
    const anchored = typeof closeMeta.handback_sha256 === "string" ? closeMeta.handback_sha256 : null;
    const sidOk = closeMeta.session_id === p.sessionId;
    const goalAnchored = typeof closeMeta.goal_id === "string";
    const goalOk = !goalAnchored || closeMeta.goal_id === p.goalId;
    const ok = sidOk && goalOk && anchored === computed;
    const what = p.handback.text == null ? "no handback (sha256 of \"\")" : `the ${new TextEncoder().encode(text).length}-byte handback shown`;
    c.add(
      "handback",
      ok ? "pass" : "fail",
      ok
        ? `674 anchors session ${p.sessionId}${goalAnchored ? ` + goal ${short(p.goalId, 10)}` : " (goal id not anchored: closed before goal ids were added)"} and handback sha256 ${short(computed)} = sha256 of ${what}.${computed === EMPTY_SHA256 && p.handback.text != null ? " (empty text)" : ""}`
        : [
            !sidOk ? `session_id on-chain ${String(closeMeta.session_id)} ≠ ${p.sessionId}` : "",
            !goalOk ? `goal_id on-chain ${String(closeMeta.goal_id)} ≠ ${p.goalId}` : "",
            anchored !== computed ? `on-chain hash ${short(anchored ?? "none")} ≠ sha256 of the handback shown ${short(computed)} (text was changed)` : "",
          ]
            .filter(Boolean)
            .join("; "),
      [txLink("close metadata", closeHash)],
    );
  }

  return finish(p, c, recomputed, now());
}

function finish(p: SessionProofDTO, c: Claims, recomputed: SessionVerification["recomputed"], at: number): SessionVerification {
  const s = c.list.map((x) => x.status);
  const status: ClaimStatus = s.includes("fail") ? "fail" : s.every((x) => x === "skip") ? "skip" : "pass";
  return { sessionId: p.sessionId, letter: p.letter, status, claims: c.list, recomputed, verifiedAt: at };
}

/** Verify every session of a goal (sequential: stays well inside Blockfrost's 10 req/s). */
export async function verifyGoal(g: GoalProofDTO, deps: VerifyDeps, onSession?: (v: SessionVerification) => void): Promise<SessionVerification[]> {
  const out: SessionVerification[] = [];
  for (const s of g.sessions) {
    let v: SessionVerification;
    try {
      v = await verifySession(s, deps);
    } catch (e) {
      v = {
        sessionId: s.sessionId,
        letter: s.letter,
        status: "fail",
        claims: [{ id: "history", statement: VERIFY_CLAIMS.history, status: "fail", detail: `Verifier error: ${(e as Error).message}`, links: [] }],
        recomputed: null,
        verifiedAt: (deps.now ?? Date.now)(),
      };
    }
    out.push(v);
    onSession?.(v);
  }
  return out;
}

/** Compact one-line summary of the enforced mandate ("Enforced by contract … · payees 2 · cap 3 tUSDM/tx · expires …"). */
export function receiptSummary(p: SessionProofDTO): { enforcedBy: string; payees: number; cap: string; expires: number | null; ticker: string } {
  const m = p.mandate;
  const ticker = tickerOf(m?.assetUnit ?? "");
  return {
    enforcedBy: p.vault ? `contract ${short(p.vault.appliedScriptHash, 6)}` : p.native?.scriptHash ? `native script ${short(p.native.scriptHash, 6)} + engine` : "engine",
    payees: m?.payees.length ?? 0,
    cap: m ? `${microToTusd(BigInt(m.perTxMaxMicro))} ${ticker}/tx` : "—",
    expires: m?.expiresAt ?? null,
    ticker,
  };
}
