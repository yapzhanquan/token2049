// Firstmate-style autonomy: the zero-token watcher absorbs routine noise (plain `tainted`, progress), the
// deterministic watchdog turns "not moving" into actionable events (session_looping / session_stalled /
// goal_completed), and the captain ACTS on them with its tools (message_session, kill_session, report_to_user) —
// with a deterministic fallback when the model only observes.
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, goals, sessions as sessionsT } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import { CaptainAgent } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner } from "../../src/planner";
import type { LLM, LLMResponse } from "../../src/contracts";
import { harness, seedGoal, seedUser } from "./helpers";

/** An LLM that is woken but never acts (the failure mode seen live: "No action needed."). */
class SilentLLM implements LLM {
  readonly name = "mock" as const;
  calls = 0;
  async complete(): Promise<LLMResponse> {
    this.calls++;
    return { text: "No action needed.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

function setup(opts: { llm?: LLM; stallMs?: number; stallCheckMs?: number } = {}) {
  const h = harness();
  const llm = opts.llm ?? new MockLLM();
  const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
  const captain = new CaptainAgent({ ...h, llm, planner });
  const filter = new WakeFilter(
    { bus: h.bus, captain, db: h.db, sessions: h.sessions },
    { debounceMs: 5, absorbFlushMs: 10_000, watchdog: { loopFailures: 4, stallMs: opts.stallMs ?? 60_000 }, stallCheckMs: opts.stallCheckMs ?? 60_000 },
  );
  filter.start({ replay: false });
  const userId = seedUser(h.db);
  const goalId = seedGoal(h.db, userId);
  const a = h.sessions.insert(goalId, userId, { name: "Blockfrost limits", role: "researcher", taskType: "research" });
  const b = h.sessions.insert(goalId, userId, { name: "Koios limits", role: "researcher", taskType: "research" });
  return { ...h, llm, captain, filter, userId, goalId, a, b };
}

const of = (h: ReturnType<typeof setup>, type: string) => h.bus.since(0).filter((e) => e.type === type);
const calls = (llm: LLM) => (llm as unknown as { calls: number }).calls;

afterEach(() => closeDb());

describe("wake filter: tainted / progress are routine", () => {
  it("absorbs plain tainted + web_fetch + progress (no LLM call), wakes only on a quarantine", async () => {
    const h = setup();
    for (let i = 0; i < 12; i++) {
      h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: `https://docs.example.com/p${i}`, status: 200 } });
      h.bus.emit("tainted", { goalId: h.goalId, sessionId: h.a, data: { url: `https://docs.example.com/p${i}`, reason: "read external content", quarantine: false } });
      h.bus.emit("progress", { goalId: h.goalId, sessionId: h.a, data: { text: `read page ${i}` } });
    }
    await h.filter.idle();
    expect(calls(h.llm)).toBe(0);
    expect(of(h, "captain_woken")).toHaveLength(0);

    h.bus.emit("tainted", { goalId: h.goalId, sessionId: h.a, data: { url: "https://evil.example.com", reason: "prompt injection", quarantine: true } });
    await h.filter.idle();
    expect(of(h, "captain_woken")).toHaveLength(1);
    expect(of(h, "captain_woken")[0].data.trigger).toBe("tainted");
  });

  it("a session closing is routine; an approved decision is routine; a rejected one wakes", async () => {
    const h = setup();
    h.bus.emit("decision_closed", { goalId: h.goalId, sessionId: h.a, data: { kind: "payment_approval", status: "approved" } });
    await h.filter.idle();
    expect(calls(h.llm)).toBe(0);
    h.bus.emit("decision_closed", { goalId: h.goalId, sessionId: h.a, data: { kind: "payment_approval", status: "rejected" } });
    await h.filter.idle();
    expect(of(h, "captain_woken")).toHaveLength(1);
  });
});

describe("watchdog → captain acts", () => {
  it("N consecutive 404s → session_looping → the captain redirects that session with message_session", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: `https://docs.blockfrost.io/guess-${i}`, status: 404 } });
    await h.filter.idle();
    expect(calls(h.llm)).toBe(0); // below the threshold: still routine
    h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: "https://docs.blockfrost.io/guess-3", status: 404 } });
    await h.filter.idle();

    const loop = of(h, "session_looping");
    expect(loop).toHaveLength(1);
    expect(loop[0].sessionId).toBe(h.a);
    expect(loop[0].data.escalation).toBe(1);
    expect((loop[0].data.recent as string[]).every((r) => r.startsWith("HTTP 404"))).toBe(true);
    expect(of(h, "captain_woken")[0].data.trigger).toBe("session_looping");
    expect(h.sessions.calls).toContain(`message:${h.a}`);
    expect(h.sessions.calls).not.toContain(`message:${h.b}`);
    const msg = of(h, "session_message")[0];
    expect(msg.data.from).toBe("captain");
    expect(String(msg.data.text)).toMatch(/Change approach/);
    const action = of(h, "captain_action").find((e) => e.data.tool === "message_session")!;
    expect(action.data.auto).toBeUndefined(); // the model acted, not the fallback
  });

  it("a success in between resets the counter (a few 404s while researching are normal)", async () => {
    const h = setup();
    for (let i = 0; i < 9; i++) {
      const ok = i % 3 === 2;
      h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: `https://koios.rest/p${i}`, status: ok ? 200 : 404 } });
    }
    await h.filter.idle();
    expect(of(h, "session_looping")).toHaveLength(0);
    expect(calls(h.llm)).toBe(0);
  });

  it("escalation ladder: 2nd loop → wrap-up message, 3rd → kill_session", async () => {
    const h = setup();
    const burst = (tag: string) => {
      for (let i = 0; i < 4; i++) h.bus.emit("tool_denied", { goalId: h.goalId, sessionId: h.a, data: { tool: "pay", taskType: "research", tag } });
    };
    burst("1");
    await h.filter.idle();
    // The redirect resets the failure counter, the escalation level stays until real progress.
    burst("2");
    await h.filter.idle();
    burst("3");
    await h.filter.idle();
    const levels = of(h, "session_looping").map((e) => e.data.escalation);
    expect(levels).toEqual([1, 2, 3]);
    const texts = of(h, "session_message").map((e) => String(e.data.text));
    expect(texts[1]).toMatch(/Wrap up now/);
    expect(h.sessions.calls).toContain(`kill:${h.a}`);
  });

  it("a RUNNING session with no activity → session_stalled → redirected; a monitor session is never 'stalled'", async () => {
    const h = setup({ stallMs: 100, stallCheckMs: 60_000 }); // scan() driven by hand: no timer races under load
    const m = h.sessions.insert(h.goalId, h.userId, { name: "Watch deposit", role: "monitor", taskType: "monitor" });
    expect(h.filter.watchdog.scan()).toEqual([]); // first sight: every session gets a fresh grace period
    await new Promise((r) => setTimeout(r, 150));
    h.bus.emit("progress", { goalId: h.goalId, sessionId: h.b, data: { text: "working" } }); // B is busy
    expect(h.filter.watchdog.scan()).toEqual([h.a]);
    expect(h.filter.watchdog.scan()).toEqual([]); // cooldown: one signal per stall window
    await h.filter.idle();
    const stalled = of(h, "session_stalled");
    expect(stalled.map((e) => e.sessionId)).toEqual([h.a]);
    expect(stalled.map((e) => e.sessionId)).not.toContain(m);
    expect(of(h, "captain_woken")[0].data.trigger).toBe("session_stalled");
    expect(h.sessions.calls).toContain(`message:${h.a}`);
    await h.filter.stop();
  });

  it("deterministic fallback: a model that only observes still gets the session redirected (auto)", async () => {
    const llm = new SilentLLM();
    const h = setup({ llm });
    for (let i = 0; i < 4; i++) h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: `https://koios.rest/faq${i}`, status: 404 } });
    await h.filter.idle();
    expect(llm.calls).toBe(1);
    const action = of(h, "captain_action").find((e) => e.data.tool === "message_session")!;
    expect(action.data.auto).toBe(true);
    expect(String((action.data.input as { text: string }).text)).toMatch(/Stop guessing URL paths/);
    expect(h.sessions.calls).toContain(`message:${h.a}`);
    const notes = h.db.select().from(goals).where(eq(goals.id, h.goalId)).get()?.notes ?? "";
    expect(notes).toMatch(/session_looping \(A\): message_session\(auto\)/);
  });
});

describe("goal completion", () => {
  it("all sessions CLOSED → one goal_completed → captain closes the goal and reports the final result", async () => {
    const llm = new SilentLLM(); // the fallback must still produce the final report
    const h = setup({ llm });
    for (const [id, summary] of [
      [h.a, "Blockfrost: 50k req/day free"],
      [h.b, "Koios: public tier, fair use"],
    ] as const) {
      h.db.update(sessionsT).set({ closeStatus: "COMPLETED", handbackJson: JSON.stringify({ result: summary, summary, sources: ["https://docs.example.com"], flags: [] }) }).where(eq(sessionsT.id, id)).run();
    }
    await h.sessions.transition(h.a, "CLOSED", "swept");
    await h.filter.idle();
    expect(of(h, "goal_completed")).toHaveLength(0); // B still open
    await h.sessions.transition(h.b, "CLOSED", "swept");
    await h.filter.idle();
    // A replayed / duplicate CLOSED never emits a second goal_completed.
    h.filter.watchdog.checkGoalCompleted(h.goalId);
    await h.filter.idle();

    const done = of(h, "goal_completed");
    expect(done).toHaveLength(1);
    expect(done[0].data).toMatchObject({ doneMet: 2, total: 2, outcome: "all_done" });
    expect(of(h, "captain_woken").map((e) => e.data.trigger)).toEqual(["goal_completed"]); // CLOSED alone never woke it
    const report = of(h, "captain_report").at(-1)!;
    expect(String(report.data.text)).toMatch(/2\/2 session\(s\) met their definition of done/);
    expect(String(report.data.text)).toMatch(/Blockfrost: 50k req\/day free/);
    expect(h.db.select().from(goals).where(eq(goals.id, h.goalId)).get()?.status).toBe("done");
  });
});
