// Funding without a UI click: delegated auto-funding at goal creation (API), the stuck-goal reconciler, batched
// child top-ups, the restart-noise fix and real concurrent silos under the MAX_PARALLEL_SESSIONS cap.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { goals, kv, users } from "@bulkhead/db";
import type { Plan } from "@bulkhead/shared";
import { eq } from "drizzle-orm";
import { createApi } from "../../src/api";
import type { Captain, Engine, LLM, SiloRunner } from "../../src/contracts";
import { createGoalReconciler, planMandateViolation } from "../../src/goal-funding";
import { setup, spec, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const inHour = () => Date.now() + 3_600_000;

/** Insert a goal the way captain.plan() does (status "planned", plan in planJson). */
function plannedGoal(hh: H, plan: Plan, opts: { userId?: string; budgetMicro?: string; status?: "planned" | "approved" | "running" } = {}) {
  const id = `g_${randomUUID()}`;
  hh.db.insert(goals).values({ id, userId: opts.userId ?? hh.userId, goal: "delegated job", budgetMicro: opts.budgetMicro ?? "20000000", deadline: inHour(), status: opts.status ?? "planned", planJson: JSON.stringify(plan), notes: "", createdAt: Date.now() }).run();
  return id;
}

function apiFor(hh: H, opts: { plan: Plan; autoFundUserEmails?: string[] }) {
  const captain = {
    async plan(args: { userId: string }) {
      const goalId = plannedGoal(hh, opts.plan, { userId: args.userId });
      return { goalId, plan: opts.plan, fundingPreview: {} };
    },
  } as unknown as Captain;
  const engine: Engine = { db: hh.db, chain: hh.chain, bus: hh.bus, sessions: hh.sessions, silos: {} as SiloRunner, signer: hh.signer, decisions: hh.decisions, market: hh.market, llm: { name: "mock" } as unknown as LLM, captain, wrapHandback: hh.sessions.wrapHandback };
  const app = createApi({ engine, myrPerTusd: "4.70", captainInfo: () => ({ name: "c", model: "m", contextTokens: 0, totalTokens: 0 }), ...(opts.autoFundUserEmails ? { autoFundUserEmails: opts.autoFundUserEmails } : {}) });
  return async (method: string, path: string, body?: unknown, userId = hh.userId) => {
    const res = await app.request(path, { method, headers: { "x-user-id": userId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const twoSessions = (): Plan => ({ sessions: [spec({ name: "A", budgetTUSD: "4", perPaymentMaxTUSD: "2", approvalThresholdTUSD: "2" }), spec({ name: "B", budgetTUSD: "6", perPaymentMaxTUSD: "2", approvalThresholdTUSD: "2" })] });

describe("delegated goals are funded at creation (no UI click)", () => {
  it("POST /goals {autoFund:true} → one funding tx, sessions RUNNING; a later approve is a no-op", async () => {
    h = await setup();
    const call = apiFor(h, { plan: twoSessions() });
    const r = await call("POST", "/goals", { goal: "x", budgetTUSD: "20", deadline: new Date(inHour()).toISOString(), autoFund: true });
    expect(r.status).toBe(201);
    expect(r.body.autoFund).toMatchObject({ ok: true });
    expect(r.body.autoFund.fundingTx).toMatch(/^[0-9a-f]{64}$/);
    const goalId = r.body.goalId as string;
    expect(h.chain.txs.filter((t) => t.kind === "fundSessions")).toHaveLength(1);
    const ids = h.sessions.list({ goalId }).map((s) => s.id);
    await waitFor(() => ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 5_000, "running");
    expect(h.db.select().from(goals).where(eq(goals.id, goalId)).get()!.status).toBe("running");
    const again = await call("POST", `/goals/${goalId}/approve`, {});
    expect(again.body).toMatchObject({ ok: true, alreadyApproved: true });
    expect(h.chain.txs.filter((t) => t.kind === "fundSessions")).toHaveLength(1);
  });

  it("AUTO_FUND_USER_EMAILS users are auto-funded; other users still need the click", async () => {
    h = await setup();
    const call = apiFor(h, { plan: twoSessions(), autoFundUserEmails: ["t@example.com"] });
    const r = await call("POST", "/goals", { goal: "x", budgetTUSD: "20", deadline: new Date(inHour()).toISOString() });
    expect(r.body.autoFund?.ok).toBe(true);

    const call2 = apiFor(h, { plan: twoSessions(), autoFundUserEmails: [] });
    const r2 = await call2("POST", "/goals", { goal: "y", budgetTUSD: "20", deadline: new Date(inHour()).toISOString() });
    expect(r2.body.autoFund).toBeUndefined();
    expect(h.sessions.list({ goalId: r2.body.goalId })).toHaveLength(0);
  });

  it("refuses to auto-fund a plan outside the goal's mandate (Σ budgets > goal budget)", async () => {
    h = await setup();
    expect(planMandateViolation({ budgetMicro: "5000000", deadline: inHour() }, twoSessions())).toMatch(/exceed the goal budget/);
    expect(planMandateViolation({ budgetMicro: "10000000", deadline: inHour() }, twoSessions())).toBeNull();
    const call = apiFor(h, { plan: { sessions: [spec({ budgetTUSD: "50" })] } });
    const r = await call("POST", "/goals", { goal: "x", budgetTUSD: "20", deadline: new Date(inHour()).toISOString(), autoFund: true });
    expect(r.body.autoFund).toMatchObject({ ok: false, reason: "outside_mandate" });
    expect(h.chain.calls.fundSessions).toBe(0);
  });

  it("self-custody users are never auto-funded (wallet signature stays required)", async () => {
    h = await setup();
    h.db.update(users).set({ custody: "self" }).where(eq(users.id, h.userId)).run();
    const call = apiFor(h, { plan: twoSessions(), autoFundUserEmails: ["t@example.com"] });
    const r = await call("POST", "/goals", { goal: "x", budgetTUSD: "20", deadline: new Date(inHour()).toISOString(), autoFund: true });
    expect(r.body.autoFund).toBeUndefined();
    expect(h.chain.calls.fundSessions).toBe(0);
  });
});

describe("Approve re-offers funding for a started goal with waiting sessions", () => {
  it("GET /goals shows awaitingFunding; approving again funds only the waiting child", async () => {
    h = await setup({ config: { spawnBatchMs: 0 } });
    const call = apiFor(h, { plan: twoSessions() });
    const r = await call("POST", "/goals", { goal: "x", budgetTUSD: "20", deadline: new Date(inHour()).toISOString(), autoFund: true });
    const goalId = r.body.goalId as string;
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro, 0n);
    await h.sessions.spawn(goalId, spec({ name: "child", budgetTUSD: "2", perPaymentMaxTUSD: "1", approvalThresholdTUSD: "1" })).catch(() => undefined);
    const listed = (await call("GET", "/goals")).body.find((g: { id: string }) => g.id === goalId);
    expect(listed).toMatchObject({ status: "running", awaitingFunding: 1 });
    expect((await call("POST", `/goals/${goalId}/approve`, {})).status).toBe(409); // still short → exact message
    h.chain.credit(h.treasury, 10_000_000n, 0n);
    const before = h.chain.txs.filter((t) => t.kind === "fundSessions").length;
    expect((await call("POST", `/goals/${goalId}/approve`, {})).body.ok).toBe(true);
    const tops = h.chain.txs.filter((t) => t.kind === "fundSessions").slice(before);
    expect(tops).toHaveLength(1);
    expect(tops[0]!.outputs.map((o) => o.tusdMicro)).toEqual([2_000_000n]);
  });
});

describe("stuck-goal reconciler (approved but unfunded)", () => {
  it("reports the exact shortfall ONCE, then funds the waiting sessions after a top-up", async () => {
    h = await setup();
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro + 1_000_000n, 0n); // 1 tUSD left
    const goalId = plannedGoal(h, twoSessions(), { status: "approved" });
    await expect(h.sessions.startPlan(goalId, twoSessions())).rejects.toThrow(/Shortfall: 9 tUSD/);
    const rec = createGoalReconciler({ db: h.db, bus: h.bus, chain: h.chain, sessions: h.sessions, config: { ...h.config, goalReconcileMs: 0 } });
    const r1 = await rec.tick();
    expect(r1.stalled).toEqual([goalId]);
    await rec.tick(); // same state → no second notice (also persisted across restarts in kv)
    const stalls = h.events("error").filter((e) => e.data.kind === "funding_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.data).toMatchObject({ reason: "insufficient_funds", shortTusdMicro: "9000000", treasuryAddress: h.treasury, assetUnit: h.chain.tx.tusdUnit() });
    expect(String(stalls[0]!.data.error)).toContain(h.treasury);

    h.chain.credit(h.treasury, 50_000_000n, 0n);
    const r2 = await rec.tick();
    expect(r2.funded).toEqual([goalId]);
    const ids = h.sessions.list({ goalId }).map((s) => s.id);
    await waitFor(() => ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 5_000, "running");
    expect(h.db.select().from(kv).where(eq(kv.key, `goal_stall:${goalId}`)).get()).toBeUndefined();
    rec.stop();
  });

  it("self-custody: never funds behind the user's back; says exactly what is missing or that a signature is needed", async () => {
    h = await setup();
    h.db.update(users).set({ custody: "self" }).where(eq(users.id, h.userId)).run();
    const goalId = plannedGoal(h, twoSessions(), { status: "approved" });
    // Rows exist and wait for the signature (as after a cancelled / expired wallet prompt).
    h.db.update(users).set({ custody: "custodial" }).where(eq(users.id, h.userId)).run();
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro, 0n);
    await h.sessions.startPlan(goalId, twoSessions()).catch(() => undefined);
    h.db.update(users).set({ custody: "self" }).where(eq(users.id, h.userId)).run();
    const rec = createGoalReconciler({ db: h.db, bus: h.bus, chain: h.chain, sessions: h.sessions, config: { ...h.config, goalReconcileMs: 0 } });
    await rec.tick();
    let stall = h.events("error").filter((e) => e.data.kind === "funding_stalled").at(-1)!;
    expect(stall.data).toMatchObject({ reason: "insufficient_funds", shortTusdMicro: "10000000" });
    h.chain.credit(h.treasury, 50_000_000n, 0n);
    await rec.tick();
    stall = h.events("error").filter((e) => e.data.kind === "funding_stalled").at(-1)!;
    expect(stall.data.reason).toBe("awaiting_signature");
    expect(h.chain.calls.fundSessions).toBe(0);
    rec.stop();
  });

  it("restart does not log 'reconcile after restart' for unfunded AWAITING_APPROVAL sessions", async () => {
    h = await setup();
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro, 0n);
    const goalId = plannedGoal(h, twoSessions(), { status: "approved" });
    await h.sessions.startPlan(goalId, twoSessions()).catch(() => undefined);
    await h.sessions.reconcile();
    expect(h.events("progress").filter((e) => /reconcile after restart/.test(String(e.data.text)))).toHaveLength(0);
  });
});

describe("child / hand-off spawns get their own funded wallet, batched", () => {
  it("3 parallel spawns → ONE top-up tx with 3 outputs, distinct letters + wallets, all start once confirmed", async () => {
    h = await setup({ config: { spawnBatchMs: 100 } });
    const goalId = h.newGoal();
    const [first] = await h.sessions.startPlan(goalId, { sessions: [spec({ name: "Lead" })] });
    await waitFor(() => h!.sessions.get(first!)!.status === "RUNNING", 5_000, "lead running");
    const before = h.chain.txs.filter((t) => t.kind === "fundSessions").length;
    const ids = await Promise.all([1, 2, 3].map((i) => h!.sessions.spawn(goalId, spec({ name: `child ${i}`, budgetTUSD: String(i) }), { parentSessionId: first! })));
    const tops = h.chain.txs.filter((t) => t.kind === "fundSessions").slice(before);
    expect(tops).toHaveLength(1);
    expect(tops[0]!.outputs.map((o) => o.tusdMicro).sort()).toEqual([1_000_000n, 2_000_000n, 3_000_000n]);
    const rows = ids.map((id) => h!.sessions.get(id)!);
    expect(new Set(rows.map((r) => r.letter)).size).toBe(3);
    expect(new Set(rows.map((r) => r.address)).size).toBe(3);
    await waitFor(() => ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 5_000, "children running");
  });

  it("a spawn the treasury cannot cover stays waiting (not lost) and says so; the reconciler funds it later", async () => {
    h = await setup({ config: { spawnBatchMs: 0 } });
    const goalId = h.newGoal();
    await h.sessions.startPlan(goalId, { sessions: [spec({ name: "Lead", budgetTUSD: "1" })] });
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro, 0n);
    const err = await h.sessions.spawn(goalId, spec({ name: "child", budgetTUSD: "2" })).catch((e) => e);
    expect(String(err.message)).toMatch(/was created but not funded: .*Shortfall: 2 tUSD.*do not spawn it again/);
    const child = h.sessions.list({ goalId }).find((s) => s.name === "child")!;
    expect(child.status).toBe("AWAITING_APPROVAL");
    h.chain.credit(h.treasury, 10_000_000n, 0n);
    h.db.update(goals).set({ status: "running" }).where(eq(goals.id, goalId)).run();
    const rec = createGoalReconciler({ db: h.db, bus: h.bus, chain: h.chain, sessions: h.sessions, config: { ...h.config, goalReconcileMs: 0 } });
    expect((await rec.tick()).funded).toEqual([goalId]);
    await waitFor(() => h!.sessions.get(child.id)!.status === "RUNNING", 5_000, "child running");
    rec.stop();
  });
});

describe("real parallel silos under the concurrency cap", () => {
  it("≥2 forked silos overlap in time (distinct pids) and never more than MAX_PARALLEL_SESSIONS at once", async () => {
    h = await setup({ realSilos: true, config: { maxParallelSessions: 2 } });
    const goalId = h.newGoal();
    const ids = await h.sessions.startPlan(goalId, {
      sessions: [spec({ name: "A", goal: "a #mock:slow=1200" }), spec({ name: "B", goal: "b #mock:slow=1200" }), spec({ name: "C", goal: "c #mock:slow=1200" })],
    });
    let maxAlive = 0;
    let maxActive = 0;
    const pids = new Set<number>();
    const sampler = setInterval(() => {
      const alive = ids.filter((id) => h!.silos.isAlive(id));
      maxAlive = Math.max(maxAlive, alive.length);
      maxActive = Math.max(maxActive, ids.filter((id) => ["RUNNING", "PAUSED", "QUARANTINED", "COMPLETING"].includes(h!.sessions.get(id)!.status)).length);
      for (const id of alive) {
        const pid = h!.silos.info(id)?.pid;
        if (pid) pids.add(pid);
      }
    }, 20);
    try {
      await Promise.all(ids.map((id) => h!.sessions.whenClosed(id, 30_000)));
    } finally {
      clearInterval(sampler);
    }
    expect(maxAlive).toBeGreaterThanOrEqual(2); // ≥2 OS processes alive at the same moment
    expect(maxActive).toBe(2); // the cap: never 3 sessions holding a slot
    expect(pids.size).toBe(3);
    const spans = ids.map((id) => {
      const t = h!.sessions.transitionsOf(id);
      return { start: t.find((x) => x.to === "RUNNING")!.at, end: t.find((x) => x.to === "COMPLETING")!.at };
    });
    // A and B ran at the same time; C waited for a free slot.
    expect(Math.max(spans[0]!.start, spans[1]!.start)).toBeLessThan(Math.min(spans[0]!.end, spans[1]!.end));
    expect(spans[2]!.start).toBeGreaterThanOrEqual(Math.min(spans[0]!.end, spans[1]!.end));
  }, 40_000);
});
