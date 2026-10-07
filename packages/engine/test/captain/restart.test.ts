// Restart-proof: a brand-new Captain + WakeFilter on the same database file acts on the CURRENT state
// (it has no memory of its own), and actionable events missed while down are replayed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, openDb, goals } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import { createEventBus } from "../../src/bus";
import { createDecisionLedger } from "../../src/decisions";
import { CaptainAgent } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner } from "../../src/planner";
import { createFakeChain } from "../fake-chain";
import { fakeSessions, seedGoal, seedUser, stubMarket } from "./helpers";

afterEach(() => closeDb());

function boot(path: string) {
  closeDb();
  const db = openDb(path);
  const bus = createEventBus(db);
  const decisions = createDecisionLedger(db, bus);
  const sessions = fakeSessions(db, bus);
  const chain = createFakeChain();
  const llm = new MockLLM();
  const planner = createPlanner({ llm, market: stubMarket, chain, db });
  const captain = new CaptainAgent({ db, bus, decisions, sessions, chain, market: stubMarket, llm, planner });
  const filter = new WakeFilter({ bus, captain, db, sessions }, { debounceMs: 5 });
  return { db, bus, decisions, sessions, chain, llm, captain, filter };
}

describe("captain restart-proofing", () => {
  it("a new Captain instance on the same DB acts on current state, and replays missed wakes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "bulkhead-restart-")), "db.sqlite");

    // ── first life ──
    let e = boot(path);
    e.filter.start();
    const userId = seedUser(e.db);
    const deadline = new Date(Date.now() + 3600_000).toISOString();
    const base = { agentType: "generic" as const, allowWebFetch: false, goal: "g", budgetTUSD: "1", perPaymentMaxTUSD: "1", approvalThresholdTUSD: "1", allowedPayees: [], deadline, dataScope: [] };
    const goalId = seedGoal(e.db, userId, {
      sessions: [
        { ...base, name: "A", role: "researcher", taskType: "research", contextFrom: [] },
        { ...base, name: "B", role: "hirer", taskType: "hire_agent", contextFrom: [] },
        { ...base, name: "C", role: "buyer", taskType: "buy_pay", contextFrom: [0] },
      ],
    });
    const a = e.sessions.insert(goalId, userId, { role: "researcher" });
    const b = e.sessions.insert(goalId, userId, { role: "hirer" });
    const c = e.sessions.insert(goalId, userId, { role: "buyer" });
    e.bus.emit("deadline_near", { goalId, data: {} });
    await e.filter.idle();
    expect(e.llm.calls).toBeGreaterThan(0);
    await e.filter.stop();

    // While the engine is "down": state changes and an actionable event happen with no watcher running.
    await e.sessions.transition(a, "COMPLETING", "handback");
    await e.sessions.transition(b, "FAILED", "crashed"); // B is no longer a valid recipient
    const missed = e.bus.emit("handback_submitted", { goalId, sessionId: a, data: { summary: "done" } });

    // ── second life: fresh process objects, same file ──
    e = boot(path);
    expect(e.llm.calls).toBe(0);
    e.filter.start(); // replays the missed handback_submitted
    await e.filter.idle();
    expect(e.llm.calls).toBeGreaterThan(0);
    const woken = e.bus.since(0).filter((x) => x.type === "captain_woken" && x.data.triggerEventId === missed.id);
    expect(woken).toHaveLength(1);
    // It read the DB: B FAILED, C takes A's handback per the plan's contextFrom.
    expect(e.sessions.calls).toContain(`passHandback:${a}->${c}`);
    expect(e.sessions.calls.some((x) => x.includes(`->${b}`))).toBe(false);
    // Long-term notes persisted across lives.
    const notes = e.db.select().from(goals).where(eq(goals.id, goalId)).get()!.notes;
    expect(notes).toMatch(/deadline_near/);
    expect(notes).toMatch(/handback_submitted \(A\)/);

    // ── third life: nothing is replayed twice ──
    e = boot(path);
    e.filter.start();
    await e.filter.idle();
    expect(e.llm.calls).toBe(0);
    // Context size survives restarts (Agent Map).
    expect(e.captain.contextTokens()).toBeGreaterThan(0);
  });
});
