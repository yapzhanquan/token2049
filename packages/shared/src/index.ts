// @bulkhead/shared — the contracts every other package builds against.
// Pure TypeScript + zod; no Node, no Cardano, no DB imports.
import { z } from "zod";

// ───────────────────────────── Money ─────────────────────────────
// tUSD has 6 decimals. Amounts move between modules as bigint "micro" units
// (1 tUSD = 1_000_000 micro) and as decimal strings in JSON.
export const TUSD_DECIMALS = 6;
export const MICRO_PER_TUSD = 1_000_000n;

export function tusdToMicro(tusd: string | number): bigint {
  const [whole, frac = ""] = String(tusd).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > TUSD_DECIMALS) throw new Error(`Bad tUSD amount: ${tusd}`);
  return BigInt(whole) * MICRO_PER_TUSD + BigInt(frac.padEnd(TUSD_DECIMALS, "0"));
}

export function microToTusd(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const frac = (abs % MICRO_PER_TUSD).toString().padStart(TUSD_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / MICRO_PER_TUSD}${frac ? `.${frac}` : ""}`;
}

/** MYR display helper. `myrPerTusd` comes from MYR_PER_TUSD (e.g. "4.70"). */
export function microToMyr(micro: bigint, myrPerTusd: string): string {
  const rateMilli = BigInt(Math.round(Number(myrPerTusd) * 1000));
  const sen = (micro * rateMilli) / (MICRO_PER_TUSD * 10n); // hundredths of MYR
  return `${sen / 100n}.${(sen % 100n).toString().padStart(2, "0")}`;
}

// ─────────────────────── Session state machine ───────────────────────
export const SESSION_STATUSES = [
  "PLANNED",
  "AWAITING_APPROVAL",
  "FUNDING",
  "RUNNING",
  "PAUSED",
  "QUARANTINED",
  "COMPLETING",
  "CLOSING",
  "CLOSED",
  "FAILED",
  "KILLED",
  "EXPIRED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Terminal-in-intent states: each must proceed to CLOSING → CLOSED. */
export const ENDING_STATUSES: readonly SessionStatus[] = ["FAILED", "KILLED", "EXPIRED"];

/** Allowed transitions (spec §5.2). Anything else is rejected by the SessionManager. */
export const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  PLANNED: ["AWAITING_APPROVAL", "FAILED", "KILLED", "EXPIRED"],
  AWAITING_APPROVAL: ["FUNDING", "FAILED", "KILLED", "EXPIRED"],
  FUNDING: ["RUNNING", "FAILED", "KILLED", "EXPIRED"],
  RUNNING: ["PAUSED", "QUARANTINED", "COMPLETING", "FAILED", "KILLED", "EXPIRED"],
  PAUSED: ["RUNNING", "FAILED", "KILLED", "EXPIRED"],
  QUARANTINED: ["RUNNING", "CLOSING", "FAILED", "KILLED", "EXPIRED"],
  // COMPLETING → RUNNING: a handback that failed its definition of done is returned once (spec v2 §3).
  COMPLETING: ["CLOSING", "RUNNING", "FAILED", "KILLED", "EXPIRED"],
  FAILED: ["CLOSING"],
  KILLED: ["CLOSING"],
  EXPIRED: ["CLOSING"],
  CLOSING: ["CLOSED"],
  CLOSED: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to); // same-state = idempotent no-op
}

// ───────────────────────────── Wallet mode ─────────────────────────────
/** "native": native-script session wallet (fallback). "vault": Bulkhead Session Vault (Aiken, Plutus V3),
 * which enforces payees / per-tx max / ADA allowance / expiry ON-CHAIN. Env WALLET_MODE picks the default. */
export const WALLET_MODES = ["native", "vault"] as const;
export type WalletMode = (typeof WALLET_MODES)[number];
export const isWalletMode = (v: unknown): v is WalletMode => v === "native" || v === "vault";

// ───────────────────────────── Mandate ─────────────────────────────
export const MandateSchema = z.object({
  budgetMicro: z.bigint().positive(),
  perPaymentMaxMicro: z.bigint().positive(),
  approvalThresholdMicro: z.bigint().nonnegative(),
  allowedPayees: z.array(z.string().regex(/^addr_test1[0-9a-z]+$/)).max(50),
  /** POSIX ms. The session wallet's native script locks spending after this. */
  expiresAt: z.number().int().positive(),
});
export type Mandate = z.infer<typeof MandateSchema>;

// ───────────────────────── Task types (spec v2 §3) ─────────────────────────
export const TASK_TYPES = ["research", "buy_pay", "hire_agent", "monitor"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type ToolName = "web_fetch" | "pay" | "hire_agent" | "read_chain" | "report_progress" | "submit_handback";

/** Tools a silo may call, per task type. SiloRunner denies anything else (event `tool_denied`). */
export const TASK_TOOLS: Record<TaskType, readonly ToolName[]> = {
  research: ["web_fetch", "report_progress", "submit_handback"],
  buy_pay: ["pay", "report_progress", "submit_handback"], // + web_fetch only if the plan sets allowWebFetch
  hire_agent: ["hire_agent", "report_progress", "submit_handback"],
  monitor: ["read_chain", "report_progress", "submit_handback"],
};

export function allowedTools(taskType: TaskType, opts: { allowWebFetch?: boolean } = {}): ToolName[] {
  const tools = [...TASK_TOOLS[taskType]];
  if (taskType === "buy_pay" && opts.allowWebFetch) tools.push("web_fetch");
  return tools;
}

/** Human-readable definition of done (shown in the UI; enforced in engine/src/done.ts). */
export const DEFINITION_OF_DONE: Record<TaskType, string> = {
  research: "Result + summary + at least 1 source.",
  buy_pay: "Every payment confirmed on-chain, with the tx hashes listed in the handback.",
  hire_agent: "The paid job completed, with result + result_hash matching the paid agent's response.",
  monitor: "The watched condition happened or the deadline passed, with a report.",
};

/** A handback failing its definition of done is returned once; the second failure → FAILED → CLOSING. */
export const MAX_DONE_ATTEMPTS = 2;

// ───────────────────────────── Planning ─────────────────────────────
// What the orchestrator LLM must return (spec §5.9). Amounts are decimal tUSD strings.
const TusdString = z.string().regex(/^\d+(\.\d{1,6})?$/);
export const PlannedSessionSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(40),
  agentType: z.enum(["researcher", "summariser", "buyer", "writer", "generic"]),
  taskType: z.enum(TASK_TYPES),
  /** buy_pay only: also allow web_fetch. */
  allowWebFetch: z.boolean().default(false),
  /** monitor only: what to watch, e.g. { kind: "deposit", address, minTUSD }. */
  watch: z.record(z.string(), z.unknown()).optional(),
  goal: z.string().min(1).max(500),
  budgetTUSD: TusdString,
  perPaymentMaxTUSD: TusdString,
  approvalThresholdTUSD: TusdString,
  /** Agent catalog ids or addr_test1… addresses. Catalog ids are resolved to addresses by the engine. */
  allowedPayees: z.array(z.string()).max(20),
  /** ISO timestamp. */
  deadline: z.string(),
  dataScope: z.array(z.string()).max(20).default([]),
  /** Index into `sessions` of the parent session, if any. */
  parent: z.number().int().nonnegative().optional(),
  /** Indexes of earlier sessions whose handbacks this one should receive as contextIn. */
  contextFrom: z.array(z.number().int().nonnegative()).default([]),
});
export const PlanSchema = z.object({ sessions: z.array(PlannedSessionSchema).min(1).max(10) });
export type PlannedSession = z.infer<typeof PlannedSessionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// ───────────────────────────── Handback ─────────────────────────────
// Validated, size-limited (spec §5.7). Text inside is DATA, never instructions.
export const HANDBACK_MAX_BYTES = 16_384;
export const HandbackSchema = z.object({
  result: z.string().max(8_000),
  summary: z.string().min(1).max(280),
  sources: z.array(z.string().max(500)).max(20).default([]),
  flags: z.array(z.string().max(80)).max(10).default([]),
  /** buy_pay: tx hashes of the payments made. */
  txHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(50).optional(),
  /** hire_agent: the job id and result hash returned by the paid agent. */
  job: z.object({ jobId: z.string(), resultHash: z.string() }).optional(),
});
export type Handback = z.infer<typeof HandbackSchema>;

// ───────────────────────────── Events ─────────────────────────────
// Append-only `events` table rows. `data` is JSON; bigints serialised as strings.
export const EVENT_TYPES = [
  "goal_created",
  "plan_proposed",
  "plan_approved",
  "session_created",
  "session_transition",
  "session_funded",
  "progress",
  "heartbeat_missed",
  "payment_requested",
  "payment_approval_needed",
  "payment_approved",
  "payment_rejected",
  "payment_submitted",
  "payment_confirmed",
  "web_fetch",
  "tainted",
  "agent_hired",
  "agent_job_paid",
  "agent_job_result",
  "handback_submitted",
  "handback_passed",
  "close_submitted",
  "close_confirmed",
  "topup_pending",
  "topup_submitted",
  "topup_confirmed",
  "deposit_seen",
  "llm_usage",
  "tool_denied",
  "session_message", // user/captain → session (DATA)
  "mandate_change_ignored", // a message tried to change the mandate
  "handback_rejected", // failed definition of done
  "handback_accepted",
  "decision_opened",
  "decision_closed",
  "captain_woken", // EventBus woke the captain for an actionable event
  "captain_absorbed", // routine event handled without an LLM call
  "captain_action", // a tool call the captain made
  "captain_report", // report_to_user
  "user_message", // user → captain
  "deadline_near",
  "error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface BulkheadEvent {
  id: number;
  at: number; // POSIX ms
  type: EventType;
  goalId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

// ───────────────────────── Silo IPC (spec §5.5) ─────────────────────────
export interface TaskSpec {
  sessionId: string;
  role: string;
  agentType: PlannedSession["agentType"];
  taskType: TaskType;
  definitionOfDone: string;
  goal: string;
  /** Mandate as decimal strings (the silo never needs bigint maths). */
  budgetTUSD: string;
  perPaymentMaxTUSD: string;
  allowedPayees: { id: string; label: string; address: string }[];
  deadline: number;
  /** monitor only: what to watch (from the plan), e.g. { kind: "deposit", address, minTUSD }. */
  watch?: Record<string, unknown>;
}

/** Work already done by a previous run of this silo (restart after a crash / server restart). */
export interface SiloCheckpoint {
  payments: { payee: string; amountTUSD: string; txHash: string }[];
  jobs: { serviceId: string; jobId: string; result: string; resultHash: string }[];
  lastProgress?: string;
}

/** Orchestrator → silo */
export type ToSilo =
  | { type: "start"; taskSpec: TaskSpec; dataScope: string[]; contextIn: ContextIn[]; tools: ToolName[]; llm: "anthropic" | "openai" | "mock"; checkpoint?: SiloCheckpoint }
  | { type: "tool_result"; requestId: string; ok: true; result: unknown }
  | { type: "tool_result"; requestId: string; ok: false; error: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop"; reason: string }
  /** A user/captain message, delivered as DATA. It may redirect the work but never the mandate. */
  | { type: "message"; messageId: string; from: "user" | "captain"; text: string }
  /** The handback failed the definition of done; the silo gets one more attempt. */
  | { type: "handback_rejected"; reason: string; attemptsLeft: number }
  /** Answer to an escalation the session raised (decision ledger). */
  | { type: "decision"; decisionId: string; kind: DecisionKind; status: "approved" | "rejected" | "expired"; note?: string }
  /** Answer to an llm_request: the silo never holds an API key, the orchestrator calls the LLM for it. */
  | { type: "llm_result"; requestId: string; ok: true; response: { text: string; toolCalls: { id: string; name: string; input: Record<string, unknown> }[]; stopReason: string } }
  | { type: "llm_result"; requestId: string; ok: false; error: string };

/** Silo → orchestrator */
export type FromSilo =
  | { type: "ready" }
  | { type: "heartbeat"; at: number }
  | { type: "tool_call"; requestId: string; tool: "web_fetch"; args: { url: string } }
  | { type: "tool_call"; requestId: string; tool: "pay"; args: { payee: string; amountTUSD: string; memo: string } }
  | { type: "tool_call"; requestId: string; tool: "hire_agent"; args: { serviceId: string; input: string } }
  | { type: "tool_call"; requestId: string; tool: "read_chain"; args: { query: "balance" | "utxos" | "tip" | "tx"; address?: string; txHash?: string } }
  | { type: "tool_call"; requestId: string; tool: "report_progress"; args: { text: string } }
  | { type: "tool_call"; requestId: string; tool: "submit_handback"; args: Handback }
  | { type: "llm_usage"; inputTokens: number; outputTokens: number }
  /** anthropic mode: ask the orchestrator to run one sub-agent completion (usage is counted by the orchestrator). */
  | { type: "llm_request"; requestId: string; system: string; messages: { role: "user" | "assistant"; content: string | unknown[] }[]; tools?: { name: string; description: string; input_schema: Record<string, unknown> }[]; maxTokens?: number }
  | { type: "log"; level: "info" | "warn" | "error"; text: string };

/** A previous session's handback passed in as context — DATA, never instructions. */
export interface ContextIn {
  fromSessionId: string;
  fromRole: string;
  tainted: boolean;
  handback: Handback;
}

// ───────────────────────── Signer (spec §5.4) ─────────────────────────
export const REJECTION_REASONS = [
  "session_not_running",
  "payee_not_allowed",
  "over_per_payment_max",
  "over_budget",
  "invalid_amount",
  "approval_rejected", // the user rejected a payment that needed approval
  "build_failed",
  "submit_failed",
  "rejected_onchain", // vault mode: the Session Vault validator rejected the tx (the chain is the final authority)
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type PayDecision =
  | { kind: "submitted"; paymentId: string; txHash: string }
  | { kind: "needs_approval"; paymentId: string }
  | { kind: "rejected"; paymentId: string; reason: RejectionReason; detail: string };

// ───────────────────────── Decision ledger (spec v2 §4) ─────────────────────────
export const DECISION_KINDS = ["payment_approval", "budget_raise", "extend_expiry", "quarantine_release", "widen_mandate"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type DecisionStatus = "open" | "approved" | "rejected" | "expired";
export interface Decision {
  id: string;
  sessionId: string;
  kind: DecisionKind;
  requestedBy: "captain" | "session";
  /** Dedup key: one open decision per (sessionId, kind, refKey), e.g. the payment id. */
  refKey: string;
  details: Record<string, unknown>;
  status: DecisionStatus;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

// ───────────────────────── Captain (spec v2 §1) ─────────────────────────
export const CAPTAIN_TOOLS = [
  "plan_task",
  "spawn_session",
  "message_session",
  "read_status",
  "pause_session",
  "resume_session",
  "kill_session",
  "pass_handback",
  "request_user_approval",
  "report_to_user",
] as const;
export type CaptainTool = (typeof CAPTAIN_TOOLS)[number];

/** Event types that can wake the captain. Everything else is absorbed without an LLM call. */
export const WAKE_EVENTS: readonly EventType[] = [
  "handback_submitted", // session finished
  "session_transition", // only to FAILED | KILLED | EXPIRED | QUARANTINED | CLOSED (see isActionable)
  "heartbeat_missed", // went quiet
  "decision_opened", // approval needed
  "decision_closed",
  "payment_rejected",
  "tainted", // → quarantine
  "deposit_seen",
  "topup_confirmed",
  "deadline_near",
  "user_message",
];

export function isActionable(e: Pick<BulkheadEvent, "type" | "data">): boolean {
  if (!WAKE_EVENTS.includes(e.type)) return false;
  if (e.type === "session_transition") return ["FAILED", "KILLED", "EXPIRED", "QUARANTINED", "CLOSED"].includes(String(e.data.to));
  return true;
}

// ───────────────────────── Agent market (spec §5.6) ─────────────────────────
export interface AgentCatalogEntry {
  id: string;
  name: string;
  skills: string[];
  priceTUSD: string;
  paymentAddress: string;
  endpoint: string;
  source: "mock" | "sokosumi" | "masumi";
  /** masumi: on-chain agent identifier (policy id + asset name). */
  agentIdentifier?: string;
  /** masumi: registry pricing type. Dynamic → priceTUSD is "0" until the seller quotes signed terms. */
  pricingType?: "Fixed" | "Dynamic";
  /** masumi: "exact" = the vault funds the very asset the escrow locks (tUSD-priced agent); "equivalent" = 1:1 value. */
  fundingMode?: "exact" | "equivalent";
  /** masumi: raw registry amounts ({ unit: policy+asset hex, "" = lovelace; amount: smallest unit }). */
  amounts?: { unit: string; amount: string }[];
}

/** Masumi-style job API */
export interface StartJobResponse {
  job_id: string;
  payment_address: string;
  amount_tusd: string;
  /** Payment must carry this id in metadata 674 so the agent can match it. */
  payment_reference: string;
}
export interface JobStatusResponse {
  job_id: string;
  status: "awaiting_payment" | "running" | "completed" | "failed";
  payment_tx?: string;
  result?: string;
  result_hash?: string;
}

// ───────────────────────── Tree + Agent map DTOs (spec §6) ─────────────────────────
export type Glyph = "closed" | "running" | "paused" | "quarantined" | "awaiting" | "failed" | "planned";

export function glyphFor(status: SessionStatus, hasPendingApproval = false): Glyph {
  if (hasPendingApproval) return "awaiting";
  switch (status) {
    case "CLOSED":
    case "COMPLETING":
    case "CLOSING":
      return "closed";
    case "RUNNING":
    case "FUNDING":
      return "running";
    case "PAUSED":
      return "paused";
    case "QUARANTINED":
      return "quarantined";
    case "AWAITING_APPROVAL":
      return "awaiting";
    case "FAILED":
    case "KILLED":
    case "EXPIRED":
      return "failed";
    case "PLANNED":
      return "planned";
  }
}

export interface TreeNode {
  id: string;
  kind: "goal" | "session" | "agent_job";
  parentId: string | null;
  letter?: string; // "A", "B", …
  role?: string;
  label: string;
  status?: SessionStatus;
  glyph: Glyph;
  ghost: boolean; // closed/killed: muted but never removed
  lines: string[]; // the 2 short lines under the label (spec §6.4)
  startedAt?: number;
  endedAt?: number;
  tokensUsed?: number;
  spentMicro?: string;
  budgetMicro?: string;
  refundMicro?: string;
  address?: string;
  closeTx?: string;
  handbackSummary?: string;
  taskType?: TaskType;
  openDecisions?: number;
}
export interface TreeEdge {
  from: string;
  to: string;
  kind: "parent" | "handback";
}
export interface TreeDTO {
  goalId: string;
  nodes: TreeNode[];
  edges: TreeEdge[];
}

// ───────────────────────── Engine HTTP API ─────────────────────────
// The engine (packages/engine) serves these on ENGINE_URL (default http://localhost:4000).
// The web app calls them server-side with the shared ENGINE_TOKEN header `x-engine-token`
// and the acting user id header `x-user-id`. SSE: GET /events/stream?goalId=… (text/event-stream,
// one BulkheadEvent per `data:` line).
export const ENGINE_ROUTES = {
  health: "GET /health",
  me: "GET /me", // treasury address, balances, custody mode
  createUser: "POST /users", // { email, name, custody: "custodial" | "self", walletAddress? }
  topupStart: "POST /topups", // { amountMYR } → { topupId }
  topupConfirm: "POST /topups/:id/confirm", // called by the web Stripe webhook (idempotent by stripeEventId)
  plan: "POST /goals", // { goal, budgetTUSD, deadline, rules } → { goalId, plan, fundingPreview }
  approvePlan: "POST /goals/:id/approve",
  goals: "GET /goals",
  tree: "GET /goals/:id/tree", // → TreeDTO
  session: "GET /sessions/:id",
  control: "POST /sessions/:id/:action", // pause|resume|kill|extend|raise|narrow
  pauseAll: "POST /sessions/pause-all",
  approvePayment: "POST /payments/:id/approve",
  rejectPayment: "POST /payments/:id/reject",
  message: "POST /sessions/:id/messages", // { text } → delivered to the silo as DATA
  peek: "GET /sessions/:id/peek", // SSE: progress/log lines only, read-only
  decisions: "GET /decisions", // ?status=open|approved|rejected|expired; no status = all
  decide: "POST /decisions/:id", // { status: "approved" | "rejected", note? }
  captainMessage: "POST /captain/messages", // user → captain
  captainLog: "GET /captain/log", // woken vs absorbed, actions, reports
  agents: "GET /agents", // AgentCatalogEntry[]
  agentMap: "GET /agent-map",
  spending: "GET /spending",
  logbook: "GET /logbook",
  stream: "GET /events/stream", // ?goalId=&after=<event id> (or Last-Event-ID)
  signature: "POST /signatures/:pendingId", // self-custody: { signedTx } for a pending signature
  activity: "GET /activity", // ?goalId=&q=&type=&limit=&before= → ActivityDTO (unified feed; q = id/hash/address search)
} as const;

// Request bodies + response DTOs for the routes above.
export * from "./api";
export * from "./staking";

export const NETWORK = "preprod" as const;
export const EXPLORER = "https://preprod.cardanoscan.io";
export const explorerTx = (hash: string) => `${EXPLORER}/transaction/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER}/address/${addr}`;
