// Sokosumi market (env MARKET=sokosumi, alone or with masumi: MARKET=masumi,sokosumi): Bulkhead `hire_agent`
// sessions hire REAL Sokosumi marketplace agents and pay with Sokosumi CREDITS (off-chain), billed ONLY to one
// configured organization workspace (the TOKEN2049 Origins Hackathon org) — never the user's personal credits.
//
// Sources (cardano-dev-skills / masumi skill, CLAUDE.md rule "check the skill + bundled docs first"):
//   .claude/skills/masumi/references/sokosumi-api-reference.md  — /v1 endpoints, auth, X-Organization-Slug,
//       POST /agents/{id}/jobs body {inputSchema, inputData, maxCredits, name}, job status enum, 402 = credits.
//   .claude/skills/masumi/references/sokosumi-marketplace.md     — credits ≈ $0.01 ("100 credits ≈ $1").
//   .claude/skills/masumi/references/api-debug-recipes.md        — key handling (never printed), balance reads.
//   Installed Sokosumi CLI 1.0.0 (`$(npm root -g)/sokosumi/dist/src/api/`): http-client.js (Bearer + the
//       X-Organization-Slug header, slug regex), services/agent-service.js (GET /v1/agents, /input-schema,
//       POST /v1/agents/{id}/jobs; maxCredits only when > 0), services/job-service.js (GET /v1/jobs/{id},
//       /events, /files, /links), models/agent-job.js ({id, agentId, status, name, result}).
//
// Money rules (the user's hard requirement):
//   * EVERY request this module sends carries `X-Organization-Slug: <SOKOSUMI_HIRE_ORGANIZATION_SLUG>`, with ONE
//     exception: the read-only control probe GET /v1/users/me/credits, which must NOT switch workspace — per the
//     live OpenAPI it answers the key's own context wallet (scope "personal" | "organization"); scope "personal"
//     is the control value for the "personal credits never move" check. The market refuses to start without a
//     slug + organization id.
//   * Before each hire: GET /v1/users/me/organizations/{orgId}/credits must answer scope "organization" with
//     enough spendable credits; the personal wallet (when readable) and every OTHER organization of the user
//     (GET /v1/users/me/organizations) are read as controls. The created job must report organizationId = the
//     configured org. After the job is created AND after it finishes: re-read everything and record the deltas.
//     A job outside the org, or ANY control balance going DOWN → `sokosumi_incident` error event + the market
//     disables itself (persisted in kv `sokosumi:disabled`; delete that row to re-enable after review).
//     The org pool is shared with other hackathon members, so org deltas are recorded, not asserted.
//   * Mandate cap: maxCredits = min(floor(min(remaining session budget, per-payment max) × SOKOSUMI_CREDITS_PER_TUSDM),
//     SOKOSUMI_MAX_CREDITS_PER_HIRE). Agents whose listed credits exceed it are refused before any request is made.
//   * Credits are OFF-CHAIN: the runner records a `payments` row with payee `sokosumi-credits:<slug>`, txHash NULL,
//     status "confirmed", amountMicro = the tUSD-equivalent (credits ÷ rate), plus an `agent_job_paid` event with
//     kind "credits". The evidence is the Sokosumi jobId + resultHash = sha256(raw UTF-8 result) (MIP-004 raw rule,
//     shared/mip004 sha256Hex — no nonce, no JSON escaping).
import { eq } from "drizzle-orm";
import { payments, sessions as sessionsT, type DB } from "@bulkhead/db";
import { microToTusd, type AgentCatalogEntry } from "@bulkhead/shared";
import { sha256Hex } from "@bulkhead/shared/mip004";
import type { AgentMarket, StartJobContext } from "./contracts";

type FetchFn = typeof fetch;
type Rec = Record<string, unknown>;

export const SOKOSUMI_PREPROD_API_URL = "https://api.preprod.sokosumi.com";
/** Catalog ids are `sokosumi:<Sokosumi agent id>`; the same string is the session's allowed-payee id. */
export const SOKOSUMI_ID_PREFIX = "sokosumi:";
/** payments.payee of an off-chain credit spend: `sokosumi-credits:<organization slug>` (never an address). */
export const SOKOSUMI_CREDITS_PAYEE_PREFIX = "sokosumi-credits:";
/** Default rate (sokosumi-marketplace.md: 1 credit ≈ $0.01 → 100 credits ≈ 1 USD ≈ 1 tUSDM). */
export const DEFAULT_CREDITS_PER_TUSDM = 100;
export const DEFAULT_MAX_CREDITS_PER_HIRE = 10;
const DISABLED_KEY = "sokosumi:disabled";
const JOB_KEY = (jobId: string) => `sokosumi:job:${jobId}`;
/** CLI http-client.js validateOrganizationSlug. */
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_FAILED = new Set(["failed", "payment_failed", "refund_resolved", "dispute_resolved", "refund_pending", "dispute_pending", "canceled", "cancelled"]);

export class SokosumiError extends Error {
  override name = "SokosumiError";
  constructor(
    message: string,
    readonly code: "config" | "disabled" | "refused" | "balance" | "http" | "input" | "insufficient_credits",
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SokosumiConfig {
  /** API origin WITHOUT /v1 (paths below start with /v1, like the CLI). Mainnet (api.sokosumi.com) is refused. */
  apiUrl: string;
  /** Bearer key. Never logged, never put into an error message or event. */
  apiKey: string;
  /** The ONLY workspace credits may come from (X-Organization-Slug). Required. */
  organizationSlug: string;
  /** That workspace's organization id (balance endpoint + scope check). Required. */
  organizationId: string;
  /** Sokosumi user id (balance endpoints); else GET /v1/users/registered. */
  userId?: string;
  /** Credits per 1 tUSD(M) of session budget. Default 100. */
  creditsPerTusd?: number;
  /** Hard ceiling per hire, whatever the session budget. Default 10. */
  maxCreditsPerHire?: number;
  /** Only these Sokosumi agent ids are listed (optional). */
  agentAllowlist?: string[];
  cacheMs?: number;
  timeoutMs?: number;
}

/** Session mandate numbers the cap is derived from (engine: the sessions + payments tables). */
export interface SokosumiMandate {
  status: string;
  budgetMicro: bigint;
  /** On-chain spend recorded by the Signer. */
  spentMicro: bigint;
  /** tUSD-equivalent of credit spends already recorded for this session (payee sokosumi-credits:…). */
  creditSpentMicro: bigint;
  perPaymentMaxMicro: bigint;
}

/** Same shape as MasumiStore (kv table in production, Map in tests). */
export interface SokosumiStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  list(prefix: string): { key: string; value: string }[];
}

export interface SokosumiDeps {
  fetchImpl?: FetchFn;
  store: SokosumiStore;
  mandate(sessionId: string): SokosumiMandate | null;
  emit?(type: "progress" | "error", sessionId: string | null, data: Record<string, unknown>): void;
  now?(): number;
  log?(msg: string): void;
}

export interface SokosumiInputField {
  id: string;
  type: string;
  name: string;
  required: boolean;
  description?: string;
  values?: unknown[];
}

/** Catalog entry: AgentCatalogEntry + Sokosumi extras (structurally compatible; the planner sees id/name/skills/priceTUSD). */
export interface SokosumiCatalogEntry extends AgentCatalogEntry {
  source: "sokosumi";
  billing: "credits";
  credits: number;
  sokosumiAgentId: string;
}

/**
 * Balances around a hire. `org` = the configured organization's pool (scope "organization", by id).
 * `personal` = GET /v1/users/{uid}/credits WITHOUT the slug header when it answers scope "personal"; null when the
 * key's own context is an organization (live 2026-10-07: the new key's context is the hackathon org, so the
 * personal wallet is not readable — and not spendable — with it). `others` = every OTHER organization the user
 * belongs to (by id): a decrease there is treated like a personal decrease.
 */
export interface BalanceSnapshot {
  org: number;
  personal: number | null;
  /** Scope the no-slug context read answered ("personal" | "organization"). */
  contextScope: string;
  others: Record<string, number>;
  at: number;
}

export interface SokosumiJobRecord {
  jobId: string;
  serviceId: string;
  agentId: string;
  agentName: string;
  sessionId: string | null;
  organizationSlug: string;
  organizationId: string;
  listedCredits: number;
  maxCredits: number;
  /** tUSD-equivalent of listedCredits at the configured rate (what the payments row records). */
  amountMicro: string;
  inputData: Record<string, unknown>;
  status: string;
  before: BalanceSnapshot;
  afterHire?: BalanceSnapshot;
  afterResult?: BalanceSnapshot;
  /** Deltas vs `before` (negative = spent). */
  orgDelta?: number;
  personalDelta?: number | null;
  otherDeltas?: Record<string, number>;
  /** Organization the job reports it belongs to (must be organizationId). */
  jobOrganizationId?: string | null;
  /** Credits the job reports (Sokosumi job.credits). */
  jobCredits?: number | null;
  result?: string;
  /** sha256(raw UTF-8 result) — Bulkhead's evidence hash. */
  resultHash?: string;
  /** Sokosumi's own job.resultHash (Masumi on-chain hash, different rule), recorded as reported. */
  sokosumiResultHash?: string | null;
  incident?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SokosumiMarket extends AgentMarket {
  readonly kind: "sokosumi";
  catalog(): Promise<SokosumiCatalogEntry[]>;
  invalidate(): void;
  disabled(): string | null;
  job(jobId: string): SokosumiJobRecord | null;
  /** Read-only: the org pool + control balances (personal when readable, other organizations). */
  balances(): Promise<BalanceSnapshot>;
  inputSchema(serviceId: string): Promise<{ raw: unknown; fields: SokosumiInputField[] }>;
}

// ───────────────────────────── helpers ─────────────────────────────
const asRec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** tUSD micro-units for `credits` at `rate` credits per tUSD (rounded up: never under-records a spend). */
export function creditsToMicro(credits: number, rate: number): bigint {
  return BigInt(Math.ceil((credits / rate) * 1_000_000));
}

/** Mandate cap in credits: floor(min(remaining budget, per-payment max) × rate), bounded by the per-hire ceiling. */
export function maxCreditsFor(m: SokosumiMandate, rate: number, ceiling: number): { maxCredits: number; capMicro: bigint; remainingMicro: bigint } {
  const remainingMicro = m.budgetMicro - m.spentMicro - m.creditSpentMicro;
  const capMicro = remainingMicro < m.perPaymentMaxMicro ? remainingMicro : m.perPaymentMaxMicro;
  const fromBudget = capMicro > 0n ? Math.floor((Number(capMicro) * rate) / 1_000_000) : 0;
  return { maxCredits: Math.max(0, Math.min(fromBudget, ceiling)), capMicro, remainingMicro };
}

export const isSokosumiCreditPayment = (p: { payee: string; txHash: string | null }) => p.txHash === null && p.payee.startsWith(SOKOSUMI_CREDITS_PAYEE_PREFIX);

/** Input-schema fields (MIP-003 style: flat `input_data` or `input_groups[].input_data`; Sokosumi items {id,type,name,data}). */
export function sokosumiInputFields(schema: unknown): SokosumiInputField[] {
  const s = asRec(schema);
  const inner = Array.isArray(schema) ? { input_data: schema } : Array.isArray(s.input_data) || Array.isArray(s.input_groups) ? s : asRec(s.inputSchema ?? s.input_schema);
  const flat = Array.isArray(inner.input_data)
    ? (inner.input_data as unknown[])
    : Array.isArray(inner.input_groups)
      ? (inner.input_groups as unknown[]).flatMap((g) => (Array.isArray(asRec(g).input_data) ? (asRec(g).input_data as unknown[]) : []))
      : [];
  const out: SokosumiInputField[] = [];
  for (const f of flat.map(asRec)) {
    const id = str(f.id) ?? str(f.key);
    if (!id) continue;
    const data = asRec(f.data);
    const validations = Array.isArray(f.validations) ? (f.validations as unknown[]).map(asRec) : [];
    const optional = validations.some((v) => v.validation === "optional" && String(v.value) === "true") || f.optional === true || f.required === false || data.optional === true;
    out.push({
      id,
      type: str(f.type) ?? "string",
      name: str(f.name) ?? id,
      required: !optional && f.type !== "none" && f.type !== "hidden",
      ...(str(data.description) ? { description: clip(str(data.description)!, 160) } : {}),
      ...(Array.isArray(data.values) ? { values: data.values as unknown[] } : {}),
    });
  }
  return out;
}

const TEXTUAL = new Set(["string", "text", "textarea", "search"]);
const PREFERRED = /^(input|prompt|text|query|question|topic|task|description|research|request|keyword|keywords|subject)$/i;

/**
 * Map the silo's free-text hire input onto an agent's input schema (the silo tool contract stays
 * { serviceId, input: string }). Compatible extension: `input` may be a JSON object string keyed by field id.
 *   - JSON object → its keys fill the matching fields.
 *   - Free text   → the primary text field (a required textual field, preferring input/prompt/query/topic/…).
 *   - Other fields → `data.default` / hidden `data.value`; optional ones without a default are left out.
 *   - A required field nothing can fill → SokosumiError("input") listing the fields, so the session can retry with JSON.
 */
export function mapSokosumiInput(schema: unknown, input: string): { inputData: Record<string, unknown>; fields: SokosumiInputField[] } {
  const fields = sokosumiInputFields(schema);
  const rawFields = (() => {
    const s = asRec(schema);
    const inner = Array.isArray(s.input_data) || Array.isArray(s.input_groups) ? s : asRec(s.inputSchema ?? s.input_schema);
    const flat = Array.isArray(inner.input_data) ? (inner.input_data as unknown[]) : Array.isArray(inner.input_groups) ? (inner.input_groups as unknown[]).flatMap((g) => (asRec(g).input_data as unknown[]) ?? []) : [];
    return new Map(flat.map(asRec).map((f) => [str(f.id) ?? str(f.key) ?? "", asRec(f.data)]));
  })();
  let provided: Rec | null = null;
  const t = input.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) provided = j as Rec;
    } catch {
      provided = null; // plain text that happens to start with "{"
    }
  }
  const inputs = fields.filter((f) => f.type !== "none" && f.type !== "hidden");
  const textual = inputs.filter((f) => TEXTUAL.has(f.type));
  const primary = provided && inputs.some((f) => f.id in provided!)
    ? null
    : (textual.find((f) => f.required && PREFERRED.test(f.id)) ??
      textual.find((f) => f.required) ??
      textual.find((f) => PREFERRED.test(f.id)) ??
      textual[0] ??
      null);
  const inputData: Record<string, unknown> = {};
  const missing: SokosumiInputField[] = [];
  for (const f of fields) {
    const data = rawFields.get(f.id) ?? {};
    if (f.type === "none") continue;
    if (f.type === "hidden") {
      if (data.value !== undefined) inputData[f.id] = data.value;
      continue;
    }
    if (provided && f.id in provided) inputData[f.id] = provided[f.id];
    else if (primary && f.id === primary.id) inputData[f.id] = input;
    else if (data.default !== undefined) inputData[f.id] = data.default;
    else if (f.required) missing.push(f);
  }
  if (!t) throw new SokosumiError("hire input is empty", "input");
  if (inputs.length > 0 && !primary && !(provided && inputs.some((f) => f.id in provided!))) {
    throw new SokosumiError(`cannot map the input onto this agent's fields (${describeFields(inputs)}); pass input as a JSON object keyed by field id`, "input");
  }
  // OpenAPI POST /agents/{id}/jobs: inputData values are string | number | boolean | string[] | number[].
  for (const [k, v] of Object.entries(inputData)) {
    const ok =
      typeof v === "string" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      typeof v === "boolean" ||
      (Array.isArray(v) && (v.every((x) => typeof x === "string") || v.every((x) => typeof x === "number" && Number.isFinite(x))));
    if (!ok) throw new SokosumiError(`field ${k}: value must be a string, number, boolean or an array of strings/numbers`, "input");
  }
  if (missing.length) {
    throw new SokosumiError(`agent needs more fields: ${describeFields(missing)}. Pass input as a JSON object keyed by field id, e.g. {${missing.map((m) => `"${m.id}": …`).join(", ")}}`, "input");
  }
  return { inputData, fields };
}

const describeFields = (fs: SokosumiInputField[]) =>
  fs.map((f) => `${f.id} (${f.type}${f.required ? ", required" : ""}${f.values?.length ? `: ${f.values.slice(0, 6).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("|")}` : ""})`).join(", ");

/** Text of a completed job: the `result` string (CLI agent-job.js), else outputs / links / files / events. */
export function resultTextOf(job: Rec, extras: { links?: Rec[]; files?: Rec[]; events?: Rec[] } = {}): string {
  const r = job.result ?? job.output ?? job.outputData;
  if (typeof r === "string" && r.trim()) return r;
  if (r && typeof r === "object") return JSON.stringify(r);
  const ev = [...(extras.events ?? [])].reverse().find((e) => typeof e.result === "string" && (e.result as string).trim());
  if (ev) return ev.result as string;
  const parts: string[] = [];
  for (const l of extras.links ?? []) if (str(l.url)) parts.push(`${str(l.title) ?? "link"}: ${str(l.url)}`);
  for (const f of extras.files ?? []) {
    const u = str(f.fileUrl) ?? str(f.sourceUrl) ?? str(f.url);
    if (u) parts.push(`${str(f.name) ?? "file"}: ${u.split("?")[0]}`); // drop signed-URL query (credentials)
  }
  return parts.join("\n");
}

// ───────────────────────────── the market ─────────────────────────────
export function createSokosumiMarket(cfg: SokosumiConfig, deps: SokosumiDeps): SokosumiMarket {
  if (!cfg.apiKey) throw new SokosumiError("Sokosumi market: SOKOSUMI_API_KEY is not set", "config");
  if (!cfg.organizationSlug?.trim()) throw new SokosumiError("Sokosumi market refused to start: SOKOSUMI_HIRE_ORGANIZATION_SLUG is not set (credits must be billed to the hackathon organization, never personal credits)", "config");
  if (!SLUG_RE.test(cfg.organizationSlug.trim())) throw new SokosumiError("Sokosumi market: SOKOSUMI_HIRE_ORGANIZATION_SLUG must contain only letters, numbers, _ or -", "config");
  if (!cfg.organizationId?.trim()) throw new SokosumiError("Sokosumi market refused to start: SOKOSUMI_HIRE_ORGANIZATION_ID is not set", "config");
  const base = cfg.apiUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    throw new SokosumiError(`Sokosumi market: invalid SOKOSUMI_API_URL`, "config");
  }
  if (host === "api.sokosumi.com" || host === "app.sokosumi.com") throw new SokosumiError("Sokosumi market: mainnet refused (preprod only: https://api.preprod.sokosumi.com)", "config");
  const slug = cfg.organizationSlug.trim();
  const orgId = cfg.organizationId.trim();
  const rate = cfg.creditsPerTusd && cfg.creditsPerTusd > 0 ? cfg.creditsPerTusd : DEFAULT_CREDITS_PER_TUSDM;
  const ceiling = cfg.maxCreditsPerHire && cfg.maxCreditsPerHire > 0 ? cfg.maxCreditsPerHire : DEFAULT_MAX_CREDITS_PER_HIRE;
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[sokosumi] ${m}`));
  const emit = deps.emit ?? (() => undefined);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  let cache: { at: number; list: SokosumiCatalogEntry[] } | null = null;
  const schemas = new Map<string, { at: number; raw: unknown }>();
  const userId: string | null = cfg.userId?.trim() || null;
  let hireChain: Promise<unknown> = Promise.resolve();

  /** Every request carries the org slug, except the personal-balance probe (`personal: true`). */
  async function call(method: "GET" | "POST", path: string, body?: unknown, opts: { personal?: boolean } = {}): Promise<Rec> {
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${cfg.apiKey}` };
    if (!opts.personal) headers["X-Organization-Slug"] = slug;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (e) {
      throw new SokosumiError(`Sokosumi ${method} ${path.split("?")[0]}: ${e instanceof Error ? e.message.replaceAll(cfg.apiKey, "***") : "network error"}`, "http");
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const msg = clip(String(asRec(parsed).message ?? asRec(parsed).error ?? `HTTP ${res.status}`).replaceAll(cfg.apiKey, "***"), 200);
      if (res.status === 402) throw new SokosumiError(`Sokosumi: insufficient credits in organization ${slug} (402): ${msg}`, "insufficient_credits", 402);
      throw new SokosumiError(`Sokosumi ${method} ${path.split("?")[0]} → HTTP ${res.status}: ${msg}`, "http", res.status);
    }
    return asRec(parsed);
  }
  const dataOf = (r: Rec): unknown => ("data" in r ? r.data : r);

  function disabledReason(): string | null {
    return deps.store.get(DISABLED_KEY);
  }
  function disable(reason: string) {
    deps.store.set(DISABLED_KEY, clip(reason, 500));
    cache = null;
    log(`market DISABLED: ${reason}`);
  }
  const load = (jobId: string): SokosumiJobRecord | null => {
    const v = deps.store.get(JOB_KEY(jobId));
    return v ? (JSON.parse(v) as SokosumiJobRecord) : null;
  };
  const save = (r: SokosumiJobRecord) => {
    r.updatedAt = now();
    deps.store.set(JOB_KEY(r.jobId), JSON.stringify(r));
  };

  // OpenAPI (live /v1/openapi.json): `{id}` may be the literal "me" for the authenticated user.
  const uid = () => encodeURIComponent(userId ?? "me");
  const spendableOf = (d: Rec): number | null => num(d.spendable) ?? num(asRec(d.credits).total) ?? num(d.balance);

  async function orgBalanceOf(id: string): Promise<{ spendable: number; scope: string }> {
    const d = asRec(dataOf(await call("GET", `/v1/users/${uid()}/organizations/${encodeURIComponent(id)}/credits`)));
    const scope = str(d.scope) ?? "";
    const spendable = spendableOf(d);
    if (spendable === null) throw new SokosumiError(`Sokosumi: organization ${id} balance has no spendable amount`, "balance");
    return { spendable, scope };
  }
  async function orgBalance(): Promise<{ spendable: number; scope: string }> {
    const b = await orgBalanceOf(orgId);
    if (b.scope !== "organization") throw new SokosumiError(`Sokosumi: org balance scope is "${b.scope || "missing"}", not "organization" — refusing to spend`, "balance");
    return b;
  }
  /** No-slug context read: the personal wallet when the key's context is personal (else null + the scope seen). */
  async function contextBalance(): Promise<{ personal: number | null; scope: string }> {
    const d = asRec(dataOf(await call("GET", `/v1/users/${uid()}/credits`, undefined, { personal: true })));
    const scope = str(d.scope) ?? "";
    if (scope === "personal") {
      const v = spendableOf(d);
      if (v === null) throw new SokosumiError("Sokosumi: personal balance has no spendable amount", "balance");
      return { personal: v, scope };
    }
    return { personal: null, scope: scope || "unknown" };
  }
  async function otherOrgBalances(): Promise<Record<string, number>> {
    const d = dataOf(await call("GET", `/v1/users/${uid()}/organizations`));
    const ids = (Array.isArray(d) ? (d as unknown[]) : []).map((o) => str(asRec(o).id)).filter((x): x is string => !!x && x !== orgId);
    const out: Record<string, number> = {};
    for (const id of ids.slice(0, 10)) out[id] = (await orgBalanceOf(id)).spendable;
    return out;
  }
  async function snapshot(): Promise<BalanceSnapshot> {
    const o = await orgBalance();
    const c = await contextBalance();
    const others = await otherOrgBalances();
    return { org: o.spendable, personal: c.personal, contextScope: c.scope, others, at: now() };
  }

  function raiseIncident(r: SokosumiJobRecord, reason: string, extra: Record<string, unknown> = {}) {
    r.incident = reason;
    save(r);
    disable(reason);
    emit("error", r.sessionId, { kind: "sokosumi_incident", incident: true, jobId: r.jobId, serviceId: r.serviceId, organizationSlug: slug, error: reason, ...extra });
  }

  /** Re-read balances, record deltas vs `before`; any decrease outside the configured org → incident + disable. */
  async function checkAfter(r: SokosumiJobRecord, phase: "afterHire" | "afterResult") {
    let snap: BalanceSnapshot;
    try {
      snap = await snapshot();
    } catch (e) {
      emit("error", r.sessionId, { kind: "sokosumi_balance_unverified", jobId: r.jobId, phase, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    r[phase] = snap;
    r.orgDelta = snap.org - r.before.org;
    r.personalDelta = snap.personal !== null && r.before.personal !== null ? snap.personal - r.before.personal : null;
    r.otherDeltas = Object.fromEntries(Object.entries(snap.others).filter(([id]) => id in r.before.others).map(([id, v]) => [id, v - r.before.others[id]!]));
    save(r);
    emit("progress", r.sessionId, {
      kind: "sokosumi_credits",
      billing: "credits",
      offChain: true,
      phase,
      jobId: r.jobId,
      serviceId: r.serviceId,
      organizationSlug: slug,
      listedCredits: r.listedCredits,
      maxCredits: r.maxCredits,
      org: { before: r.before.org, after: snap.org, delta: r.orgDelta },
      personal: { before: r.before.personal, after: snap.personal, delta: r.personalDelta, contextScope: snap.contextScope },
      otherOrganizations: r.otherDeltas,
    });
    if (r.personalDelta !== null && r.personalDelta < 0) {
      raiseIncident(r, `personal Sokosumi credits decreased by ${-r.personalDelta} around job ${r.jobId} (org ${slug}); hiring disabled`, { personalBefore: r.before.personal, personalAfter: snap.personal });
      return;
    }
    const hit = Object.entries(r.otherDeltas).find(([, d]) => d < 0);
    if (hit) raiseIncident(r, `credits of another workspace (${hit[0]}) decreased by ${-hit[1]} around job ${r.jobId}; hiring disabled`, { otherOrganizationId: hit[0], delta: hit[1] });
  }

  async function catalog(): Promise<SokosumiCatalogEntry[]> {
    if (disabledReason()) return [];
    if (cache && now() - cache.at < (cfg.cacheMs ?? 60_000)) return cache.list;
    const list: SokosumiCatalogEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await call("GET", `/v1/agents?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const data = Array.isArray(r.data) ? (r.data as unknown[]) : [];
      for (const a of data.map(asRec)) {
        const id = str(a.id);
        const name = str(a.name);
        const credits = num(asRec(a.price ?? a.pricing).credits ?? a.credits);
        // Credit-priced agents only (x402 / openapi entries have no credits); free (0) dev agents are skipped.
        if (!id || !name || credits === null || credits <= 0) continue;
        if (cfg.agentAllowlist?.length && !cfg.agentAllowlist.includes(id)) continue;
        const cats = (Array.isArray(a.categories) ? a.categories : Array.isArray(a.tags) ? a.tags : []).map((c) => str(asRec(c).name)).filter((x): x is string => !!x);
        const summary = str(a.summary) ?? str(a.description) ?? "";
        list.push({
          id: `${SOKOSUMI_ID_PREFIX}${id}`,
          name,
          skills: [...cats.slice(0, 4), `credits:${credits}`, "billing:sokosumi-credits(off-chain)", ...(summary ? [clip(summary.replace(/\s+/g, " "), 140)] : [])],
          priceTUSD: microToTusd(creditsToMicro(credits, rate)),
          paymentAddress: "",
          endpoint: `${base}/v1/agents/${encodeURIComponent(id)}`,
          source: "sokosumi",
          billing: "credits",
          credits,
          sokosumiAgentId: id,
        });
      }
      cursor = str(asRec(asRec(r.meta).pagination).nextCursor) ?? null;
      if (!cursor) break;
    }
    cache = { at: now(), list };
    return list;
  }

  const agentIdOf = (serviceId: string) => (serviceId.startsWith(SOKOSUMI_ID_PREFIX) ? serviceId.slice(SOKOSUMI_ID_PREFIX.length) : serviceId);

  async function rawSchema(agentId: string): Promise<unknown> {
    const hit = schemas.get(agentId);
    if (hit && now() - hit.at < (cfg.cacheMs ?? 60_000)) return hit.raw;
    const raw = dataOf(await call("GET", `/v1/agents/${encodeURIComponent(agentId)}/input-schema`));
    schemas.set(agentId, { at: now(), raw });
    return raw;
  }

  async function startJobLocked(serviceId: string, input: string, ctx?: StartJobContext) {
    const off = disabledReason();
    if (off) throw new SokosumiError(`Sokosumi hiring is disabled: ${off}`, "disabled");
    const entry = (await catalog()).find((a) => a.id === serviceId || a.sokosumiAgentId === serviceId);
    if (!entry) throw new SokosumiError(`unknown Sokosumi agent "${serviceId}"`, "refused");
    if (!ctx?.sessionId) throw new SokosumiError("Sokosumi hires need a session mandate (no session context)", "refused");
    const m = deps.mandate(ctx.sessionId);
    if (!m) throw new SokosumiError(`session ${ctx.sessionId} not found`, "refused");
    if (m.status !== "RUNNING") throw new SokosumiError(`session is ${m.status}`, "refused");
    const cap = maxCreditsFor(m, rate, ceiling);
    if (entry.credits > cap.maxCredits) {
      throw new SokosumiError(
        `agent ${entry.name} costs ${entry.credits} credits > mandate cap ${cap.maxCredits} credits (remaining ${microToTusd(cap.remainingMicro > 0n ? cap.remainingMicro : 0n)} tUSD, per-payment max ${microToTusd(m.perPaymentMaxMicro)} tUSD × ${rate} credits/tUSDM, ceiling ${ceiling})`,
        "refused",
      );
    }
    const raw = await rawSchema(entry.sokosumiAgentId);
    const { inputData } = mapSokosumiInput(raw, input);
    // Balances BEFORE: org scope must be "organization" for the configured org id with enough credits;
    // personal (when readable) + every other workspace are the controls.
    const before = await snapshot();
    if (before.org < entry.credits) throw new SokosumiError(`organization ${slug} has ${before.org} spendable credits < ${entry.credits}`, "insufficient_credits");
    const body = { inputSchema: raw, inputData, maxCredits: cap.maxCredits, name: clip(`Bulkhead ${ctx.sessionId} · ${entry.name}`, 120) };
    const created = asRec(dataOf(await call("POST", `/v1/agents/${encodeURIComponent(entry.sokosumiAgentId)}/jobs`, body)));
    const jobId = str(created.id);
    if (!jobId) throw new SokosumiError("Sokosumi: job creation returned no id", "http");
    const jobOrg = str(created.organizationId) ?? str(asRec(created.organization).id) ?? null;
    const t = now();
    const rec: SokosumiJobRecord = {
      jobId,
      serviceId: entry.id,
      agentId: entry.sokosumiAgentId,
      agentName: entry.name,
      sessionId: ctx.sessionId,
      organizationSlug: slug,
      organizationId: orgId,
      listedCredits: entry.credits,
      maxCredits: cap.maxCredits,
      amountMicro: creditsToMicro(entry.credits, rate).toString(),
      inputData,
      status: str(created.status) ?? "started",
      before,
      jobOrganizationId: jobOrg,
      jobCredits: num(created.credits),
      createdAt: t,
      updatedAt: t,
    };
    save(rec);
    log(`hired ${entry.name} job ${jobId} (${entry.credits} credits, cap ${cap.maxCredits}, org ${slug})`);
    if (jobOrg !== orgId) {
      // The job is not in the hackathon workspace (personal or another org): stop everything.
      raiseIncident(rec, `Sokosumi job ${jobId} was created in ${jobOrg ? `organization ${jobOrg}` : "a non-organization (personal) workspace"}, not ${orgId}; hiring disabled`, { jobOrganizationId: jobOrg });
      await checkAfter(rec, "afterHire");
      throw new SokosumiError(`job ${jobId} was not billed to organization ${slug}; hiring disabled`, "disabled");
    }
    await checkAfter(rec, "afterHire");
    if (disabledReason()) throw new SokosumiError(`Sokosumi hiring is disabled after job ${jobId}: ${disabledReason()}`, "disabled");
    return {
      jobId,
      paymentAddress: "",
      amountMicro: BigInt(rec.amountMicro),
      reference: jobId,
      billing: { kind: "credits" as const, credits: entry.credits, maxCredits: cap.maxCredits, organizationSlug: slug, payee: `${SOKOSUMI_CREDITS_PAYEE_PREFIX}${slug}` },
    };
  }

  const market: SokosumiMarket = {
    kind: "sokosumi",
    invalidate() {
      cache = null;
      schemas.clear();
    },
    disabled: disabledReason,
    job: load,
    balances: snapshot,
    async inputSchema(serviceId) {
      const raw = await rawSchema(agentIdOf(serviceId));
      return { raw, fields: sokosumiInputFields(raw) };
    },
    catalog,
    startJob(serviceId, input, ctx) {
      // Serialised: balance deltas are attributed to one hire at a time.
      const run = hireChain.then(() => startJobLocked(serviceId, input, ctx));
      hireChain = run.catch(() => undefined);
      return run;
    },
    async status(_serviceId, jobId) {
      const r = load(jobId);
      if (!r) return { status: "failed" };
      if (r.status === "completed" && r.result !== undefined && r.resultHash) return { status: "completed", result: r.result, resultHash: r.resultHash };
      const job = asRec(dataOf(await call("GET", `/v1/jobs/${encodeURIComponent(jobId)}`)));
      const st = (str(job.status) ?? "").toLowerCase();
      if (st === "completed") {
        let text = resultTextOf(job);
        if (!text.trim()) {
          const list = async (sfx: string) => {
            try {
              const d = dataOf(await call("GET", `/v1/jobs/${encodeURIComponent(jobId)}/${sfx}`));
              return Array.isArray(d) ? (d as unknown[]).map(asRec) : [];
            } catch {
              return [];
            }
          };
          text = resultTextOf(job, { links: await list("links"), files: await list("files"), events: await list("events") });
        }
        if (!text.trim()) return { status: "running" }; // completed but output not readable yet
        r.status = "completed";
        r.result = text;
        r.resultHash = sha256Hex(text);
        r.sokosumiResultHash = str(job.resultHash) ?? null;
        r.jobCredits = num(job.credits) ?? r.jobCredits ?? null;
        save(r);
        await checkAfter(r, "afterResult");
        return { status: "completed", result: text, resultHash: r.resultHash };
      }
      if (TERMINAL_FAILED.has(st)) {
        r.status = st;
        save(r);
        await checkAfter(r, "afterResult");
        return { status: "failed" };
      }
      if (st && st !== r.status) {
        r.status = st;
        save(r);
        if (st === "input_required") emit("progress", r.sessionId, { kind: "log", level: "warn", text: `Sokosumi job ${jobId} asks for more input (input_required); Bulkhead does not answer HITL steps — it will time out` });
      }
      return { status: "running" };
    },
    async resolvePayeeAlias(alias, ctx) {
      // A Sokosumi agent id as an allowed payee: credits are off-chain, so no tUSD ever goes to this entry's
      // address. The vault/mandate needs an addr_test1 value: the session owner's own treasury (harmless).
      if (!alias.startsWith(SOKOSUMI_ID_PREFIX)) return null;
      const entry = (await catalog()).find((a) => a.id === alias);
      if (!entry || !ctx?.ownerAddress) return null;
      return { id: entry.id, label: `${entry.name} (Sokosumi credits, off-chain)`, address: ctx.ownerAddress };
    },
  };
  return market;
}

// ───────────────────────────── composite (catalog shows every market) ─────────────────────────────
export interface CompositePart {
  name: "mock" | "masumi" | "sokosumi";
  market: AgentMarket;
}
/** Routes startJob/status to the market that listed the service id; catalog = union (source labelled). */
export function createCompositeMarket(parts: CompositePart[]): AgentMarket & { invalidate(): void; parts: CompositePart[] } {
  const owner = new Map<string, CompositePart>();
  async function catalog(): Promise<AgentCatalogEntry[]> {
    const got = await Promise.allSettled(parts.map((p) => p.market.catalog()));
    const out: AgentCatalogEntry[] = [];
    let firstErr: unknown = null;
    got.forEach((g, i) => {
      const p = parts[i]!;
      if (g.status === "rejected") {
        firstErr ??= g.reason;
        return;
      }
      for (const e of g.value) {
        if (owner.has(e.id) && owner.get(e.id) !== p) continue; // first market wins on an id clash
        owner.set(e.id, p);
        out.push({ ...e, source: e.source ?? p.name });
      }
    });
    if (!out.length && firstErr) throw firstErr;
    return out;
  }
  async function route(serviceId: string): Promise<CompositePart> {
    let p = owner.get(serviceId);
    if (!p) {
      await catalog().catch(() => undefined);
      p = owner.get(serviceId);
    }
    if (!p && serviceId.startsWith(SOKOSUMI_ID_PREFIX)) p = parts.find((x) => x.name === "sokosumi");
    if (!p) throw new Error(`unknown agent service "${serviceId}"`);
    return p;
  }
  return {
    parts,
    invalidate() {
      owner.clear();
      for (const p of parts) (p.market as { invalidate?: () => void }).invalidate?.();
    },
    catalog,
    async startJob(serviceId, input, ctx) {
      return (await route(serviceId)).market.startJob(serviceId, input, ctx);
    },
    async status(serviceId, jobId) {
      return (await route(serviceId)).market.status(serviceId, jobId);
    },
    async resolvePayeeAlias(alias, ctx) {
      for (const p of parts) {
        if (!p.market.resolvePayeeAlias) continue;
        const r = await p.market.resolvePayeeAlias(alias, ctx);
        if (r) return r;
      }
      return null;
    },
  };
}

// ───────────────────────────── engine wiring helpers ─────────────────────────────
/** Session mandate + recorded credit spends from the engine DB. */
export function dbSokosumiMandate(db: DB): SokosumiDeps["mandate"] {
  return (sessionId) => {
    const s = db.select().from(sessionsT).where(eq(sessionsT.id, sessionId)).get();
    if (!s) return null;
    const credit = db
      .select()
      .from(payments)
      .where(eq(payments.sessionId, sessionId))
      .all()
      .filter((p) => isSokosumiCreditPayment(p) && p.status === "confirmed")
      .reduce((a, p) => a + BigInt(p.amountMicro), 0n);
    return { status: s.status, budgetMicro: BigInt(s.budgetMicro), spentMicro: BigInt(s.spentMicro), creditSpentMicro: credit, perPaymentMaxMicro: BigInt(s.perPaymentMaxMicro) };
  };
}

/** Config from env. Throws (market refuses to start) without the org slug / id or the API key. */
export function sokosumiConfigFromEnv(env: NodeJS.ProcessEnv): SokosumiConfig {
  const apiKey = env.SOKOSUMI_API_KEY ?? "";
  if (!apiKey) throw new SokosumiError("MARKET=sokosumi needs SOKOSUMI_API_KEY in bulkhead/.env (preprod key from app.sokosumi.com/connections)", "config");
  const organizationSlug = env.SOKOSUMI_HIRE_ORGANIZATION_SLUG?.trim() ?? "";
  if (!organizationSlug) throw new SokosumiError("MARKET=sokosumi refused: SOKOSUMI_HIRE_ORGANIZATION_SLUG is not set (credits must come from the hackathon organization, never personal credits)", "config");
  const organizationId = env.SOKOSUMI_HIRE_ORGANIZATION_ID?.trim() ?? "";
  if (!organizationId) throw new SokosumiError("MARKET=sokosumi refused: SOKOSUMI_HIRE_ORGANIZATION_ID is not set", "config");
  const rate = env.SOKOSUMI_CREDITS_PER_TUSDM ? Number(env.SOKOSUMI_CREDITS_PER_TUSDM) : DEFAULT_CREDITS_PER_TUSDM;
  if (!Number.isFinite(rate) || rate <= 0) throw new SokosumiError("SOKOSUMI_CREDITS_PER_TUSDM must be a positive number", "config");
  const ceiling = env.SOKOSUMI_MAX_CREDITS_PER_HIRE ? Number(env.SOKOSUMI_MAX_CREDITS_PER_HIRE) : DEFAULT_MAX_CREDITS_PER_HIRE;
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new SokosumiError("SOKOSUMI_MAX_CREDITS_PER_HIRE must be a positive number", "config");
  return {
    apiUrl: env.SOKOSUMI_API_URL?.trim() || SOKOSUMI_PREPROD_API_URL,
    apiKey,
    organizationSlug,
    organizationId,
    ...(env.SOKOSUMI_USER_ID?.trim() ? { userId: env.SOKOSUMI_USER_ID.trim() } : {}),
    creditsPerTusd: rate,
    maxCreditsPerHire: ceiling,
    ...(env.SOKOSUMI_AGENT_ALLOWLIST ? { agentAllowlist: env.SOKOSUMI_AGENT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}
