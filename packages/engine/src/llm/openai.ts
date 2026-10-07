// OpenAI implementation of the LLM contract, on the Responses API (function tools + reasoning;
// Chat Completions refuses tools together with reasoning on current models).
//   orchestrator (captain + planner): OPENAI_MODEL (default gpt-5.4), reasoning effort "medium".
//   subagent: OPENAI_SUBAGENT_MODEL (default gpt-5.6-luna), reasoning effort "low".
// Callers (captain.ts, silo/child.ts) build messages in the Anthropic block shape — text, tool_use,
// tool_result — so this provider translates that shape to Responses input items on the way in, and
// returns `raw` in the same block shape on the way out. Stateless (store: false): the caller resends
// the history each call, as with the Anthropic provider. The tool loop stays in the caller.
import OpenAI from "openai";
import type { LLM, LLMMessage, LLMResponse, LLMToolDef } from "../contracts";

export const OPENAI_MODELS = {
  orchestrator: "gpt-5.4",
  subagent: "gpt-5.6-luna",
} as const;

export interface OpenAILLMOptions {
  apiKey?: string;
  /** Inject a client (tests). */
  client?: OpenAI;
  models?: Partial<Record<"orchestrator" | "subagent", string>>;
  maxRetries?: number;
  timeoutMs?: number;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type InputItem = OpenAI.Responses.ResponseInputItem;

/** Anthropic-shaped messages → Responses API input items. */
export function toResponsesInput(messages: LLMMessage[]): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    for (const b of m.content as Block[]) {
      if (b.type === "text" && b.text) {
        out.push({ role: m.role, content: b.text });
      } else if (b.type === "tool_use" && b.id && b.name) {
        out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.is_error ? `ERROR: ${body}` : body });
      }
    }
  }
  return out;
}

export class OpenAILLM implements LLM {
  readonly name = "openai" as const;
  private _calls = 0;
  private readonly client: OpenAI;
  readonly models: Record<"orchestrator" | "subagent", string>;

  constructor(opts: OpenAILLMOptions = {}) {
    this.client =
      opts.client ??
      new OpenAI({ apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY, maxRetries: opts.maxRetries ?? 4, timeout: opts.timeoutMs ?? 120_000 });
    this.models = { ...OPENAI_MODELS, ...opts.models };
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
    const tools: OpenAI.Responses.FunctionTool[] | undefined = args.tools?.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false,
    }));
    const res = await this.client.responses.create({
      model: this.models[args.model],
      instructions: args.system,
      input: toResponsesInput(args.messages),
      ...(tools?.length ? { tools } : {}),
      max_output_tokens: args.maxTokens ?? (args.model === "orchestrator" ? 16_000 : 8_000),
      reasoning: { effort: args.model === "orchestrator" ? "medium" : "low" },
      store: false,
    });
    this._calls++;

    const text: string[] = [];
    const toolCalls: LLMResponse["toolCalls"] = [];
    let refused = false;
    for (const item of res.output) {
      if (item.type === "message") {
        for (const c of item.content) {
          if (c.type === "output_text") text.push(c.text);
          else if (c.type === "refusal") refused = true;
        }
      } else if (item.type === "function_call") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
        } catch {
          input = { _unparsed: item.arguments };
        }
        toolCalls.push({ id: item.call_id, name: item.name, input });
      }
    }
    const joined = refused ? "" : text.join("\n");
    // Hand back the turn in the block shape the callers append to their history.
    const raw: Block[] = [...(joined ? [{ type: "text", text: joined }] : []), ...toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input }))];
    const stopReason = refused
      ? "refusal"
      : toolCalls.length
        ? "tool_use"
        : res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn";
    return {
      text: joined,
      toolCalls: refused ? [] : toolCalls,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      stopReason,
      raw,
    };
  }
}
