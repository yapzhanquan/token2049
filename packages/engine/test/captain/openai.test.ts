import { describe, expect, it } from "vitest";
import { OpenAILLM, toResponsesInput } from "../../src/llm/openai";
import { createLLM, llmProvider } from "../../src/llm";
import { MockLLM } from "../../src/llm/mock";

describe("OpenAI provider (Responses API)", () => {
  it("translates the Anthropic block shape the captain and silos use", () => {
    const out = toResponsesInput([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "call_1", name: "read_status", input: { id: "all" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}' },
          { type: "tool_result", tool_use_id: "call_2", content: "denied", is_error: true },
          { type: "text", text: "continue" },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "checking" },
      { type: "function_call", call_id: "call_1", name: "read_status", arguments: '{"id":"all"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
      { type: "function_call_output", call_id: "call_2", output: "ERROR: denied" },
      { role: "user", content: "continue" },
    ]);
  });

  it("returns tool calls and raw blocks in the shape callers append back", async () => {
    const fake = {
      responses: {
        create: async (req: Record<string, unknown>) => {
          expect(req.model).toBe("gpt-5.6-luna");
          expect(req.reasoning).toEqual({ effort: "low" });
          expect(req.instructions).toBe("s");
          expect(req.store).toBe(false);
          return {
            status: "completed",
            output: [
              { type: "reasoning", id: "rs_1", summary: [] },
              { type: "function_call", call_id: "c1", name: "pay", arguments: '{"amount":"1"}' },
            ],
            usage: { input_tokens: 12, output_tokens: 5 },
          };
        },
      },
    };
    const llm = new OpenAILLM({ client: fake as never });
    const res = await llm.complete({ model: "subagent", system: "s", messages: [{ role: "user", content: "go" }], tools: [{ name: "pay", description: "d", input_schema: { type: "object" } }] });
    expect(res.toolCalls).toEqual([{ id: "c1", name: "pay", input: { amount: "1" } }]);
    expect(res.raw).toEqual([{ type: "tool_use", id: "c1", name: "pay", input: { amount: "1" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(llm.calls).toBe(1);
  });

  it("selects the provider from env: Anthropic, else OpenAI, else mock", () => {
    expect(llmProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toBe("anthropic");
    expect(llmProvider({ OPENAI_API_KEY: "o" })).toBe("openai");
    expect(llmProvider({})).toBe("mock");
    const llm = createLLM({ OPENAI_API_KEY: "o", OPENAI_SUBAGENT_MODEL: "x-mini" }) as OpenAILLM;
    expect(llm).toBeInstanceOf(OpenAILLM);
    expect(llm.models).toEqual({ orchestrator: "gpt-5.4", subagent: "x-mini" });
    expect(createLLM({})).toBeInstanceOf(MockLLM);
  });
});

import { normalizePlanShape, validatePlan } from "../../src/planner";

describe("planner normalisation for real models", () => {
  it("fixes format slips but keeps rule violations", () => {
    const raw = {
      sessions: [
        { name: "r", role: "Find and rank the top 3 Cardano DEXs by recent trading volume, with sources", agentType: "general-research", taskType: "research", allowWebFetch: true, goal: "g", budgetTUSD: "0.5", perPaymentMaxTUSD: "0.5", approvalThresholdTUSD: "0.5", allowedPayees: [], deadline: "2026-12-01T00:00:00Z", dataScope: "Public data from https://defillama.com/chain/Cardano and taptools.io only.", contextFrom: [] },
      ],
    };
    const n = normalizePlanShape(raw) as { sessions: Record<string, unknown>[] };
    expect((n.sessions[0].role as string).length).toBeLessThanOrEqual(40);
    expect(n.sessions[0].agentType).toBe("generic");
    expect(n.sessions[0].dataScope).toEqual(["https://defillama.com/chain/Cardano", "taptools.io"]);
    const ok = validatePlan(JSON.stringify(raw), { totalMicro: 5_000_000n, deadlineMs: Date.parse("2026-12-02T00:00:00Z"), catalog: [] });
    expect(ok.ok).toBe(true);
    const over = validatePlan(JSON.stringify({ sessions: [{ ...raw.sessions[0], budgetTUSD: "9" }] }), { totalMicro: 5_000_000n, deadlineMs: Date.parse("2026-12-02T00:00:00Z"), catalog: [] });
    expect(over.ok).toBe(false);
  });
});
