// Full autonomous run (Firstmate model), no user clicks: a delegated goal is planned by the captain, auto-funded inside
// its mandate, and the crew runs in REAL silo processes (mock sub-agents) on the FakeChain. Every sub-agent starts
// stuck in a loop (#mock:loop); the watchdog flags it, the captain redirects it with message_session, the crew
// finishes (research + paid agent hire + payment), and on goal_completed the captain closes the goal and reports.
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, goals, sessions as sessionsT } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import { CaptainAgent, wrapHandback } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner } from "../../src/planner";
import { autoFundGoal } from "../../src/goal-funding";
import { OutcomeReporter } from "../../src/captain/reports";
import { setup, waitFor } from "./helpers";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  closeDb();
});

describe("autonomous crew (no clicks after delegation)", () => {
  it("plans in parallel, redirects looping sub-agents, pays/hires within mandate, closes the goal and reports", async () => {
    // Heartbeats at a realistic cadence: a loaded CI box can take > 450 ms to boot a tsx silo.
    const h = await setup({ realSilos: true, supervisor: true, config: { heartbeatMs: 1_000 } });
    const llm = new MockLLM();
    const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
    const captain = new CaptainAgent({ db: h.db, chain: h.chain, bus: h.bus, sessions: h.sessions, decisions: h.decisions, market: h.market, llm, planner, wrapHandback });
    const wake = new WakeFilter({ bus: h.bus, captain, db: h.db, sessions: h.sessions }, { debounceMs: 10, absorbFlushMs: 500, watchdog: { loopFailures: 4, stallMs: 60_000 } });
    wake.start({ replay: false });
    const reporter = new OutcomeReporter({ db: h.db, bus: h.bus, decisions: h.decisions, llm, wording: "llm" });
    reporter.start();
    cleanup = async () => {
      await reporter.stop();
      await wake.stop();
      await h.cleanup();
    };

    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
    const { goalId, plan } = await captain.plan({
      userId: h.userId,
      goal: "Research competitors and hire a market-research agent, then pay for a summary #mock:loop",
      budgetTUSD: "10",
      deadline,
      rules: "",
    });
    // Parallel: at least two sessions start at once; only the payment waits for the research it uses.
    expect(plan.sessions.filter((s) => s.contextFrom.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(plan.sessions.map((s) => s.taskType)).toEqual(expect.arrayContaining(["hire_agent", "buy_pay"]));

    // Delegated goal: funded inside its mandate with no click (what POST /goals does for an API / Sokosumi goal).
    const funded = await autoFundGoal({ db: h.db, bus: h.bus, sessions: h.sessions }, goalId);
    expect(funded.ok, JSON.stringify(funded)).toBe(true);

    await waitFor(() => h.db.select().from(goals).where(eq(goals.id, goalId)).get()?.status === "done", 60_000, "goal done");
    await waitFor(() => h.events("goal_completed").length > 0, 10_000, "goal_completed");
    await wake.idle();
    await waitFor(() => h.bus.since(0, { goalId }).some((e) => e.type === "captain_report" && /Goal complete/.test(String(e.data.text))), 10_000, "final report");

    const rows = h.db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all();
    expect(rows.length).toBe(plan.sessions.length);
    // Every looping sub-agent was redirected by the captain (not by the user).
    const looping = new Set(h.events("session_looping").map((e) => e.sessionId));
    const why = JSON.stringify(h.bus.since(0, { goalId }).filter((e) => ["session_transition", "error", "progress", "tool_denied"].includes(e.type)).map((e) => [e.type, e.sessionId?.slice(-4), e.data.to ?? e.data.text ?? e.data.kind, e.data.reason ?? ""]));
    expect(looping.size, why).toBe(rows.length);
    const redirected = new Set(h.events("session_message").filter((e) => e.data.from === "captain").map((e) => e.sessionId));
    for (const id of looping) expect(redirected.has(id)).toBe(true);
    expect(h.events("session_message").filter((e) => e.data.from === "user")).toHaveLength(0);
    // Definition of done met everywhere; money actually moved (an agent was hired and paid, a payment made).
    expect(rows.map((r) => r.closeStatus)).toEqual(rows.map(() => "COMPLETED"));
    expect(rows.reduce((s, r) => s + BigInt(r.spentMicro), 0n)).toBeGreaterThan(0n);
    expect(h.events("agent_job_result").length).toBeGreaterThan(0);
    expect(h.events("payment_confirmed").length).toBeGreaterThan(0);
    // No decision was needed (in-policy spending runs without clicks) and the goal closed with one completion event.
    expect(h.decisions.list()).toHaveLength(0);
    expect(h.events("goal_completed")).toHaveLength(1);
    expect(h.events("goal_completed")[0].data.outcome).toBe("all_done");
    // The captain woke for actionable events only (never for routine progress / plain tainted reads).
    const triggers = h.bus.since(0, { goalId }).filter((e) => e.type === "captain_woken").map((e) => String(e.data.trigger));
    for (const t of triggers) expect(["progress", "tainted", "web_fetch", "session_funded", "payment_submitted"]).not.toContain(t);
    expect(triggers).toContain("session_looping");
    expect(triggers).toContain("goal_completed");
    // Trust surface: one structured outcome report per accepted handback + one goal result, each with risk + evidence;
    // every captain action carries a `why`.
    await reporter.idle();
    const reports = h.bus.since(0, { goalId }).filter((e) => e.type === "captain_report" && typeof e.data.kind === "string").map((e) => e.data);
    expect(reports.filter((r) => r.kind === "session_result").map((r) => r.sessionId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(reports.filter((r) => r.kind === "goal_result")).toHaveLength(1);
    for (const r of reports) {
      expect(["low", "medium", "high"]).toContain(r.risk);
      expect(String(r.headline).length).toBeLessThanOrEqual(120);
      expect((r.evidence as { kind: string }[]).some((e) => e.kind === "dod")).toBe(true);
    }
    const paid = reports.find((r) => r.kind === "session_result" && (r.evidence as { kind: string }[]).some((e) => e.kind === "tx"));
    expect(paid, "a paying session's report cites its payment tx").toBeTruthy();
    expect(h.bus.since(0, { goalId }).filter((e) => e.type === "captain_action").every((e) => typeof e.data.why === "string" && String(e.data.why).length > 5)).toBe(true);
  }, 90_000);
});
