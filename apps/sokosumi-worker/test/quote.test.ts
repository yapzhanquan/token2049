import { describe, expect, it } from "vitest";
import { computeQuote, parseDeadline, parseOrder } from "../src/quote";
import { QUOTE_CFG } from "./fakes";

const NOW = Date.parse("2026-10-07T10:00:00Z");

describe("quote", () => {
  it("price = crew budget + fee", () => {
    expect(computeQuote(5_000_000n, QUOTE_CFG)).toEqual({ crewBudgetMicro: 5_000_000n, feeMicro: 500_000n, quoteMicro: 5_500_000n, capped: false });
  });
  it("caps the price at MAX_QUOTE_TUSDM by shrinking the crew budget", () => {
    expect(computeQuote(19_500_000n, QUOTE_CFG)).toMatchObject({ quoteMicro: 20_000_000n, capped: false });
    expect(computeQuote(50_000_000n, QUOTE_CFG)).toEqual({ crewBudgetMicro: 19_500_000n, feeMicro: 500_000n, quoteMicro: 20_000_000n, capped: true });
  });
  it("rejects a cap that does not exceed the fee, and non-positive budgets", () => {
    expect(() => computeQuote(1n, { feeMicro: 500_000n, maxQuoteMicro: 500_000n })).toThrow(/exceed/);
    expect(() => computeQuote(0n, QUOTE_CFG)).toThrow(/positive/);
  });
});

describe("parseOrder", () => {
  it("reads goal, budget and deadline lines", () => {
    const o = parseOrder("Find three Kuala Lumpur venues for a 40-person meetup.\nBudget: 3.25 tUSDM\nDeadline: 2026-10-07T14:00:00Z", QUOTE_CFG, NOW);
    expect(o.goal).toBe("Find three Kuala Lumpur venues for a 40-person meetup.");
    expect(o.crewBudgetMicro).toBe("3250000");
    expect(o.quoteMicro).toBe("3750000");
    expect(o.deadlineMs).toBe(Date.parse("2026-10-07T14:00:00Z"));
    expect(o.capped).toBe(false);
  });
  it("explicit Goal: line, relative deadline, inline budget", () => {
    const o = parseOrder("Goal: compare preprod faucets\nwith a budget of 1.5 tUSDM\nDeadline: in 90 minutes", QUOTE_CFG, NOW);
    expect(o.goal).toBe("compare preprod faucets");
    expect(o.crewBudgetMicro).toBe("1500000");
    expect(o.deadlineMs).toBe(NOW + 90 * 60_000);
  });
  it("defaults budget and deadline and notes them; caps large budgets", () => {
    const d = parseOrder("Summarise CIP-68", QUOTE_CFG, NOW);
    expect(d.crewBudgetMicro).toBe("2000000");
    expect(d.deadlineMs).toBe(NOW + 120 * 60_000);
    expect(d.notes.join(" ")).toMatch(/default crew budget/);
    const c = parseOrder("Big job\nBudget: 100", QUOTE_CFG, NOW);
    expect(c).toMatchObject({ crewBudgetMicro: "19500000", quoteMicro: "20000000", capped: true, requestedBudgetMicro: "100000000" });
  });
  it("clamps a too-close deadline and rejects empty goals", () => {
    expect(parseOrder("x\nDeadline: 1m", QUOTE_CFG, NOW).deadlineMs).toBe(NOW + 15 * 60_000);
    expect(() => parseOrder("Budget: 2\nDeadline: 2h", QUOTE_CFG, NOW)).toThrow(/no goal/);
    expect(() => parseOrder("   ", QUOTE_CFG, NOW)).toThrow(/empty/);
  });
  it("parseDeadline handles units and junk", () => {
    expect(parseDeadline("2h", NOW)).toBe(NOW + 7_200_000);
    expect(parseDeadline("3 days", NOW)).toBe(NOW + 3 * 86_400_000);
    expect(parseDeadline("soon", NOW)).toBeNull();
  });
});
