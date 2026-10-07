import { afterEach, describe, expect, it } from "vitest";
import { agentJobs } from "@bulkhead/db";
import { setup, spec, startPlan, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe("tree builder (parents, handback edges, ghost nodes)", () => {
  it("builds goal → sessions → agent_job, handback edge A→C, ghosts keep summary/spend/refund/close tx", async () => {
    h = await setup();
    const goalId = h.newGoal("Research competitors");
    const ids = await h.sessions.startPlan(goalId, {
      sessions: [spec({ name: "A", role: "researcher" }), spec({ name: "B", role: "sub", parent: 0 }), spec({ name: "C", role: "writer", contextFrom: [0] })],
    });
    const [a, b, c] = ids as [string, string, string];
    await waitFor(() => h!.sessions.get(a)!.status === "RUNNING" && h!.sessions.get(b)!.status === "RUNNING", 5_000, "A,B running");
    // C waits for A's handback (contextFrom) — still FUNDING (queued)
    expect(h.sessions.get(c)!.status).toBe("FUNDING");

    h.db.insert(agentJobs).values({ id: "j1", sessionId: a, serviceId: "market-research", externalJobId: "job-1", input: "x", priceMicro: "2000000", status: "completed", result: "r", resultHash: "ab".repeat(32), createdAt: Date.now(), updatedAt: Date.now() }).run();
    await h.sessions.acceptSubmission(a, { result: "found 3 competitors", summary: "3 competitors found", sources: ["https://docs.example.com"], flags: [] });
    expect(await h.sessions.reviewHandback(a)).toEqual({ accepted: true });
    await h.sessions.whenClosed(a, 5_000);
    await waitFor(() => h!.sessions.get(c)!.status === "RUNNING", 5_000, "C running");
    expect(h.events("handback_passed", c)[0]!.data).toMatchObject({ from: a, to: c });
    await h.sessions.kill(b, "user", "not needed");
    await h.sessions.whenClosed(b, 5_000);

    const tree = h.sessions.tree(goalId);
    const node = (id: string) => tree.nodes.find((n) => n.id === id)!;
    expect(node(goalId)).toMatchObject({ kind: "goal", parentId: null });
    expect(node(a)).toMatchObject({ kind: "session", parentId: goalId, letter: "A", ghost: true, glyph: "closed", handbackSummary: "3 competitors found", refundMicro: "10000000" });
    expect(node(a).closeTx).toMatch(/^[0-9a-f]{64}$/);
    expect(node(a).lines[1]).toMatch(/returned/);
    expect(node(b)).toMatchObject({ parentId: a, ghost: true, glyph: "failed", status: "CLOSED" });
    expect(node(b).lines[0]).toMatch(/killed by user/);
    expect(node(c)).toMatchObject({ parentId: goalId, ghost: false, glyph: "running" });
    expect(node("job_j1")).toMatchObject({ kind: "agent_job", parentId: a, glyph: "closed" });
    expect(tree.edges).toEqual(
      expect.arrayContaining([
        { from: goalId, to: a, kind: "parent" },
        { from: a, to: b, kind: "parent" },
        { from: goalId, to: c, kind: "parent" },
        { from: a, to: "job_j1", kind: "parent" },
        { from: a, to: c, kind: "handback" },
      ]),
    );
    // C received A's handback as contextIn (data)
    const sent = h.stub.sent.filter((s) => s.sessionId === c);
    expect(h.stub.started).toContain(c);
    expect(sent.length).toBe(0); // contextIn was set before the silo started (delivered in start)
  });
});

describe("parallel sessions (spec §5.3)", () => {
  it("one funding tx for 3 sessions; all 3 RUNNING at the same time (real silos)", async () => {
    h = await setup({ realSilos: true });
    const goalId = h.newGoal();
    const ids = await h.sessions.startPlan(goalId, {
      sessions: [spec({ name: "A", goal: "a #mock:slow=1500" }), spec({ name: "B", goal: "b #mock:slow=1500", budgetTUSD: "7" }), spec({ name: "C", goal: "c #mock:slow=1500", budgetTUSD: "3" })],
    });
    const fundings = h.chain.txs.filter((t) => t.kind === "fundSessions");
    expect(fundings).toHaveLength(1);
    expect(fundings[0]!.outputs.map((o) => o.tusdMicro)).toEqual([10_000_000n, 7_000_000n, 3_000_000n]);
    expect(new Set(ids.map((id) => h!.sessions.get(id)!.address)).size).toBe(3);
    await Promise.all(ids.map((id) => h!.sessions.whenClosed(id, 30_000)));
    const spans = ids.map((id) => {
      const t = h!.sessions.transitionsOf(id);
      return { start: t.find((x) => x.to === "RUNNING")!.at, end: t.find((x) => x.to === "COMPLETING")!.at };
    });
    const latestStart = Math.max(...spans.map((s) => s.start));
    const earliestEnd = Math.min(...spans.map((s) => s.end));
    expect(latestStart).toBeLessThan(earliestEnd); // all three overlapped
  }, 40_000);

  it("MAX_PARALLEL_SESSIONS queues extra sessions until a slot frees", async () => {
    h = await setup({ config: { maxParallelSessions: 2 } });
    const goalId = h.newGoal();
    const ids = await h.sessions.startPlan(goalId, { sessions: [spec({ name: "A" }), spec({ name: "B" }), spec({ name: "C" })] });
    await waitFor(() => ids.filter((id) => h!.sessions.get(id)!.status === "RUNNING").length === 2, 5_000, "2 running");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sessions.get(ids[2]!)!.status).toBe("FUNDING");
    await h.sessions.kill(ids[0]!, "user", "free a slot");
    await waitFor(() => h!.sessions.get(ids[2]!)!.status === "RUNNING", 5_000, "C running");
  });
});
