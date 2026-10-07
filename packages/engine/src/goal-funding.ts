// Goal funding outside the UI click: delegated auto-funding at creation + the stuck-goal reconciler.
//
//  - startGoal(): "approve & fund" a goal (planned → approved → startPlan → running). Used by the HTTP approve
//    route, by auto-funding and by the reconciler, so all three behave the same (idempotent, never double-funds).
//  - autoFundGoal(): goals created through the API by a DELEGATED custodial user (Sokosumi worker, Masumi Standard
//    API, or a request with `autoFund: true`) are funded at creation — but only when the plan stays inside the goal's
//    mandate (Σ session budgets ≤ goal budget, per-payment max ≤ budget, deadlines ≤ goal deadline). Self-custody
//    goals always keep the wallet-signed approval.
//  - createGoalReconciler(): approved/running goals whose sessions still have no funding tx (approve failed on a
//    shortfall, a child spawn could not be topped up, a crash) are retried for custodial users once the treasury
//    can cover them, and otherwise surface ONE clear `error` event { kind: "funding_stalled" } with the exact
//    shortfall (asset + amount + treasury address). The same message is never re-emitted (persisted in kv), so
//    restarts don't spam the log.
//  - Treasury autopilot (treasury-autopilot.ts): for its target accounts (delegated custodial users) a shortfall is
//    not a stall — the reconciler asks the autopilot to refill the treasury from the funding account (inside the
//    24 h standing cap), waits for the refill to confirm and funds the goal in the SAME pass. Only a refill the
//    autopilot cannot make (cap reached, source too low) becomes the one `funding_stalled` notice, with the exact
//    amount still needed.
import { eq, inArray } from "drizzle-orm";
import { goals, kv, sessions as sessionsT, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { PlanSchema, tusdToMicro, type Plan } from "@bulkhead/shared";
import type { EventBus, SessionManager } from "./contracts";
import { FundingError, fundingNeed, fundingShortfall, sessionFloatFor, type RuntimeSessionManager } from "./sessions";
import type { RuntimeConfig } from "./sessions-store";
import { parseVaultParams } from "./vault";
import { autopilotFor } from "./treasury-autopilot";

export interface GoalFundingDeps {
  db: DB;
  bus: EventBus;
  chain: Chain;
  sessions: RuntimeSessionManager;
  config: RuntimeConfig;
}

/** What starting / auto-funding a goal needs (the HTTP API has only the public SessionManager). */
export interface GoalStartDeps {
  db: DB;
  bus: EventBus;
  sessions: Pick<SessionManager, "startPlan" | "list">;
}

type GoalRow = typeof goals.$inferSelect;
type UserRow = typeof users.$inferSelect;

const DEADLINE_SLACK_MS = 60_000;

/** Why a plan is NOT inside its goal's mandate (null = inside). Auto-funding refuses plans that are not. */
export function planMandateViolation(goal: Pick<GoalRow, "budgetMicro" | "deadline">, plan: Plan): string | null {
  if (!plan.sessions.length) return "the plan has no sessions";
  let total = 0n;
  for (const s of plan.sessions) {
    const budget = tusdToMicro(s.budgetTUSD);
    total += budget;
    if (tusdToMicro(s.perPaymentMaxTUSD) > budget) return `session "${s.name}": per-payment max ${s.perPaymentMaxTUSD} exceeds its budget ${s.budgetTUSD}`;
    const dl = Date.parse(s.deadline);
    if (!Number.isFinite(dl) || dl > goal.deadline + DEADLINE_SLACK_MS) return `session "${s.name}": deadline ${s.deadline} is after the goal deadline`;
  }
  if (total > BigInt(goal.budgetMicro)) return `the plan's session budgets (${total} µ) exceed the goal budget (${goal.budgetMicro} µ)`;
  return null;
}

/** A custodial user whose API goals are funded at creation (AUTO_FUND_USER_EMAILS). */
export function isDelegatedUser(config: Pick<RuntimeConfig, "autoFundUserEmails">, user: Pick<UserRow, "email" | "custody">): boolean {
  return user.custody === "custodial" && (config.autoFundUserEmails ?? []).includes(user.email.toLowerCase());
}

/**
 * Approve + fund a goal (idempotent): planned → approved (+ plan_approved), SessionManager.startPlan (creates the
 * session rows once, funds every unfunded wallet in ONE treasury tx), approved → running. Throws whatever
 * startPlan throws (FundingError with the exact shortfall on insufficient funds).
 */
export function startGoal(deps: GoalStartDeps, goalId: string, extra: Record<string, unknown> = {}): Promise<void> {
  // One start per goal at a time (approve click, auto-fund and the reconciler share it): never create rows twice.
  const cur = starting.get(goalId);
  if (cur) return cur;
  const p = startGoalOnce(deps, goalId, extra).finally(() => starting.delete(goalId));
  starting.set(goalId, p);
  return p;
}
const starting = new Map<string, Promise<void>>();
/** True while startGoal() runs for this goal. */
export const isStarting = (goalId: string) => starting.has(goalId);

async function startGoalOnce(deps: GoalStartDeps, goalId: string, extra: Record<string, unknown>): Promise<void> {
  const { db, bus, sessions } = deps;
  const g = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!g) throw new Error(`goal ${goalId} not found`);
  const plan = PlanSchema.parse(JSON.parse(g.planJson));
  if (g.status === "planned") {
    db.update(goals).set({ status: "approved" }).where(eq(goals.id, g.id)).run();
    bus.emit("plan_approved", { goalId: g.id, data: { userId: g.userId, sessions: plan.sessions.length, ...extra } });
  }
  await sessions.startPlan(g.id, plan);
  const now = db.select({ status: goals.status }).from(goals).where(eq(goals.id, g.id)).get();
  if (now?.status === "approved") db.update(goals).set({ status: "running" }).where(eq(goals.id, g.id)).run();
}

export type AutoFundResult =
  | { ok: true; fundingTx: string | null; sessionIds: string[] }
  | { ok: false; reason: "self_custody" | "outside_mandate" | "insufficient_funds" | "funding_failed"; error: string; autopilot?: "refilling" };

/** Fund a delegated (API) goal at creation, inside its mandate. On a shortfall the goal stays approved and the
 * reconciler retries once the treasury is topped up. */
export async function autoFundGoal(deps: GoalStartDeps, goalId: string): Promise<AutoFundResult> {
  const { db, bus } = deps;
  const g = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!g) throw new Error(`goal ${goalId} not found`);
  const user = db.select().from(users).where(eq(users.id, g.userId)).get();
  if (!user || user.custody !== "custodial") return { ok: false, reason: "self_custody", error: "self-custody goals are funded only after the wallet signs (Approve & start)" };
  const plan = PlanSchema.parse(JSON.parse(g.planJson));
  const violation = planMandateViolation(g, plan);
  if (violation) {
    bus.emit("error", { goalId, data: { kind: "auto_fund_refused", error: `not auto-funded: ${violation}; the plan needs an explicit approval` } });
    return { ok: false, reason: "outside_mandate", error: violation };
  }
  try {
    await startGoal(deps, goalId, { delegated: true, by: "auto-fund" });
  } catch (e) {
    if (e instanceof FundingError) {
      const ap = autopilotFor(db);
      if (ap?.covers(user)) {
        // Not a stall: the treasury autopilot refills this account and the reconciler funds the goal right after.
        bus.emit("progress", { goalId, data: { kind: "log", level: "info", text: "treasury short for this goal — the treasury autopilot is refilling it; funding follows automatically once the refill confirms" } });
        ap.nudge();
        return { ok: false, reason: "insufficient_funds", error: e.message, autopilot: "refilling" };
      }
      noteStall(deps, goalId, "insufficient_funds", e.message, e.details());
      return { ok: false, reason: "insufficient_funds", error: e.message };
    }
    const msg = e instanceof Error ? e.message : String(e);
    bus.emit("error", { goalId, data: { kind: "funding_failed", where: "auto-fund", error: msg, note: "the goal reconciler retries" } });
    return { ok: false, reason: "funding_failed", error: msg };
  }
  const after = db.select().from(goals).where(eq(goals.id, goalId)).get()!;
  return { ok: true, fundingTx: after.fundingTx ?? null, sessionIds: deps.sessions.list({ goalId }).map((s) => s.id) };
}

// ─────────── stall notices (deduplicated, persisted) ───────────
const stallKey = (goalId: string) => `goal_stall:${goalId}`;

/** Emit ONE `error` { kind: "funding_stalled" } per distinct message (kv-persisted, survives restarts). */
function noteStall(deps: Pick<GoalFundingDeps, "db" | "bus">, goalId: string, reason: string, message: string, details: Record<string, unknown> = {}): boolean {
  const { db, bus } = deps;
  const key = stallKey(goalId);
  const value = `${reason}|${message}`;
  if (db.select().from(kv).where(eq(kv.key, key)).get()?.value === value) return false;
  db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
  bus.emit("error", { goalId, data: { kind: "funding_stalled", reason, error: message, ...details } });
  return true;
}
function clearStall(db: DB, goalId: string): boolean {
  const key = stallKey(goalId);
  if (!db.select().from(kv).where(eq(kv.key, key)).get()) return false;
  db.delete(kv).where(eq(kv.key, key)).run();
  return true;
}

export interface GoalReconcileReport {
  checked: number;
  funded: string[];
  stalled: string[];
}

export interface GoalReconciler {
  start(): void;
  stop(): void;
  /** One pass (exposed for tests / boot). */
  tick(): Promise<GoalReconcileReport>;
  /** Run a pass now, or right after the one in progress (treasury autopilot: a refill confirmed / a shortfall seen). */
  nudge(): void;
}

export function createGoalReconciler(deps: GoalFundingDeps): GoalReconciler {
  const { db, bus, chain, sessions, config } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let offWatcher: (() => void) | null = null;
  let running: Promise<GoalReconcileReport> | null = null;
  let again = false;
  let stopped = false;

  const unitOrUndefined = () => {
    try {
      return chain.tx.tusdUnit();
    } catch {
      return undefined;
    }
  };

  /** Lower-bound estimate of what funding these rows needs (same formula as the funding preflight). */
  function needOf(rows: (typeof sessionsT.$inferSelect)[]) {
    return fundingNeed(
      rows.map((r) => {
        const float = config.sessionFloatLovelace ?? sessionFloatFor({ taskType: r.taskType, allowedPayees: JSON.parse(r.allowedPayeesJson) as unknown[] });
        const allowance = r.walletMode === "vault" ? (parseVaultParams(r.scriptJson)?.adaAllowanceLovelace ?? 0n) : 0n;
        return { tusdMicro: BigInt(r.budgetMicro), extraLovelace: float > allowance ? float : allowance };
      }),
    );
  }

  /**
   * Treasury autopilot for a shortfall of this goal's (custodial) owner: refill, wait for confirmation, then the
   * caller funds in the same pass. null = the autopilot does not cover this user (normal stall path).
   */
  async function viaAutopilot(user: UserRow, goalId: string, needTusdMicro: bigint, needLovelace: bigint, ids: string[]): Promise<"ok" | "waiting" | "blocked" | null> {
    const ap = autopilotFor(db);
    if (!ap || user.custody !== "custodial" || !ap.covers(user)) return null;
    const r = await ap.ensure({ userId: user.id, needTusdMicro, needLovelace, goalId, reason: `goal ${goalId} funding shortfall`, wait: true });
    if (r.status === "sufficient" || r.status === "refilled") return "ok";
    if (r.status === "pending") return "waiting"; // still confirming: the next pass (or the confirmation nudge) funds it
    if (r.status === "blocked") {
      noteStall(deps, goalId, "autopilot_blocked", r.message, {
        autopilot: r.reason,
        shortTusdMicro: r.neededTusdMicro.toString(),
        shortLovelace: r.neededLovelace.toString(),
        treasuryAddress: user.treasuryAddress,
        assetUnit: unitOrUndefined(),
        sessionIds: ids,
      });
      return "blocked";
    }
    return null;
  }

  async function reconcileGoal(g: GoalRow, report: GoalReconcileReport): Promise<void> {
    if (isStarting(g.id) || sessions.isFunding(g.id)) return; // a start / funding tx / wallet signature is in flight
    const rows = db.select().from(sessionsT).where(eq(sessionsT.goalId, g.id)).all();
    const unfunded = rows.filter((r) => !r.fundingTx && (r.status === "PLANNED" || r.status === "AWAITING_APPROVAL") && r.expiresAt > config.now());
    const needsPlanStart = g.status === "approved" && rows.length === 0 && g.deadline > config.now();
    if (!unfunded.length && !needsPlanStart) {
      if (clearStall(db, g.id)) bus.emit("progress", { goalId: g.id, data: { kind: "log", level: "info", text: "goal funding no longer stalled" } });
      return;
    }
    const user = db.select().from(users).where(eq(users.id, g.userId)).get();
    if (!user) return;
    report.checked++;
    const ids = unfunded.map((r) => r.id);

    // Exact shortfall first (cheap; avoids building a tx that must fail, and keeps the log quiet).
    if (unfunded.length) {
      const need = needOf(unfunded);
      const bal = await chain.tx.balanceOf(user.treasuryAddress).catch(() => null);
      if (bal) {
        const e = fundingShortfall({ haveLovelace: bal.lovelace, haveTusdMicro: bal.tusdMicro, needLovelace: need.lovelace, needTusdMicro: need.tusdMicro, myrPerTusd: config.myrPerTusd, treasuryAddress: user.treasuryAddress, assetUnit: unitOrUndefined() });
        if (e) {
          const auto = await viaAutopilot(user, g.id, need.tusdMicro, need.lovelace, ids);
          if (auto === "blocked") report.stalled.push(g.id);
          if (auto !== "ok") {
            if (auto === null && noteStall(deps, g.id, "insufficient_funds", `${unfunded.length} session wallet(s) of this goal are waiting for funding. ${e.message}`, { ...e.details(), sessionIds: ids })) report.stalled.push(g.id);
            return;
          }
          // refilled + confirmed by the autopilot: fund below, in this same pass
        }
      }
    }
    if (user.custody !== "custodial") {
      // Self-custody: the funding tx must be signed by the user's wallet — never funded behind their back.
      if (noteStall(deps, g.id, "awaiting_signature", `${unfunded.length || "The"} session wallet(s) of this goal are not funded yet. Your wallet ${user.treasuryAddress} holds enough: open the goal and click "Approve & start" to sign the funding transaction.`, { treasuryAddress: user.treasuryAddress, sessionIds: ids }))
        report.stalled.push(g.id);
      return;
    }
    const fundNow = async () => (needsPlanStart ? (await startGoal(deps, g.id, { by: "goal-reconciler" }), sessions.list({ goalId: g.id }).map((s) => s.id)) : await sessions.fundUnfunded(g.id));
    try {
      let funded: string[];
      try {
        funded = await fundNow();
      } catch (e) {
        // The chain said "not enough" (fees, a plan start with no rows yet): one autopilot refill, then one retry.
        if (!(e instanceof FundingError)) throw e;
        const auto = await viaAutopilot(user, g.id, e.needTusdMicro, e.needLovelace, ids);
        if (auto === "blocked") {
          report.stalled.push(g.id);
          return;
        }
        if (auto === "waiting") return;
        if (auto === null) throw e;
        funded = await fundNow();
      }
      if (funded.length) {
        report.funded.push(g.id);
        clearStall(db, g.id);
        bus.emit("progress", { goalId: g.id, data: { kind: "log", level: "info", text: `goal reconciler funded ${funded.length} waiting session wallet(s)`, sessionIds: funded } });
      }
    } catch (e) {
      if (e instanceof FundingError) {
        if (noteStall(deps, g.id, "insufficient_funds", e.message, { ...e.details(), sessionIds: ids })) report.stalled.push(g.id);
      } else if (noteStall(deps, g.id, "funding_failed", `funding the waiting session wallets failed: ${e instanceof Error ? e.message : String(e)} (retrying every ${Math.round((config.goalReconcileMs ?? 60_000) / 1000)} s)`, { sessionIds: ids })) {
        report.stalled.push(g.id);
      }
    }
  }

  const rec: GoalReconciler = {
    start() {
      stopped = false;
      if (timer || offWatcher) return;
      const every = config.goalReconcileMs ?? 60_000;
      if (every > 0) {
        timer = setInterval(() => void rec.tick().catch(() => undefined), every);
        timer.unref?.();
      }
      // A deposit to any treasury may unblock a stalled goal: re-check shortly after.
      try {
        offWatcher = chain.watcher.on((e) => {
          if (e.type !== "deposit" || soon) return;
          const isTreasury = !!db.select({ id: users.id }).from(users).where(eq(users.treasuryAddress, e.address)).get();
          if (!isTreasury) return;
          soon = setTimeout(() => {
            soon = null;
            void rec.tick().catch(() => undefined);
          }, 2_000);
          soon.unref?.();
        });
      } catch {
        offWatcher = null;
      }
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = null;
      soon = null;
      offWatcher?.();
      offWatcher = null;
    },
    tick() {
      if (running) return running;
      running = (async () => {
        const report: GoalReconcileReport = { checked: 0, funded: [], stalled: [] };
        const rows = db.select().from(goals).where(inArray(goals.status, ["approved", "running"])).all();
        for (const g of rows) {
          try {
            await reconcileGoal(g, report);
          } catch (e) {
            bus.emit("error", { goalId: g.id, data: { kind: "goal_reconcile_failed", error: e instanceof Error ? e.message : String(e) } });
          }
        }
        return report;
      })().finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          void rec.tick().catch(() => undefined);
        }
      });
      return running;
    },
    nudge() {
      if (stopped) return;
      if (running) again = true;
      else void rec.tick().catch(() => undefined);
    },
  };
  return rec;
}
