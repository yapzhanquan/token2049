// Full wiring smoke: wireEngine (real runtime: bus, ledger, signer, silos, sessions, supervisor, on-ramp)
// + FakeChain + MockLLM + captain + API, driven through app.request. FakeChain = nothing on-chain.
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@bulkhead/db";
import { createApi } from "../../src/api";
import { wireEngine, type WiredEngine } from "../../src/wire";
import { MockLLM } from "../../src/llm/mock";
import { createFakeChain } from "../fake-chain";
import { freshDb, stubMarket } from "./helpers";

let engine: WiredEngine | null = null;
afterAll(async () => {
  await engine?.shutdown();
  closeDb();
});

describe("wired engine (FakeChain)", () => {
  it("boots, tops up (simulated fiat), plans, approves and runs sessions in parallel; captain wakes only on actionable events", async () => {
    const db = freshDb();
    // Treasury starts with ADA for min-UTxO + fees (the simulated top-up adds tUSD + 2 ADA).
    const chain = createFakeChain({ autoConfirmMs: 20, treasuryStart: { tusdMicro: 0n, lovelace: 50_000_000n } });
    const llm = new MockLLM();
    engine = await wireEngine({ db, chain, llm, market: stubMarket, config: { txPollMs: 50, heartbeatMs: 1_000 } });
    await engine.boot();
    const e = engine;
    const app = createApi({ engine: e, onramp: e.onramp, token: "t", myrPerTusd: "4.70", captainInfo: e.captainInfo, wakeStats: () => e.wake.stats });
    const call = async (method: string, path: string, user?: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "x-engine-token": "t", "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const health = await call("GET", "/health");
    expect(health.body).toMatchObject({ ok: true, network: "preprod", llm: "mock" });

    const userId = (await call("POST", "/users", undefined, { email: "w@example.com", custody: "custodial" })).body.userId as string;
    const top = await call("POST", "/topups", userId, { amountMYR: "50", simulated: true });
    expect(top.status).toBe(201);
    const confirmed = await call("POST", `/topups/${top.body.topupId}/confirm`, userId, {});
    expect(confirmed.status).toBe(200);
    const again = await call("POST", `/topups/${top.body.topupId}/confirm`, userId, {}); // idempotent
    expect(again.body.topup.id).toBe(confirmed.body.topup.id);

    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await call("POST", "/goals", userId, { goal: "Research competitors", budgetTUSD: "6", deadline, rules: "" });
    expect(planned.status).toBe(201);
    expect(planned.body.plan.sessions.map((s: { taskType: string }) => s.taskType)).toEqual(["research", "hire_agent", "buy_pay"]);

    const approved = await call("POST", `/goals/${planned.body.goalId}/approve`, userId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.sessionIds).toHaveLength(3);

    const map = await call("GET", "/agent-map", userId);
    expect(map.body.cards.filter((x: { kind: string }) => x.kind === "session")).toHaveLength(3);
    const tree = await call("GET", `/goals/${planned.body.goalId}/tree`, userId);
    expect(tree.status).toBe(200);
    // Funding / session_created / transitions to RUNNING / progress are routine: they never wake the captain.
    await e.wake.idle();
    const wakeTriggers = e.bus.since(0).filter((x) => x.type === "captain_woken").map((x) => String(x.data.trigger));
    for (const t of wakeTriggers) expect(["session_created", "session_funded", "progress", "plan_approved", "payment_submitted", "heartbeat"]).not.toContain(t);
    // Let the crew run: wait until every session is CLOSED (mock silos finish quickly on the FakeChain).
    const ids = approved.body.sessionIds as string[];
    const deadlineMs = Date.now() + 45_000;
    while (Date.now() < deadlineMs && !ids.every((id) => e.sessions.get(id)?.status === "CLOSED")) await new Promise((r) => setTimeout(r, 200));
    await e.wake.idle();
    const statuses = ids.map((id) => e.sessions.get(id)?.status);
    const types = e.bus.since(0).map((x) => x.type);
    expect(statuses).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
    const tools = e.bus.since(0).filter((x) => x.type === "captain_action").map((x) => String(x.data.tool));
    expect(tools).toContain("read_status"); // the captain read each handback (as data) after it was woken
    expect(e.bus.since(0).filter((x) => x.type === "captain_woken").map((x) => String(x.data.trigger))).toContain("handback_submitted");
    expect(types).toContain("handback_submitted");
    e.wake.flushAbsorbed();
    const absorbed = e.bus.since(0).filter((x) => x.type === "captain_absorbed").reduce((s, x) => s + Number(x.data.count), 0);
    expect(absorbed).toBeGreaterThan(5);
  }, 60_000);
});
