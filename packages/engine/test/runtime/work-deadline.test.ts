// Work deadline (WORK_DEADLINE_SECONDS): the crew's working time is time-boxed separately from the on-chain windows.
//  - the silo hands back a partial result at the deadline (flag "partial: time limit"), never a failure
//  - the captain's watchdog collects a handback itself when the silo does not, and the session closes right away
//  - the vault expiry stays minimal-but-valid: ≥ work deadline + the Pay / close buffer
//  - goal_completed / goal_result say the goal was time-boxed
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions as sessionsTable } from "@bulkhead/db";
import { PARTIAL_TIME_LIMIT_FLAG, TIMEBOXED_CLOSE_STATUS, isTimeLimitPartial, type Handback } from "@bulkhead/shared";
import { CrewWatchdog } from "../../src/captain/watchdog";
import { WakeFilter } from "../../src/captain/wake";
import { OutcomeReporter } from "../../src/captain/reports";
import { finalReport } from "../../src/captain/captain";
import { partialHandbackFrom, planWaves } from "../../src/sessions";
import { minVaultExpiry, runtimeConfig } from "../../src/sessions-store";
import { plannerWorkRule } from "../../src/planner";
import { MockLLM } from "../../src/llm/mock";
import type { Captain } from "../../src/contracts";
import { setup, spec, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const row = (x: H, id: string) => x.db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).get()!;
const handbackOf = (x: H, id: string) => JSON.parse(row(x, id).handbackJson ?? "null") as Handback | null;
const watchdogFor = (x: H, graceMs = 100) =>
  new CrewWatchdog({ bus: x.bus, db: x.db }, { work: { deadlineOf: (id) => x.sessions.workDeadlineOf(id), timeBox: (id, why) => x.sessions.timeBox(id, why), graceMs } });

describe("work deadline settings", () => {
  it("WORK_DEADLINE_SECONDS defaults to 60 s; the on-chain buffers are separate", () => {
    const keep = { ...process.env };
    try {
      for (const k of ["WORK_DEADLINE_SECONDS", "WORK_WRAPUP_SECONDS", "VAULT_EXPIRY_BUFFER_SECONDS", "VAULT_FUNDING_ALLOWANCE_SECONDS"]) delete process.env[k];
      const c = runtimeConfig();
      expect(c.workDeadlineMs).toBe(60_000);
      expect(c.workWrapUpMs).toBe(15_000);
      expect(c.vaultExpiryBufferMs).toBe(300_000);
      expect(c.vaultFundingAllowanceMs).toBe(300_000);
      process.env.WORK_DEADLINE_SECONDS = "0";
      expect(runtimeConfig().workDeadlineMs).toBe(0);
    } finally {
      process.env = keep;
    }
  });

  it("waves: one parallel wave, a dependent synthesis step, queued sessions", () => {
    expect(planWaves([{ contextFrom: [] }, { contextFrom: [] }, { contextFrom: [0, 1] }], 5)).toEqual([0, 0, 1]);
    expect(planWaves([{ contextFrom: [] }, { contextFrom: [] }, { contextFrom: [] }], 2)).toEqual([0, 0, 1]);
    const c = { workDeadlineMs: 60_000, vaultExpiryBufferMs: 300_000, vaultFundingAllowanceMs: 300_000 };
    expect(minVaultExpiry(0, c, 0)).toBe(660_000);
    expect(minVaultExpiry(0, c, 1)).toBe(720_000);
  });

  it("planner prompt: 60 seconds, one parallel wave, at most one dependent synthesis step", () => {
    const rule = plannerWorkRule(60);
    expect(rule).toMatch(/you have 60 seconds/);
    expect(rule).toMatch(/prefer ONE parallel wave/);
    expect(rule).toMatch(/At most ONE dependent synthesis step/);
    expect(plannerWorkRule(0)).toBe("");
  });

  it("mock captain: goal_completed says time-boxed; work_deadline_reached needs no action", async () => {
    const llm = new MockLLM();
    const wake = (trigger: Record<string, unknown>) =>
      llm.complete({ model: "orchestrator", system: "captain", messages: [{ role: "user", content: `<wake>${JSON.stringify({ trigger })}</wake>\n<state_json>{"sessions":[]}</state_json>` }] });
    const done = await wake({ type: "goal_completed", goalId: "g", data: { timeBoxed: true, workSeconds: 60 } });
    expect(String(done.toolCalls[0]?.input.text)).toMatch(/Time-boxed to 60 s of work/);
    const cut = await wake({ type: "work_deadline_reached", sessionId: "s", data: { workSeconds: 60 } });
    expect(cut.toolCalls).toEqual([]);
  });

  it("partial handback from what the session recorded passes the handback firewall", () => {
    const hb = partialHandbackFrom({ taskType: "research", lastProgress: "read docs", sources: ["https://docs.example.com/a"], txHashes: ["ab".repeat(32), "not-a-hash"], job: null, workSeconds: 60 });
    expect(hb.flags[0]).toBe(PARTIAL_TIME_LIMIT_FLAG);
    expect(isTimeLimitPartial(hb)).toBe(true);
    expect(hb.txHashes).toEqual(["ab".repeat(32)]);
    expect(hb.summary).toMatch(/^Partial \(time limit 60 s\)/);
  });
});

describe("vault expiry vs work deadline", () => {
  it("vault expiry ≥ work deadline + buffer (raised when the planned deadline is too close; dependents get one more wave)", async () => {
    h = await setup({ config: { workDeadlineMs: 60_000, vaultExpiryBufferMs: 300_000, vaultFundingAllowanceMs: 300_000 } });
    const goalId = h.newGoal();
    const t0 = Date.now();
    const close = new Date(Date.now() + 5_000).toISOString(); // far too short for funding + Pay + close
    const ids = await h.sessions.startPlan(goalId, { sessions: [spec({ deadline: close }), spec({ deadline: close }), spec({ deadline: close, agentType: "summariser", role: "summariser", contextFrom: [0, 1] })] });
    await waitFor(() => row(h!, ids[0]!).status === "RUNNING" && row(h!, ids[1]!).status === "RUNNING", 10_000, "first wave RUNNING");
    const [a, b, c] = ids.map((id) => row(h!, id));
    // Minimal-but-valid: funding allowance + work + buffer, never the 5 s the plan asked for.
    expect(a!.expiresAt).toBeGreaterThanOrEqual(t0 + 660_000);
    expect(a!.expiresAt).toBeLessThan(t0 + 660_000 + 10_000);
    expect(c!.expiresAt - a!.expiresAt).toBeGreaterThanOrEqual(59_000); // the synthesis step starts one wave later
    // Once RUNNING: expiry − work deadline ≥ the Pay / close buffer.
    for (const r of [a!, b!]) expect(r.expiresAt - h.sessions.workDeadlineOf(r.id)!).toBeGreaterThanOrEqual(300_000);
    expect(h.sessions.workDeadlineOf(a!.id)).toBe(a!.startedAt! + 60_000);
    expect(h.sessions.tree(goalId).nodes.find((n) => n.id === a!.id)?.workDeadlineAt).toBe(a!.startedAt! + 60_000);
    expect(h.events("progress").some((e) => /wallet expiry raised/.test(String(e.data.text)))).toBe(true);
  });

  it("WORK_DEADLINE_SECONDS=0 keeps the planned deadline as the expiry", async () => {
    h = await setup({ config: { workDeadlineMs: 0 } });
    const goalId = h.newGoal();
    const d = Date.now() + 120_000;
    const [id] = await h.sessions.startPlan(goalId, { sessions: [spec({ deadline: new Date(d).toISOString() })] });
    expect(row(h, id!).expiresAt).toBe(d);
    expect(h.sessions.workDeadlineOf(id!)).toBeNull();
  });
});

describe("time-boxed crew (real silos, mock agents)", () => {
  it("a goal completes within the work deadline with partial handbacks; goal_completed + goal_result say time-boxed", async () => {
    const work = 6_000;
    h = await setup({ realSilos: true, config: { workDeadlineMs: work, workWrapUpMs: 1_500, vaultExpiryBufferMs: 60_000, vaultFundingAllowanceMs: 60_000 } });
    const wd = watchdogFor(h, 1_000);
    const off = h.bus.subscribe((e) => wd.observe(e));
    const reporter = new OutcomeReporter({ db: h.db, bus: h.bus, wording: "deterministic" });
    reporter.start();
    try {
      const goalId = h.newGoal("Compare two docs sites");
      const ids = await h.sessions.startPlan(goalId, {
        sessions: [
          spec({ name: "fast", goal: "Read the docs" }), // finishes well inside the work time
          spec({ name: "slow", goal: "Read slowly #mock:slow=60000" }), // fetches, then would idle for a minute
          spec({ name: "empty", goal: "Nothing to read #mock:slow=60000", dataScope: [] }), // gathers nothing useful
        ],
      });
      const [fast, slow, empty] = ids as [string, string, string];
      await Promise.all(ids.map((id) => h!.sessions.whenClosed(id, 30_000)));
      for (const id of ids) {
        const r = row(h, id);
        // Closed right after the work deadline (+ silo/close slack), not at the vault expiry.
        expect(r.endedAt! - r.startedAt!).toBeLessThan(work + 8_000);
        expect(r.expiresAt).toBeGreaterThan(r.endedAt!);
      }
      expect(isTimeLimitPartial(handbackOf(h, fast))).toBe(false);
      expect(row(h, fast).closeStatus).toBe("COMPLETED");
      // slow: its partial carries the page it read → definition of done met, still flagged partial.
      expect(isTimeLimitPartial(handbackOf(h, slow))).toBe(true);
      expect(handbackOf(h, slow)!.sources.length).toBeGreaterThan(0);
      expect(row(h, slow).closeStatus).toBe("COMPLETED");
      // empty: partial without a source → kept as TIMEBOXED (not FAILED, no retry).
      expect(isTimeLimitPartial(handbackOf(h, empty))).toBe(true);
      expect(row(h, empty).closeStatus).toBe(TIMEBOXED_CLOSE_STATUS);
      expect(h.events("handback_rejected", empty)).toHaveLength(0);
      expect(h.events("progress", slow).some((e) => /wrap up/.test(String(e.data.text)))).toBe(true);
      // The vault was revoked to the treasury at close.
      for (const id of ids) expect(h.events("close_confirmed", id)).toHaveLength(1);

      const done = await waitFor(() => h!.events("goal_completed").find((e) => e.goalId === goalId), 5_000, "goal_completed");
      expect(done.data.timeBoxed).toBe(true);
      expect(done.data.timeBoxedSessions).toEqual(expect.arrayContaining([row(h, slow).letter, row(h, empty).letter]));
      expect(done.data.outcome).toBe("partial");
      await reporter.idle();
      const goalResult = h.events("captain_report").find((e) => e.data.kind === "goal_result" && e.goalId === goalId);
      expect(goalResult).toBeTruthy();
      expect(String(goalResult!.data.headline)).toMatch(/time-boxed/);
      expect(String(goalResult!.data.text)).toMatch(/time-boxed to 6 s of work/);
      // The captain's deterministic final report says so too.
      const text = finalReport(
        "Compare two docs sites",
        h.sessions.list({ goalId }).map((s) => ({ id: s.id, letter: s.letter, name: s.name, spentMicro: s.spentMicro })),
        (id) => handbackOf(h!, id),
        (id) => row(h!, id).closeStatus,
        "tUSD",
        { workSeconds: 6 },
      );
      expect(text).toMatch(/Time-boxed: the crew had 6 s of work per session/);
      expect(text).toMatch(/partial \(time limit\)/);
    } finally {
      off();
      await reporter.stop();
    }
  }, 60_000);
});

describe("watchdog at the work deadline (silo never hands back)", () => {
  it("collects a partial handback, closes the sessions and reports the goal as time-boxed", async () => {
    // Stub silos: nothing ever submits, like a hung / slow sub-agent.
    h = await setup({ config: { workDeadlineMs: 1_500, vaultExpiryBufferMs: 60_000, vaultFundingAllowanceMs: 60_000 } });
    const goalId = h.newGoal();
    const ids = await h.sessions.startPlan(goalId, { sessions: [spec({ name: "read" }), spec({ name: "idle" })] });
    const [read, idle] = ids as [string, string];
    await waitFor(() => ids.every((id) => row(h!, id).status === "RUNNING"), 10_000, "RUNNING");
    // A read that happened before the deadline (what the session recorded).
    h.bus.emit("web_fetch", { goalId, sessionId: read, data: { url: "https://docs.example.com/page", status: 200, bytes: 100 } });
    const wd = watchdogFor(h, 100);
    expect(wd.scanWork()).toEqual([]); // not yet
    const acted: string[] = [];
    await waitFor(() => (acted.push(...wd.scanWork()), acted.length >= ids.length), 10_000, "watchdog acts after deadline + grace");
    expect(acted.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(Date.now()).toBeGreaterThanOrEqual(h.sessions.workDeadlineOf(id)! + 100);
    await Promise.all(ids.map((id) => h!.sessions.whenClosed(id, 10_000)));
    expect(h.events("work_deadline_reached").map((e) => e.sessionId).sort()).toEqual([...ids].sort());
    const hb = handbackOf(h, read)!;
    expect(hb.flags).toContain(PARTIAL_TIME_LIMIT_FLAG);
    expect(hb.sources).toEqual(["https://docs.example.com/page"]);
    expect(row(h, read).closeStatus).toBe("COMPLETED");
    expect(row(h, idle).closeStatus).toBe(TIMEBOXED_CLOSE_STATUS);
    expect(wd.scanWork()).toEqual([]); // nothing left to act on
    expect(wd.checkGoalCompleted(goalId)).toBe(true);
    const done = h.events("goal_completed").find((e) => e.goalId === goalId)!;
    expect(done.data).toMatchObject({ timeBoxed: true, total: 2 });
  });

  it("the wake filter wires the watchdog to the SessionManager (no captain LLM involved)", async () => {
    h = await setup({ config: { workDeadlineMs: 200, vaultExpiryBufferMs: 60_000, vaultFundingAllowanceMs: 60_000 } });
    const woken: string[] = [];
    const captain = { tools: [], wake: async (e: { type: string }) => void woken.push(e.type), userMessage: async () => undefined, plan: async () => ({}) } as unknown as Captain;
    const keep = process.env.WORK_GRACE_SECONDS;
    process.env.WORK_GRACE_SECONDS = "0.1";
    const wake = new WakeFilter({ bus: h.bus, captain, db: h.db, sessions: h.sessions }, { workCheckMs: 50, debounceMs: 10 });
    if (keep === undefined) delete process.env.WORK_GRACE_SECONDS;
    else process.env.WORK_GRACE_SECONDS = keep;
    wake.start({ replay: false });
    try {
      const goalId = h.newGoal();
      const [id] = await h.sessions.startPlan(goalId, { sessions: [spec()] });
      await h.sessions.whenClosed(id!, 10_000);
      expect(row(h, id!).closeStatus).toBe(TIMEBOXED_CLOSE_STATUS);
      await wake.idle();
      expect(woken).toContain("work_deadline_reached");
    } finally {
      await wake.stop();
    }
  });
});
