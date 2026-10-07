// Real silo processes (child_process.fork + tsx), FakeChain, fake market + web.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { sessions as sessionsTable } from "@bulkhead/db";
import type { PlannedSession, TaskType } from "@bulkhead/shared";
import { PAYEE_1, PAYEE_2, setup, spec, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

function specFor(t: TaskType, hook: string, treasury: string): PlannedSession {
  const base = { name: `${t} ${hook}`, goal: `Do the ${t} task ${hook}`.trim() };
  switch (t) {
    case "research":
      return spec({ ...base, taskType: "research", dataScope: ["docs.example.com"] });
    case "buy_pay":
      return spec({ ...base, taskType: "buy_pay", role: "buyer", agentType: "buyer", goal: `Pay 1.5 tUSD to each vendor ${hook}`, allowedPayees: [PAYEE_1, PAYEE_2], dataScope: [] });
    case "hire_agent":
      return spec({ ...base, taskType: "hire_agent", role: "hirer", allowedPayees: ["market-research"], dataScope: [] });
    case "monitor":
      return spec({ ...base, taskType: "monitor", role: "watcher", watch: { kind: "balance", address: treasury, minTUSD: 1 }, dataScope: [] });
  }
}

const closeStatus = (x: H, id: string) => x.db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).get()!.closeStatus;

describe.each(["research", "buy_pay", "hire_agent", "monitor"] as const)("task type %s", (t) => {
  it("denies a disallowed tool; definition of done: pass, fail once → retry, fail twice → FAILED → CLOSING (swept)", async () => {
    h = await setup({ realSilos: true });
    const goalId = h.newGoal();
    const ids = await h.sessions.startPlan(goalId, { sessions: [specFor(t, "#mock:deny", h.treasury), specFor(t, "#mock:bad-once", h.treasury), specFor(t, "#mock:bad-always", h.treasury)] });
    const [deny, once, always] = ids as [string, string, string];
    await Promise.all(ids.map((id) => h!.sessions.whenClosed(id, 40_000)));

    // 1. disallowed tool → tool_denied, session still completes normally
    const denied = h.events("tool_denied", deny);
    expect(denied.length).toBe(1);
    expect(denied[0]!.data.taskType).toBe(t);
    expect(closeStatus(h, deny)).toBe("COMPLETED");
    expect(h.events("handback_rejected", deny)).toHaveLength(0);

    // 2. fail once → handback_rejected (attemptsLeft 1) → retry accepted
    const rej1 = h.events("handback_rejected", once);
    expect(rej1).toHaveLength(1);
    expect(rej1[0]!.data.attemptsLeft).toBe(1);
    expect(h.events("handback_accepted", once)).toHaveLength(1);
    expect(closeStatus(h, once)).toBe("COMPLETED");
    expect(h.sessions.transitionsOf(once).map((x) => x.to)).toEqual(expect.arrayContaining(["COMPLETING", "RUNNING", "CLOSING", "CLOSED"]));

    // 3. fail twice → FAILED → CLOSING → CLOSED, funds swept with metadata 674
    expect(h.events("handback_rejected", always)).toHaveLength(2);
    const seq = h.sessions.transitionsOf(always).map((x) => x.to);
    expect(seq.slice(-3)).toEqual(["FAILED", "CLOSING", "CLOSED"]);
    expect(closeStatus(h, always)).toBe("FAILED");
    for (const id of ids) {
      const sweep = h.chain.txs.find((x) => x.kind === "sweep" && (x.args as { sessionId: string }).sessionId === id);
      expect(sweep, `sweep for ${id}`).toBeTruthy();
      expect((sweep!.metadata![674] as { log_sha256: string }).log_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(h.chain.balance(h.sessions.get(id)!.address!).tusdMicro).toBe(0n);
    }
    if (t === "buy_pay") expect(h.events("payment_confirmed", once).length).toBe(2);
    if (t === "hire_agent") expect(h.events("agent_job_result", once).length).toBe(1);
    if (t === "research") expect(h.events("tainted", once).length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("silo isolation", () => {
  it("child runs with a minimal env in its own temp dir, deleted on close", async () => {
    h = await setup({ realSilos: true });
    process.env.SECRET_FOR_TEST = "must-not-leak";
    const goalId = h.newGoal();
    const [id] = await h.sessions.startPlan(goalId, { sessions: [spec({ goal: "slow research #mock:slow=1500 #mock:env" })] });
    const info = await waitFor(() => h!.silos.info(id!), 10_000, "silo info");
    expect(existsSync(info.tempDir)).toBe(true);
    await h.sessions.whenClosed(id!, 30_000);
    await waitFor(() => !existsSync(info.tempDir), 5_000, "temp dir removed");
    const envLine = String(h.events("progress", id).find((e) => String(e.data.text).startsWith("env keys:"))!.data.text);
    expect(envLine).not.toMatch(/SECRET_FOR_TEST|MASTER_SECRET|OPERATOR_MNEMONIC|ANTHROPIC_API_KEY|BLOCKFROST|DATABASE_PATH|ENGINE_TOKEN/);
    expect(envLine).toContain("SILO_SESSION_ID");
    delete process.env.SECRET_FOR_TEST;
  }, 40_000);

  it("3 missed heartbeats → heartbeat_missed → FAILED → CLOSING → CLOSED", async () => {
    h = await setup({ realSilos: true, supervisor: true });
    const goalId = h.newGoal();
    const [id] = await h.sessions.startPlan(goalId, { sessions: [spec({ goal: "hang #mock:hang" })] });
    await h.sessions.whenClosed(id!, 30_000);
    expect(h.events("heartbeat_missed", id)).toHaveLength(1);
    expect(closeStatus(h, id!)).toBe("FAILED");
  }, 40_000);

  it("wall-clock deadline → EXPIRED → CLOSING → CLOSED", async () => {
    h = await setup({ realSilos: true, supervisor: true, config: { heartbeatMs: 5_000 } });
    const goalId = h.newGoal();
    const [id] = await h.sessions.startPlan(goalId, { sessions: [spec({ goal: "hang #mock:hang", deadline: new Date(Date.now() + 2_500).toISOString() })] });
    await h.sessions.whenClosed(id!, 30_000);
    expect(closeStatus(h, id!)).toBe("EXPIRED");
  }, 40_000);
});
