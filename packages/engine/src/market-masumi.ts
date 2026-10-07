// Masumi market (env MARKET=masumi): Bulkhead `hire_agent` sessions hire REAL Masumi registry agents (MIP-003)
// and pay through a Masumi Payment Service (MPS) purchase. The mock market (market.ts) stays the default.
//
// STATUS: INFERRED buyer flow. No Masumi demo ever implemented the buyer side (docs/SOKOSUMI-PROTOCOL.md §7);
// every MPS route/field below is taken from the local MPS source (masumi-payment-service/src/routes/api):
//   GET  /wallet/list?walletType=Purchasing           (read)   → the purchasing hot wallet address
//   GET  /registry?network=Preprod[&filterPaymentSourceType=Web3CardanoV2]  (read, wallet-scoped) → RegistryEntry[]
//   POST /purchase                                     (pay)    → lock the job price in the Masumi escrow
//   POST /purchase/resolve-blockchain-identifier       (read)   → purchase status (onChainState, resultHash)
//   POST /purchase/request-refund                      (pay)    → buyer refund request
//   POST /wallet/transfer-funds                        (ADMIN)  → sweep a refund out of the purchasing wallet
//   GET  /wallet/transfer-funds?id=…                   (ADMIN)  → sweep tx status
// Envelope: HTTP 2xx + { status: "success", data } (payment-core endpoint-factory). Header `token: <key>`.
//
// Money path (the user's brief §5, "fund the exact job price from the session vault"):
//   1. startJob: MIP-003 POST {apiBaseUrl}/start_job with our hex nonce → the seller's signed terms
//      (blockchainIdentifier, agentIdentifier, sellerVKey, payByTime, submitResultTime, unlockTime,
//      externalDisputeUnlockTime, input_hash, [amounts for Dynamic pricing]). We verify input_hash ourselves.
//   2. The runner pays `amountMicro` tUSD to `paymentAddress` = Bulkhead's MPS PURCHASING wallet through the
//      Signer → in vault mode a Session Vault `Pay` (allowlist + per-tx max on-chain; budget / approval
//      threshold / decision ledger in the Signer). The purchasing wallet's payment credential therefore has to be
//      in the vault's payees: resolve it with the payee alias `masumi:purchasing-wallet` (or any masumi catalog id).
//   3. status(): once THAT vault payment is confirmed on-chain, POST /purchase with the signed terms verbatim;
//      MPS locks the agent's price in the Masumi escrow from the purchasing wallet.
//   4. Poll the seller /status + MPS purchase; on completion verify MIP-004: sha256(nonce;result) must equal the
//      seller's reported hash (if any) and the hash the seller put on-chain (purchase.resultHash). Mismatch →
//      POST /purchase/request-refund and the job fails.
//   5. Refunds (mismatch, seller failure, no result by submitResultTime) come back from the escrow to the
//      purchasing wallet (we pass buyerReturnAddress = purchasing wallet so a configured collection address can't
//      divert them). The watcher then sweeps the FUNDED tUSD back with POST /wallet/transfer-funds (admin key) to
//      the session vault's OWNER (the user's treasury). It never sweeps into the vault script address itself:
//      transfer-funds cannot attach the inline datum Void the vault builders expect (docs/VAULT-SPEC.md), so a
//      datum-less UTxO there would be unspendable by Bulkhead's tooling. The treasury is where Revoke/Recover
//      send vault funds anyway.
//
// Asset reality (honest): a Session Vault Pay can only move tUSD (+ ≤ ada_allowance lovelace). Masumi agents price
// in their own units. Per agent pricing unit:
//   - Bulkhead tUSD unit           → fundingMode "exact": the vault funds the very asset MPS locks.
//   - USD-pegged units (tUSDM, …)  → fundingMode "equivalent": 1:1 by value; MPS locks the purchasing wallet's own
//                                    tUSDM float, the funded tUSD stays in the wallet as its counter-value.
//   - lovelace                     → only with MASUMI_TUSD_PER_ADA (a declared rate), fundingMode "equivalent".
//   - anything else / Free / non-Cardano / non-Preprod → not listed.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { kv, payments, sessions as sessionsT, users, type DB } from "@bulkhead/db";
import { microToTusd, tusdToMicro, type AgentCatalogEntry } from "@bulkhead/shared";
import { isSha256Hex, mip004InputHash, mip004ResultHash } from "@bulkhead/shared/mip004";
import type { AgentMarket, StartJobContext } from "./contracts";

type FetchFn = typeof fetch;

/** Planner/session payee alias that resolves to Bulkhead's MPS purchasing wallet address. */
export const MASUMI_PURCHASING_WALLET_ALIAS = "masumi:purchasing-wallet";
/** Masumi preprod test USDM (policy + asset name hex), docs/SOKOSUMI-PROTOCOL.md §3. */
export const PREPROD_TUSDM_UNIT = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export type FundingMode = "exact" | "equivalent";
export type MasumiPhase =
  | "start_pending" // start_job POST about to be / being sent
  | "quoted" // signed terms stored; waiting for the vault funding to confirm
  | "purchase_pending" // POST /purchase in flight (uncertain on crash → resolve before reposting)
  | "purchased" // MPS purchase exists; escrow lock in progress / locked
  | "completed" // result verified (MIP-004)
  | "refund_requested" // buyer refund requested (or waiting until it can be)
  | "refunded" // escrow refunded to the purchasing wallet; sweep pending
  | "funding_unused" // funding confirmed but no purchase will be made; sweep pending
  | "sweep_submitted"
  | "swept"
  | "unswept" // refund sits in the purchasing wallet; needs an admin key / operator action
  | "failed"; // nothing (more) to do; money never left the session or is accounted elsewhere

export interface MasumiJobRecord {
  jobId: string;
  serviceId: string;
  agentIdentifier: string;
  apiBaseUrl: string;
  sessionId: string | null;
  nonce: string;
  inputData: Record<string, string>;
  inputHash: string;
  /** Seller's signed terms, verbatim strings. */
  terms: {
    blockchainIdentifier: string;
    sellerVkey: string;
    payByTime: string;
    submitResultTime: string;
    unlockTime: string;
    externalDisputeUnlockTime: string;
    paymentSourceType?: string;
    supportedPaymentSourceIndex?: number;
    paymentForceLayer?: string | null;
  };
  pricingType: "Fixed" | "Dynamic";
  amounts: { unit: string; amount: string }[];
  amountMicro: string;
  fundingMode: FundingMode;
  phase: MasumiPhase;
  purchaseId?: string;
  fundingTxHash?: string;
  result?: string;
  resultHash?: string;
  refundReason?: string;
  sweep?: { id: string; toAddress: string; tusdMicro: string; lovelace: string; txHash?: string | null; status?: string };
  error?: string;
  lastPollAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Minimal persistence (the engine's kv table in production, a Map in tests). */
export interface MasumiStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  list(prefix: string): { key: string; value: string }[];
}
/** The Signer payment that funded a job (looked up by session + payment reference). */
export interface FundingInfo {
  status: string; // payments.status
  txHash: string | null;
  amountMicro: bigint;
  payee: string;
}

export interface MasumiConfig {
  /** Only "Preprod" is accepted (TEAM-BRIEF: preprod only). */
  network: "Preprod";
  /** MPS base URL including /api/v1. */
  mpsUrl: string;
  /** MPS key with canRead+canPay scoped to the PURCHASING wallet (from .local/mps-buyer.env). */
  buyerToken: string;
  /** Optional MPS admin key: refund sweeps (POST /wallet/transfer-funds is admin-only). Never logged. */
  adminToken?: string;
  /** Optional MPS key used only for GET /registry discovery (else buyerToken; MPS scopes it to the key's wallets). */
  discoveryToken?: string;
  /** Optional public Masumi Registry Service (POST /registry-entry/). */
  registryUrl?: string;
  registryToken?: string;
  /** Pin the purchasing wallet (else GET /wallet/list?walletType=Purchasing must return exactly one). */
  purchasingWalletAddress?: string;
  /** Bulkhead tUSD unit (policy + asset name hex). */
  tusdUnit: string;
  /** Units valued 1:1 with tUSD (USD-pegged, 6 decimals). Default: preprod tUSDM. */
  usdUnits?: string[];
  /** tUSD per 1 ADA, decimal string (e.g. "0.45"); unset → lovelace-priced agents are not listed. */
  tusdPerAda?: string;
  /** Refuse quotes above this (before any money moves). Default 100 tUSD. */
  maxPriceMicro?: bigint;
  /** start_job is refused unless payByTime leaves at least this long for the vault funding to confirm. */
  minPayWindowMs?: number;
  /** Only these agentIdentifiers are listed (optional allowlist). */
  agentAllowlist?: string[];
  /** Allow http:// apiBaseUrls (loopback demo agents). Default false. */
  allowHttpAgents?: boolean;
  /** Require the seller's on-chain resultHash before reporting completion. Default true. */
  requireOnChainResult?: boolean;
  /** lovelace sent with a sweep (MPS minimum is 2 ADA; the purchasing wallet covers it). */
  sweepLovelace?: bigint;
  /** A quoted job whose funding confirmed but that nobody polled for this long is abandoned (swept back). */
  abandonAfterMs?: number;
  /** Seller-result grace after submitResultTime before a refund is requested. */
  resultGraceMs?: number;
  watchMs?: number;
  cacheMs?: number;
  timeoutMs?: number;
}

export interface MasumiDeps {
  fetchImpl?: FetchFn;
  store: MasumiStore;
  /** The Signer payment carrying `ref:<reference>` for this session (null if none yet). */
  funding(q: { sessionId: string; reference: string }): FundingInfo | null;
  /** Where a swept refund goes: the session vault's owner (treasury). */
  sweepTarget(sessionId: string): { address: string; label: string } | null;
  emit?(type: "progress" | "error", sessionId: string | null, data: Record<string, unknown>): void;
  now?(): number;
  log?(msg: string): void;
}

export class MasumiError extends Error {
  override name = "MasumiError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface MasumiMarket extends AgentMarket {
  readonly kind: "masumi";
  invalidate(): void;
  purchasingWallet(): Promise<string>;
  resolvePayeeAlias(alias: string): Promise<{ id: string; label: string; address: string } | null>;
  /** Discovery diagnostics: excluded registry entries and why. */
  discoveryReport(): { listed: number; excluded: { name: string; agentIdentifier: string | null; reason: string }[] };
  job(jobId: string): MasumiJobRecord | null;
  /** One watcher pass (refunds, deadlines, sweeps). Exposed for tests. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

const KEY = (jobId: string) => `masumi:job:${jobId}`;
const NUM_RE = /^\d+$/;
const HEX_NONCE_BYTES = 10; // 20 hex chars (MPS: 14–26 hex)
const LIVE_PHASES: MasumiPhase[] = ["quoted", "purchase_pending", "purchased", "refund_requested", "refunded", "funding_unused", "sweep_submitted"];

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const firstStr = (o: Rec, ...keys: string[]) => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};
const normUnit = (u: string) => (u === "lovelace" ? "" : u);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "agent";

/** MPS times are unix-ms strings. Pass numbers/strings through verbatim (the seller signed exactly those);
 * ISO strings become their unix-ms value (what MPS stored when the seller created the payment). */
function timeField(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  if (typeof v !== "string" || !v) return undefined;
  if (NUM_RE.test(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? String(t) : undefined;
}

/** Load KEY=VALUE pairs from an env file (e.g. .local/mps-buyer.env). Values are never logged. */
export function readEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      out[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return {};
  }
}

// ───────────────────────────── pricing ─────────────────────────────
export interface PricedAmounts {
  pricingType: "Fixed" | "Dynamic";
  amounts: { unit: string; amount: string }[];
}

/** Cardano Preprod pricing of a registry entry (MPS RegistryEntry or public Registry Service entry). */
export function pricingOf(entry: Rec, network: string): PricedAmounts | { error: string } {
  const sources = Array.isArray(entry.supportedPaymentSources) ? (entry.supportedPaymentSources as unknown[]).map(asRec) : [];
  if (sources.length) {
    const s = sources.find((x) => x.chain === "Cardano" && x.network === network);
    if (!s) return { error: `no Cardano ${network} payment source` };
    const p = asRec(s.pricing);
    if (p.pricingType === "Fixed") {
      const fixed = Array.isArray(p.fixed) ? (p.fixed as unknown[]).map(asRec) : [];
      const amounts = fixed.map((f) => ({ unit: normUnit(str(f.asset) ?? ""), amount: str(f.amount) ?? "" }));
      return amounts.length ? { pricingType: "Fixed", amounts } : { error: "fixed pricing without amounts" };
    }
    if (p.pricingType === "Dynamic") return { pricingType: "Dynamic", amounts: [] };
    return { error: `pricing ${String(p.pricingType ?? "unknown")} not supported` };
  }
  const ap = asRec(entry.AgentPricing ?? entry.agentPricing);
  if (ap.pricingType === "Fixed") {
    const list = Array.isArray(ap.Pricing) ? ap.Pricing : Array.isArray(asRec(ap.FixedPricing).Amounts) ? (asRec(ap.FixedPricing).Amounts as unknown[]) : [];
    const amounts = (list as unknown[]).map(asRec).map((a) => ({ unit: normUnit(str(a.unit) ?? ""), amount: str(a.amount) ?? "" }));
    return amounts.length ? { pricingType: "Fixed", amounts } : { error: "fixed pricing without amounts" };
  }
  if (ap.pricingType === "Dynamic") return { pricingType: "Dynamic", amounts: [] };
  return { error: ap.pricingType ? `pricing ${String(ap.pricingType)} not supported` : "no pricing" };
}

/** Convert Masumi amounts to tUSD micro; null when a unit is not convertible. */
export function toTusdMicro(amounts: { unit: string; amount: string }[], cfg: Pick<MasumiConfig, "tusdUnit" | "usdUnits" | "tusdPerAda">): { micro: bigint; mode: FundingMode } | { error: string } {
  if (!amounts.length) return { error: "no amounts" };
  const usd = new Set((cfg.usdUnits ?? [PREPROD_TUSDM_UNIT]).map((u) => u.toLowerCase()));
  let micro = 0n;
  let exact = true;
  for (const a of amounts) {
    if (!NUM_RE.test(a.amount) || BigInt(a.amount) <= 0n) return { error: `bad amount "${a.amount}"` };
    const amt = BigInt(a.amount);
    const unit = normUnit(a.unit).toLowerCase();
    if (unit === cfg.tusdUnit.toLowerCase()) micro += amt;
    else if (usd.has(unit)) {
      micro += amt;
      exact = false;
    } else if (unit === "") {
      if (!cfg.tusdPerAda) return { error: "lovelace pricing needs MASUMI_TUSD_PER_ADA" };
      // tUSD micro = lovelace × (tUSD per ADA), both 6 decimals; round UP (never under-fund).
      const rate = tusdToMicro(cfg.tusdPerAda);
      micro += (amt * rate + 999_999n) / 1_000_000n;
      exact = false;
    } else return { error: `unit ${a.unit.slice(0, 16)}… is not convertible to tUSD` };
  }
  return { micro, mode: exact ? "exact" : "equivalent" };
}

/** MIP-003 /input_schema → the single input field a free-text `input` goes into. */
export function inputFieldOf(schema: unknown): string | null {
  const s = asRec(schema);
  const fields: { id: string; type: string; optional: boolean }[] = [];
  if (Array.isArray(s.input_data)) {
    for (const f of (s.input_data as unknown[]).map(asRec)) {
      const id = str(f.id) ?? str(f.key);
      if (!id) continue;
      const validations = Array.isArray(f.validations) ? (f.validations as unknown[]).map(asRec) : [];
      const optional = validations.some((v) => v.validation === "optional" && String(v.value) === "true");
      fields.push({ id, type: str(f.type) ?? "string", optional });
    }
  } else if (asRec(s.properties) && Object.keys(asRec(s.properties)).length) {
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [id, def] of Object.entries(asRec(s.properties))) fields.push({ id, type: str(asRec(def).type) ?? "string", optional: !req.has(id) });
  }
  const textual = fields.filter((f) => ["string", "text", "textarea"].includes(f.type));
  const required = fields.filter((f) => !f.optional);
  if (required.length > 1) return null; // can't fill several required fields from one free text
  if (required.length === 1) return textual.some((f) => f.id === required[0]!.id) ? required[0]!.id : null;
  const preferred = textual.find((f) => /^(input|prompt|text|query|question|topic|task|description)$/i.test(f.id));
  return preferred?.id ?? (textual.length === 1 ? textual[0]!.id : fields.length === 0 ? "input" : null);
}

// ───────────────────────────── the market ─────────────────────────────
export function createMasumiMarket(cfg: MasumiConfig, deps: MasumiDeps): MasumiMarket {
  if (cfg.network !== "Preprod") throw new MasumiError("Masumi market: only Preprod is allowed (mainnet refused)", "network");
  if (!cfg.buyerToken) throw new MasumiError("Masumi market: missing MPS buyer token (MPS_BUYER_TOKEN in .local/mps-buyer.env)", "config");
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[masumi] ${m}`));
  const emit = deps.emit ?? (() => undefined);
  const mps = cfg.mpsUrl.replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const maxPriceMicro = cfg.maxPriceMicro ?? 100_000_000n;
  const minPayWindowMs = cfg.minPayWindowMs ?? 4 * 60_000;
  const requireOnChainResult = cfg.requireOnChainResult ?? true;
  const sweepLovelace = cfg.sweepLovelace ?? 2_000_000n;
  const abandonAfterMs = cfg.abandonAfterMs ?? 5 * 60_000;
  const resultGraceMs = cfg.resultGraceMs ?? 2 * 60_000;
  const allow = cfg.agentAllowlist?.length ? new Set(cfg.agentAllowlist) : null;

  let cache: { at: number; list: (AgentCatalogEntry & { agentIdentifier: string })[] } | null = null;
  let report: ReturnType<MasumiMarket["discoveryReport"]> = { listed: 0, excluded: [] };
  let wallet: string | null = cfg.purchasingWalletAddress ?? null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function http<T>(method: string, url: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
    const res = await f(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", accept: "application/json", ...(opts.token ? { token: opts.token } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 300);
    }
    // Never include request headers (tokens) in errors; the URL carries no secrets.
    if (!res.ok) throw new HttpError(`${method} ${url.replace(/\?.*$/, "")} → HTTP ${res.status}${typeof asRec(body).error === "string" ? `: ${String(asRec(body).error).slice(0, 200)}` : ""}`, res.status, body);
    return body as T;
  }
  /** MPS call: unwraps { status: "success", data }. */
  async function mpsCall<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const r = asRec(await http<unknown>(method, `${mps}${path}`, { token, ...(body !== undefined ? { body } : {}) }));
    if (r.status !== "success") throw new HttpError(`MPS ${method} ${path}: status ${String(r.status)}`, 200, r);
    return r.data as T;
  }

  // ─────────── persistence ───────────
  const load = (jobId: string): MasumiJobRecord | null => {
    const v = deps.store.get(KEY(jobId));
    if (!v) return null;
    try {
      return JSON.parse(v) as MasumiJobRecord;
    } catch {
      return null;
    }
  };
  const save = (r: MasumiJobRecord) => {
    r.updatedAt = now();
    deps.store.set(KEY(r.jobId), JSON.stringify(r));
  };
  const setPhase = (r: MasumiJobRecord, phase: MasumiPhase, patch: Partial<MasumiJobRecord> = {}) => {
    Object.assign(r, patch, { phase });
    save(r);
    emit("progress", r.sessionId, { kind: "masumi", phase, jobId: r.jobId, serviceId: r.serviceId, blockchainIdentifier: r.terms.blockchainIdentifier.slice(0, 24), ...(patch.error ? { error: patch.error } : {}), ...(patch.refundReason ? { reason: patch.refundReason } : {}) });
  };

  // ─────────── purchasing wallet ───────────
  async function purchasingWallet(): Promise<string> {
    if (wallet) return wallet;
    const data = asRec(await mpsCall<unknown>("GET", `/wallet/list?walletType=Purchasing&take=10`, cfg.buyerToken));
    const list = (Array.isArray(data.Wallets) ? (data.Wallets as unknown[]) : []).map(asRec).filter((w) => !w.type || w.type === "Purchasing");
    const addrs = [...new Set(list.map((w) => str(w.walletAddress)).filter((a): a is string => !!a))];
    if (addrs.length !== 1) throw new MasumiError(`MPS has ${addrs.length} purchasing wallets visible to the buyer key; pin one with MASUMI_PURCHASING_WALLET_ADDRESS`, "wallet");
    if (!/^addr_test1[0-9a-z]+$/.test(addrs[0]!)) throw new MasumiError("purchasing wallet is not a preprod addr_test1 address (mainnet refused)", "network");
    wallet = addrs[0]!;
    return wallet;
  }

  // ─────────── discovery ───────────
  async function registryEntries(): Promise<Rec[]> {
    const out: Rec[] = [];
    const errors: string[] = [];
    if (cfg.registryUrl) {
      try {
        const body = asRec(await http<unknown>("POST", `${cfg.registryUrl.replace(/\/+$/, "")}/registry-entry/`, { ...(cfg.registryToken ? { token: cfg.registryToken } : {}), body: { network: cfg.network, filter: { status: ["Online"], paymentTypes: ["Web3CardanoV1"] }, limit: 50 } }));
        const data = body.data ?? body;
        const d = asRec(data);
        const list = Array.isArray(data) ? data : (d.entries ?? d.Entries ?? d.Assets ?? d.items ?? []);
        for (const e of Array.isArray(list) ? list : []) out.push({ ...asRec(e), __src: "registry" });
      } catch (e) {
        errors.push(`registry service: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const token = cfg.discoveryToken ?? cfg.buyerToken;
    for (const q of [`/registry?network=${cfg.network}&limit=100&filterPaymentSourceType=Web3CardanoV2`, `/registry?network=${cfg.network}&limit=100`]) {
      try {
        const data = asRec(await mpsCall<unknown>("GET", q, token));
        for (const e of Array.isArray(data.Assets) ? (data.Assets as unknown[]) : []) out.push({ ...asRec(e), __src: "mps" });
      } catch (e) {
        errors.push(`MPS registry: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!out.length && errors.length) throw new MasumiError(`Masumi discovery failed: ${errors.join("; ")}`, "discovery");
    return out;
  }

  async function catalog(): Promise<AgentCatalogEntry[]> {
    if (cache && now() - cache.at < (cfg.cacheMs ?? 60_000)) return cache.list;
    const addr = await purchasingWallet();
    const excluded: { name: string; agentIdentifier: string | null; reason: string }[] = [];
    const list: (AgentCatalogEntry & { agentIdentifier: string })[] = [];
    const seen = new Set<string>();
    for (const e of await registryEntries()) {
      const name = firstStr(e, "name") ?? "agent";
      const agentIdentifier = firstStr(e, "agentIdentifier", "agent_identifier", "assetIdentifier") ?? null;
      const no = (reason: string) => excluded.push({ name, agentIdentifier, reason });
      if (!agentIdentifier || agentIdentifier.length < 57) {
        no("no agentIdentifier");
        continue;
      }
      if (seen.has(agentIdentifier)) continue;
      const state = firstStr(e, "state", "status");
      if (state && !["RegistrationConfirmed", "UpdateConfirmed", "Online"].includes(state)) {
        no(`state ${state}`);
        continue;
      }
      if (allow && !allow.has(agentIdentifier)) {
        no("not in MASUMI_AGENT_ALLOWLIST");
        continue;
      }
      const type = firstStr(e, "type");
      if (type && type !== "Standard") {
        no(`entry type ${type} (only MIP-003 Standard agents are hireable)`);
        continue;
      }
      const api = firstStr(e, "apiBaseUrl", "api_base_url", "apiUrl", "api_url");
      if (!api) {
        no("no apiBaseUrl");
        continue;
      }
      let u: URL;
      try {
        u = new URL(api);
      } catch {
        no("bad apiBaseUrl");
        continue;
      }
      if (u.protocol !== "https:" && !(u.protocol === "http:" && cfg.allowHttpAgents)) {
        no(`${u.protocol} apiBaseUrl (set MASUMI_ALLOW_HTTP_AGENTS=1 for loopback demo agents)`);
        continue;
      }
      const pr = pricingOf(e, cfg.network);
      if ("error" in pr) {
        no(pr.error);
        continue;
      }
      let priceTUSD = "0";
      let fundingMode: FundingMode = "equivalent";
      if (pr.pricingType === "Fixed") {
        const t = toTusdMicro(pr.amounts, cfg);
        if ("error" in t) {
          no(t.error);
          continue;
        }
        if (t.micro > maxPriceMicro) {
          no(`price ${microToTusd(t.micro)} tUSD above MASUMI_MAX_PRICE_TUSD`);
          continue;
        }
        priceTUSD = microToTusd(t.micro);
        fundingMode = t.mode;
      }
      seen.add(agentIdentifier);
      const tags = Array.isArray(e.Tags) ? (e.Tags as unknown[]) : Array.isArray(e.tags) ? (e.tags as unknown[]) : [];
      list.push({
        id: `masumi-${slug(name)}-${agentIdentifier.slice(-8)}`,
        name,
        skills: tags.map(String).slice(0, 10),
        priceTUSD,
        paymentAddress: addr,
        endpoint: api.replace(/\/+$/, ""),
        source: "masumi",
        agentIdentifier,
        pricingType: pr.pricingType,
        fundingMode,
        amounts: pr.amounts,
      });
    }
    report = { listed: list.length, excluded };
    if (excluded.length) log(`discovery: ${list.length} listed, ${excluded.length} excluded`);
    cache = { at: now(), list };
    return list;
  }

  async function entryOf(serviceId: string) {
    const list = await catalog();
    const e = list.find((a) => a.id === serviceId || a.agentIdentifier === serviceId);
    if (!e) throw new MasumiError(`unknown Masumi agent "${serviceId}"`, "unknown_agent");
    return e;
  }

  // ─────────── hire ───────────
  async function startJob(serviceId: string, input: string, ctx?: StartJobContext) {
    const entry = await entryOf(serviceId);
    const addr = await purchasingWallet();
    // Session filter: the session must be allowed to pay the purchasing wallet (also enforced by the Signer and,
    // in vault mode, on-chain), and the agent must be one the plan named — or the plan used the alias.
    if (ctx?.allowedPayees) {
      const toWallet = ctx.allowedPayees.filter((p) => p.address === addr);
      if (!toWallet.length) throw new MasumiError("this session may not pay the Masumi purchasing wallet (add the agent or masumi:purchasing-wallet to allowedPayees)", "payee_not_allowed");
      const ids = new Set(toWallet.flatMap((p) => [p.id, ...(p.also ?? [])]));
      const wildcard = ids.has(MASUMI_PURCHASING_WALLET_ALIAS) || ids.has(addr);
      if (!wildcard && !ids.has(entry.id)) throw new MasumiError(`agent ${entry.id} is not in this session's allowed payees`, "payee_not_allowed");
    }
    const api = entry.endpoint;
    try {
      const av = asRec(await http<unknown>("GET", `${api}/availability`));
      if (av.status && av.status !== "available") throw new MasumiError(`agent unavailable: ${String(av.message ?? av.status).slice(0, 120)}`, "unavailable");
    } catch (e) {
      if (e instanceof MasumiError) throw e;
      throw new MasumiError(`agent availability check failed: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
    }
    const schema = await http<unknown>("GET", `${api}/input_schema`).catch(() => null);
    const field = inputFieldOf(schema);
    if (!field) throw new MasumiError("agent input schema needs structured input this hire cannot fill from free text", "input_schema");
    const inputData = { [field]: input };
    const nonce = randomBytes(HEX_NONCE_BYTES).toString("hex");
    const inputHash = mip004InputHash(inputData, nonce);

    // Journal before the external write (a crash here leaves a visible start_pending, never a silent repost).
    const pendingId = `pending-${nonce}`;
    const t0 = now();
    deps.store.set(KEY(pendingId), JSON.stringify({ jobId: pendingId, phase: "start_pending", serviceId: entry.id, sessionId: ctx?.sessionId ?? null, nonce, createdAt: t0 }));
    const resp = asRec(await http<unknown>("POST", `${api}/start_job`, { body: { identifier_from_purchaser: nonce, input_data: inputData } }));

    const jobId = firstStr(resp, "job_id", "id");
    const blockchainIdentifier = firstStr(resp, "blockchainIdentifier", "blockchain_identifier");
    const sellerVkey = firstStr(resp, "sellerVKey", "sellerVkey", "seller_vkey");
    const agentIdentifier = firstStr(resp, "agentIdentifier", "agent_identifier");
    const payByTime = timeField(resp.payByTime ?? resp.pay_by_time);
    const submitResultTime = timeField(resp.submitResultTime ?? resp.submit_result_time);
    const unlockTime = timeField(resp.unlockTime ?? resp.unlock_time);
    const externalDisputeUnlockTime = timeField(resp.externalDisputeUnlockTime ?? resp.external_dispute_unlock_time);
    const fail = (msg: string, code = "bad_terms"): never => {
      deps.store.set(KEY(pendingId), JSON.stringify({ jobId: pendingId, phase: "failed", serviceId: entry.id, sessionId: ctx?.sessionId ?? null, nonce, error: msg, createdAt: t0 }));
      throw new MasumiError(`Masumi start_job: ${msg}`, code);
    };
    if (!jobId || !blockchainIdentifier || !sellerVkey || !agentIdentifier || !payByTime || !submitResultTime || !unlockTime || !externalDisputeUnlockTime) fail("response is missing signed payment terms");
    if (agentIdentifier !== entry.agentIdentifier) fail("agentIdentifier does not match the registry entry");
    const echoed = firstStr(resp, "identifierFromPurchaser", "identifier_from_purchaser");
    if (echoed && echoed !== nonce) fail("identifierFromPurchaser echo does not match our nonce");
    const sellerInputHash = firstStr(resp, "input_hash", "inputHash");
    if (sellerInputHash && sellerInputHash.toLowerCase() !== inputHash) fail("seller input_hash does not match our MIP-004 input hash", "input_hash_mismatch");
    if (Number(payByTime) < now() + minPayWindowMs) fail(`payByTime leaves less than ${Math.round(minPayWindowMs / 60_000)} min to fund the purchase`, "deadline");

    let amounts: { unit: string; amount: string }[];
    const quoted = [resp.amounts, resp.Amounts, resp.RequestedFunds, resp.requestedFunds, resp.requested_funds].find((x) => Array.isArray(x)) as unknown[] | undefined;
    const quotedAmounts = (quoted ?? []).map(asRec).map((a) => ({ unit: normUnit(str(a.unit) ?? ""), amount: str(a.amount) ?? "" }));
    if (entry.pricingType === "Dynamic") {
      if (!quotedAmounts.length) fail("Dynamic-priced agent returned no amounts in its signed terms");
      amounts = quotedAmounts;
    } else {
      amounts = entry.amounts ?? [];
      if (quotedAmounts.length) {
        const key = (l: { unit: string; amount: string }[]) => JSON.stringify([...l].sort((a, b) => a.unit.localeCompare(b.unit)));
        if (key(quotedAmounts) !== key(amounts)) fail("quoted amounts differ from the registry's fixed pricing");
      }
    }
    const t = toTusdMicro(amounts, cfg);
    if ("error" in t) return fail(t.error, "price");
    if (t.micro > maxPriceMicro) fail(`price ${microToTusd(t.micro)} tUSD above MASUMI_MAX_PRICE_TUSD`, "price");

    const pst = firstStr(resp, "paymentSourceType");
    const spsi = resp.supportedPaymentSourceIndex;
    const rec: MasumiJobRecord = {
      jobId: jobId!,
      serviceId: entry.id,
      agentIdentifier: agentIdentifier!,
      apiBaseUrl: api,
      sessionId: ctx?.sessionId ?? null,
      nonce,
      inputData,
      inputHash,
      terms: {
        blockchainIdentifier: blockchainIdentifier!,
        sellerVkey: sellerVkey!,
        payByTime: payByTime!,
        submitResultTime: submitResultTime!,
        unlockTime: unlockTime!,
        externalDisputeUnlockTime: externalDisputeUnlockTime!,
        ...(pst ? { paymentSourceType: pst } : {}),
        ...(typeof spsi === "number" ? { supportedPaymentSourceIndex: spsi } : {}),
        ...(resp.paymentForceLayer !== undefined ? { paymentForceLayer: (str(resp.paymentForceLayer) ?? null) as string | null } : {}),
      },
      pricingType: entry.pricingType === "Dynamic" ? "Dynamic" : "Fixed",
      amounts,
      amountMicro: t.micro.toString(),
      fundingMode: t.mode,
      phase: "quoted",
      lastPollAt: now(),
      createdAt: t0,
      updatedAt: t0,
    };
    if (load(rec.jobId)) fail("seller reused an existing job id");
    save(rec);
    deps.store.set(KEY(pendingId), JSON.stringify({ jobId: pendingId, phase: "quoted", realJobId: rec.jobId, createdAt: t0 }));
    emit("progress", rec.sessionId, { kind: "masumi", phase: "quoted", jobId: rec.jobId, serviceId: entry.id, priceTUSD: microToTusd(t.micro), fundingMode: t.mode, amounts, payByTime });
    return { jobId: rec.jobId, paymentAddress: addr, amountMicro: t.micro, reference: nonce };
  }

  // ─────────── state machine ───────────
  async function resolvePurchase(r: MasumiJobRecord): Promise<Rec | null> {
    try {
      return asRec(await mpsCall<unknown>("POST", "/purchase/resolve-blockchain-identifier", cfg.buyerToken, { network: cfg.network, blockchainIdentifier: r.terms.blockchainIdentifier }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async function createPurchase(r: MasumiJobRecord, addr: string) {
    setPhase(r, "purchase_pending");
    const body = {
      network: cfg.network,
      blockchainIdentifier: r.terms.blockchainIdentifier,
      inputHash: r.inputHash,
      sellerVkey: r.terms.sellerVkey,
      agentIdentifier: r.agentIdentifier,
      // Fixed: MPS checks these equal the on-chain pricing; Dynamic: they are part of the seller's signature.
      Amounts: r.amounts,
      payByTime: r.terms.payByTime,
      submitResultTime: r.terms.submitResultTime,
      unlockTime: r.terms.unlockTime,
      externalDisputeUnlockTime: r.terms.externalDisputeUnlockTime,
      identifierFromPurchaser: r.nonce,
      buyerReturnAddress: addr,
      metadata: JSON.stringify({ bulkhead: { jobId: r.jobId, sessionId: r.sessionId, fundingTx: r.fundingTxHash ?? null } }).slice(0, 1000),
      ...(r.terms.paymentSourceType ? { paymentSourceType: r.terms.paymentSourceType } : {}),
      ...(r.terms.supportedPaymentSourceIndex !== undefined ? { supportedPaymentSourceIndex: r.terms.supportedPaymentSourceIndex } : {}),
      ...(r.terms.paymentForceLayer !== undefined ? { paymentForceLayer: r.terms.paymentForceLayer } : {}),
    };
    try {
      const p = asRec(await mpsCall<unknown>("POST", "/purchase", cfg.buyerToken, body));
      setPhase(r, "purchased", { purchaseId: str(p.id) ?? "" });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        setPhase(r, "purchased"); // "Purchase exists" — MPS dedupes on blockchainIdentifier
        return;
      }
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        // Definitive rejection: no purchase exists → the funding goes back.
        setPhase(r, "funding_unused", { error: `MPS refused the purchase: ${e.message}` });
        emit("error", r.sessionId, { kind: "masumi_purchase_refused", jobId: r.jobId, error: e.message });
        return;
      }
      // Uncertain (network / 5xx): stay purchase_pending; the next pass resolves before any repost.
      r.error = `purchase uncertain: ${e instanceof Error ? e.message : String(e)}`;
      save(r);
    }
  }

  async function requestRefund(r: MasumiJobRecord, reason: string) {
    try {
      await mpsCall<unknown>("POST", "/purchase/request-refund", cfg.buyerToken, { network: cfg.network, blockchainIdentifier: r.terms.blockchainIdentifier });
      setPhase(r, "refund_requested", { refundReason: reason });
    } catch (e) {
      // Not yet allowed (e.g. still locking) → keep the intent; the watcher retries.
      setPhase(r, "refund_requested", { refundReason: reason, error: `refund request pending: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const refundedOnChain = (p: Rec) => {
    const st = str(p.onChainState);
    const back = Array.isArray(p.WithdrawnForBuyer) && (p.WithdrawnForBuyer as unknown[]).length > 0;
    return st === "RefundWithdrawn" || (st === "DisputedWithdrawn" && back);
  };

  /** MIP-004 verification against the seller's /status and the on-chain result hash. */
  function verify(r: MasumiJobRecord, result: string, sellerHash: string | undefined, onChain: string | null): { ok: true; hash: string } | { ok: false; why: string } {
    const ours = mip004ResultHash(result, r.nonce);
    if (sellerHash && sellerHash.toLowerCase() !== ours && sellerHash.toLowerCase() !== r.inputHash + ours) return { ok: false, why: "seller result hash ≠ sha256(nonce;result)" };
    if (onChain) {
      const h = onChain.toLowerCase();
      if (h !== ours && h !== r.inputHash + ours) return { ok: false, why: "on-chain resultHash ≠ sha256(nonce;result)" };
    }
    return { ok: true, hash: ours };
  }

  async function advance(r: MasumiJobRecord, fromPoll: boolean): Promise<{ status: string; result?: string; resultHash?: string }> {
    if (fromPoll) {
      r.lastPollAt = now();
      save(r);
    }
    const addr = await purchasingWallet();
    const t = now();
    if (r.phase === "quoted") {
      const fund = r.sessionId ? deps.funding({ sessionId: r.sessionId, reference: r.nonce }) : null;
      if (!fund) {
        // No funding payment at all: give up once the seller's deadline is gone or nobody polls any more.
        if (Number(r.terms.payByTime) < t + 60_000 || (!fromPoll && t - r.lastPollAt > abandonAfterMs)) {
          setPhase(r, "failed", { error: "no funding payment was made" });
          return { status: "failed" };
        }
        return { status: "awaiting_payment" };
      }
      if (fund.status === "rejected" || fund.status === "failed") {
        setPhase(r, "failed", { error: `funding payment ${fund.status}` });
        return { status: "failed" };
      }
      // requested / awaiting_approval / approved / submitted: wait. Even when payByTime passes meanwhile we keep
      // waiting — a late-approved payment must still be found and swept back (funding_unused below).
      if (fund.status !== "confirmed") return { status: "awaiting_payment" };
      r.fundingTxHash = fund.txHash ?? undefined;
      if (fund.payee !== addr || fund.amountMicro < BigInt(r.amountMicro)) {
        setPhase(r, "funding_unused", { error: "funding payment does not match the quote (payee/amount)" });
        return { status: "failed" };
      }
      if (Number(r.terms.payByTime) < t + 60_000) {
        setPhase(r, "funding_unused", { error: "funding confirmed too late (payByTime)" });
        return { status: "failed" };
      }
      if (!fromPoll && t - r.lastPollAt > abandonAfterMs) {
        setPhase(r, "funding_unused", { error: "hire abandoned by the session after funding" });
        return { status: "failed" };
      }
      await createPurchase(r, addr);
      return { status: (r.phase as MasumiPhase) === "funding_unused" ? "failed" : "awaiting_payment" };
    }
    if (r.phase === "purchase_pending") {
      const p = await resolvePurchase(r).catch(() => undefined);
      if (p === undefined) return { status: "awaiting_payment" };
      if (p) setPhase(r, "purchased", { purchaseId: str(p.id) ?? "" });
      else await createPurchase(r, addr); // confirmed absent → safe to post (MPS also dedupes)
      return { status: "awaiting_payment" };
    }
    if (r.phase === "purchased") {
      const p = await resolvePurchase(r).catch(() => undefined);
      if (p === undefined) return { status: "running" };
      if (!p) return { status: "awaiting_payment" };
      const st = str(p.onChainState) ?? null;
      const next = asRec(p.NextAction);
      if (refundedOnChain(p)) {
        setPhase(r, "refunded", { refundReason: r.refundReason ?? `escrow ${st}` });
        return { status: "failed" };
      }
      if (st === "FundsOrDatumInvalid") {
        setPhase(r, "refund_requested", { refundReason: "escrow funds or datum invalid" });
        return { status: "failed" };
      }
      if (next.errorType && fromPoll) emit("error", r.sessionId, { kind: "masumi_purchase_error", jobId: r.jobId, errorType: next.errorType, note: str(next.errorNote)?.slice(0, 200) ?? null });
      if (!st) return { status: "awaiting_payment" }; // not locked yet
      // Escrow is locked (or further): ask the seller.
      let s: Rec = {};
      try {
        s = asRec(await http<unknown>("GET", `${r.apiBaseUrl}/status?job_id=${encodeURIComponent(r.jobId)}`));
      } catch {
        /* transient */
      }
      const sellerStatus = str(s.status);
      if (sellerStatus === "failed") {
        await requestRefund(r, "seller reported the job failed");
        return { status: "failed" };
      }
      const onChainHash = str(p.resultHash) ?? null;
      if (sellerStatus === "completed" && s.result !== undefined) {
        const result = typeof s.result === "string" ? s.result : JSON.stringify(s.result);
        if (requireOnChainResult && !onChainHash) {
          if (t > Number(r.terms.submitResultTime) + resultGraceMs) {
            await requestRefund(r, "no result hash on-chain by submitResultTime");
            return { status: "failed" };
          }
          return { status: "running" };
        }
        const v = verify(r, result, firstStr(s, "result_hash", "output_hash", "resultHash"), onChainHash);
        if (!v.ok) {
          setPhase(r, "refund_requested", { result: result.slice(0, 8_000), refundReason: `MIP-004 mismatch: ${v.why}` });
          await requestRefund(r, `MIP-004 mismatch: ${v.why}`);
          emit("error", r.sessionId, { kind: "masumi_hash_mismatch", jobId: r.jobId, why: v.why });
          return { status: "failed" };
        }
        setPhase(r, "completed", { result: result.slice(0, 8_000), resultHash: v.hash });
        return { status: "completed", result, resultHash: v.hash };
      }
      if (t > Number(r.terms.submitResultTime) + resultGraceMs && !onChainHash) {
        await requestRefund(r, "seller missed submitResultTime");
        return { status: "failed" };
      }
      return { status: sellerStatus === "awaiting_payment" ? "awaiting_payment" : "running" };
    }
    if (r.phase === "completed") return { status: "completed", result: r.result ?? "", resultHash: r.resultHash ?? "" };
    return { status: "failed" };
  }

  /** Watcher-only phases: refunds and sweeps. */
  async function settle(r: MasumiJobRecord) {
    if (r.phase === "refund_requested") {
      const p = await resolvePurchase(r).catch(() => undefined);
      if (!p) return;
      if (refundedOnChain(p)) return setPhase(r, "refunded");
      if (str(p.onChainState) === "Withdrawn") return setPhase(r, "failed", { error: "seller withdrew the payment despite the refund request (dispute lost/expired)" });
      if (r.error?.startsWith("refund request pending") && str(p.onChainState) !== "RefundRequested") await requestRefund(r, r.refundReason ?? "refund");
      return;
    }
    if (r.phase === "refunded" || r.phase === "funding_unused") {
      if (!r.sessionId) return setPhase(r, "unswept", { error: "no session to return the funds to" });
      const target = deps.sweepTarget(r.sessionId);
      if (!target) return setPhase(r, "unswept", { error: "no sweep target (session owner treasury) found" });
      if (!cfg.adminToken) {
        setPhase(r, "unswept", { error: "no MPS admin key: transfer-funds is admin-only; operator must sweep manually" });
        emit("error", r.sessionId, { kind: "masumi_refund_unswept", jobId: r.jobId, tusd: microToTusd(BigInt(r.amountMicro)), to: target.address });
        return;
      }
      try {
        const x = asRec(
          await mpsCall<unknown>("POST", "/wallet/transfer-funds", cfg.adminToken, {
            fromWalletAddress: await purchasingWallet(),
            toAddress: target.address,
            lovelaceAmount: sweepLovelace.toString(),
            assets: [{ unit: cfg.tusdUnit, quantity: r.amountMicro }],
          }),
        );
        setPhase(r, "sweep_submitted", { sweep: { id: str(x.id) ?? "", toAddress: target.address, tusdMicro: r.amountMicro, lovelace: sweepLovelace.toString(), txHash: str(x.txHash) ?? null, status: str(x.status) ?? "Pending" } });
      } catch (e) {
        r.error = `sweep failed: ${e instanceof Error ? e.message : String(e)}`;
        save(r);
      }
      return;
    }
    if (r.phase === "sweep_submitted" && r.sweep?.id && cfg.adminToken) {
      try {
        const x = asRec(await mpsCall<unknown>("GET", `/wallet/transfer-funds?id=${encodeURIComponent(r.sweep.id)}`, cfg.adminToken));
        const tr = asRec((Array.isArray(x.transfers) ? x.transfers[0] : x) ?? {});
        const status = str(tr.status);
        const txHash = str(tr.txHash) ?? null;
        if (status === "Confirmed") setPhase(r, "swept", { sweep: { ...r.sweep, status, txHash } });
        else if (status && status !== "Pending") setPhase(r, "refunded", { error: `sweep ${status}: ${str(tr.errorNote) ?? ""}`.trim() }); // retry
      } catch {
        /* transient */
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const { value } of deps.store.list("masumi:job:")) {
        let r: MasumiJobRecord;
        try {
          r = JSON.parse(value) as MasumiJobRecord;
        } catch {
          continue;
        }
        if (!r.terms || !LIVE_PHASES.includes(r.phase)) continue;
        try {
          if (r.phase === "quoted" || r.phase === "purchase_pending" || r.phase === "purchased") await advance(r, false);
          // Settle phases may chain within one pass (refund_requested → refunded → sweep_submitted → swept).
          for (let step = 0; step < 4; step++) {
            const before = r.phase;
            if (r.phase === "refund_requested" || r.phase === "refunded" || r.phase === "funding_unused" || r.phase === "sweep_submitted") await settle(r);
            if (r.phase === before) break;
          }
        } catch (e) {
          log(`watcher: job ${r.jobId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      ticking = false;
    }
  }

  const market: MasumiMarket = {
    kind: "masumi",
    invalidate() {
      cache = null;
    },
    purchasingWallet,
    async resolvePayeeAlias(alias) {
      if (alias !== MASUMI_PURCHASING_WALLET_ALIAS) return null;
      return { id: MASUMI_PURCHASING_WALLET_ALIAS, label: "Masumi purchasing wallet", address: await purchasingWallet() };
    },
    discoveryReport: () => report,
    job: (jobId) => load(jobId),
    catalog,
    startJob,
    async status(_serviceId, jobId) {
      const r = load(jobId);
      if (!r || !r.terms) return { status: "failed" };
      return advance(r, true);
    },
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), cfg.watchMs ?? 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return market;
}

// ───────────────────────────── engine wiring helpers ─────────────────────────────
/** kv-table store. */
export function dbMasumiStore(db: DB): MasumiStore {
  return {
    get: (key) => db.select().from(kv).where(eq(kv.key, key)).get()?.value ?? null,
    set: (key, value) => {
      db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
    },
    list: (prefix) => db.select().from(kv).all().filter((r) => r.key.startsWith(prefix)),
  };
}

/** The Signer payment that carries `ref:<reference>` in its memo (runner: "hire <id> ref:<reference>"). */
export function dbFundingLookup(db: DB): MasumiDeps["funding"] {
  return ({ sessionId, reference }) => {
    const rows = db.select().from(payments).where(eq(payments.sessionId, sessionId)).all();
    const hit = rows.filter((p) => /(?:^|\s)ref:(\S+)/.exec(p.memo)?.[1] === reference).sort((a, b) => b.createdAt - a.createdAt)[0];
    return hit ? { status: hit.status, txHash: hit.txHash, amountMicro: BigInt(hit.amountMicro), payee: hit.payee } : null;
  };
}

/** Refund sweeps go to the session vault's OWNER (user treasury), see the header comment. */
export function dbSweepTarget(db: DB): MasumiDeps["sweepTarget"] {
  return (sessionId) => {
    const s = db.select({ userId: sessionsT.userId }).from(sessionsT).where(eq(sessionsT.id, sessionId)).get();
    if (!s) return null;
    const u = db.select({ a: users.treasuryAddress }).from(users).where(eq(users.id, s.userId)).get();
    return u?.a && /^addr_test1[0-9a-z]+$/.test(u.a) ? { address: u.a, label: "session owner treasury" } : null;
  };
}

/** Config from env + the token files under .local/ (never printed). */
export function masumiConfigFromEnv(env: NodeJS.ProcessEnv, tusdUnit: string, repoRoot: string): MasumiConfig {
  const network = env.MASUMI_NETWORK ?? "Preprod";
  if (network !== "Preprod") throw new MasumiError(`MASUMI_NETWORK=${network} refused: Bulkhead is preprod only`, "network");
  const buyerFile = readEnvFile(env.MASUMI_MPS_BUYER_ENV_FILE ?? `${repoRoot}/.local/mps-buyer.env`);
  const adminFile = readEnvFile(env.MASUMI_MPS_ADMIN_ENV_FILE ?? `${repoRoot}/.local/mps-admin.env`);
  const buyerToken = env.MPS_BUYER_TOKEN ?? buyerFile.MPS_BUYER_TOKEN ?? "";
  if (!buyerToken) throw new MasumiError("MARKET=masumi needs MPS_BUYER_TOKEN (a canPay MPS key scoped to the purchasing wallet) in .local/mps-buyer.env", "config");
  const adminToken = env.MPS_ADMIN_TOKEN ?? adminFile.MPS_ADMIN_TOKEN;
  const usd = env.MASUMI_USD_UNITS?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    network: "Preprod",
    mpsUrl: env.MASUMI_MPS_URL ?? buyerFile.MPS_URL ?? "http://127.0.0.1:3901/api/v1",
    buyerToken,
    ...(adminToken ? { adminToken } : {}),
    ...(env.MPS_DISCOVERY_TOKEN ?? buyerFile.MPS_DISCOVERY_TOKEN ? { discoveryToken: env.MPS_DISCOVERY_TOKEN ?? buyerFile.MPS_DISCOVERY_TOKEN } : {}),
    ...(env.MASUMI_REGISTRY_URL ? { registryUrl: env.MASUMI_REGISTRY_URL } : {}),
    ...(env.REGISTRY_API_KEY ? { registryToken: env.REGISTRY_API_KEY } : {}),
    ...(env.MASUMI_PURCHASING_WALLET_ADDRESS ? { purchasingWalletAddress: env.MASUMI_PURCHASING_WALLET_ADDRESS } : {}),
    tusdUnit,
    ...(usd?.length ? { usdUnits: usd } : {}),
    ...(env.MASUMI_TUSD_PER_ADA ? { tusdPerAda: env.MASUMI_TUSD_PER_ADA } : {}),
    ...(env.MASUMI_MAX_PRICE_TUSD ? { maxPriceMicro: tusdToMicro(env.MASUMI_MAX_PRICE_TUSD) } : {}),
    ...(env.MASUMI_AGENT_ALLOWLIST ? { agentAllowlist: env.MASUMI_AGENT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    allowHttpAgents: env.MASUMI_ALLOW_HTTP_AGENTS === "1",
    requireOnChainResult: env.MASUMI_REQUIRE_ONCHAIN_RESULT !== "0",
  };
}
