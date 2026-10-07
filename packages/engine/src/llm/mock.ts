// Deterministic MockLLM (no API key needed). It reads the same prompts the real model gets:
//   - planner prompts carry <planning_request>{…}</planning_request> and <catalog>[…]</catalog>
//   - captain wakes carry <wake>{…}</wake> and <state_json>{…}</state_json>
// and answers with a valid Plan JSON or a short scripted sequence of captain tool calls.
// `calls` counts completed calls: the wake-filter test asserts routine events never increase it.
import { microToTusd, tusdToMicro, type AgentCatalogEntry } from "@bulkhead/shared";
import type { LLM, LLMMessage, LLMResponse, LLMToolDef } from "../contracts";

type ToolCall = LLMResponse["toolCalls"][number];

export interface MockCallRecord {
  model: "orchestrator" | "subagent";
  kind: "plan" | "wake" | "subagent" | "other";
  toolCalls: string[];
}

const TERMINAL = ["CLOSED", "CLOSING", "FAILED", "KILLED", "EXPIRED"];

export class MockLLM implements LLM {
  readonly name = "mock" as const;
  calls = 0;
  readonly history: MockCallRecord[] = [];
  private seq = 0;

  async complete(args: { model: "orchestrator" | "subagent"; system: string; messages: LLMMessage[]; tools?: LLMToolDef[]; maxTokens?: number }): Promise<LLMResponse> {
    const first = textOf(args.messages[0]);
    let res: LLMResponse;
    let kind: MockCallRecord["kind"] = "other";
    if (/<(report|bearings|ahoy)_facts>/.test(first)) {
      // Captain wording (wording.ts): re-word the deterministic draft. The mock keeps the draft's facts verbatim.
      const draft = /\nDraft: (.*)\n/.exec(first)?.[1] ?? "";
      res = this.reply(draft.trim(), []);
    } else if (args.model === "subagent") {
      kind = "subagent";
      res = this.reply("Working on it.", []);
    } else if (first.includes("<planning_request>")) {
      kind = "plan";
      res = this.reply(JSON.stringify(mockPlan(extract(first, "planning_request"), extract(first, "catalog") ?? [])), []);
    } else if (first.includes("<wake>")) {
      kind = "wake";
      res = this.reply(...this.wakeStep(args.messages));
    } else {
      res = this.reply("OK.", []);
    }
    res.usage = { inputTokens: Math.ceil((args.system.length + JSON.stringify(args.messages).length) / 4), outputTokens: Math.ceil((res.text.length + JSON.stringify(res.toolCalls).length) / 4) };
    this.calls++;
    this.history.push({ model: args.model, kind, toolCalls: res.toolCalls.map((t) => t.name) });
    return res;
  }

  private reply(text: string, calls: Omit<ToolCall, "id">[]): LLMResponse {
    const toolCalls = calls.map((c) => ({ ...c, id: `toolu_mock_${++this.seq}` }));
    return { text, toolCalls, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: toolCalls.length ? "tool_use" : "end_turn" };
  }

  /** Scripted captain behaviour, step = number of assistant turns so far in this wake. */
  private wakeStep(messages: LLMMessage[]): [string, Omit<ToolCall, "id">[]] {
    const first = textOf(messages[0]);
    type Ev = { type: string; sessionId?: string; goalId?: string; data: Record<string, unknown> };
    const wake = extract(first, "wake") as { trigger: Ev; coalesced?: Ev[] } | null;
    const state = (extract(first, "state_json") ?? {}) as MockState;
    const step = messages.filter((m) => m.role === "assistant").length;
    if (!wake) return ["Nothing to do.", []];
    const t = wake.trigger;
    const sessions = state.sessions ?? [];
    const s = sessions.find((x) => x.id === t.sessionId);
    const label = s ? `${s.letter} (${s.role})` : (t.sessionId ?? "the crew");
    const report = (text: string) => ({ name: "report_to_user", input: { text } });

    switch (t.type) {
      case "handback_submitted": {
        // Handle every handback in this (possibly coalesced) wake.
        const ids = [t, ...(wake.coalesced ?? [])].filter((x) => x.type === "handback_submitted" && x.sessionId).map((x) => x.sessionId!);
        const uniq = [...new Set(ids)];
        if (step === 0) return ["Reading the handbacks.", uniq.map((id) => ({ name: "read_status", input: { sessionId: id } }))];
        if (step === 1) {
          const calls: Omit<ToolCall, "id">[] = [];
          for (const id of uniq) {
            const src = sessions.find((x) => x.id === id);
            const lbl = src ? `${src.letter} (${src.role})` : id;
            const review = state.handbackReviews?.[id];
            if (review && !review.accepted) {
              calls.push(report(`Session ${lbl}'s handback did not meet its definition of done (${review.reason ?? "incomplete"}).`));
              continue;
            }
            const idx = sessions.findIndex((x) => x.id === id);
            const open = (x: (typeof sessions)[number]) => !TERMINAL.includes(x.status) && x.status !== "COMPLETING" && !uniq.includes(x.id);
            const next = sessions.find((x) => open(x) && (x.contextFrom ?? []).includes(idx)) ?? sessions.find((x, i) => i > idx && open(x));
            if (next && src) calls.push({ name: "pass_handback", input: { fromSessionId: src.id, toSessionId: next.id } });
            calls.push(report(`Session ${lbl} handed back${next ? `; passing its handback to ${next.letter} (${next.role})` : ""}.`));
          }
          return ["Passing the handbacks on.", calls];
        }
        return ["Done.", []];
      }
      case "payment_rejected":
        return step === 0 ? ["", [report(`Session ${label}: payment rejected (${String(t.data.reason ?? "policy")}). No funds moved.`)]] : ["Done.", []];
      case "decision_opened":
        return step === 0
          ? ["", [report(`Approval needed for session ${label}: ${String(t.data.kind ?? "decision")}. Open the Decisions list to approve or reject.`)]]
          : ["Done.", []];
      case "decision_closed":
        return step === 0 ? ["", [report(`Decision for session ${label} was ${String(t.data.status ?? "closed")}.`)]] : ["Done.", []];
      case "heartbeat_missed":
      case "session_transition":
        if (step === 0 && t.sessionId) return ["Checking the session.", [{ name: "read_status", input: { sessionId: t.sessionId } }]];
        if (step <= 1)
          return ["", [report(t.type === "heartbeat_missed" ? `Session ${label} went quiet (missed heartbeats).` : `Session ${label} is now ${String(t.data.to)}.`)]];
        return ["Done.", []];
      case "session_looping":
      case "session_stalled": {
        // Act on every stuck session in this wake: redirect (escalation 1-2), kill at 3+.
        if (step > 0) return ["Done.", []];
        const stuck = [t, ...(wake.coalesced ?? [])].filter((x) => (x.type === "session_looping" || x.type === "session_stalled") && x.sessionId);
        const calls: Omit<ToolCall, "id">[] = [];
        for (const x of stuck) {
          if (calls.some((c) => c.input.sessionId === x.sessionId)) continue;
          const esc = Number(x.data.escalation ?? 1);
          if (esc >= 3) calls.push({ name: "kill_session", input: { sessionId: x.sessionId!, reason: "stuck after repeated redirects" } });
          else
            calls.push({
              name: "message_session",
              input: { sessionId: x.sessionId!, text: esc >= 2 ? "Wrap up now: submit_handback with what you have." : `Change approach: ${String(x.data.hint ?? "stop retrying failing calls")}` },
            });
        }
        return ["Redirecting the stuck session(s).", calls];
      }
      case "goal_completed": {
        if (step > 0) return ["Done.", []];
        const met = sessions.filter((x) => x.closeStatus === "COMPLETED").length;
        const secs = Number(t.data.workSeconds ?? 0);
        const boxed = t.data.timeBoxed === true ? ` Time-boxed to ${secs ? `${secs} s` : "the work time"} of work; partial results are marked.` : "";
        return ["", [report(`Goal complete: ${met}/${sessions.length} session(s) met their definition of done.${boxed}`)]];
      }
      case "work_deadline_reached":
        // The watchdog already collected the partial handback and closes the session: nothing to do, no replacement.
        return ["Work time is up for that session; its partial handback is collected and it is closing.", []];
      case "tainted":
        return step === 0 ? ["", [report(`Session ${label} read untrusted web content; its spending now needs your approval.`)]] : ["Done.", []];
      case "deposit_seen":
      case "topup_confirmed":
        return step === 0 ? ["", [report("Top-up confirmed on-chain; your treasury balance is updated.")]] : ["Done.", []];
      case "deadline_near":
        return step === 0 ? ["", [report(`Session ${label} is close to its deadline.`)]] : ["Done.", []];
      case "user_message":
        return userMessageStep(String(t.data.text ?? ""), sessions, step, messages);
      default:
        return step === 0 ? ["", [report(`Noted: ${t.type}.`)]] : ["Done.", []];
    }
  }
}

interface MockState {
  handbackReviews?: Record<string, { accepted: boolean; reason?: string }>;
  sessions?: { id: string; letter: string; role: string; status: string; contextFrom?: number[]; closeStatus?: string | null }[];
}

function userMessageStep(text: string, sessions: NonNullable<MockState["sessions"]>, step: number, messages: LLMMessage[]): [string, Omit<ToolCall, "id">[]] {
  if (step > 0) {
    if (/\bstatus\b/i.test(text) && step === 1) {
      const last = messages[messages.length - 1];
      const summary = Array.isArray(last.content) ? String((last.content[0] as { content?: string })?.content ?? "").slice(0, 400) : "";
      return ["", [{ name: "report_to_user", input: { text: `Status: ${summary || "see the tree"}` } }]];
    }
    return ["Done.", []];
  }
  const m = /^\s*(?:tell|ask|message)\s+(?:session\s+)?([A-Z])\b[\s:,-]*(.+)$/is.exec(text);
  if (m) return ["", [{ name: "message_session", input: { sessionId: m[1].toUpperCase(), text: m[2].trim() } }]];
  const p = /\b(pause|resume|kill)\s+(?:session\s+)?([A-Z])\b/i.exec(text);
  if (p) {
    const tool = `${p[1].toLowerCase()}_session`;
    return ["", [{ name: tool, input: { sessionId: p[2].toUpperCase(), ...(tool === "kill_session" ? { reason: "user asked" } : {}) } }]];
  }
  if (/\bstatus\b/i.test(text)) return ["", [{ name: "read_status", input: { sessionId: "all" } }]];
  const running = sessions.filter((s) => !TERMINAL.includes(s.status)).length;
  return ["", [{ name: "report_to_user", input: { text: `Noted. ${running} session(s) are active; I'll keep you posted.` } }]];
}

/** A valid 3-session plan: research → hire_agent (market-research) → buy_pay (summariser), with A's handback to C. */
export function mockPlan(req: { goal?: string; budgetTUSD?: string; deadline?: string; rules?: string } | null, catalog: AgentCatalogEntry[]) {
  const goal = (req?.goal ?? "Research competitors").slice(0, 400);
  const total = safeMicro(req?.budgetTUSD ?? "10");
  const deadline = req?.deadline && !Number.isNaN(Date.parse(req.deadline)) ? new Date(req.deadline).toISOString() : new Date(Date.now() + 3600_000).toISOString();
  const pick = (re: RegExp) => catalog.find((a) => re.test(a.id) || re.test(a.name) || a.skills.some((s) => re.test(s)));
  const researcher = pick(/research/i) ?? catalog[0];
  const summariser = pick(/summar/i) ?? catalog.find((a) => a !== researcher) ?? researcher;

  const a = (total * 10n) / 100n;
  const b = (total * 45n) / 100n;
  const c = total - a - b;
  const capPer = (budget: bigint, agent?: AgentCatalogEntry) => {
    if (!agent) return budget;
    const price = safeMicro(agent.priceTUSD);
    return price > 0n && price <= budget ? price : budget;
  };
  const t = microToTusd;
  return {
    rationale: "Desk research and the agent hire start at once; the summary purchase waits for the research because it pays based on those findings.",
    sessions: [
      {
        name: "Desk research",
        role: "researcher",
        agentType: "researcher",
        taskType: "research",
        allowWebFetch: false,
        goal: `Collect public sources for: ${goal}`.slice(0, 500),
        budgetTUSD: t(a > 0n ? a : 1n),
        perPaymentMaxTUSD: t(a > 0n ? a : 1n),
        approvalThresholdTUSD: t(a > 0n ? a : 1n),
        allowedPayees: [],
        deadline,
        // Public pages the research silo may fetch (its egress allowlist). Override with
        // MOCK_RESEARCH_SOURCES (comma-separated URLs).
        dataScope: researchSources(),
        contextFrom: [],
      },
      {
        name: "Hire market research",
        role: "hirer",
        agentType: "generic",
        taskType: "hire_agent",
        allowWebFetch: false,
        goal: `Hire ${researcher?.name ?? "a market-research agent"} for: ${goal}`.slice(0, 500),
        budgetTUSD: t(b),
        perPaymentMaxTUSD: t(capPer(b, researcher)),
        approvalThresholdTUSD: t(capPer(b, researcher)), // default: = per-payment max (in-policy payments run without clicks)
        allowedPayees: researcher ? [researcher.id] : [],
        deadline,
        dataScope: [],
        contextFrom: [],
      },
      {
        name: "Buy summary",
        role: "buyer",
        agentType: "buyer",
        taskType: "buy_pay",
        allowWebFetch: false,
        goal: `Pay ${summariser?.name ?? "the summariser"} to turn the findings into a brief for: ${goal}`.slice(0, 500),
        budgetTUSD: t(c),
        perPaymentMaxTUSD: t(capPer(c, summariser)),
        approvalThresholdTUSD: t(capPer(c, summariser)),
        allowedPayees: summariser ? [summariser.id] : [],
        deadline,
        dataScope: [],
        contextFrom: [0],
      },
    ],
  };
}

function researchSources(): string[] {
  const fromEnv = process.env.MOCK_RESEARCH_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv?.length ? fromEnv : ["https://developers.cardano.org/docs/developers/curriculum/fundamentals/core-concepts/addresses/", "https://cips.cardano.org/"];
}

function safeMicro(v: string): bigint {
  try {
    return tusdToMicro(v);
  } catch {
    return 10_000_000n;
  }
}

function textOf(m: LLMMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
}

function extract(text: string, tag: string): any {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
