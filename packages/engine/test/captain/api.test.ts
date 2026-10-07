// API smoke: in-process Hono app.request against FakeChain + MockLLM (no network, no ports).
import { afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@bulkhead/db";
import { createApi } from "../../src/api";
import { CaptainAgent, wrapHandback } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { MockLLM } from "../../src/llm/mock";
import { createPlanner } from "../../src/planner";
import type { Engine, Signer, SiloRunner } from "../../src/contracts";
import { harness } from "./helpers";

afterEach(() => closeDb());

const TOKEN = "test-token";

function setup() {
  const h = harness();
  const llm = new MockLLM();
  const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db });
  const captain = new CaptainAgent({ ...h, llm, planner });
  const wake = new WakeFilter({ bus: h.bus, captain, db: h.db, sessions: h.sessions }, { debounceMs: 5, absorbFlushMs: 60_000 });
  wake.start({ replay: false });
  const engine: Engine = {
    db: h.db,
    chain: h.chain,
    bus: h.bus,
    sessions: h.sessions,
    silos: {} as SiloRunner,
    signer: { pay: async () => ({ kind: "rejected", paymentId: "x", reason: "session_not_running", detail: "" }), resolveApproval: async () => ({ kind: "rejected", paymentId: "x", reason: "session_not_running", detail: "" }) } as Signer,
    decisions: h.decisions,
    market: h.market,
    llm,
    captain,
    wrapHandback,
  };
  const app = createApi({
    engine,
    token: TOKEN,
    myrPerTusd: "4.70",
    captainInfo: () => ({ name: captain.name, model: "mock", contextTokens: captain.contextTokens(), totalTokens: captain.totalTokens() }),
    wakeStats: () => wake.stats,
  });
  return { ...h, llm, captain, wake, app };
}

describe("engine HTTP API (smoke)", () => {
  it("serves the full goal → plan → approve → control → captain flow", async () => {
    const h = setup();
    const call = async (method: string, path: string, opts: { user?: string; body?: unknown; token?: string } = {}) => {
      const res = await h.app.request(path, {
        method,
        headers: { "x-engine-token": opts.token ?? TOKEN, ...(opts.user ? { "x-user-id": opts.user } : {}), "content-type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    expect((await h.app.request("/health")).status).toBe(200);
    expect((await call("GET", "/me", { token: "wrong" })).status).toBe(401);

    const created = await call("POST", "/users", { body: { email: "Ada@Example.com", name: "Ada", custody: "custodial" } });
    expect(created.status).toBe(201);
    const userId = created.body.userId as string;
    expect(created.body.treasuryAddress).toMatch(/^addr_test1/);
    expect((await call("POST", "/users", { body: { email: "ada@example.com" } })).body.created).toBe(false);
    const other = (await call("POST", "/users", { body: { email: "eve@example.com" } })).body.userId as string;

    expect((await call("GET", "/me")).status).toBe(401); // no x-user-id
    const me = await call("GET", "/me", { user: userId });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ userId, email: "ada@example.com", custody: "custodial", treasuryAddress: created.body.treasuryAddress, network: "preprod", myrPerTusd: "4.70" });
    expect(me.body.balances).toHaveProperty("tusdMicro");

    const agents = await call("GET", "/agents", { user: userId });
    expect(agents.body).toHaveLength(2);

    const deadline = new Date(Date.now() + 3 * 3600_000).toISOString();
    const planned = await call("POST", "/goals", { user: userId, body: { goal: "Research competitors", budgetTUSD: "12", deadline, rules: "" } });
    expect(planned.status).toBe(201);
    expect(planned.body.plan.sessions).toHaveLength(3);
    expect(planned.body.fundingPreview.totalTusd).toBe("12");
    const goalId = planned.body.goalId as string;

    const approved = await call("POST", `/goals/${goalId}/approve`, { user: userId });
    expect(approved.status).toBe(200);
    expect(approved.body.ok).toBe(true);
    expect(approved.body.sessionIds).toHaveLength(3);
    expect((await call("POST", `/goals/${goalId}/approve`, { user: userId })).body.alreadyApproved).toBe(true);
    expect((await call("POST", `/goals/${goalId}/approve`, { user: other })).status).toBe(404);
    const [a, b, c] = approved.body.sessionIds as string[];

    const goalsList = await call("GET", "/goals", { user: userId });
    expect(goalsList.body[0]).toMatchObject({ id: goalId, sessions: 3, budgetMicro: "12000000" });
    const tree = await call("GET", `/goals/${goalId}/tree`, { user: userId });
    expect(tree.body.nodes.length).toBeGreaterThanOrEqual(4);

    const detail = await call("GET", `/sessions/${a}`, { user: userId });
    expect(detail.body).toMatchObject({ id: a, letter: "A", goalId });
    expect(detail.body.mandate.budgetMicro).toMatch(/^\d+$/);
    expect(Array.isArray(detail.body.activity)).toBe(true);
    expect((await call("GET", `/sessions/${a}`, { user: other })).status).toBe(404);

    // Routine progress is absorbed (no LLM call); a user message to the captain wakes it.
    const before = h.llm.calls;
    for (let i = 0; i < 5; i++) h.bus.emit("progress", { goalId, sessionId: b, data: { text: `working ${i}` } });
    await h.wake.idle();
    expect(h.llm.calls).toBe(before);
    expect((await call("POST", "/captain/messages", { user: userId, body: { goalId, text: "tell C use the summary from A" } })).status).toBe(202);
    await h.wake.idle();
    expect(h.llm.calls).toBeGreaterThan(before);
    expect(h.sessions.calls).toContain(`message:${c}`);
    h.wake.flushAbsorbed();
    const log = await call("GET", `/captain/log?goalId=${goalId}`, { user: userId });
    expect(log.body.woken).toBe(1);
    expect(log.body.absorbed).toBeGreaterThanOrEqual(5);
    const actions = (log.body.entries as { kind: string; text: string }[]).filter((e) => e.kind === "action");
    expect(actions.some((e) => e.text.startsWith("message_session"))).toBe(true);
    expect(log.body.entries.some((e: { kind: string; text: string }) => e.kind === "absorbed" && /progress ×5/.test(e.text))).toBe(true);

    // Direct user → session message (DATA).
    expect((await call("POST", `/sessions/${b}/messages`, { user: userId, body: { text: "prefer vendors in Malaysia" } })).status).toBe(201);

    // Mandate widening goes through the decision ledger.
    const raise = await call("POST", `/sessions/${b}/raise`, { user: userId, body: { addTUSD: "1.5" } });
    expect(raise.body.decision.status).toBe("open");
    const open = await call("GET", "/decisions?status=open", { user: userId });
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toMatchObject({ kind: "budget_raise", letter: "B", sessionId: b });
    expect(open.body[0].details.addMicro).toBe("1500000");
    expect((await call("GET", "/decisions?status=open", { user: other })).body).toHaveLength(0);
    const decided = await call("POST", `/decisions/${open.body[0].id}`, { user: userId, body: { status: "rejected", note: "not now" } });
    expect(decided.body.status).toBe("rejected");
    expect((await call("GET", "/decisions?status=open", { user: userId })).body).toHaveLength(0);

    expect((await call("POST", `/sessions/${a}/pause`, { user: userId })).body).toMatchObject({ ok: true, status: "PAUSED" });
    expect((await call("POST", `/sessions/${a}/explode`, { user: userId })).status).toBe(404);
    expect((await call("POST", "/sessions/pause-all", { user: userId })).body.paused).toBe(2);

    const map = await call("GET", "/agent-map", { user: userId });
    expect(map.body.captain).toMatchObject({ name: "Captain", model: "mock" });
    expect(map.body.captain.contextTokens).toBeGreaterThan(0);
    expect(map.body.cards).toHaveLength(3);
    expect(map.body.cards[0]).toMatchObject({ kind: "session", goalId });

    const spending = await call("GET", "/spending", { user: userId });
    expect(spending.body.perSession).toHaveLength(3);
    expect(spending.body.totals).toHaveProperty("topupFeesMyr");
    expect(spending.body.balanceHistory.length).toBeGreaterThan(0);
    const logbook = await call("GET", "/logbook", { user: userId });
    expect(Array.isArray(logbook.body)).toBe(true);
    expect((await call("POST", "/topups", { user: userId, body: { amountMYR: "50" } })).status).toBe(503); // no on-ramp wired in this test

    // SSE: replays from ?after= and streams.
    const ctrl = new AbortController();
    const res = await h.app.request(`/events/stream?goalId=${goalId}&after=0`, { headers: { "x-engine-token": TOKEN, "x-user-id": userId }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let got = "";
    while (!got.includes("goal_created")) got += new TextDecoder().decode((await reader.read()).value);
    expect(got).toMatch(/event: ready/);
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    await h.wake.stop();
  });
});
