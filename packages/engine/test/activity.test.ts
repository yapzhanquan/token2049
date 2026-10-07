// GET /activity: unified feed + search by every key type (FakeChain, in-process Hono, no network).
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { agentJobs, closeDb, decisions as decisionsT, kv, payments, topups } from "@bulkhead/db";
import type { ActivityDTO } from "@bulkhead/shared";
import { createApi } from "../src/api";
import type { Engine, Signer, SiloRunner } from "../src/contracts";
import { stakingKvKey } from "../src/staking";
import { harness, seedGoal, seedUser } from "./captain/helpers";
import { fakeAddress } from "./fake-chain";

afterEach(() => closeDb());

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

function setup() {
  const h = harness();
  const engine = {
    db: h.db,
    chain: h.chain,
    bus: h.bus,
    sessions: h.sessions,
    silos: {} as SiloRunner,
    signer: {} as Signer,
    decisions: h.decisions,
    market: h.market,
    llm: { name: "mock" },
    captain: {},
    wrapHandback: () => "",
  } as unknown as Engine;
  const app = createApi({ engine, myrPerTusd: "4.70", chainLabel: "fake", captainInfo: () => ({ name: "c", model: "m", contextTokens: 0, totalTokens: 0 }) });
  const now = Date.now();
  const userId = seedUser(h.db);
  const other = seedUser(h.db);
  const goalId = seedGoal(h.db, userId);
  const otherGoal = seedGoal(h.db, other);
  const A = h.sessions.insert(goalId, userId, { role: "researcher", taskType: "research" });
  const B = h.sessions.insert(goalId, userId, { role: "buyer", taskType: "hire_agent" });
  const X = h.sessions.insert(otherGoal, other, { role: "spy" });
  const fundTx = hex("fund");
  const payTx = hex("pay");
  const closeTx = hex("close");
  const topTx = hex("top");
  const stakeTx = hex("stake");
  const otherTx = hex("other");
  const payee = fakeAddress("agent:mr");
  const addrB = h.sessions.get(B)!.address!;
  const { bus, db } = h;

  bus.emit("session_funded", { goalId, sessionId: A, data: { phase: "submitted", txHash: fundTx, budgetMicro: "1000000" } });
  bus.emit("session_funded", { goalId, sessionId: A, data: { phase: "confirmed", txHash: fundTx, budgetMicro: "1000000" } });
  bus.emit("progress", { goalId, sessionId: A, data: { kind: "log", level: "info", text: "reading sources" } });
  db.insert(payments).values({ id: "pay_abc123", sessionId: B, payee, amountMicro: "2000000", memo: "hire", status: "confirmed", txHash: payTx, createdAt: now, updatedAt: now }).run();
  db.insert(agentJobs).values({ id: "job_xyz789", sessionId: B, serviceId: "market-research", externalJobId: "ext-42", input: "x", priceMicro: "2000000", paymentId: "pay_abc123", status: "completed", createdAt: now, updatedAt: now }).run();
  db.insert(decisionsT).values({ id: "dec_q1w2e3", sessionId: B, kind: "payment_approval", requestedBy: "session", refKey: "pay_abc123", detailsJson: JSON.stringify({ paymentId: "pay_abc123", amountMicro: "2000000" }), status: "approved", createdAt: now }).run();
  bus.emit("agent_hired", { goalId, sessionId: B, data: { jobRowId: "job_xyz789", jobId: "ext-42", serviceId: "market-research", paymentAddress: payee, priceMicro: "2000000" } });
  bus.emit("decision_opened", { goalId, sessionId: B, data: { decisionId: "dec_q1w2e3", kind: "payment_approval", details: { paymentId: "pay_abc123", amountMicro: "2000000" } } });
  bus.emit("payment_requested", { goalId, sessionId: B, data: { paymentId: "pay_abc123", payee, amountMicro: "2000000" } });
  bus.emit("decision_closed", { goalId, sessionId: B, data: { decisionId: "dec_q1w2e3", kind: "payment_approval", status: "approved" } });
  bus.emit("payment_submitted", { goalId, sessionId: B, data: { paymentId: "pay_abc123", txHash: payTx, payee, amountMicro: "2000000" } });
  bus.emit("payment_confirmed", { goalId, sessionId: B, data: { paymentId: "pay_abc123", txHash: payTx, payee, amountMicro: "2000000" } });
  bus.emit("agent_job_paid", { goalId, sessionId: B, data: { jobRowId: "job_xyz789", jobId: "ext-42", serviceId: "market-research", txHash: payTx, paymentId: "pay_abc123" } });
  bus.emit("agent_job_result", { goalId, sessionId: B, data: { jobRowId: "job_xyz789", jobId: "ext-42", serviceId: "market-research", resultHash: "r", preview: "done" } });
  bus.emit("close_confirmed", { goalId, sessionId: A, data: { txHash: closeTx, refundMicro: "400000" } });
  db.insert(topups).values({ id: "top_m1n2b3", userId, amountMyr: "10.00", feeMyr: "0.15", tusdMicro: "2095744", simulated: true, status: "confirmed", txHash: topTx, createdAt: now, updatedAt: now }).run();
  bus.emit("topup_pending", { data: { topupId: "top_m1n2b3", userId, amountMyr: "10.00", simulated: true } });
  bus.emit("topup_confirmed", { data: { topupId: "top_m1n2b3", userId, txHash: topTx, tusdMicro: "2095744" } });
  bus.emit("captain_report", { goalId, data: { text: "all good", userId } });
  db.insert(kv).values({ key: stakingKvKey(userId), value: JSON.stringify({ txs: [{ kind: "setup", txHash: stakeTx, at: now, certs: ["stake_registration"], feeLovelace: "1", depositDeltaLovelace: "2000000", confirmed: true }] }) }).run();
  // Another user's activity must never leak.
  bus.emit("payment_confirmed", { goalId: otherGoal, sessionId: X, data: { paymentId: "pay_other", txHash: otherTx, payee, amountMicro: "5" } });
  bus.emit("topup_confirmed", { data: { topupId: "top_other", userId: other, txHash: otherTx, tusdMicro: "5" } });

  const get = async (qs: string, user = userId) => {
    const res = await app.request(`/activity${qs}`, { headers: { "x-user-id": user } });
    return { status: res.status, body: (await res.json()) as ActivityDTO };
  };
  return { ...h, app, get, userId, goalId, A, B, X, fundTx, payTx, closeTx, topTx, stakeTx, otherTx, payee, addrB };
}

describe("GET /activity", () => {
  it("returns a collapsed, newest-first, user-scoped feed", async () => {
    const t = setup();
    const { status, body } = await t.get("");
    expect(status).toBe(200);
    const ats = body.rows.map((r) => r.at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    expect(body.rows.some((r) => r.txHash === t.otherTx)).toBe(false);
    // One row per payment / job / decision / top-up / funding tx.
    expect(body.rows.filter((r) => r.paymentId === "pay_abc123" && r.kind === "payment")).toHaveLength(1);
    expect(body.rows.filter((r) => r.kind === "hire")).toHaveLength(1);
    expect(body.rows.filter((r) => r.kind === "decision")).toHaveLength(1);
    expect(body.rows.filter((r) => r.kind === "topup")).toHaveLength(1);
    expect(body.rows.filter((r) => r.kind === "funding")).toHaveLength(1);
    const pay = body.rows.find((r) => r.kind === "payment")!;
    expect(pay).toMatchObject({ status: "confirmed", txHash: t.payTx, direction: "out", amountMicro: "2000000", letter: "B" });
    const hire = body.rows.find((r) => r.kind === "hire")!;
    expect(hire).toMatchObject({ agentJobId: "job_xyz789", externalJobId: "ext-42", status: "completed", txHash: t.payTx });
    expect(body.rows.find((r) => r.kind === "decision")!.status).toBe("approved");
    expect(body.rows.find((r) => r.kind === "close")).toMatchObject({ direction: "in", amountMicro: "400000", txHash: t.closeTx });
    expect(body.rows.find((r) => r.kind === "topup")).toMatchObject({ direction: "in", status: "confirmed", txHash: t.topTx });
    expect(body.rows.find((r) => r.kind === "staking")).toMatchObject({ txHash: t.stakeTx, status: "confirmed" });
  });

  it("filters by tab group and paginates with before", async () => {
    const t = setup();
    const pays = (await t.get("?type=payments")).body.rows;
    expect(pays.length).toBeGreaterThan(0);
    expect(pays.every((r) => r.kind === "payment" || r.kind === "rejection")).toBe(true);
    const fund = (await t.get("?type=funding")).body.rows;
    expect(new Set(fund.map((r) => r.kind))).toEqual(new Set(["funding", "close", "topup", "staking"]));
    expect((await t.get("?type=captain")).body.rows.every((r) => r.kind === "captain")).toBe(true);
    const p1 = (await t.get("?limit=3")).body;
    expect(p1.rows).toHaveLength(3);
    expect(p1.nextBefore).not.toBeNull();
    const p2 = (await t.get(`?limit=3&before=${p1.nextBefore}`)).body;
    expect(p2.rows.length).toBeGreaterThan(0);
    const ids1 = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.some((r) => ids1.has(r.id))).toBe(false);
  });

  it("searches by session id, id prefix and letter", async () => {
    const t = setup();
    const full = (await t.get(`?q=${t.B}`)).body;
    expect(full.match).toMatchObject({ type: "session", value: t.B });
    expect(full.rows.length).toBeGreaterThanOrEqual(8); // uncollapsed history
    expect(full.rows.every((r) => r.sessionId === t.B)).toBe(true);
    expect((await t.get(`?q=${t.B.slice(0, 8)}`)).body.match?.value).toBe(t.B);
    const letter = (await t.get(`?q=a&goalId=${t.goalId}`)).body;
    expect(letter.match).toMatchObject({ type: "letter", value: t.A });
    expect(letter.rows.every((r) => r.sessionId === t.A)).toBe(true);
  });

  it("searches by agent job id and external job id", async () => {
    const t = setup();
    for (const q of ["job_xyz789", "ext-42"]) {
      const b = (await t.get(`?q=${q}`)).body;
      expect(b.match).toMatchObject({ type: "agent_job", value: "job_xyz789" });
      expect(b.rows.filter((r) => r.kind === "hire")).toHaveLength(3);
      expect(b.rows.some((r) => r.kind === "payment" && r.status === "confirmed")).toBe(true);
    }
  });

  it("searches by tx hash (in DB) and falls back to a live chain lookup", async () => {
    const t = setup();
    const b = (await t.get(`?q=${t.payTx}`)).body;
    expect(b.match).toMatchObject({ type: "tx", value: t.payTx });
    expect(b.match?.chain ?? null).toBeNull();
    expect(b.rows.map((r) => r.kind).sort()).toEqual(["hire", "payment", "payment"]);
    expect((await t.get(`?q=${t.stakeTx}`)).body.rows[0]).toMatchObject({ kind: "staking" });
    // Another user's tx is not theirs: no DB rows, only the public chain summary.
    const o = (await t.get(`?q=${t.otherTx}`)).body;
    expect(o.rows).toHaveLength(0);
    expect(o.match?.chain).toMatchObject({ found: false });
    // Confirmed on the (fake) chain → found with a block height.
    const conf = t.chain.txs[0];
    if (conf) {
      t.chain.tick();
      const c = (await t.get(`?q=${conf.txHash}`)).body;
      expect(c.match?.chain).toMatchObject({ found: true });
    }
  });

  it("searches by decision id, payment id and top-up id", async () => {
    const t = setup();
    const d = (await t.get("?q=dec_q1w2e3")).body;
    expect(d.match).toMatchObject({ type: "decision" });
    expect(d.rows.filter((r) => r.kind === "decision").map((r) => r.status).sort()).toEqual(["approved", "open"]);
    const p = (await t.get("?q=pay_abc")).body;
    expect(p.match).toMatchObject({ type: "payment", value: "pay_abc123" });
    expect(p.rows.filter((r) => r.kind === "payment").map((r) => r.status).sort()).toEqual(["confirmed", "pending", "requested"]);
    const tp = (await t.get("?q=top_m1n2b3")).body;
    expect(tp.match).toMatchObject({ type: "topup" });
    expect(tp.rows).toHaveLength(2);
  });

  it("searches by address: session wallet, payee and treasury", async () => {
    const t = setup();
    const s = (await t.get(`?q=${t.addrB}`)).body;
    expect(s.match).toMatchObject({ type: "address", label: expect.stringContaining("Session B") });
    expect(s.rows.every((r) => r.sessionId === t.B)).toBe(true);
    const p = (await t.get(`?q=${t.payee}`)).body;
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.rows.every((r) => r.sessionId !== t.X)).toBe(true);
    const treasury = (await t.get(`?q=${fakeAddress(`treasury:${t.userId}`)}`)).body;
    expect(treasury.match?.label).toBe("Your treasury");
    expect(new Set(treasury.rows.map((r) => r.kind))).toEqual(new Set(["funding", "close", "topup", "staking"]));
    expect((await t.get("?q=addr1qxyz")).status).toBe(400);
  });

  it("is user-scoped: another user's ids and goals are invisible", async () => {
    const t = setup();
    const other = await t.get(`?q=${t.X}`);
    expect(other.body.match?.type).not.toBe("session");
    expect(other.body.rows.some((r) => r.sessionId === t.X)).toBe(false);
    expect((await t.get(`?q=pay_other`)).body.rows).toHaveLength(0);
    expect((await t.get(`?q=bad%20value`)).status).toBe(400);
  });
});
