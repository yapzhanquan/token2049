// Planner: independent sub-tasks run in parallel (only true data dependencies wait), and task types follow the goal
// (a goal that asks to hire / pay gets a session that can spend).
import { afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@bulkhead/db";
import type { Plan } from "@bulkhead/shared";
import type { LLM, LLMResponse } from "../../src/contracts";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner, goalWantsSpend, parallelizePlan } from "../../src/planner";
import { harness, seedUser } from "./helpers";

afterEach(() => closeDb());

const deadline = () => new Date(Date.now() + 2 * 3600_000).toISOString();

function scripted(outputs: string[]): LLM & { prompts: string[]; calls: number } {
  const prompts: string[] = [];
  const llm = {
    name: "mock" as const,
    prompts,
    calls: 0,
    async complete(args: { messages: unknown[] }): Promise<LLMResponse> {
      prompts.push(JSON.stringify(args.messages));
      const text = outputs[Math.min(llm.calls, outputs.length - 1)]!;
      llm.calls++;
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  };
  return llm;
}

const base = (over: Record<string, unknown>) => ({
  role: "researcher",
  agentType: "researcher",
  taskType: "research",
  allowWebFetch: false,
  budgetTUSD: "0.3",
  perPaymentMaxTUSD: "0.3",
  approvalThresholdTUSD: "0.3",
  allowedPayees: [],
  deadline: deadline(),
  dataScope: ["https://docs.example.com"],
  contextFrom: [],
  ...over,
});

describe("planner: parallel first", () => {
  it("unchains independent research sessions; the synthesis session gets every handback it needs", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    // What models produced live: a linear chain A → B → C although A and B are independent.
    const chain = {
      sessions: [
        base({ name: "Blockfrost free tier", goal: "Research Blockfrost preprod free-tier rate limits" }),
        base({ name: "Koios free tier", goal: "Research Koios preprod free-tier rate limits", contextFrom: [0], parent: 0 }),
        base({ name: "Recommend an API", role: "summariser", agentType: "summariser", goal: "Recommend Blockfrost or Koios for a small dApp backend", contextFrom: [1] }),
      ],
    };
    const llm = scripted([JSON.stringify(chain)]);
    const r = await createPlanner({ llm, market: h.market, chain: h.chain, db: h.db }).plan({
      userId,
      goal: "Compare Blockfrost and Koios free tiers and recommend one",
      budgetTUSD: "1",
      deadline: deadline(),
      rules: "",
    });
    const deps = r.plan.sessions.map((s) => s.contextFrom);
    expect(deps).toEqual([[], [], [0, 1]]);
    expect(r.plan.sessions[1].parent).toBeUndefined();
    expect(r.plan.sessions.filter((s) => s.contextFrom.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(r.planNotes?.join(" ")).toMatch(/runs in parallel/);
    // The prompt itself asks for parallel, per-subject sessions.
    expect(llm.prompts[0]).toBeDefined();
  });

  it("MockLLM (no API key) plans a multi-part goal with >= 2 sessions that start at once", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const { plan } = await createPlanner({ llm: new MockLLM(), market: h.market, chain: h.chain, db: h.db }).plan({
      userId,
      goal: "Research competitors and hire a market-research agent, then buy a summary",
      budgetTUSD: "10",
      deadline: deadline(),
      rules: "",
    });
    const independent = plan.sessions.filter((s) => s.contextFrom.length === 0);
    expect(independent.length).toBeGreaterThanOrEqual(2);
    expect(plan.sessions.some((s) => s.taskType === "hire_agent" || s.taskType === "buy_pay")).toBe(true);
  });

  it("keeps true data dependencies: a payment session waits for the research it pays on", () => {
    const plan = {
      sessions: [base({ name: "Find vendor", goal: "Find the cheapest vendor" }), base({ name: "Pay vendor", role: "buyer", agentType: "buyer", taskType: "buy_pay", goal: "Pay the vendor found", contextFrom: [0] })],
    } as unknown as Plan;
    expect(parallelizePlan(plan)).toEqual([]);
    expect(plan.sessions[1].contextFrom).toEqual([0]);
  });
});

describe("planner: task types follow the goal", () => {
  it("a goal that asks to hire an agent but gets a research-only plan is repaired once to include a spender", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const researchOnly = { sessions: [base({ name: "Research", goal: "Research the market" })] };
    const fixed = {
      sessions: [
        base({ name: "Research", goal: "Research the market" }),
        base({
          name: "Hire market research",
          role: "hirer",
          agentType: "generic",
          taskType: "hire_agent",
          dataScope: [],
          goal: "Hire the market-research agent",
          budgetTUSD: "2.5",
          perPaymentMaxTUSD: "2",
          approvalThresholdTUSD: "2",
          allowedPayees: ["market-research"],
        }),
      ],
    };
    const llm = scripted([JSON.stringify(researchOnly), JSON.stringify(fixed)]);
    const { plan } = await createPlanner({ llm, market: h.market, chain: h.chain, db: h.db }).plan({
      userId,
      goal: "Hire a market research agent to size the Malaysian coffee market",
      budgetTUSD: "5",
      deadline: deadline(),
      rules: "Spend only what the goal needs.",
    });
    expect(llm.calls).toBe(2);
    expect(llm.prompts[1]).toMatch(/no session can spend/);
    expect(plan.sessions.map((s) => s.taskType)).toEqual(["research", "hire_agent"]);
  });

  it("goalWantsSpend reads the goal, not the generic spending rules", () => {
    expect(goalWantsSpend("Hire an agent to summarise this")).toBe(true);
    expect(goalWantsSpend("Buy two API keys and pay the vendor")).toBe(true);
    expect(goalWantsSpend("Compare Blockfrost and Koios free tiers")).toBe(false);
  });
});
