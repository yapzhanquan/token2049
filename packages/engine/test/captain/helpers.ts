// Test harness for the captain: real DB, real EventBus + DecisionLedger (runtime), FakeChain,
// and a small DB-backed SessionManager stand-in (no silos / no child processes).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDb, openDb, goals, messages, sessions as sessionsT, users, type DB } from "@bulkhead/db";
import { tusdToMicro, type AgentCatalogEntry, type Handback, type Plan, type PlannedSession, type SessionStatus } from "@bulkhead/shared";
import { eq } from "drizzle-orm";
import { createEventBus } from "../../src/bus";
import { createDecisionLedger } from "../../src/decisions";
import { buildTree } from "../../src/tree";
import { getSessionDb, toSessionRow } from "../../src/sessions-store";
import type { AgentMarket, EventBus, SessionManager } from "../../src/contracts";
import { createFakeChain, fakeAddress, type FakeChain } from "../fake-chain";

export const CATALOG: AgentCatalogEntry[] = [
  { id: "market-research", name: "Market Research", skills: ["research"], priceTUSD: "2", paymentAddress: fakeAddress("agent:mr"), endpoint: "http://127.0.0.1:1/mr", source: "mock" },
  { id: "summariser", name: "Summariser", skills: ["summarise"], priceTUSD: "1", paymentAddress: fakeAddress("agent:sum"), endpoint: "http://127.0.0.1:1/sum", source: "mock" },
];

export const stubMarket: AgentMarket = {
  catalog: async () => CATALOG,
  startJob: async () => {
    throw new Error("not in tests");
  },
  status: async () => ({ status: "running" }),
};

export function freshDb(): DB {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), "bulkhead-captain-"));
  return openDb(join(dir, "test.sqlite"));
}

export function seedUser(db: DB, id = `u_${randomUUID().slice(0, 8)}`) {
  db.insert(users)
    .values({
      id,
      email: `${id}@test.local`,
      name: "Test",
      custody: "custodial",
      accountIndex: 0,
      treasuryAddress: fakeAddress(`treasury:${id}`),
      ownerKeyHash: "00".repeat(28),
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function seedGoal(db: DB, userId: string, plan: Plan | null = null, status: "planned" | "running" = "running", budgetTUSD = "10") {
  const id = `g_${randomUUID()}`;
  db.insert(goals)
    .values({
      id,
      userId,
      goal: "Research competitors",
      budgetMicro: tusdToMicro(budgetTUSD).toString(),
      deadline: Date.now() + 3_600_000,
      rules: "",
      status,
      planJson: JSON.stringify(plan ?? { sessions: [] }),
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** DB-backed SessionManager stand-in: same tables + events as the runtime one, no silos or chain. */
export function fakeSessions(db: DB, bus: EventBus): SessionManager & { insert(goalId: string, userId: string, spec: Partial<PlannedSession> & { status?: SessionStatus; handback?: Handback }): string; calls: string[] } {
  const calls: string[] = [];
  const goalOf = (id: string) => getSessionDb(db, id)?.goalId;
  const setStatus = (id: string, to: SessionStatus, reason: string) => {
    const row = getSessionDb(db, id);
    if (!row || row.status === to) return;
    db.update(sessionsT).set({ status: to, updatedAt: Date.now() }).where(eq(sessionsT.id, id)).run();
    bus.emit("session_transition", { goalId: row.goalId, sessionId: id, data: { from: row.status, to, reason } });
  };
  const insert = (goalId: string, userId: string, spec: Partial<PlannedSession> & { status?: SessionStatus; handback?: Handback }) => {
    const n = db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all().length;
    const id = `s_${randomUUID().slice(0, 12)}`;
    db.insert(sessionsT)
      .values({
        id,
        goalId,
        userId,
        letter: String.fromCharCode(65 + n),
        name: spec.name ?? `Session ${n}`,
        role: spec.role ?? "worker",
        agentType: spec.agentType ?? "generic",
        taskType: spec.taskType ?? "research",
        goal: spec.goal ?? "do things",
        status: spec.status ?? "RUNNING",
        budgetMicro: tusdToMicro(spec.budgetTUSD ?? "1").toString(),
        perPaymentMaxMicro: tusdToMicro(spec.perPaymentMaxTUSD ?? "1").toString(),
        approvalThresholdMicro: tusdToMicro(spec.approvalThresholdTUSD ?? "1").toString(),
        allowedPayeesJson: JSON.stringify((spec.allowedPayees ?? []).map((a) => ({ id: a, label: a, address: a }))),
        expiresAt: Date.now() + 3_600_000,
        keyIndex: n,
        address: fakeAddress(`session:${id}`),
        handbackJson: spec.handback ? JSON.stringify(spec.handback) : null,
        startedAt: Date.now(),
        createdAt: Date.now() + n,
        updatedAt: Date.now(),
      })
      .run();
    bus.emit("session_created", { goalId, sessionId: id, data: {} });
    return id;
  };
  const sm: ReturnType<typeof fakeSessions> = {
    calls,
    insert,
    async startPlan(goalId, plan) {
      calls.push("startPlan");
      const g = db.select().from(goals).where(eq(goals.id, goalId)).get()!;
      return plan.sessions.map((s) => insert(goalId, g.userId, s));
    },
    async spawn(goalId, spec) {
      calls.push("spawn");
      const g = db.select().from(goals).where(eq(goals.id, goalId)).get()!;
      return insert(goalId, g.userId, spec);
    },
    get: (id) => {
      const r = getSessionDb(db, id);
      return r ? toSessionRow(r) : null;
    },
    list(filter = {}) {
      return db
        .select()
        .from(sessionsT)
        .all()
        .filter((r) => (!filter.goalId || r.goalId === filter.goalId) && (!filter.status || filter.status.includes(r.status as SessionStatus)))
        .map(toSessionRow);
    },
    async transition(id, to, reason) {
      setStatus(id, to, reason);
    },
    async pause(id) {
      calls.push(`pause:${id}`);
      setStatus(id, "PAUSED", "paused");
    },
    async resume(id) {
      calls.push(`resume:${id}`);
      setStatus(id, "RUNNING", "resumed");
    },
    async kill(id, _by, reason) {
      calls.push(`kill:${id}`);
      setStatus(id, "KILLED", reason);
    },
    async pauseAll() {
      calls.push("pauseAll");
    },
    async message(id, from, text) {
      calls.push(`message:${id}`);
      const messageId = `m_${randomUUID().slice(0, 8)}`;
      db.insert(messages).values({ id: messageId, sessionId: id, from, text, createdAt: Date.now() }).run();
      bus.emit("session_message", { goalId: goalOf(id), sessionId: id, data: { messageId, from, text } });
      return { messageId };
    },
    async passHandback(from, to) {
      calls.push(`passHandback:${from}->${to}`);
      bus.emit("handback_passed", { goalId: goalOf(from), sessionId: to, data: { from, to } });
    },
    async raiseBudget() {
      calls.push("raiseBudget");
    },
    async extendExpiry() {
      calls.push("extendExpiry");
    },
    async narrowBudget() {
      calls.push("narrowBudget");
    },
    async reviewHandback(id) {
      calls.push(`review:${id}`);
      bus.emit("handback_accepted", { goalId: goalOf(id), sessionId: id, data: {} });
      return { accepted: true };
    },
    tree: (goalId) => buildTree(db, goalId, { myrPerTusd: "4.70", now: Date.now() }),
    async reconcile() {},
  };
  return sm;
}

export function harness() {
  const db = freshDb();
  const bus = createEventBus(db);
  const decisions = createDecisionLedger(db, bus);
  const chain: FakeChain = createFakeChain();
  const sessions = fakeSessions(db, bus);
  return { db, bus, decisions, chain, sessions, market: stubMarket };
}
