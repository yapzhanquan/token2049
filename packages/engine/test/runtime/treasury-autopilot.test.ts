// Treasury autopilot: delegated treasuries are refilled from the funding account (inside the 24 h cap) so a paid
// task never waits for a human to move tUSDM + tADA — and the goal is funded in the same reconciler pass.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { goals, kv, users } from "@bulkhead/db";
import { tusdToMicro, type Plan } from "@bulkhead/shared";
import { autoFundGoal, createGoalReconciler, startGoal, type GoalReconciler } from "../../src/goal-funding";
import { createTreasuryAutopilot, treasuryAutopilotConfigFromEnv, type TreasuryAutopilot, type TreasuryAutopilotConfig } from "../../src/treasury-autopilot";
import { eventToRow } from "../../src/api-activity";
import { createFakeChain } from "../fake-chain";
import { setup, spec, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
let stops: (() => void)[] = [];
afterEach(async () => {
  for (const s of stops) s();
  stops = [];
  await h?.cleanup();
  h = null;
});

const WORKER = "w@example.com";
const DAY = 24 * 60 * 60_000;
const cfg = (over: Partial<TreasuryAutopilotConfig> = {}): TreasuryAutopilotConfig => ({
  enabled: true,
  source: "t@example.com",
  targets: [WORKER],
  lowTusdMicro: tusdToMicro("5"),
  lowLovelace: tusdToMicro("15"),
  refillTusdMicro: tusdToMicro("20"),
  refillLovelace: tusdToMicro("40"),
  capTusdMicro: tusdToMicro("200"),
  capLovelace: tusdToMicro("200"),
  windowMs: DAY,
  checkMs: 0,
  pendingStaleMs: 20 * 60_000,
  ...over,
});

/** A delegated custodial worker account with an EMPTY treasury (the incident). */
async function addWorker(hh: H, custody: "custodial" | "self" = "custodial") {
  const id = "user_worker";
  const t = await hh.chain.keys.treasury(id, 1);
  hh.db.insert(users).values({ id, email: WORKER, name: "Worker", custody, accountIndex: 1, treasuryAddress: t.address, ownerKeyHash: t.keyHash, stakeKeyHash: t.stakeKeyHash, createdAt: Date.now() }).run();
  return { id, treasury: t.address };
}

const twoSessions = (): Plan => ({ sessions: [spec({ name: "A", budgetTUSD: "4", perPaymentMaxTUSD: "2", approvalThresholdTUSD: "2" }), spec({ name: "B", budgetTUSD: "6", perPaymentMaxTUSD: "2", approvalThresholdTUSD: "2" })] });

function plannedGoal(hh: H, userId: string, plan: Plan = twoSessions()) {
  const id = `g_${randomUUID()}`;
  hh.db.insert(goals).values({ id, userId, goal: "paid sokosumi task", budgetMicro: "20000000", deadline: Date.now() + 3_600_000, status: "planned", planJson: JSON.stringify(plan), notes: "", createdAt: Date.now() }).run();
  return id;
}

function wire(hh: H, over: Partial<TreasuryAutopilotConfig> = {}): { rec: GoalReconciler; ap: TreasuryAutopilot } {
  const rec = createGoalReconciler({ db: hh.db, bus: hh.bus, chain: hh.chain, sessions: hh.sessions, config: { ...hh.config, goalReconcileMs: 0 } });
  const ap = createTreasuryAutopilot({ db: hh.db, bus: hh.bus, chain: hh.chain, config: cfg(over), runtime: hh.config, reconcile: () => rec.nudge() });
  stops.push(() => ap.stop(), () => rec.stop());
  return { rec, ap };
}

const refills = (hh: H, from: string) => hh.chain.txs.filter((t) => t.kind === "fundSessions" && t.from[0] === from);

describe("treasury autopilot", () => {
  it("shortfall → refill from the funding account → goal funded, with no clicks", async () => {
    h = await setup();
    const w = await addWorker(h);
    const { ap } = wire(h); // not start()ed: the shortfall path alone must refill (no periodic check involved)
    const goalId = plannedGoal(h, w.id);
    const r = await autoFundGoal({ db: h.db, bus: h.bus, sessions: h.sessions }, goalId);
    expect(r).toMatchObject({ ok: false, reason: "insufficient_funds", autopilot: "refilling" });

    await waitFor(() => h!.db.select().from(goals).where(eq(goals.id, goalId)).get()!.status === "running", 8_000, "goal running");
    const ids = h.sessions.list({ goalId }).map((s) => s.id);
    expect(ids).toHaveLength(2);
    await waitFor(() => ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 8_000, "sessions running");

    // ONE refill: source treasury → worker treasury, topped up to max(need, refill level), CIP-20 674 memo.
    const txs = refills(h, h.treasury);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.outputs).toHaveLength(1);
    expect(txs[0]!.outputs[0]).toMatchObject({ address: w.treasury, tusdMicro: 20_000_000n });
    expect(txs[0]!.outputs[0]!.lovelace).toBeGreaterThanOrEqual(40_000_000n);
    const msg = (txs[0]!.metadata as { msg: string[] }).msg;
    expect(msg[0]).toBe("Bulkhead treasury autopilot refill");
    for (const l of msg) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(64);

    const ev = h.events("treasury_refill");
    expect(ev.map((e) => e.data.status)).toEqual(["submitted", "confirmed"]);
    expect(ev[1]!.data).toMatchObject({ tx: txs[0]!.txHash, from: { userId: h.userId, address: h.treasury }, to: { userId: w.id, email: WORKER, address: w.treasury }, amounts: { tusdMicro: "20000000", lovelace: "40000000" } });
    expect(String(ev[1]!.data.reason)).toContain(goalId);
    // No human step: no stall notice, no decision.
    expect(h.events("error").filter((e) => e.data.kind === "funding_stalled")).toHaveLength(0);
    expect(h.events("decision_opened")).toHaveLength(0);
    expect(ap.usage().tusdMicro).toBe(20_000_000n);

    // Shown in Activity (funding group → kind "topup").
    const row = eventToRow(ev[1]!, new Map());
    expect(row).toMatchObject({ kind: "topup", status: "confirmed", txHash: txs[0]!.txHash, amountMicro: "20000000" });
    expect(row!.title).toMatch(/Treasury autopilot: 20 tUSD \+ 40 tADA t@example\.com → w@example\.com/);
  });

  it("an explicit approve that hits a shortfall (Sokosumi worker flow) also refills + funds with no further click", async () => {
    h = await setup();
    const w = await addWorker(h);
    const { ap } = wire(h, { lowTusdMicro: 0n, lowLovelace: 0n }); // periodic check alone would do nothing
    ap.start();
    const goalId = plannedGoal(h, w.id);
    // What POST /goals/:id/approve does on a shortfall: startGoal throws, the route emits `error` {where:"startPlan"}.
    await startGoal({ db: h.db, bus: h.bus, sessions: h.sessions }, goalId).catch((e: Error) => h!.bus.emit("error", { goalId, data: { where: "startPlan", message: e.message } }));
    await waitFor(() => h!.db.select().from(goals).where(eq(goals.id, goalId)).get()!.status === "running", 8_000, "goal running");
    const ids = h.sessions.list({ goalId }).map((s) => s.id);
    await waitFor(() => ids.length === 2 && ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 8_000, "sessions running");
    expect(refills(h, h.treasury)).toHaveLength(1);
    expect(h.events("error").filter((e) => e.data.kind === "funding_stalled")).toHaveLength(0);
  });

  it("over the 24 h cap → no refill, ONE escalation with the exact amount needed", async () => {
    h = await setup();
    const w = await addWorker(h);
    const { rec } = wire(h, { capTusdMicro: tusdToMicro("5") });
    const goalId = plannedGoal(h, w.id);
    await autoFundGoal({ db: h.db, bus: h.bus, sessions: h.sessions }, goalId);
    await rec.tick();
    await rec.tick();
    await rec.tick();
    expect(refills(h, h.treasury)).toHaveLength(0);
    const stalls = h.events("error").filter((e) => e.data.kind === "funding_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.goalId).toBe(goalId);
    expect(stalls[0]!.data).toMatchObject({ reason: "autopilot_blocked", autopilot: "cap", shortTusdMicro: "10000000", treasuryAddress: w.treasury });
    expect(String(stalls[0]!.data.error)).toMatch(/24 h standing cap.*needs 10 tUSD \+ 22\.2 tADA more.*send 10 tUSD \+ 22\.2 tADA to addr_test1/);
    // The goal path owns the escalation: no second, generic notice.
    expect(h.events("error").filter((e) => e.data.kind === "autopilot_funding_blocked")).toHaveLength(0);
    expect(h.events("decision_opened")).toHaveLength(0);
  });

  it("periodic low-water check: refills below low-water, trims to the cap, then says once that the cap is reached", async () => {
    h = await setup();
    const w = await addWorker(h);
    const { ap } = wire(h, { capTusdMicro: tusdToMicro("30") });
    expect((await ap.tick()).refilled).toEqual([w.id]);
    await waitFor(() => h!.events("treasury_refill").some((e) => e.data.status === "confirmed"), 5_000, "refill confirmed");
    expect(h.chain.balance(w.treasury).tusdMicro).toBe(20_000_000n);
    expect((await ap.tick()).refilled).toEqual([]); // above low-water: nothing to do
    // Spend it down below low-water: only 10 tUSD of cap left → trimmed refill of 10.
    h.chain.credit(w.treasury, -18_000_000n, 0n);
    await ap.tick();
    await waitFor(() => h!.events("treasury_refill").filter((e) => e.data.status === "confirmed").length === 2, 5_000, "2nd refill");
    expect(refills(h, h.treasury).map((t) => t.outputs[0]!.tusdMicro)).toEqual([20_000_000n, 10_000_000n]);
    // Cap exhausted: one notice, however often it checks.
    h.chain.credit(w.treasury, -12_000_000n, 0n);
    await ap.tick();
    await ap.tick();
    expect(refills(h, h.treasury)).toHaveLength(2);
    const blocked = h.events("error").filter((e) => e.data.kind === "autopilot_funding_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.data).toMatchObject({ reason: "cap", neededTusdMicro: "20000000", to: { userId: w.id } });
  });

  it("never refills a self-custody account and never draws from a self-custody source", async () => {
    h = await setup();
    const w = await addWorker(h, "self");
    const { ap, rec } = wire(h);
    expect(ap.covers({ id: w.id, email: WORKER, custody: "self" })).toBe(false);
    expect(await ap.ensure({ userId: w.id, needTusdMicro: 10_000_000n, reason: "test" })).toMatchObject({ status: "blocked", reason: "self_custody" });
    await ap.tick();
    // A self-custody goal still waits for the wallet (exact shortfall notice), nothing is sent behind its back.
    const goalId = plannedGoal(h, w.id);
    h.db.update(goals).set({ status: "approved" }).where(eq(goals.id, goalId)).run();
    await rec.tick();
    expect(String(h.events("error").find((e) => e.data.kind === "funding_stalled")!.data.reason)).toMatch(/^(insufficient_funds|awaiting_signature)$/);
    expect(h.chain.calls.fundSessions).toBe(0);

    // Custodial target, but the SOURCE is self-custody → refused.
    h.db.update(users).set({ custody: "custodial" }).where(eq(users.id, w.id)).run();
    h.db.update(users).set({ custody: "self" }).where(eq(users.id, h.userId)).run();
    expect(ap.covers({ id: w.id, email: WORKER, custody: "custodial" })).toBe(false);
    expect(await ap.ensure({ userId: w.id, needTusdMicro: 10_000_000n, reason: "test" })).toMatchObject({ status: "blocked", reason: "self_custody" });
    expect(h.chain.calls.fundSessions).toBe(0);
    expect(h.events("treasury_refill")).toHaveLength(0);
  });

  it("no double refill: concurrent triggers share the one pending refill", async () => {
    const chain = createFakeChain(); // manual confirmations
    h = await setup({ chain });
    const w = await addWorker(h);
    const { ap } = wire(h);
    const rs = await Promise.all([
      ap.ensure({ userId: w.id, needTusdMicro: 10_000_000n, reason: "a" }),
      ap.ensure({ userId: w.id, needTusdMicro: 12_000_000n, reason: "b" }),
      ap.tick(),
      ap.ensure({ userId: w.id, reason: "c" }),
    ]);
    expect(refills(h, h.treasury)).toHaveLength(1);
    const tx = refills(h, h.treasury)[0]!.txHash;
    expect(rs[0]).toEqual({ status: "pending", txHash: tx });
    expect(rs[1]).toEqual({ status: "pending", txHash: tx });
    chain.tick();
    await waitFor(() => h!.events("treasury_refill").some((e) => e.data.status === "confirmed"), 5_000, "confirmed");
    expect(await ap.ensure({ userId: w.id, needTusdMicro: 12_000_000n, reason: "d" })).toEqual({ status: "sufficient" });
    expect(refills(h, h.treasury)).toHaveLength(1);
  });

  it("restart-safe: a pending refill is resumed (not re-sent) and the cap usage survives", async () => {
    const chain = createFakeChain();
    h = await setup({ chain });
    const w = await addWorker(h);
    const first = wire(h, { capTusdMicro: tusdToMicro("30") });
    const r1 = await first.ap.ensure({ userId: w.id, needTusdMicro: 10_000_000n, reason: "before restart" });
    expect(r1.status).toBe("pending");
    first.ap.stop(); // "crash"
    first.rec.stop();

    const second = wire(h, { capTusdMicro: tusdToMicro("30") });
    second.ap.start();
    expect(await second.ap.ensure({ userId: w.id, needTusdMicro: 10_000_000n, reason: "after restart" })).toMatchObject({ status: "pending" });
    expect(refills(h, h.treasury)).toHaveLength(1);
    expect(second.ap.usage().tusdMicro).toBe(20_000_000n);
    chain.tick();
    await waitFor(() => h!.events("treasury_refill").filter((e) => e.data.status === "confirmed").length === 1, 5_000, "confirmed once");
    expect(h.db.select().from(kv).where(eq(kv.key, `treasury_autopilot:pending:${w.id}`)).get()).toBeUndefined();
    // The persisted usage still bounds the next refill: 10 left of 30.
    h.chain.credit(w.treasury, -20_000_000n, 0n);
    const r2 = await second.ap.ensure({ userId: w.id, needTusdMicro: 15_000_000n, reason: "needs more than the cap allows" });
    expect(r2).toMatchObject({ status: "blocked", reason: "cap", neededTusdMicro: 15_000_000n });
  });

  it("config from env: defaults (source = the user's account, targets = AUTO_FUND_USER_EMAILS) and overrides", () => {
    const d = treasuryAutopilotConfigFromEnv({}, ["sokosumi-coworker@bulkhead.local", "masumi-standard@bulkhead.local"]);
    expect(d).toMatchObject({ enabled: true, source: "zq@demo.bulkhead.local", targets: ["sokosumi-coworker@bulkhead.local", "masumi-standard@bulkhead.local"], lowTusdMicro: 5_000_000n, lowLovelace: 15_000_000n, refillTusdMicro: 20_000_000n, refillLovelace: 40_000_000n, capTusdMicro: 200_000_000n, capLovelace: 200_000_000n, checkMs: 60_000 });
    const o = treasuryAutopilotConfigFromEnv({ TREASURY_AUTOPILOT: "off", TREASURY_AUTOPILOT_SOURCE_USER: "u_abc", TREASURY_AUTOPILOT_TARGETS: "A@x.io, b@y.io", TREASURY_AUTOPILOT_CAP_TUSDM: "50.5", TREASURY_AUTOPILOT_REFILL_ADA: "bogus" });
    expect(o).toMatchObject({ enabled: false, source: "u_abc", targets: ["a@x.io", "b@y.io"], capTusdMicro: 50_500_000n, refillLovelace: 40_000_000n });
    expect(treasuryAutopilotConfigFromEnv({ TREASURY_AUTOPILOT_TARGETS: "none" }, ["x@y.z"]).targets).toEqual([]);
  });
});
