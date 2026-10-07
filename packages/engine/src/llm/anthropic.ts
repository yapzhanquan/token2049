// Anthropic implementation of the LLM contract.
//   orchestrator (captain + planner): claude-sonnet-5-5 — adaptive thinking (default on this model),
//     effort "medium", server-side refusal fallback ("default" routing).
//   subagent: claude-haiku-4-5 — plain Messages API.
// One call = one Messages request. The tool-use LOOP lives in the caller (captain.ts): it appends
// `raw` (the full assistant content, incl. thinking blocks) and the tool_result blocks, then calls again.
import Anthropic from "@anthropic-ai/sdk";
import type { LLM, LLMMessage, LLMResponse, LLMToolDef } from "../contracts";

export const ANTHROPIC_MODELS = {
  orchestrator: "claude-sonnet-5-5",
  subagent: "claude-haiku-4-5",
} as const;

export interface AnthropicLLMOptions {
  apiKey?: string;
  /** Inject a client (tests). */
  client?: Anthropic;
  models?: Partial<Record<"orchestrator" | "subagent", string>>;
  /** SDK-level retries for 408/409/429/5xx/connection errors (exponential backoff, honours retry-after). */
  maxRetries?: number;
  timeoutMs?: number;
}

export class AnthropicLLM implements LLM {
  readonly name = "anthropic" as const;
  private _calls = 0;
  private readonly client: Anthropic;
  readonly models: Record<"orchestrator" | "subagent", string>;

  constructor(opts: AnthropicLLMOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY, maxRetries: opts.maxRetries ?? 4, timeout: opts.timeoutMs ?? 120_000 });
    this.models = { ...ANTHROPIC_MODELS, ...opts.models };
  }

  get calls(): number {
    return this._calls;
  }

  async complete(args: {
    model: "orchestrator" | "subagent";
    system: string;
    messages: LLMMessage[];
    tools?: LLMToolDef[];
    maxTokens?: number;
  }): Promise<LLMResponse> {
    const model = this.models[args.model];
    const tools = args.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
    // Stable system prompt → cache it (tools render before system, so both are cached).
    const system = [{ type: "text" as const, text: args.system, cache_control: { type: "ephemeral" as const } }];

    let content: unknown[];
    let usage: { inputTokens: number; outputTokens: number };
    let stopReason: string;

    // Application-level retry on top of the SDK's retries: only for transient failures the SDK gave up on.
    const maxAttempts = 2;
    for (let attempt = 1; ; attempt++) {
      try {
        if (args.model === "orchestrator") {
          const res = await this.client.beta.messages.create({
            model,
            max_tokens: args.maxTokens ?? 16_000,
            system,
            messages: args.messages as Anthropic.Beta.BetaMessageParam[],
            ...(tools ? { tools: tools as Anthropic.Beta.BetaTool[] } : {}),
            output_config: { effort: "medium" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          });
          content = res.content as unknown[];
          usage = {
            inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
            outputTokens: res.usage.output_tokens,
          };
          stopReason = res.stop_reason ?? "end_turn";
        } else {
          const res = await this.client.messages.create({
            model,
            max_tokens: args.maxTokens ?? 8_000,
            system,
            messages: args.messages as Anthropic.MessageParam[],
            ...(tools ? { tools } : {}),
          });
          content = res.content as unknown[];
          usage = {
            inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
            outputTokens: res.usage.output_tokens,
          };
          stopReason = res.stop_reason ?? "end_turn";
        }
        break;
      } catch (err) {
        const transient =
          err instanceof Anthropic.RateLimitError ||
          err instanceof Anthropic.InternalServerError ||
          err instanceof Anthropic.APIConnectionError;
        if (!transient || attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    this._calls++;

    const text: string[] = [];
    const toolCalls: LLMResponse["toolCalls"] = [];
    if (stopReason !== "refusal") {
      for (const b of content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
        if (b.type === "text" && b.text) text.push(b.text);
        if (b.type === "tool_use" && b.id && b.name) toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
    }
    return { text: text.join("\n"), toolCalls, usage, stopReason, raw: content };
  }
}
