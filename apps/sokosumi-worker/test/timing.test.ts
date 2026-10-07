// Escrow + crew timing: MPS times at the minimums MPS accepts (masumi-payment-service
// src/routes/api/payments/index.ts), PAY_BY ≥ 12 min (the preprod escrow lock took ~9 min), crew works 60 s.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { MPS_MIN_PAYBY_TO_SUBMIT_MS, MPS_MIN_SUBMIT_AHEAD_MS, MPS_MIN_UNLOCK_GAP_MS, minResultDeadline, mpsTimes, parseOrder, type PaymentTiming } from "../src/quote";
import { QUOTE_CFG } from "./fakes";

const NOW = Date.parse("2026-10-07T10:00:00Z");
const MIN = 60_000;
const T: PaymentTiming = { payByMs: 12 * MIN, workMs: 60_000, resultMarginMs: 3 * MIN };
const CFG = { ...QUOTE_CFG, defaultDeadlineMs: 0, timing: T };

/** The exact checks MPS runs on POST /payment (and /purchase). */
function mpsAccepts(now: number, t: ReturnType<typeof mpsTimes>): boolean {
  const pay = t.payByTime.getTime();
  const submit = t.submitResultTime.getTime();
  const unlock = t.unlockTime.getTime();
  const dispute = t.externalDisputeUnlockTime.getTime();
  return pay <= submit - MPS_MIN_PAYBY_TO_SUBMIT_MS && pay >= now - 5 * MIN && submit >= now + MPS_MIN_SUBMIT_AHEAD_MS && unlock >= submit + MPS_MIN_UNLOCK_GAP_MS && dispute >= unlock + MPS_MIN_UNLOCK_GAP_MS;
}

describe("MPS minimum times", () => {
  it("pay-by 12 min; result deadline = max(15 min, pay-by + 5 min, pay-by + work + margin) + 1 min skew = 18 min", () => {
    expect(minResultDeadline(NOW, T)).toBe(NOW + 18 * MIN);
    const t = mpsTimes(NOW, 0, T);
    expect(t.payByTime.getTime()).toBe(NOW + 12 * MIN);
    expect(t.submitResultTime.getTime()).toBe(NOW + 18 * MIN);
    expect(t.unlockTime.getTime()).toBe(NOW + 34 * MIN);
    expect(t.externalDisputeUnlockTime.getTime()).toBe(NOW + 50 * MIN);
    // Accepted by MPS even when it receives the request up to a minute later.
    expect(mpsAccepts(NOW, t)).toBe(true);
    expect(mpsAccepts(NOW + 59_000, t)).toBe(true);
  });

  it("the crew still gets its 60 s + margin when the escrow locks at the last pay-by moment", () => {
    const t = mpsTimes(NOW, 0, T);
    expect(t.submitResultTime.getTime() - t.payByTime.getTime()).toBeGreaterThanOrEqual(T.workMs + T.resultMarginMs);
  });

  it("a later Task deadline only pushes the result deadline out", () => {
    const later = NOW + 2 * 3_600_000;
    const t = mpsTimes(NOW, later, T);
    expect(t.submitResultTime.getTime()).toBe(later);
    expect(mpsAccepts(NOW, t)).toBe(true);
  });
});

describe("quote with the MPS minimum", () => {
  it("a Task deadline under the MPS minimum is raised with a note; the crew works 60 s after escrow locks", () => {
    const o = parseOrder("Summarise CIP-68\nDeadline: 5m", CFG, NOW);
    expect(o.deadlineMs).toBe(NOW + 18 * MIN);
    expect(o.notes.join(" ")).toMatch(/raised to the minimum of 18 minutes \(the payment service needs/);
    expect(o.notes.join(" ")).toMatch(/Crew works for 60 s after escrow locks/);
  });
  it("no deadline → the minimum (no raise note); a far deadline is kept", () => {
    const d = parseOrder("Summarise CIP-68", CFG, NOW);
    expect(d.deadlineMs).toBe(NOW + 18 * MIN);
    expect(d.notes.join(" ")).not.toMatch(/raised/);
    expect(parseOrder("Summarise CIP-68\nDeadline: 2h", CFG, NOW).deadlineMs).toBe(NOW + 2 * 3_600_000);
  });
});

describe("worker timing config", () => {
  const base = { SOKOSUMI_COWORKER_ID: "cw", ENGINE_TOKEN: "t" } as NodeJS.ProcessEnv;
  it("defaults: pay-by 12 min, crew 60 s, margin 3 min, default deadline = the minimum", () => {
    const c = loadConfig(base);
    expect(c.runner.payByMs).toBe(12 * MIN);
    expect(c.runner.workMs).toBe(60_000);
    expect(c.runner.resultMarginMs).toBe(3 * MIN);
    expect(c.runner.quote.defaultDeadlineMs).toBe(0);
    expect(c.runner.quote.timing).toEqual({ payByMs: 12 * MIN, workMs: 60_000, resultMarginMs: 3 * MIN });
  });
  it("PAY_BY_MINUTES below 12 is raised to 12 (the escrow lock took ~9 min)", () => {
    expect(loadConfig({ ...base, PAY_BY_MINUTES: "5" }).runner.payByMs).toBe(12 * MIN);
    expect(loadConfig({ ...base, PAY_BY_MINUTES: "20", WORK_DEADLINE_SECONDS: "90" }).runner).toMatchObject({ payByMs: 20 * MIN, workMs: 90_000 });
  });
});

describe("paid Task with the minimum MPS times", () => {
  const cfg = { quote: { ...CFG }, payByMs: 12 * MIN, workMs: 60_000, resultMarginMs: 3 * MIN };
  it("requests pay-by 12 min / result 18 min, starts the crew once escrow locks (~9 min), goal bound = result − margin", async () => {
    const { makeRig } = await import("./fakes");
    const rig = makeRig({ paid: true, cfg });
    const t0 = rig.clock.t;
    rig.soko.addTask("t1", "Research preprod DEX liquidity\nBudget: 4 tUSDM\nDeadline: 5m");
    const r = rig.runner();
    let j = (await r.process(rig.soko.task("t1")))!;
    const terms = rig.gate.calls.find((c) => c.op === "terms")!.arg as { payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date };
    expect(terms.payByTime.getTime()).toBe(t0 + 12 * MIN);
    expect(terms.submitResultTime.getTime()).toBe(t0 + 18 * MIN);
    expect(mpsAccepts(t0, terms)).toBe(true);
    expect(j.order!.notes.join(" ")).toMatch(/Crew works for 60 s after escrow locks/);
    rig.clock.t = t0 + 9 * MIN; // the escrow lock took ~9 min on preprod
    rig.gate.lockFunds("bi_1", true);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    const goal = rig.engine.calls.find((c) => c.op === "createGoal")!.arg as { deadline: string };
    expect(Date.parse(goal.deadline)).toBe(t0 + 15 * MIN);
  });
  it("escrow locked too late for 60 s of work + the close margin → crew not started", async () => {
    const { makeRig } = await import("./fakes");
    const rig = makeRig({ paid: true, cfg });
    const t0 = rig.clock.t;
    rig.soko.addTask("t2", "Research preprod DEX liquidity\nBudget: 4 tUSDM");
    const r = rig.runner();
    await r.process(rig.soko.task("t2"));
    rig.clock.t = t0 + 14 * MIN + 30_000; // 18 − 14.5 = 3.5 min < 60 s + 3 min
    rig.gate.lockFunds("bi_1", true);
    const j = (await r.process(rig.soko.task("t2")))!;
    expect(rig.engine.count("createGoal")).toBe(0);
    expect(j.phase).toBe("failed");
  });
});
