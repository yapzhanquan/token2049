import type { LLM } from "../contracts";
import { AnthropicLLM, ANTHROPIC_MODELS } from "./anthropic";
import { OpenAILLM, OPENAI_MODELS } from "./openai";
import { MockLLM } from "./mock";

export { AnthropicLLM, ANTHROPIC_MODELS, OpenAILLM, OPENAI_MODELS, MockLLM };

/** Which real provider the env selects, if any. Anthropic wins when both keys are set. */
export function llmProvider(env: NodeJS.ProcessEnv = process.env): "anthropic" | "openai" | "mock" {
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "mock";
}

/** Anthropic or OpenAI when its key is set, otherwise the deterministic MockLLM. */
export function createLLM(env: NodeJS.ProcessEnv = process.env): LLM {
  switch (llmProvider(env)) {
    case "anthropic":
      return new AnthropicLLM({ apiKey: env.ANTHROPIC_API_KEY });
    case "openai":
      return new OpenAILLM({
        apiKey: env.OPENAI_API_KEY,
        models: {
          ...(env.OPENAI_MODEL ? { orchestrator: env.OPENAI_MODEL } : {}),
          ...(env.OPENAI_SUBAGENT_MODEL ? { subagent: env.OPENAI_SUBAGENT_MODEL } : {}),
        },
      });
    default:
      return new MockLLM();
  }
}

/** Model label for the Agent Map captain card. */
export function modelLabel(llm: LLM, which: "orchestrator" | "subagent" = "orchestrator"): string {
  if (llm instanceof AnthropicLLM || llm instanceof OpenAILLM) return llm.models[which];
  return `mock (${ANTHROPIC_MODELS[which]} offline stand-in)`;
}
