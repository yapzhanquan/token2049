// Internal engine interfaces. Two halves are built in parallel against these:
//   "runtime"  — EventBus, SessionManager, SiloRunner + silo child, Signer, DecisionLedger,
//                definition-of-done checks, supervisor, reconciliation, AgentMarket client, OnRamp.
//   "captain"  — LLM providers (Anthropic + MockLLM), Captain agent loop + tools + wake filter,
//                planner, HTTP API (Hono) + SSE, server.ts wiring.
import type {
  BulkheadEvent,
  CaptainTool,
  ContextIn,
  Decision,
  DecisionKind,
  EventType,
  Handback,
  PayDecision,
  Plan,
  PlannedSession,
  SessionStatus,
  TaskType,
  TreeDTO,
  AgentCatalogEntry,
  PlanRationale,
} from "@bulkhead/shared";
import type { DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";

// ─────────────── EventBus (in-process emitter + append-only events table) ───────────────
export interface EventBus {
  /** Persists the event, then notifies subscribers. Returns the stored event (with id). */
  emit(type: EventType, fields: { goalId?: string; sessionId?: string; data?: Record<string, unknown> }): BulkheadEvent;
  subscribe(fn: (e: BulkheadEvent) => void): () => void;
  /** Events since an id (for SSE resume and restart reconciliation). */
  since(afterId: number, filter?: { goalId?: string; sessionId?: string }): BulkheadEvent[];
}

// ─────────────── SessionManager ───────────────
export interface SessionRow {
  id: string;
  goalId: string;
  userId: string;
  parentSessionId: string | null;
  letter: string;
  name: string;
  role: string;
  taskType: TaskType;
  status: SessionStatus;
  budgetMicro: bigint;
  spentMicro: bigint;
  perPaymentMaxMicro: bigint;
  approvalThresholdMicro: bigint;
  allowedPayees: { id: string; label: string; address: string }[];
  expiresAt: number;
  address: string | null;
  tainted: boolean;
  tokensUsed: number;
  doneAttempts: number;
}

export interface SessionManager {
  /** Create sessions for an approved plan: derive keys, build native scripts, fund all in ONE tx, start silos. */
  startPlan(goalId: string, plan: Plan): Promise<string[]>;
  /** Add one session to a running goal (captain spawn_session). Funded from the treasury via TreasuryQueue. */
  spawn(goalId: string, spec: PlannedSession, opts?: { parentSessionId?: string; contextFrom?: string[] }): Promise<string>;
  get(sessionId: string): SessionRow | null;
  list(filter?: { goalId?: string; status?: SessionStatus[] }): SessionRow[];
  /** Idempotent; validates against TRANSITIONS; records reason + timestamp; emits session_transition. */
  transition(sessionId: string, to: SessionStatus, reason: string): Promise<void>;
  pause(sessionId: string, by: "user" | "captain"): Promise<void>;
  resume(sessionId: string, by: "user" | "captain"): Promise<void>;
  /** → KILLED → CLOSING → sweep → CLOSED. */
  kill(sessionId: string, by: "user" | "captain", reason: string): Promise<void>;
  pauseAll(by: "user" | "captain"): Promise<void>;
  /** Deliver a message to the silo as DATA. Never touches the mandate (emits mandate_change_ignored if it tries). */
  message(sessionId: string, from: "user" | "captain", text: string): Promise<{ messageId: string }>;
  /** Pass a closed session's handback as contextIn to another session (emits handback_passed). */
  passHandback(fromSessionId: string, toSessionId: string, by: "user" | "captain"): Promise<void>;
  /** Mandate controls (spec §5.8). Widening requires an approved decision id. */
  raiseBudget(sessionId: string, addMicro: bigint, decisionId: string): Promise<void>;
  extendExpiry(sessionId: string, newExpiresAt: number, decisionId: string): Promise<void>;
  narrowBudget(sessionId: string, newBudgetMicro: bigint): Promise<void>;
  /** Accept or reject a submitted handback against the task type's definition of done. */
  reviewHandback(sessionId: string): Promise<{ accepted: boolean; reason?: string }>;
  tree(goalId: string): TreeDTO;
  /** On boot: reconcile non-CLOSED sessions with DB + chain before resuming (spec §5.2). */
  reconcile(): Promise<void>;
  /** Work deadline of a session (startedAt + WORK_DEADLINE_SECONDS); null before RUNNING / when disabled. */
  workDeadlineOf?(sessionId: string): number | null;
  /** Work deadline reached: collect a partial handback and close the session (the watchdog's action). */
  timeBox?(sessionId: string, reason: string): Promise<boolean>;
}

// ─────────────── SiloRunner (child_process.fork per session; IPC only) ───────────────
export interface SiloRunner {
  start(args: {
    sessionId: string;
    taskType: TaskType;
    allowWebFetch: boolean;
    contextIn: ContextIn[];
    dataScope: string[];
  }): Promise<void>;
  send(sessionId: string, msg: import("@bulkhead/shared").ToSilo): void;
  stop(sessionId: string, reason: string): Promise<void>;
  isAlive(sessionId: string): boolean;
}

// ─────────────── Signer (policy engine + the only signer of session payments) ───────────────
export interface Signer {
  pay(sessionId: string, req: { payee: string; amountMicro: bigint; memo: string; reference?: string }): Promise<PayDecision>;
  /** Called when a payment_approval decision is approved/rejected. */
  resolveApproval(paymentId: string, approved: boolean): Promise<PayDecision>;
}

// ─────────────── Decision ledger ───────────────
export interface DecisionLedger {
  /** Returns the existing OPEN decision for the same (sessionId, kind, refKey) instead of creating a duplicate. */
  open(args: { sessionId: string; kind: DecisionKind; requestedBy: "captain" | "session"; refKey: string; details: Record<string, unknown> }): Decision;
  /** Closes it, applies the effect (via Signer / SessionManager), relays the answer to the session over IPC. */
  decide(decisionId: string, status: "approved" | "rejected", decidedBy: string, note?: string): Promise<Decision>;
  list(filter?: { status?: Decision["status"]; sessionId?: string }): Decision[];
}

// ─────────────── Agent market client (spec §5.6) ───────────────
/** Optional hiring context (the runner passes it; markets may ignore it). */
export interface StartJobContext {
  sessionId: string;
  /** The session's resolved allowlist; `also` = other plan ids that resolved to the same address. */
  allowedPayees?: { id: string; address: string; also?: string[] }[];
}
/** Off-chain billing of a hired job (Sokosumi credits): the runner records it instead of an on-chain payment. */
export interface OffChainBilling {
  kind: "credits";
  credits: number;
  maxCredits: number;
  organizationSlug: string;
  /** payments.payee for the record, e.g. "sokosumi-credits:<slug>" (never an address). */
  payee: string;
}
export interface StartedJob {
  jobId: string;
  paymentAddress: string;
  amountMicro: bigint;
  reference: string;
  /** Set → no Signer payment: credits were charged off-chain by the market (market-sokosumi.ts). */
  billing?: OffChainBilling;
}
export interface AgentMarket {
  catalog(): Promise<AgentCatalogEntry[]>;
  startJob(serviceId: string, input: string, ctx?: StartJobContext): Promise<StartedJob>;
  status(serviceId: string, jobId: string): Promise<{ status: string; result?: string; resultHash?: string }>;
  /** Optional payee aliases (e.g. "masumi:purchasing-wallet", "sokosumi:<agent id>") → an allowlist entry.
   * `ownerAddress` = the session owner's treasury (used by off-chain-billed markets that need a harmless address). */
  resolvePayeeAlias?(alias: string, ctx?: { ownerAddress?: string }): Promise<{ id: string; label: string; address: string } | null>;
}

// ─────────────── LLM ───────────────
export interface LLMToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface LLMMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}
export interface LLMResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  /** Provider-native assistant content blocks (e.g. Anthropic thinking + tool_use), to append back unchanged
   * in a tool-use loop. Optional: callers fall back to rebuilding text + tool_use blocks. */
  raw?: unknown[];
}
export interface LLM {
  readonly name: "anthropic" | "openai" | "mock";
  /** Number of completed calls — the wake-filter test asserts on this for MockLLM. */
  readonly calls: number;
  complete(args: { model: "orchestrator" | "subagent"; system: string; messages: LLMMessage[]; tools?: LLMToolDef[]; maxTokens?: number }): Promise<LLMResponse>;
}

// ─────────────── Captain (Firstmate model) ───────────────
export interface Captain {
  /** Called by the wake filter for actionable events only. Reads state from DB + chain, then acts via tools. */
  wake(trigger: BulkheadEvent, coalesced?: BulkheadEvent[]): Promise<void>;
  /** user → captain (POST /captain/messages). Always actionable. */
  userMessage(userId: string, goalId: string | null, text: string): Promise<void>;
  /** plan_task as a direct API (POST /goals) — returns a validated plan + funding preview. */
  plan(args: { userId: string; goal: string; budgetTUSD: string; deadline: string; rules: string }): Promise<{ goalId: string; plan: Plan; fundingPreview: { feeLovelace: string; totalTusd: string; totalLovelace: string }; rationale?: PlanRationale }>;
  readonly tools: readonly CaptainTool[];
}

/** Everything wired together in server.ts. */
export interface Engine {
  db: DB;
  chain: Chain;
  bus: EventBus;
  sessions: SessionManager;
  silos: SiloRunner;
  signer: Signer;
  decisions: DecisionLedger;
  market: AgentMarket;
  llm: LLM;
  captain: Captain;
  /** Handback text is DATA: helper that wraps it for any LLM prompt (spec §5.7). */
  wrapHandback(h: Handback, meta: { fromSessionId: string; tainted: boolean }): string;
}
