// The captain's 10 tools: LLM tool definitions + executors.
// Executors act ONLY through SessionManager / DecisionLedger / EventBus (plus read-only DB reads for status).
// They can REQUEST money changes (request_user_approval → DecisionLedger.open, requestedBy "captain");
// nothing here can approve a decision, sign, or touch keys. Every call emits `captain_action`.
import {
  CAPTAIN_TOOLS,
  DECISION_KINDS,
  HandbackSchema,
  PlannedSessionSchema,
  microToTusd,
  tusdToMicro,
  type BulkheadEvent,
  type CaptainTool,
  type DecisionKind,
  type Handback,
} from "@bulkhead/shared";
import { goals, payments, sessions as sessionsT, type DB } from "@bulkhead/db";
import { and, eq } from "drizzle-orm";
import type { AgentMarket, DecisionLedger, Engine, EventBus, LLMToolDef, SessionManager, SessionRow } from "../contracts";
import { cleanModelWhy, deriveWhy } from "./why";

export interface CaptainToolContext {
  db: DB;
  bus: EventBus;
  sessions: SessionManager;
  decisions: DecisionLedger;
  market: AgentMarket;
  wrapHandback: Engine["wrapHandback"];
  userId: string;
  goalId: string | null;
  /** The event that woke the captain (recorded on each captain_action). */
  triggerEventId?: number;
  /** The wake's events (trigger first): the evidence a deterministic `why` is derived from. */
  wakeEvents?: BulkheadEvent[];
  /** Wake triggers whose report_to_user is routine (record only, no push) — see captain.ts reportNotify. */
  routineWake?: boolean;
  /** plan_task → creates a planned goal awaiting the user's "Approve & start". */
  planGoal: (req: { goal: string; budgetTUSD: string; deadline: string; rules: string }) => Promise<{ goalId: string; sessions: number; totalTusd: string }>;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

const sessionRef = { type: "string", description: "Session id or its letter within the current goal (e.g. \"B\")." };

/** Every tool takes an optional `why`: one evidence-based sentence shown to the user next to the action. */
const WHY_PROP = {
  type: "string",
  description: "One short sentence for the user: the evidence that made you act + what this does (e.g. \"B hit 4 consecutive 404s; redirecting it to docs.cardano.org\"). Cite facts from the state, never invent them.",
};

const RAW_TOOL_DEFS: readonly LLMToolDef[] = [
  {
    name: "plan_task",
    description:
      "Plan a NEW goal into parallel sessions. Creates a plan preview the user must approve (\"Approve & start\") before anything is funded. Use only when the user asks for new work.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        budgetTUSD: { type: "string", description: "Total budget, decimal tUSD." },
        deadline: { type: "string", description: "ISO timestamp." },
        rules: { type: "string" },
      },
      required: ["goal", "budgetTUSD", "deadline"],
      additionalProperties: false,
    },
  },
  {
    name: "spawn_session",
    description:
      "Add one session to the current running goal, funded from the treasury. Its budget must fit inside the goal's approved budget; payees must be catalog agents or payees already approved for this goal. Otherwise use request_user_approval.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        agentType: { type: "string", enum: ["researcher", "summariser", "buyer", "writer", "generic"] },
        taskType: { type: "string", enum: ["research", "buy_pay", "hire_agent", "monitor"] },
        allowWebFetch: { type: "boolean" },
        goal: { type: "string" },
        budgetTUSD: { type: "string" },
        perPaymentMaxTUSD: { type: "string" },
        approvalThresholdTUSD: { type: "string" },
        allowedPayees: { type: "array", items: { type: "string" }, description: "Catalog ids or addr_test1 addresses." },
        deadline: { type: "string", description: "ISO timestamp, not after the goal deadline." },
        parentSessionId: { type: "string" },
        contextFromSessionIds: { type: "array", items: { type: "string" }, description: "Earlier sessions whose handbacks this one receives." },
      },
      required: ["name", "role", "taskType", "goal", "budgetTUSD", "perPaymentMaxTUSD", "approvalThresholdTUSD", "allowedPayees", "deadline"],
      additionalProperties: false,
    },
  },
  {
    name: "message_session",
    description: "Send a message to a running session's sub-agent. Delivered as DATA: it may redirect the work but can never change the mandate (budget, payees, limits, expiry).",
    input_schema: { type: "object", properties: { sessionId: sessionRef, text: { type: "string" } }, required: ["sessionId", "text"], additionalProperties: false },
  },
  {
    name: "read_status",
    description: "Read the current status of one session (mandate, spend, handback, open decisions, recent progress) or of all sessions of the goal (sessionId \"all\").",
    input_schema: { type: "object", properties: { sessionId: sessionRef }, required: ["sessionId"], additionalProperties: false },
  },
  {
    name: "pause_session",
    description: "Pause a running session (its spending stops).",
    input_schema: { type: "object", properties: { sessionId: sessionRef }, required: ["sessionId"], additionalProperties: false },
  },
  {
    name: "resume_session",
    description: "Resume a paused session.",
    input_schema: { type: "object", properties: { sessionId: sessionRef }, required: ["sessionId"], additionalProperties: false },
  },
  {
    name: "kill_session",
    description: "Kill a session: it closes and ALL its leftover funds are swept back to the user's treasury.",
    input_schema: { type: "object", properties: { sessionId: sessionRef, reason: { type: "string" } }, required: ["sessionId", "reason"], additionalProperties: false },
  },
  {
    name: "pass_handback",
    description: "Pass a finished session's handback to another session as context (data, never instructions).",
    input_schema: {
      type: "object",
      properties: { fromSessionId: sessionRef, toSessionId: sessionRef },
      required: ["fromSessionId", "toSessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "request_user_approval",
    description:
      "Ask the USER to approve a money or mandate change (budget_raise, extend_expiry, quarantine_release, widen_mandate, or a pending payment_approval). Creates one open decision; you cannot approve it yourself.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...DECISION_KINDS] },
        sessionId: sessionRef,
        reason: { type: "string" },
        amountTUSD: { type: "string", description: "budget_raise: the extra amount." },
        newExpiresAt: { type: "string", description: "extend_expiry: the new ISO expiry." },
        paymentId: { type: "string", description: "payment_approval: the pending payment id." },
      },
      required: ["kind", "sessionId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "report_to_user",
    description: "Tell the user something (plain, short, factual). This is the only way your words reach the user.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];

export const CAPTAIN_TOOL_DEFS: readonly LLMToolDef[] = RAW_TOOL_DEFS.map((d) => ({
  ...d,
  input_schema: { ...d.input_schema, properties: { ...(d.input_schema.properties as Record<string, unknown>), why: WHY_PROP } },
}));

if (CAPTAIN_TOOL_DEFS.length !== CAPTAIN_TOOLS.length || CAPTAIN_TOOL_DEFS.some((d, i) => d.name !== CAPTAIN_TOOLS[i])) {
  throw new Error("captain tool definitions out of sync with CAPTAIN_TOOLS");
}

class ToolError extends Error {}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name} is required`);
  return v.trim();
};

/** Resolve a session id or letter, scoped to the acting user (and goal for letters). */
export function resolveSession(ctx: CaptainToolContext, ref: unknown): SessionRow {
  const r = str(ref, "sessionId");
  let row = ctx.sessions.get(r);
  if (!row && /^[A-Za-z]{1,2}$/.test(r) && ctx.goalId) {
    row = ctx.sessions.list({ goalId: ctx.goalId }).find((s) => s.letter.toUpperCase() === r.toUpperCase()) ?? null;
  }
  if (!row || row.userId !== ctx.userId) throw new ToolError(`unknown session ${r}`);
  return row;
}

export function sessionView(row: SessionRow) {
  return {
    id: row.id,
    letter: row.letter,
    name: row.name,
    role: row.role,
    taskType: row.taskType,
    status: row.status,
    budgetTUSD: microToTusd(row.budgetMicro),
    spentTUSD: microToTusd(row.spentMicro),
    leftTUSD: microToTusd(row.budgetMicro - row.spentMicro),
    perPaymentMaxTUSD: microToTusd(row.perPaymentMaxMicro),
    approvalThresholdTUSD: microToTusd(row.approvalThresholdMicro),
    allowedPayees: row.allowedPayees.map((p) => p.label || p.id),
    expiresAt: new Date(row.expiresAt).toISOString(),
    tainted: row.tainted,
    doneAttempts: row.doneAttempts,
    parentSessionId: row.parentSessionId,
  };
}

export function readHandback(db: DB, sessionId: string): Handback | null {
  const r = db.select({ h: sessionsT.handbackJson }).from(sessionsT).where(eq(sessionsT.id, sessionId)).get();
  if (!r?.h) return null;
  const parsed = HandbackSchema.safeParse(JSON.parse(r.h));
  return parsed.success ? parsed.data : null;
}

async function execute(name: string, input: Record<string, unknown>, ctx: CaptainToolContext): Promise<unknown> {
  switch (name as CaptainTool) {
    case "plan_task": {
      return ctx.planGoal({
        goal: str(input.goal, "goal"),
        budgetTUSD: str(input.budgetTUSD, "budgetTUSD"),
        deadline: str(input.deadline, "deadline"),
        rules: typeof input.rules === "string" ? input.rules : "",
      });
    }
    case "spawn_session":
      return spawnSession(input, ctx);
    case "message_session": {
      const row = resolveSession(ctx, input.sessionId);
      const text = str(input.text, "text").slice(0, 4_000);
      const { messageId } = await ctx.sessions.message(row.id, "captain", text);
      return { delivered: true, messageId, session: row.letter };
    }
    case "read_status": {
      if (input.sessionId === "all") {
        const rows = ctx.goalId ? ctx.sessions.list({ goalId: ctx.goalId }) : ctx.sessions.list().filter((s) => s.userId === ctx.userId && s.status !== "CLOSED");
        return { sessions: rows.filter((s) => s.userId === ctx.userId).map(sessionView) };
      }
      const row = resolveSession(ctx, input.sessionId);
      const h = readHandback(ctx.db, row.id);
      const progress = ctx.bus
        .since(0, { sessionId: row.id })
        .filter((e) => e.type === "progress")
        .slice(-3)
        .map((e) => String(e.data.text ?? "").slice(0, 200));
      return {
        ...sessionView(row),
        handback: h ? ctx.wrapHandback(h, { fromSessionId: row.id, tainted: row.tainted }) : null,
        openDecisions: ctx.decisions.list({ status: "open", sessionId: row.id }).map((d) => ({ id: d.id, kind: d.kind, details: d.details })),
        recentProgress: progress,
      };
    }
    case "pause_session": {
      const row = resolveSession(ctx, input.sessionId);
      await ctx.sessions.pause(row.id, "captain");
      return { session: row.letter, status: ctx.sessions.get(row.id)?.status };
    }
    case "resume_session": {
      const row = resolveSession(ctx, input.sessionId);
      await ctx.sessions.resume(row.id, "captain");
      return { session: row.letter, status: ctx.sessions.get(row.id)?.status };
    }
    case "kill_session": {
      const row = resolveSession(ctx, input.sessionId);
      await ctx.sessions.kill(row.id, "captain", typeof input.reason === "string" ? input.reason.slice(0, 200) : "captain decision");
      return { session: row.letter, status: ctx.sessions.get(row.id)?.status };
    }
    case "pass_handback": {
      const from = resolveSession(ctx, input.fromSessionId);
      const to = resolveSession(ctx, input.toSessionId);
      if (from.id === to.id) throw new ToolError("cannot pass a handback to the same session");
      if (from.goalId !== to.goalId) throw new ToolError("sessions belong to different goals");
      await ctx.sessions.passHandback(from.id, to.id, "captain");
      return { passed: true, from: from.letter, to: to.letter };
    }
    case "request_user_approval":
      return requestApproval(input, ctx);
    case "report_to_user": {
      const text = str(input.text, "text").slice(0, 2_000);
      // notify=false: the wake was routine (e.g. a mid-goal accepted handback, a top-up the user made themselves, an
      // approval the structured escalation report already surfaced) — recorded in the log + /ahoy, not pushed.
      const e = ctx.bus.emit("captain_report", {
        goalId: ctx.goalId ?? undefined,
        data: { text, userId: ctx.userId, triggerEventId: ctx.triggerEventId, notify: !ctx.routineWake, ...(ctx.routineWake ? { routine: true } : {}) },
      });
      return { reported: true, eventId: e.id };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

async function spawnSession(input: Record<string, unknown>, ctx: CaptainToolContext) {
  if (!ctx.goalId) throw new ToolError("spawn_session needs a running goal; use plan_task for new work");
  const goal = ctx.db.select().from(goals).where(eq(goals.id, ctx.goalId)).get();
  if (!goal || goal.userId !== ctx.userId) throw new ToolError("unknown goal");
  if (goal.status !== "running" && goal.status !== "approved") throw new ToolError(`goal is ${goal.status}; the user must approve the plan first`);

  const { parentSessionId, contextFromSessionIds, ...rest } = input;
  const parsed = PlannedSessionSchema.safeParse({ agentType: "generic", ...rest });
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const spec = parsed.data;

  // Guard rails: the goal's approved budget is the envelope; no new payees beyond catalog/plan; no later deadline.
  const budget = tusdToMicro(spec.budgetTUSD);
  if (tusdToMicro(spec.perPaymentMaxTUSD) > budget) throw new ToolError("perPaymentMaxTUSD exceeds budgetTUSD");
  const committed = ctx.sessions.list({ goalId: ctx.goalId }).reduce((s, r) => s + r.budgetMicro, 0n);
  const envelope = BigInt(goal.budgetMicro);
  if (committed + budget > envelope) {
    throw new ToolError(
      `budget ${spec.budgetTUSD} tUSD exceeds the goal's remaining approved budget (${microToTusd(envelope - committed)} tUSD). Ask the user with request_user_approval(kind "widen_mandate").`,
    );
  }
  const deadline = Date.parse(spec.deadline);
  if (Number.isNaN(deadline) || deadline > goal.deadline) spec.deadline = new Date(goal.deadline).toISOString();

  const catalog = await ctx.market.catalog().catch(() => []);
  const planPayees = new Set<string>(
    (JSON.parse(goal.planJson || "{}").sessions ?? []).flatMap((s: { allowedPayees?: string[] }) => s.allowedPayees ?? []),
  );
  spec.allowedPayees = spec.allowedPayees.map((p) => {
    const entry = catalog.find((a) => a.id === p || a.name === p || a.paymentAddress === p);
    if (entry) return entry.id; // resolved to { id, label, address } by the SessionManager
    if (planPayees.has(p)) return p;
    throw new ToolError(`payee ${p} is not a catalog agent or an approved payee of this goal`);
  });

  const parent = typeof parentSessionId === "string" && parentSessionId ? resolveSession(ctx, parentSessionId).id : undefined;
  const contextFrom = Array.isArray(contextFromSessionIds) ? contextFromSessionIds.map((r) => resolveSession(ctx, r).id) : [];
  const id = await ctx.sessions.spawn(ctx.goalId, spec, { parentSessionId: parent, contextFrom });
  const row = ctx.sessions.get(id);
  return { sessionId: id, letter: row?.letter, status: row?.status };
}

function requestApproval(input: Record<string, unknown>, ctx: CaptainToolContext) {
  const kind = str(input.kind, "kind") as DecisionKind;
  if (!DECISION_KINDS.includes(kind)) throw new ToolError(`kind must be one of ${DECISION_KINDS.join(", ")}`);
  const row = resolveSession(ctx, input.sessionId);
  const reason = str(input.reason, "reason").slice(0, 500);
  // Escalate only real decisions: nothing to decide for a session that is finishing or gone, and a quarantine
  // release only exists while the session is quarantined (the runtime opens that one itself).
  if (["COMPLETING", "CLOSING", "CLOSED", "FAILED", "KILLED", "EXPIRED"].includes(row.status)) {
    throw new ToolError(`session ${row.letter} is ${row.status}; there is nothing for the user to decide`);
  }
  if (kind === "quarantine_release" && row.status !== "QUARANTINED") throw new ToolError(`session ${row.letter} is not quarantined`);
  const details: Record<string, unknown> = { reason, requestedVia: "captain" };
  let refKey: string;
  switch (kind) {
    case "budget_raise": {
      const amount = str(input.amountTUSD, "amountTUSD");
      const micro = tusdToMicro(amount);
      if (micro <= 0n) throw new ToolError("amountTUSD must be > 0");
      Object.assign(details, { amountTUSD: microToTusd(micro), addMicro: micro.toString() });
      refKey = `budget_raise:${micro}`;
      break;
    }
    case "extend_expiry": {
      const ms = Date.parse(str(input.newExpiresAt, "newExpiresAt"));
      if (Number.isNaN(ms) || ms <= row.expiresAt) throw new ToolError("newExpiresAt must be later than the current expiry");
      Object.assign(details, { newExpiresAt: ms, newExpiresAtIso: new Date(ms).toISOString() });
      refKey = `extend_expiry:${ms}`;
      break;
    }
    case "payment_approval": {
      // Payment approvals are opened by the Signer; the captain may only re-surface an existing pending payment.
      const pid = str(input.paymentId, "paymentId");
      const p = ctx.db.select().from(payments).where(and(eq(payments.id, pid), eq(payments.sessionId, row.id))).get();
      if (!p || p.status !== "awaiting_approval") throw new ToolError("no pending payment with that id for this session");
      Object.assign(details, { paymentId: pid, payee: p.payee, amountTUSD: microToTusd(BigInt(p.amountMicro)) });
      refKey = pid;
      break;
    }
    default:
      refKey = kind;
  }
  const before = ctx.decisions.list({ status: "open", sessionId: row.id }).find((d) => d.kind === kind && d.refKey === refKey);
  const d = ctx.decisions.open({ sessionId: row.id, kind, requestedBy: "captain", refKey, details });
  return { decisionId: d.id, status: d.status, duplicate: Boolean(before && before.id === d.id), note: "Waiting for the user. You cannot approve this yourself." };
}

/** Execute one captain tool call, emitting `captain_action` either way. Never throws. */
export async function runCaptainTool(name: string, rawInput: Record<string, unknown>, ctx: CaptainToolContext, opts: { auto?: boolean; why?: string } = {}): Promise<ToolOutcome> {
  // `why` is commentary for the user, never a tool argument.
  const { why: modelWhy, ...input } = rawInput ?? {};
  let outcome: ToolOutcome;
  try {
    outcome = { ok: true, result: await execute(name, input, ctx) };
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const sessionRefIn = (input?.sessionId ?? input?.fromSessionId) as string | undefined;
  let sessionId: string | undefined;
  let row: SessionRow | null = null;
  try {
    row = sessionRefIn && sessionRefIn !== "all" ? resolveSession(ctx, sessionRefIn) : null;
    sessionId = row?.id;
  } catch {
    sessionId = undefined;
  }
  let toLetter: string | undefined;
  try {
    toLetter = name === "pass_handback" ? resolveSession(ctx, input.toSessionId).letter : undefined;
  } catch {
    toLetter = undefined;
  }
  const helperWhy = cleanModelWhy(opts.why); // the deterministic ladder passes its own evidence
  const fromModel = helperWhy ? null : cleanModelWhy(modelWhy);
  const why = helperWhy ?? fromModel ?? deriveWhy({ tool: name, input, events: ctx.wakeEvents ?? [], row, toLetter, db: ctx.db });
  ctx.bus.emit("captain_action", {
    goalId: ctx.goalId ?? undefined,
    sessionId,
    data: {
      tool: name,
      input: truncateJson(input),
      ok: outcome.ok,
      ...(outcome.ok ? { result: truncateJson(outcome.result) } : { error: outcome.error }),
      userId: ctx.userId,
      triggerEventId: ctx.triggerEventId,
      // auto: the deterministic helper made this move (the model did not act on an actionable signal).
      ...(opts.auto ? { auto: true } : {}),
      // why: one evidence-based sentence (model-written, or derived from the wake's events).
      why,
      whySource: fromModel ? "model" : "auto",
    },
  });
  return outcome;
}

export function toJsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

function truncateJson(v: unknown, max = 2_000): unknown {
  const s = JSON.stringify(toJsonSafe(v));
  return s.length <= max ? JSON.parse(s) : { truncated: s.slice(0, max) };
}
