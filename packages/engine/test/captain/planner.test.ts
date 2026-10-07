import { afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@bulkhead/db";
import { tusdToMicro } from "@bulkhead/shared";
import type { LLM, LLMResponse } from "../../src/contracts";
import { MockLLM, mockPlan } from "../../src/llm/mock";
import { createPlanner, PlanError, validatePlan } from "../../src/planner";
import { CaptainAgent } from "../../src/captain/captain";
import { CATALOG, harness, seedUser } from "./helpers";

afterEach(() => closeDb());

const deadline = () => new Date(Date.now() + 2 * 3600_000).toISOString();

function scripted(outputs: string[]): LLM & { prompts: string[] } {
  let calls = 0;
  const prompts: string[] = [];
  return {
    name: "mock",
    prompts,
    get calls() {
      return calls;
    },
    async complete(args): Promise<LLMResponse> {
      prompts.push(JSON.stringify(args.messages));
      const text = outputs[Math.min(calls, outputs.length - 1)];
      calls++;
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  };
}

describe("planner", () => {
  it("MockLLM plans 'Research competitors' as research + hire_agent + buy_pay with catalog payees validated", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const llm = new MockLLM();
    const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
    const { plan, fundingPreview, payeeLabels } = await planner.plan({ userId, goal: "Research competitors for my coffee shop", budgetTUSD: "12", deadline: deadline(), rules: "" });
    expect(plan.sessions.map((s) => s.taskType)).toEqual(["research", "hire_agent", "buy_pay"]);
    expect(plan.sessions[1].allowedPayees).toEqual([CATALOG[0].id]);
    expect(plan.sessions[2].allowedPayees).toEqual([CATALOG[1].id]);
    expect(plan.sessions[2].contextFrom).toEqual([0]);
    expect(payeeLabels[CATALOG[0].id]).toBe("Market Research");
    const sum = plan.sessions.reduce((s, x) => s + tusdToMicro(x.budgetTUSD), 0n);
    expect(sum).toBeLessThanOrEqual(tusdToMicro("12"));
    expect(tusdToMicro(plan.sessions[1].perPaymentMaxTUSD)).toBe(tusdToMicro(CATALOG[0].priceTUSD));
    expect(fundingPreview.totalTusd).toBe("12");
    expect(fundingPreview.error).toBeUndefined();
    expect(llm.calls).toBe(1);
  });

  it("repairs invalid LLM JSON once", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const good = JSON.stringify(mockPlan({ goal: "x", budgetTUSD: "10", deadline: deadline() }, CATALOG));
    const llm = scripted(["Sure! Here is a plan: {not json", good]);
    const { plan } = await createPlanner({ llm, market: h.market, chain: h.chain, db: h.db }).plan({ userId, goal: "x", budgetTUSD: "10", deadline: deadline(), rules: "" });
    expect(plan.sessions).toHaveLength(3);
    expect(llm.calls).toBe(2);
    expect(llm.prompts[1]).toMatch(/That plan is invalid/);
  });

  it("feeds business-rule violations (over budget, unknown payee) back for repair, and gives up after one retry", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const bad = mockPlan({ goal: "x", budgetTUSD: "50", deadline: deadline() }, CATALOG); // budgets total 50 > 10
    bad.sessions[2].allowedPayees = ["evil-agent"];
    const llm = scripted([JSON.stringify(bad)]);
    const p = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db }).plan({ userId, goal: "x", budgetTUSD: "10", deadline: deadline(), rules: "" });
    await expect(p).rejects.toBeInstanceOf(PlanError);
    expect(llm.calls).toBe(2);
    expect(llm.prompts[1]).toMatch(/above the goal budget/);
    expect(llm.prompts[1]).toMatch(/evil-agent/);
  });

  it("validatePlan: schema errors, ordering of contextFrom, deadline clamp", () => {
    const ctx = { totalMicro: tusdToMicro("10"), deadlineMs: Date.now() + 3600_000, catalog: CATALOG };
    expect(validatePlan("{}", ctx).ok).toBe(false);
    const plan = mockPlan({ goal: "x", budgetTUSD: "10", deadline: new Date(Date.now() + 99 * 3600_000).toISOString() }, CATALOG);
    const r = validatePlan(JSON.stringify(plan), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Date.parse(r.plan.sessions[0].deadline)).toBeLessThanOrEqual(ctx.deadlineMs);
    plan.sessions[0].contextFrom = [2];
    const r2 = validatePlan("```json\n" + JSON.stringify(plan) + "\n```", ctx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.join()).toMatch(/earlier sessions/);
  });

  it("validatePlan clamps approvalThresholdTUSD to the session budget; the prompt defaults it to perPaymentMaxTUSD", async () => {
    const ctx = { totalMicro: tusdToMicro("10"), deadlineMs: Date.now() + 3600_000, catalog: CATALOG };
    const plan = mockPlan({ goal: "x", budgetTUSD: "10", deadline: deadline() }, CATALOG);
    plan.sessions[1].approvalThresholdTUSD = "999";
    const r = validatePlan(JSON.stringify(plan), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.sessions[1].approvalThresholdTUSD).toBe(r.plan.sessions[1].budgetTUSD);
    for (const s of mockPlan({ goal: "x", budgetTUSD: "10", deadline: deadline() }, CATALOG).sessions) expect(s.approvalThresholdTUSD).toBe(s.perPaymentMaxTUSD);
    const { PLANNER_SYSTEM } = await import("../../src/planner");
    expect(PLANNER_SYSTEM).toMatch(/Default approvalThresholdTUSD = perPaymentMaxTUSD/);
  });

  it("Captain.plan stores a planned goal and emits goal_created + plan_proposed", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const llm = new MockLLM();
    const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
    const captain = new CaptainAgent({ ...h, llm, planner });
    const r = await captain.plan({ userId, goal: "Research competitors", budgetTUSD: "10", deadline: deadline(), rules: "" });
    const types = h.bus.since(0).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["goal_created", "plan_proposed"]));
    expect(r.goalId).toMatch(/^g_/);
  });
});
