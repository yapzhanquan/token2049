// Workstream D: confirmation depth in the engine's waits + ADA Handle payees (plan time and mandate edits).
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, goals, sessions as sessionsT } from "@bulkhead/db";
import type { Chain, ChainEvent, HandleResolver } from "@bulkhead/chain";
import { waitForTx, isFinal } from "../src/sessions-store";
import { createPlanner, PlanError, resolvePlanHandles, validatePlan } from "../src/planner";
import type { LLM, LLMResponse } from "../src/contracts";
import { mockPlan } from "../src/llm/mock";
import { CATALOG, harness, seedUser } from "./captain/helpers";
import { PAYEE_1, PAYEE_2, setup, spec, waitFor } from "./runtime/helpers";

afterEach(() => closeDb());

// ── fake handle resolver (the real one is tested against mocked Blockfrost in packages/chain/test/handle.test.ts)
class HandleNotFound extends Error {
  code = "not_found";
}
function fakeHandles(map: Record<string, string>, calls: string[] = []): HandleResolver {
  return {
    async resolve(h) {
      calls.push(h);
      const name = h.trim().toLowerCase();
      if (name === "$twins") throw Object.assign(new Error("ADA Handle $twins is held by 2 addresses on preprod; refusing an ambiguous payee"), { code: "ambiguous" });
      const address = map[name];
      if (!address) throw new HandleNotFound(`ADA Handle ${name} was not found on preprod`);
      return { handle: name, address, resolvedAt: 1_700_000_000_000, unit: "f0ff…000de140" + Buffer.from(name.slice(1)).toString("hex"), standard: "cip68", source: "blockfrost" };
    },
  };
}

describe("waitForTx: CONFIRMATIONS depth + rollback", () => {
  function fakeChain(need: number) {
    const listeners = new Set<(e: ChainEvent) => void>();
    let reading: { blockHeight: number; slot: number; confirmations?: number } | null = null;
    const chain = {
      confirmations: need,
      watcher: { on: (l: (e: ChainEvent) => void) => (listeners.add(l), () => listeners.delete(l)), watchTx: () => {} },
      provider: { fetchTxConfirmation: async () => reading },
    } as unknown as Chain;
    return { chain, emit: (e: ChainEvent) => listeners.forEach((l) => l(e)), set: (r: typeof reading) => (reading = r) };
  }

  it("isFinal: depth-less readings count (already gated); explicit depth must reach N", () => {
    expect(isFinal(null, 2)).toBe(false);
    expect(isFinal({}, 2)).toBe(true);
    expect(isFinal({ confirmations: 1 }, 2)).toBe(false);
    expect(isFinal({ confirmations: 2 }, 2)).toBe(true);
  });

  it("waits through tx_pending and a rollback; resolves only at depth ≥ N", async () => {
    const f = fakeChain(3);
    const depths: number[] = [];
    let done = false;
    const p = waitForTx(f.chain, "h1", { timeoutMs: 2_000, pollMs: 10, onDepth: (n) => depths.push(n) }).then((ok) => ((done = true), ok));
    f.set({ blockHeight: 10, slot: 1, confirmations: 1 });
    f.emit({ type: "tx_pending", txHash: "h1", slot: 1, blockHeight: 10, confirmations: 1, required: 3 });
    f.emit({ type: "tx_confirmed", txHash: "h1", slot: 1, confirmations: 2 }); // below N (stale/other watcher): ignored
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    f.set(null);
    f.emit({ type: "tx_rolled_back", txHash: "h1", blockHeight: 10 });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    f.set({ blockHeight: 12, slot: 3, confirmations: 3 });
    expect(await p).toBe(true);
    expect(depths).toEqual([1, 0]);
  });

  it("times out (false) when the tx never reaches N", async () => {
    const f = fakeChain(2);
    f.set({ blockHeight: 10, slot: 1, confirmations: 1 });
    expect(await waitForTx(f.chain, "h2", { timeoutMs: 60, pollMs: 10 })).toBe(false);
  });

  it("a tx_confirmed event at depth ≥ N resolves immediately", async () => {
    const f = fakeChain(2);
    const p = waitForTx(f.chain, "h3", { timeoutMs: 2_000, pollMs: 1_000 });
    f.emit({ type: "tx_confirmed", txHash: "h3", slot: 1, confirmations: 2 });
    expect(await p).toBe(true);
  });
});

function scripted(text: string): LLM {
  return {
    name: "mock",
    calls: 0,
    async complete(): Promise<LLMResponse> {
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  };
}
const deadline = () => new Date(Date.now() + 2 * 3600_000).toISOString();

function planWithPayees(payees: string[]) {
  const p = mockPlan({ goal: "x", budgetTUSD: "10", deadline: deadline() }, CATALOG) as { sessions: Array<{ taskType: string; allowedPayees: string[] }> };
  const buy = p.sessions.find((s) => s.taskType === "buy_pay")!;
  buy.allowedPayees = payees;
  return p;
}

describe("planner: $handle payee-resolution step", () => {
  it("resolves $handles at plan time, pins {handle, address, resolvedAt}, labels them", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const calls: string[] = [];
    const llm = scripted(JSON.stringify(planWithPayees(["$Test", CATALOG[1].id, "$test"])));
    const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db, handles: fakeHandles({ $test: PAYEE_1 }, calls) });
    const { plan, payeeHandles, payeeLabels } = await planner.plan({ userId, goal: "x", budgetTUSD: "10", deadline: deadline(), rules: "pay $test" });
    const buy = plan.sessions.find((s) => s.taskType === "buy_pay")!;
    expect(buy.allowedPayees).toEqual(["$test", CATALOG[1].id, "$test"]);
    expect(payeeHandles).toEqual({ $test: expect.objectContaining({ handle: "$test", address: PAYEE_1, resolvedAt: 1_700_000_000_000, standard: "cip68" }) });
    expect(payeeLabels.$test).toMatch(/^\$test \(addr_test1/);
    expect(calls).toEqual(["$test"]); // one lookup per distinct handle
  });

  it("rejects unresolvable and ambiguous handles with a clear message", async () => {
    const h = harness();
    const userId = seedUser(h.db);
    const llm = scripted(JSON.stringify(planWithPayees(["$ghost", "$twins"])));
    const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db, handles: fakeHandles({}) });
    const err = await planner.plan({ userId, goal: "x", budgetTUSD: "10", deadline: deadline(), rules: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.message).toMatch(/ADA Handle payee could not be resolved/);
    expect(err.issues).toEqual(["ADA Handle $ghost was not found on preprod", "ADA Handle $twins is held by 2 addresses on preprod; refusing an ambiguous payee"]);
  });

  it("invalid handle syntax is a validation issue; no resolver → clear refusal", async () => {
    const bad = validatePlan(JSON.stringify(planWithPayees(["$not valid"])), { totalMicro: 10_000_000n, deadlineMs: Date.now() + 3 * 3600_000, catalog: CATALOG });
    expect(bad.ok).toBe(false);
    expect((bad as { issues: string[] }).issues.join()).toMatch(/not a valid ADA Handle/);
    const ok = validatePlan(JSON.stringify(planWithPayees(["$x"])), { totalMicro: 10_000_000n, deadlineMs: Date.now() + 3 * 3600_000, catalog: CATALOG });
    expect(ok.ok).toBe(true);
    const r = await resolvePlanHandles((ok as { plan: Parameters<typeof resolvePlanHandles>[0] }).plan, undefined);
    expect(r).toEqual({ ok: false, issues: ["$x: ADA Handle resolution is not available (no chain data source configured)"] });
  });
});

describe("sessions: handle payees are pinned at plan time and resolved on mandate edits", () => {
  let h: Awaited<ReturnType<typeof setup>> | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it("session creation uses the plan-pinned address; widen_mandate resolves a new $handle; unknown handles are refused", async () => {
    h = await setup();
    const calls: string[] = [];
    Object.assign(h.chain, { handles: fakeHandles({ $test: STALE, $hello: PAYEE_2 }, calls) });
    const goalId = h.newGoal();
    h.db.update(goals).set({ planJson: JSON.stringify({ payeeHandles: { $test: { handle: "$test", address: PAYEE_1, resolvedAt: 123 } } }) }).where(eq(goals.id, goalId)).run();
    const [id] = await h.sessions.startPlan(goalId, {
      sessions: [spec({ name: "Buyer", taskType: "buy_pay", agentType: "buyer", role: "buyer", allowedPayees: ["$test"], dataScope: [] })],
    });
    await waitFor(() => h!.sessions.get(id!)!.status === "RUNNING", 10_000, "running");
    const row = h.sessions.get(id!)!;
    // pinned: the approved PAYEE_1, not today's holder (STALE)
    expect(row.allowedPayees).toEqual([{ id: "$test", label: "$test", address: PAYEE_1, handle: "$test", resolvedAt: 123 }]);
    expect(calls).toEqual([]);
    expect((await h.signer.pay(id!, { payee: "$test", amountMicro: 1_000_000n, memo: "by handle" })).kind).toBe("submitted");

    const d = h.decisions.open({ sessionId: id!, kind: "widen_mandate", requestedBy: "captain", refKey: "w1", details: { addPayees: ["$hello"] } });
    await h.decisions.decide(d.id, "approved", "user");
    await waitFor(() => h!.sessions.get(id!)!.allowedPayees.length === 2, 5_000, "widened");
    expect(h.sessions.get(id!)!.allowedPayees[1]).toEqual({ id: "$hello", label: "$hello", address: PAYEE_2, handle: "$hello", resolvedAt: 1_700_000_000_000 });

    const d2 = h.decisions.open({ sessionId: id!, kind: "widen_mandate", requestedBy: "captain", refKey: "w2", details: { addPayees: ["$ghost"] } });
    await h.decisions.decide(d2.id, "approved", "user");
    await waitFor(() => h!.events("error").some((e) => e.data.kind === "decision_effect_failed"), 5_000, "refusal");
    expect(String(h.events("error").find((e) => e.data.kind === "decision_effect_failed")!.data.error)).toMatch(/\$ghost was not found on preprod/);
    expect(JSON.parse(h.db.select().from(sessionsT).where(eq(sessionsT.id, id!)).get()!.allowedPayeesJson)).toHaveLength(2);
  });
});

const STALE = "addr_test1vz" + "9".repeat(50);
