import { afterEach, describe, expect, it } from "vitest";
import { closeDb, goals } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import { CaptainAgent } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner } from "../../src/planner";
import { harness, seedGoal, seedUser } from "./helpers";

function setup() {
  const h = harness();
  const llm = new MockLLM();
  const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
  const captain = new CaptainAgent({ ...h, llm, planner });
  const filter = new WakeFilter({ bus: h.bus, captain, db: h.db, sessions: h.sessions }, { debounceMs: 5, absorbFlushMs: 10_000 });
  filter.start({ replay: false });
  const userId = seedUser(h.db);
  const goalId = seedGoal(h.db, userId, {
    sessions: [
      { name: "A", role: "researcher", agentType: "researcher", taskType: "research", allowWebFetch: false, goal: "g", budgetTUSD: "1", perPaymentMaxTUSD: "1", approvalThresholdTUSD: "1", allowedPayees: [], deadline: new Date(Date.now() + 3600_000).toISOString(), dataScope: [], contextFrom: [] },
      { name: "B", role: "buyer", agentType: "buyer", taskType: "buy_pay", allowWebFetch: false, goal: "g", budgetTUSD: "1", perPaymentMaxTUSD: "1", approvalThresholdTUSD: "1", allowedPayees: [], deadline: new Date(Date.now() + 3600_000).toISOString(), dataScope: [], contextFrom: [0] },
    ],
  });
  const a = h.sessions.insert(goalId, userId, { role: "researcher", taskType: "research" });
  const b = h.sessions.insert(goalId, userId, { role: "buyer", taskType: "buy_pay" });
  return { ...h, llm, captain, filter, userId, goalId, a, b };
}

const count = (h: ReturnType<typeof setup>, type: string) => h.bus.since(0).filter((e) => e.type === type).length;

afterEach(() => closeDb());

describe("captain wake filter (zero-token watcher)", () => {
  it("absorbs routine events without any LLM call", async () => {
    const h = setup();
    for (let i = 0; i < 25; i++) h.bus.emit("progress", { goalId: h.goalId, sessionId: h.a, data: { text: `step ${i}` } });
    h.bus.emit("llm_usage", { goalId: h.goalId, sessionId: h.a, data: { inputTokens: 10, outputTokens: 5 } });
    h.bus.emit("payment_submitted", { goalId: h.goalId, sessionId: h.b, data: {} });
    h.bus.emit("session_transition", { goalId: h.goalId, sessionId: h.a, data: { from: "FUNDING", to: "RUNNING" } });
    await h.filter.idle();
    expect(h.llm.calls).toBe(0);
    expect(count(h, "captain_woken")).toBe(0);

    h.filter.flushAbsorbed();
    const absorbed = h.bus.since(0).filter((e) => e.type === "captain_absorbed");
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0].data.count).toBe(30); // 28 above + 2 session_created during setup
    expect((absorbed[0].data.byType as Record<string, number>).progress).toBe(25);
    expect(h.filter.stats).toEqual({ woken: 0, absorbed: 30 });
  });

  it("wakes the captain (LLM calls) for actionable events and logs the wake", async () => {
    const h = setup();
    h.bus.emit("payment_rejected", { goalId: h.goalId, sessionId: h.b, data: { reason: "payee_not_allowed" } });
    await h.filter.idle();
    expect(h.llm.calls).toBeGreaterThan(0);
    expect(count(h, "captain_woken")).toBe(1);
    const report = h.bus.since(0).find((e) => e.type === "captain_report");
    expect(String(report?.data.text)).toMatch(/payee_not_allowed/);
    const action = h.bus.since(0).find((e) => e.type === "captain_action");
    expect(action?.data.tool).toBe("report_to_user");

    // A session_transition to FAILED is actionable; one to PAUSED is not.
    const before = h.llm.calls;
    h.bus.emit("session_transition", { goalId: h.goalId, sessionId: h.a, data: { from: "RUNNING", to: "PAUSED" } });
    await h.filter.idle();
    expect(h.llm.calls).toBe(before);
    h.bus.emit("session_transition", { goalId: h.goalId, sessionId: h.a, data: { from: "RUNNING", to: "FAILED" } });
    await h.filter.idle();
    expect(h.llm.calls).toBeGreaterThan(before);
  });

  it("coalesces a burst of actionable events for one goal into a single wake", async () => {
    const h = setup();
    h.bus.emit("decision_opened", { goalId: h.goalId, sessionId: h.b, data: { kind: "payment_approval" } });
    h.bus.emit("payment_rejected", { goalId: h.goalId, sessionId: h.b, data: { reason: "over_budget" } });
    h.bus.emit("heartbeat_missed", { goalId: h.goalId, sessionId: h.a, data: {} });
    await h.filter.idle();
    expect(count(h, "captain_woken")).toBe(1);
    const woken = h.bus.since(0).find((e) => e.type === "captain_woken")!;
    expect(woken.data.trigger).toBe("decision_opened");
    expect((woken.data.coalesced as unknown[]).length).toBe(2);
  });

  it("serializes wakes: two goals never run the captain concurrently", async () => {
    const h = setup();
    const goal2 = seedGoal(h.db, h.userId);
    let running = 0;
    let maxRunning = 0;
    const orig = h.captain.wake.bind(h.captain);
    h.captain.wake = async (t, c) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      await orig(t, c);
      running--;
    };
    h.bus.emit("deadline_near", { goalId: h.goalId, data: {} });
    h.bus.emit("deadline_near", { goalId: goal2, data: {} });
    await h.filter.idle();
    expect(count(h, "captain_woken")).toBe(2);
    expect(maxRunning).toBe(1);
  });

  it("on handback_submitted: reviews the handback (definition of done) and passes it to the next session", async () => {
    const h = setup();
    await h.sessions.transition(h.a, "COMPLETING", "handback");
    h.bus.emit("handback_submitted", { goalId: h.goalId, sessionId: h.a, data: { summary: "found 3 competitors" } });
    await h.filter.idle();
    expect(h.sessions.calls).toContain(`review:${h.a}`);
    expect(h.sessions.calls).toContain(`passHandback:${h.a}->${h.b}`);
    const notes = h.db.select().from(goals).where(eq(goals.id, h.goalId)).get()?.notes ?? "";
    expect(notes).toMatch(/handback_submitted \(A\): read_status, pass_handback, report_to_user/);
  });

  it("user messages always wake the captain; 'tell B …' becomes message_session (DATA to the silo)", async () => {
    const h = setup();
    await h.captain.userMessage(h.userId, h.goalId, "tell B focus on the cheapest vendor");
    await h.filter.idle();
    expect(h.sessions.calls).toContain(`message:${h.b}`);
    const msg = h.bus.since(0).find((e) => e.type === "session_message");
    expect(msg?.data.text).toBe("focus on the cheapest vendor");
    expect(msg?.data.from).toBe("captain");
  });
});
