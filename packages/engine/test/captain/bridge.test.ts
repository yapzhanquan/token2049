// Trust surface (Firstmate-style communication): plan rationale, `why` on every captain action, structured outcome
// reports with deterministic risk + evidence, /bearings, /ahoy, and "escalate only real decisions". MockLLM only.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, goals, payments, sessions as sessionsT } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import { renderReportText, type AhoyDTO, type BearingsDTO, type CaptainReportData, type GoalSummary, type PlanRationale } from "@bulkhead/shared";
import { createApi } from "../../src/api";
import { CaptainAgent, isRoutineWake, wrapHandback } from "../../src/captain/captain";
import { WakeFilter } from "../../src/captain/wake";
import { OutcomeReporter } from "../../src/captain/reports";
import { buildPlanRationale, rationaleFromPlanJson } from "../../src/captain/rationale";
import { runCaptainTool, type CaptainToolContext } from "../../src/captain/tools";
import { deriveWhy, failureSummary } from "../../src/captain/why";
import { acceptLine } from "../../src/captain/wording";
import { MockLLM, mockPlan } from "../../src/llm/mock";
import { createPlanner, modelRationale } from "../../src/planner";
import type { Engine, LLM, LLMResponse, Signer, SiloRunner } from "../../src/contracts";
import { CATALOG, harness, seedGoal, seedUser } from "./helpers";

afterEach(() => closeDb());

const TX = (c: string) => c.repeat(64).slice(0, 64);
const reportsOf = (h: { bus: { since(n: number): { type: string; data: Record<string, unknown> }[] } }) =>
  h.bus.since(0).filter((e) => e.type === "captain_report" && typeof e.data.kind === "string").map((e) => e.data as unknown as CaptainReportData);

/** An LLM that never acts (the deterministic fallback must still fill `why`). */
class SilentLLM implements LLM {
  readonly name = "mock" as const;
  calls = 0;
  async complete(): Promise<LLMResponse> {
    this.calls++;
    return { text: "No action needed.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

/** A wording model that invents a number (must be rejected → deterministic headline). */
class LyingLLM implements LLM {
  readonly name = "mock" as const;
  calls = 0;
  async complete(): Promise<LLMResponse> {
    this.calls++;
    return { text: "A finished and saved you 999 tUSD", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

function setup(opts: { llm?: LLM; reporterLlm?: LLM | null } = {}) {
  const h = harness();
  const llm = opts.llm ?? new MockLLM();
  const planner = createPlanner({ llm, market: h.market, chain: h.chain, db: h.db, walletMode: "vault" });
  const captain = new CaptainAgent({ ...h, llm, planner });
  const filter = new WakeFilter({ bus: h.bus, captain, db: h.db, sessions: h.sessions }, { debounceMs: 5, absorbFlushMs: 60_000, watchdog: { loopFailures: 4, stallMs: 60_000 }, stallCheckMs: 60_000 });
  filter.start({ replay: false });
  const reporter = new OutcomeReporter({ db: h.db, bus: h.bus, decisions: h.decisions, llm: opts.reporterLlm === undefined ? new MockLLM() : opts.reporterLlm, wording: "llm" });
  reporter.start();
  const userId = seedUser(h.db);
  const goalId = seedGoal(h.db, userId);
  const a = h.sessions.insert(goalId, userId, { name: "Blockfrost limits", role: "researcher", taskType: "research", dataScope: ["https://docs.blockfrost.io/"] });
  const b = h.sessions.insert(goalId, userId, { name: "Buy summary", role: "buyer", taskType: "buy_pay", budgetTUSD: "5", perPaymentMaxTUSD: "3", approvalThresholdTUSD: "1" });
  h.db.update(sessionsT).set({ dataScopeJson: JSON.stringify(["https://docs.blockfrost.io/"]), walletMode: "vault" }).where(eq(sessionsT.id, a)).run();
  const settle = async () => {
    await filter.idle();
    await reporter.idle();
    await filter.idle();
    await reporter.idle();
  };
  return { ...h, llm, captain, filter, reporter, userId, goalId, a, b, settle };
}

const setHandback = (h: ReturnType<typeof setup>, id: string, hb: Record<string, unknown>, patch: Partial<typeof sessionsT.$inferInsert> = {}) =>
  h.db.update(sessionsT).set({ handbackJson: JSON.stringify({ flags: [], sources: [], ...hb }), ...patch }).where(eq(sessionsT.id, id)).run();

// ───────────────────────────── 1. plan rationale ─────────────────────────────
describe("plan rationale", () => {
  it("the planner stores a plain-language rationale per goal (why these sessions, parallel vs dependent, budget, guards)", async () => {
    const h = setup();
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    const r = await h.captain.plan({ userId: h.userId, goal: "Research competitors and hire a market-research agent, then pay for a summary", budgetTUSD: "10", deadline, rules: "" });
    const rat = r.rationale as PlanRationale;
    expect(rat.source).toBe("planner"); // the mock planner's own one-liner passed validation
    expect(rat.summary).toMatch(/start at once/);
    expect(rat.sessions.map((s) => s.letter)).toEqual(["A", "B", "C"]);
    expect(rat.sessions[2]).toMatchObject({ runs: "after", after: ["A"] });
    expect(rat.sessions[0].why).toMatch(/no pay tool/);
    expect(rat.sessions[1].why).toMatch(/Hires Market Research \(2 /);
    expect(rat.parallelism).toMatch(/A and B start at once; C waits for A's handback because it pays based on those findings/);
    expect(rat.budget).toMatch(/^10 of 10 \S+ allocated \(A 1, B 4\.5, C 4\.5\)/);
    expect(rat.guards[0]).toMatch(/Session Vault \(Aiken, Plutus V3\)/);
    expect(rat.guards.join(" ")).toMatch(/CIP-20 \(label 674\)/);
    // Persisted on the goal + announced with the plan.
    const g = h.db.select().from(goals).where(eq(goals.id, r.goalId)).get()!;
    expect(JSON.parse(g.planJson).rationale.summary).toBe(rat.summary);
    expect(h.bus.since(0).find((e) => e.type === "plan_proposed")?.data.rationale).toBeTruthy();
  });

  it("rejects a model rationale that invents numbers; rebuilds one for goals planned before rationales existed", () => {
    const plan = mockPlan({ goal: "x", budgetTUSD: "10" }, CATALOG) as never as Parameters<typeof modelRationale>[1];
    expect(modelRationale(JSON.stringify({ rationale: "Three sessions; saves 70% of the budget", sessions: [] }), plan, "10")).toBeNull();
    expect(modelRationale(JSON.stringify({ rationale: "Two research parts run in parallel." }), plan, "10")).toBe("Two research parts run in parallel.");
    const old = rationaleFromPlanJson(JSON.stringify({ ...plan, rationale: undefined, payeeLabels: { "market-research": "Market Research" } }), "10000000", "native");
    expect(old?.source).toBe("deterministic");
    expect(old?.guards[0]).toMatch(/native script/);
    const single = buildPlanRationale({ plan: { sessions: [{ ...plan.sessions[0], contextFrom: [] }] }, budgetTUSD: "4" });
    expect(single.parallelism).toMatch(/One session/);
    expect(single.budget).toMatch(/stays unallocated/);
  });
});

// ───────────────────────────── 2. captain action why ─────────────────────────────
describe("captain_action.why", () => {
  it("model acts without a why → derived from the evidence: 'A hit 4 consecutive HTTP 404s; redirected A to docs.blockfrost.io'", async () => {
    const h = setup();
    for (let i = 0; i < 4; i++) h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.a, data: { url: `https://docs.blockfrost.io/guess-${i}`, status: 404 } });
    await h.settle();
    const action = h.bus.since(0).find((e) => e.type === "captain_action" && e.data.tool === "message_session")!;
    expect(action.data.whySource).toBe("auto");
    expect(action.data.why).toBe("A hit 4 consecutive HTTP 404s; redirected A to docs.blockfrost.io");
    // `why` never leaks into the tool input.
    expect((action.data.input as Record<string, unknown>).why).toBeUndefined();
  });

  it("the deterministic fallback ladder fills why on redirect and on kill", async () => {
    const h = setup({ llm: new SilentLLM() });
    const burst = () => {
      for (let i = 0; i < 4; i++) h.bus.emit("tool_denied", { goalId: h.goalId, sessionId: h.a, data: { tool: "pay", taskType: "research" } });
    };
    for (let i = 0; i < 3; i++) {
      burst();
      await h.settle();
    }
    const acts = h.bus.since(0).filter((e) => e.type === "captain_action");
    expect(acts.every((e) => typeof e.data.why === "string" && String(e.data.why).length > 10)).toBe(true);
    expect(acts.map((e) => e.data.why)).toEqual([
      "A hit 4 denied tool calls (pay); redirected A to docs.blockfrost.io",
      "A hit 4 denied tool calls (pay); told A to wrap up and hand back what it has",
      "A hit 4 denied tool calls (pay) even after 2 redirect(s); stopped A, its leftover funds return to your treasury",
    ]);
    expect(acts.every((e) => e.data.auto === true && e.data.whySource === "auto")).toBe(true);
    // The kill became ONE structured incident report (no duplicate free-text report).
    const incident = reportsOf(h).find((r) => r.kind === "incident")!;
    expect(incident).toMatchObject({ letter: "A", risk: "medium", notify: true });
    expect(incident.headline).toMatch(/^I stopped A \(researcher\): stuck after 2 redirect/);
    expect(h.bus.since(0).filter((e) => e.type === "captain_report" && !e.data.kind)).toHaveLength(0);
  });

  it("a model-written why is kept (whySource: model)", async () => {
    const h = setup();
    const ctx: CaptainToolContext = { db: h.db, bus: h.bus, sessions: h.sessions, decisions: h.decisions, market: h.market, wrapHandback, userId: h.userId, goalId: h.goalId, planGoal: async () => ({ goalId: "", sessions: 0, totalTusd: "0" }) };
    await runCaptainTool("pause_session", { sessionId: "B", why: "B's payee list changed upstream; pausing until the user confirms" }, ctx);
    const a = h.bus.since(0).find((e) => e.type === "captain_action")!;
    expect(a.data).toMatchObject({ tool: "pause_session", ok: true, whySource: "model", why: "B's payee list changed upstream; pausing until the user confirms" });
    expect(failureSummary(["HTTP 404 a", "blocked b (x)", "HTTP 500 c"])).toBe("3 failed tool calls (HTTP 404 ×1, blocked fetch ×1, HTTP 500 ×1)");
    expect(deriveWhy({ tool: "report_to_user", input: { text: "hi" }, events: [] })).toBe("Reported to you");
  });
});

// ───────────────────────────── 3. outcome reports ─────────────────────────────
describe("captain_report (structured outcome reports)", () => {
  it("accepted handback → session_result: plain headline, low risk, DoD + handback hash + sources + vault evidence, not pushed", async () => {
    const h = setup();
    setHandback(h, h.a, { result: "50k/day", summary: "Blockfrost free tier allows 50k requests/day", sources: ["https://blockfrost.io/pricing", "https://docs.blockfrost.io/"] });
    await h.sessions.transition(h.a, "COMPLETING", "handback");
    h.bus.emit("handback_submitted", { goalId: h.goalId, sessionId: h.a, data: { summary: "x" } });
    await h.settle();
    const r = reportsOf(h).filter((x) => x.kind === "session_result");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "session_result", goalId: h.goalId, sessionId: h.a, letter: "A", risk: "low", notify: false, wording: "llm", userId: h.userId });
    expect(r[0].headline).toBe("A (researcher) finished: Blockfrost free tier allows 50k requests/day");
    expect(r[0].headline.length).toBeLessThanOrEqual(120);
    expect(r[0].riskReason).toMatch(/definition of done met first time; 2 sources/);
    expect(r[0].evidence.map((e) => e.kind)).toEqual(["dod", "handback_hash", "source", "source", "vault"]);
    expect(r[0].evidence[1].ref).toMatch(/^[0-9a-f]{64}$/);
    expect(r[0].evidence.at(-1)?.url).toMatch(/^https:\/\/preprod\.cardanoscan\.io\/address\/addr_test1/);
    expect(r[0].text).toBe(renderReportText(r[0]));
    // Replays never duplicate it.
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: h.a, data: {} });
    await h.settle();
    expect(reportsOf(h).filter((x) => x.kind === "session_result")).toHaveLength(1);
  });

  it("risk rules: DoD failed once → high; quarantine → high; unconfirmed payment → high; single source + gaps → medium", async () => {
    const h = setup();
    setHandback(h, h.a, { result: "r", summary: "found it", sources: ["https://a.example"], flags: ["pricing page was down"] }, { doneAttempts: 0 });
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: h.a, data: {} });
    await h.settle();
    let r = reportsOf(h).find((x) => x.sessionId === h.a)!;
    expect(r.risk).toBe("medium");
    expect(r.riskReason).toMatch(/reports gaps: pricing page was down; the result rests on a single source/);
    expect(r.notify).toBe(true);

    const c = h.sessions.insert(h.goalId, h.userId, { name: "Second try", role: "researcher", taskType: "research" });
    setHandback(h, c, { result: "r", summary: "ok", sources: ["https://a.example", "https://b.example"] }, { doneAttempts: 1 });
    h.bus.emit("handback_rejected", { goalId: h.goalId, sessionId: c, data: { reason: "research needs at least 1 source" } });
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: c, data: {} });
    await h.settle();
    r = reportsOf(h).find((x) => x.sessionId === c)!;
    expect(r.risk).toBe("high");
    expect(r.riskReason).toMatch(/first handback failed the definition of done/);

    setHandback(h, h.b, { result: "paid", summary: "paid the summariser", txHashes: [TX("a")] });
    h.db.insert(payments).values({ id: "p1", sessionId: h.b, payee: "addr_test1xyz", amountMicro: "2000000", status: "submitted", txHash: TX("a"), createdAt: Date.now(), updatedAt: Date.now() }).run();
    h.bus.emit("tainted", { goalId: h.goalId, sessionId: h.b, data: { url: "https://evil.example", reason: "prompt injection", quarantine: true } });
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: h.b, data: {} });
    await h.settle();
    r = reportsOf(h).find((x) => x.kind === "session_result" && x.sessionId === h.b)!;
    expect(r.risk).toBe("high");
    expect(r.riskReason).toMatch(/quarantined.*1 payment\(s\) not yet confirmed on-chain/);
    expect(r.evidence.find((e) => e.kind === "tx")).toMatchObject({ ref: TX("a"), url: `https://preprod.cardanoscan.io/transaction/${TX("a")}` });
    expect(r.headline).toMatch(/^B \(buyer\) paid 2 \S+ in 1 payment: paid the summariser/);
  });

  it("the LLM may only re-word from the facts: an invented number falls back to the deterministic headline", async () => {
    const h = setup({ reporterLlm: new LyingLLM() });
    setHandback(h, h.a, { result: "r", summary: "Koios has a public tier", sources: ["https://koios.rest", "https://api.koios.rest"] });
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: h.a, data: {} });
    await h.settle();
    const r = reportsOf(h)[0];
    expect(r.wording).toBe("deterministic");
    expect(r.headline).toBe("A (researcher) finished: Koios has a public tier");
    expect(acceptLine("A finished; 2 sources", { sources: 2 }, "draft", 120)).toBe("A finished; 2 sources");
    expect(acceptLine("tx abcdef0123456789 confirmed", {}, "draft", 120)).toBeNull();
  });

  it("goal_completed → goal_result with close txs + handback hashes; kills/quarantines → incidents; approvals → escalations", async () => {
    const h = setup();
    for (const [id, closeTx] of [
      [h.a, TX("c")],
      [h.b, TX("d")],
    ] as const) {
      setHandback(h, id, { result: "r", summary: `done ${id.slice(-3)}`, sources: ["https://x.example", "https://y.example"] }, { closeStatus: "COMPLETED", closeTx, handbackSha256: TX("e"), refundMicro: "500000", spentMicro: "1000000" });
    }
    await h.sessions.transition(h.a, "CLOSED", "swept");
    await h.sessions.transition(h.b, "CLOSED", "swept");
    await h.settle();
    const g = reportsOf(h).find((r) => r.kind === "goal_result")!;
    expect(g.headline).toMatch(/^Goal done: 2\/2 sessions met their definition of done; spent 2 of 10 /);
    expect(g.risk).toBe("low");
    expect(g.notify).toBe(true);
    expect(g.evidence.filter((e) => e.kind === "tx").map((e) => e.ref)).toEqual([TX("c"), TX("d")]);
    expect(g.evidence.find((e) => e.kind === "handback_hash")?.url).toBe(`https://preprod.cardanoscan.io/transaction/${TX("c")}`);
    expect(g.next).toMatch(/1 \S+ came back to your treasury/);

    // Escalation: a payment above the approval threshold (opened by the Signer) → question + recommendation.
    const h2 = setup();
    h2.decisions.open({ sessionId: h2.b, kind: "payment_approval", requestedBy: "session", refKey: "p9", details: { paymentId: "p9", payee: "summariser", amountMicro: "3000000", amountTUSD: "3" } });
    // A raise the USER opened in the UI is not an escalation (they are already deciding).
    h2.decisions.open({ sessionId: h2.a, kind: "budget_raise", requestedBy: "captain", refKey: "budget_raise:1", details: { initiator: "user", addMicro: "1000000" } });
    await h2.settle();
    const esc = reportsOf(h2).filter((r) => r.kind === "escalation");
    expect(esc).toHaveLength(1);
    expect(esc[0].headline).toMatch(/^Approve a 3 \S+ payment from B to summariser\?/);
    expect(esc[0].recommendation?.action).toBe("approve");
    expect(esc[0].next).toMatch(/^Recommended: approve — summariser is on B's payee list/);
    expect(esc[0].decisionId).toBeTruthy();

    // Quarantine → ONE high-risk incident carrying the decision + "keep it stopped".
    h2.decisions.open({ sessionId: h2.a, kind: "quarantine_release", requestedBy: "session", refKey: "quarantine", details: { url: "https://evil.example/x", reason: "prompt injection" } });
    await h2.settle();
    const q = reportsOf(h2).find((r) => r.kind === "incident")!;
    expect(q).toMatchObject({ risk: "high", letter: "A", notify: true });
    expect(q.headline).toBe("A (researcher) quarantined: it read flagged content on evil.example");
    expect(q.recommendation?.action).toBe("reject");
    expect(reportsOf(h2).filter((r) => r.kind === "escalation")).toHaveLength(1); // not double-reported

    // User kill: recorded, not pushed.
    await h2.sessions.kill(h2.b, "user", "killed by user: not needed");
    await h2.settle();
    const k = reportsOf(h2).find((r) => r.kind === "incident" && r.sessionId === h2.b)!;
    expect(k).toMatchObject({ risk: "low", notify: false, headline: "You stopped B (buyer)" });
  });
});

// ───────────────────────────── 4 + 5. bearings + ahoy over HTTP ─────────────────────────────
function api(h: ReturnType<typeof setup>, reportsDir: string) {
  const engine: Engine = {
    db: h.db,
    chain: h.chain,
    bus: h.bus,
    sessions: h.sessions,
    silos: {} as SiloRunner,
    signer: {} as Signer,
    decisions: h.decisions,
    market: h.market,
    llm: h.llm,
    captain: h.captain,
    wrapHandback,
  };
  const app = createApi({ engine, myrPerTusd: "4.70", reportsDir, captainInfo: () => ({ name: "Captain", model: "mock", contextTokens: 0, totalTokens: 0 }) });
  return async <T>(method: string, path: string, body?: unknown, user = h.userId): Promise<{ status: number; body: T }> => {
    const res = await app.request(path, { method, headers: { "x-user-id": user, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as T };
  };
}

describe("GET /bearings, POST /bearings/file", () => {
  it("deterministic four-part digest from DB + chain: needs you (ranked, with recommendation), done, in flight, money", async () => {
    const h = setup();
    const call = api(h, mkdtempSync(join(tmpdir(), "bulkhead-reports-")));
    setHandback(h, h.a, { result: "r", summary: "Blockfrost: 50k req/day", sources: ["https://blockfrost.io", "https://docs.blockfrost.io"] }, { status: "CLOSED", closeStatus: "COMPLETED", closeTx: TX("f"), refundMicro: "250000", spentMicro: "0", endedAt: Date.now() });
    h.db.update(sessionsT).set({ spentMicro: "1000000", fundingTx: TX("1") }).where(eq(sessionsT.id, h.b)).run();
    h.db.insert(payments).values({ id: "p2", sessionId: h.b, payee: "addr_test1q", amountMicro: "1000000", status: "submitted", txHash: TX("2"), createdAt: Date.now(), updatedAt: Date.now() }).run();
    h.decisions.open({ sessionId: h.b, kind: "payment_approval", requestedBy: "session", refKey: "p3", details: { paymentId: "p3", payee: "summariser", amountMicro: "2000000" } });
    const planned = seedGoal(h.db, h.userId, null, "planned");
    await h.settle();

    const { status, body } = await call<BearingsDTO>("GET", "/bearings");
    expect(status).toBe(200);
    expect(body.needsYou[0]).toMatchObject({ sessionId: h.b, risk: "low", recommendation: { action: "approve" } });
    expect(body.needsYou[0].text).toMatch(/^Approve a 2 \S+ payment from B to summariser\? Recommended: approve/);
    expect(body.needsYou.some((n) => n.goalId === planned && /Approve & start/.test(n.text))).toBe(true);
    expect(body.done[0]).toMatchObject({ letter: "A", risk: "low" });
    expect(body.done[0].text).toMatch(/^A \(researcher\) delivered: Blockfrost: 50k req\/day/);
    expect(body.done[0].refs.map((r) => r.kind)).toEqual(["tx", "handback_hash"]);
    expect(body.inFlight.map((i) => i.letter)).not.toContain("B"); // B waits on the user → needs you, not in flight
    expect(body.money).toMatchObject({ budget: "10", spent: "1", returned: "0.25", pendingTx: 1 });
    expect(body.money.pendingTxs[0].ref).toBe(TX("2"));
    expect(["chain", "db"]).toContain(body.money.inVaultsSource);
    expect(body.overall).toMatchObject({ source: "deterministic" });
    expect(body.overall.text).toMatch(/^2 things need you; 0 in flight, 1 done; 1 of 10 \S+ spent, 0.25 returned, 1 tx pending\.$/);

    const judged = await call<BearingsDTO>("GET", `/bearings?goalId=${h.goalId}&judge=1`);
    expect(judged.body.goalId).toBe(h.goalId);
    expect(judged.body.overall.source).toBe("llm");
    expect((await call("GET", `/bearings?goalId=${h.goalId}`, undefined, seedUser(h.db))).status).toBe(404); // scoped per user
  });

  it("file mode writes one dated markdown report (replaced on re-run)", async () => {
    const h = setup();
    const dir = mkdtempSync(join(tmpdir(), "bulkhead-reports-"));
    const call = api(h, dir);
    const first = await call<{ ok: boolean; path: string; file: string }>("POST", "/bearings/file", { goalId: h.goalId });
    expect(first.status).toBe(201);
    expect(first.body.file).toMatch(new RegExp(`^bearings-${new Date().toISOString().slice(0, 10)}-[A-Za-z0-9]{1,8}-[A-Za-z0-9]{8}\\.md$`));
    const md = readFileSync(first.body.path, "utf8");
    expect(md).toMatch(/^# Bearings - \w+ \d{4}-\d{2}-\d{2}/);
    for (const s of ["## Needs you", "## Done", "## In flight", "## Money"]) expect(md).toContain(s);
    expect(md).toContain("Nothing has finished recently.");
    const again = await call<{ path: string }>("POST", "/bearings/file", { goalId: h.goalId });
    expect(again.body.path).toBe(first.body.path);
  });
});

describe("GET /ahoy, POST /ahoy/seen", () => {
  it("recaps since the seen-marker (grouped, routine counted) + every open decision ranked by impact", async () => {
    const h = setup();
    const call = api(h, tmpdir());
    // Before any marker: falls back to the user's last message to the captain.
    await h.captain.userMessage(h.userId, h.goalId, "status?");
    await h.settle();
    let a = (await call<AhoyDTO>("GET", "/ahoy")).body;
    expect(a.since.kind).toBe("last_message");

    const seen = await call<{ seenEventId: number }>("POST", "/ahoy/seen", { eventId: a.latestEventId });
    expect(seen.body.seenEventId).toBe(a.latestEventId);
    a = (await call<AhoyDTO>("GET", "/ahoy")).body;
    expect(a.since.kind).toBe("marker");
    expect(a.nothingHappened).toBe(true);
    expect(a.headline.text).toMatch(/^Nothing happened since you last checked/);

    // Things happen while the user is away.
    for (let i = 0; i < 5; i++) h.bus.emit("progress", { goalId: h.goalId, sessionId: h.a, data: { text: `step ${i}` } });
    setHandback(h, h.a, { result: "r", summary: "Blockfrost: 50k req/day", sources: ["https://a.example", "https://b.example"] });
    h.bus.emit("handback_accepted", { goalId: h.goalId, sessionId: h.a, data: {} });
    h.bus.emit("payment_confirmed", { goalId: h.goalId, sessionId: h.b, data: { txHash: TX("9"), amountMicro: "1500000", amountTUSD: "1.5" } });
    // Two open decisions: a small payment, and a quarantine with the whole budget at stake + an imminent expiry.
    h.decisions.open({ sessionId: h.b, kind: "payment_approval", requestedBy: "session", refKey: "p4", details: { paymentId: "p4", payee: "summariser", amountMicro: "1100000" } });
    const c = h.sessions.insert(h.goalId, h.userId, { name: "Scraper", role: "researcher", taskType: "research", budgetTUSD: "4" });
    h.db.update(sessionsT).set({ expiresAt: Date.now() + 10 * 60_000, status: "QUARANTINED" }).where(eq(sessionsT.id, c)).run();
    h.decisions.open({ sessionId: c, kind: "quarantine_release", requestedBy: "session", refKey: "quarantine", details: { url: "https://evil.example", reason: "prompt injection" } });
    await h.settle();

    a = (await call<AhoyDTO>("GET", "/ahoy")).body;
    expect(a.nothingHappened).toBe(false);
    const keys = a.groups.map((g) => g.key);
    expect(keys[0]).toBe("reports");
    expect(keys).toContain("money");
    expect(keys.at(-1)).toBe("routine");
    const outcomes = a.groups[0].items.map((i) => i.text);
    expect(outcomes[0]).toMatch(/quarantined.*risk high/); // highest risk first
    expect(outcomes.some((t) => /A \(researcher\) finished: Blockfrost/.test(t))).toBe(true);
    expect(a.groups.find((g) => g.key === "money")?.items[0].text).toMatch(/^B: 1 payment confirmed on-chain \(1\.5 /);
    expect(a.groups.find((g) => g.key === "routine")?.items[0].text).toMatch(/progress notes ×5/);
    // Ranked: the quarantine (security + expiry in 10 min + whole budget) outranks the small payment.
    expect(a.decisions.map((d) => d.kind)).toEqual(["quarantine_release", "payment_approval"]);
    expect(a.decisions[0].impactReason).toMatch(/4 \S+ at stake.*C's wallet expires in 10 min.*blocks C.*security/);
    expect(a.decisions[0].recommendation.action).toBe("reject");
    expect(a.decisions[0].impactScore).toBeGreaterThan(a.decisions[1].impactScore);
    expect(a.headline.text).toMatch(/^Since you last checked.*: 3 outcomes \(1 high risk\).*1\.5 \S+ paid\. 2 decisions wait for you — first: Release C from quarantine\?/);

    const judged = (await call<AhoyDTO>("GET", "/ahoy?judge=1")).body;
    expect(judged.headline.source).toBe("llm");

    // Marking seen clears the recap but never the open decisions.
    await call("POST", "/ahoy/seen", {});
    a = (await call<AhoyDTO>("GET", "/ahoy")).body;
    expect(a.nothingHappened).toBe(true);
    expect(a.decisions).toHaveLength(2);
    expect(a.headline.text).toMatch(/^Nothing new happened since you last checked.*but 2 decisions wait for you/);
  });
});

// ───────────────────────────── 6. escalate only real decisions ─────────────────────────────
describe("escalate only real decisions", () => {
  it("routine wakes are recorded, not pushed; routine events never create decisions or reports", async () => {
    expect(isRoutineWake([{ id: 1, at: 0, type: "topup_confirmed", data: {} }], {})).toBe(true);
    expect(isRoutineWake([{ id: 1, at: 0, type: "handback_submitted", sessionId: "s", data: {} }], { s: { accepted: true } })).toBe(true);
    expect(isRoutineWake([{ id: 1, at: 0, type: "handback_submitted", sessionId: "s", data: {} }], { s: { accepted: false } })).toBe(false);
    expect(isRoutineWake([{ id: 1, at: 0, type: "user_message", data: {} }], {})).toBe(false);
    expect(isRoutineWake([{ id: 1, at: 0, type: "goal_completed", data: {} }], {})).toBe(false);

    const h = setup();
    // A mid-goal accepted handback: the mock captain chats about it, but that chat is not pushed.
    await h.sessions.transition(h.a, "COMPLETING", "handback");
    setHandback(h, h.a, { result: "r", summary: "found", sources: ["https://a.example", "https://b.example"] });
    h.bus.emit("handback_submitted", { goalId: h.goalId, sessionId: h.a, data: { summary: "found" } });
    await h.settle();
    const chat = h.bus.since(0).filter((e) => e.type === "captain_report" && !e.data.kind);
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((e) => e.data.notify === false && e.data.routine === true)).toBe(true);
    // A user message is always answered with notify=true.
    await h.captain.userMessage(h.userId, h.goalId, "how is it going?");
    await h.settle();
    expect(h.bus.since(0).filter((e) => e.type === "captain_report" && !e.data.kind).at(-1)?.data.notify).toBe(true);

    // Routine noise: no decisions, no reports.
    const before = { d: h.decisions.list().length, r: reportsOf(h).length };
    for (let i = 0; i < 10; i++) {
      h.bus.emit("web_fetch", { goalId: h.goalId, sessionId: h.b, data: { url: `https://x.example/${i}`, status: 200 } });
      h.bus.emit("tainted", { goalId: h.goalId, sessionId: h.b, data: { url: `https://x.example/${i}`, reason: "read external content", quarantine: false } });
      h.bus.emit("payment_confirmed", { goalId: h.goalId, sessionId: h.b, data: { txHash: TX("7"), amountMicro: "1" } });
    }
    await h.settle();
    expect(h.decisions.list().length).toBe(before.d);
    expect(reportsOf(h).length).toBe(before.r);

    // The captain cannot open a decision about a session that is finishing / gone, or release a non-quarantined one.
    const ctx: CaptainToolContext = { db: h.db, bus: h.bus, sessions: h.sessions, decisions: h.decisions, market: h.market, wrapHandback, userId: h.userId, goalId: h.goalId, planGoal: async () => ({ goalId: "", sessions: 0, totalTusd: "0" }) };
    const closedOut = await runCaptainTool("request_user_approval", { kind: "budget_raise", sessionId: "A", reason: "more", amountTUSD: "1" }, ctx);
    expect(closedOut).toMatchObject({ ok: false });
    const notQ = await runCaptainTool("request_user_approval", { kind: "quarantine_release", sessionId: "B", reason: "x" }, ctx);
    expect(notQ).toMatchObject({ ok: false, error: "session B is not quarantined" });
    expect(h.decisions.list({ status: "open" })).toHaveLength(0);
  });

  it("GET /goals exposes the rationale (rebuilt for goals planned before rationales existed)", async () => {
    const h = setup();
    const call = api(h, tmpdir());
    const plan = mockPlan({ goal: "x", budgetTUSD: "10" }, CATALOG);
    const old = seedGoal(h.db, h.userId, { sessions: plan.sessions } as never, "planned");
    const list = (await call<GoalSummary[]>("GET", "/goals")).body;
    const g = list.find((x) => x.id === old)!;
    expect(g.rationale?.sessions).toHaveLength(3);
    expect(g.rationale?.parallelism).toMatch(/C waits for A's handback/);
  });
});
