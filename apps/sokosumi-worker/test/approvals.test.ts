import { describe, expect, it } from "vitest";
import { judgeDecision } from "../src/approvals";
import { makeRig } from "./fakes";

const ctx = { crewBudgetMicro: 3_000_000n, extraAllowanceMicro: 0n, floatMicro: 2_000_000n, spentMicro: 1_000_000n, deadlineMs: 10_000 };

describe("judgeDecision", () => {
  it("approves payments and raises only within the quoted crew budget", () => {
    expect(judgeDecision({ kind: "payment_approval", details: { amountMicro: "2000000" } }, ctx).action).toBe("approve");
    expect(judgeDecision({ kind: "payment_approval", details: { amountMicro: "2000001" } }, ctx).action).toBe("ask");
    expect(judgeDecision({ kind: "budget_raise", details: { addMicro: "1000000" } }, ctx).action).toBe("approve");
    expect(judgeDecision({ kind: "budget_raise", details: { addMicro: "1000001" } }, ctx).action).toBe("ask");
    expect(judgeDecision({ kind: "budget_raise", details: { addMicro: "1000001" } }, { ...ctx, extraAllowanceMicro: 1n }).action).toBe("approve");
  });
  it("never auto-approves unbounded kinds or unreadable amounts", () => {
    expect(judgeDecision({ kind: "quarantine_release", details: {} }, ctx).action).toBe("ask");
    expect(judgeDecision({ kind: "widen_mandate", details: {} }, ctx).action).toBe("ask");
    expect(judgeDecision({ kind: "payment_approval", details: { amountMicro: "1.5" } }, ctx).action).toBe("ask");
    expect(judgeDecision({ kind: "extend_expiry", details: { newExpiresAt: 9_000 } }, ctx).action).toBe("approve");
    expect(judgeDecision({ kind: "extend_expiry", details: { newExpiresAt: 11_000 } }, ctx).action).toBe("ask");
  });
});

describe("budget-bounded auto-approval in the runner", () => {
  async function running() {
    const rig = makeRig();
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 3 tUSDM"); // plan funds 2 tUSDM (2 × 1)
    const r = rig.runner();
    const j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    return { rig, r, goalId: j.goalId! };
  }

  it("approves within budget, asks above it, and an owner 'approve n tUSDM' unlocks it", async () => {
    const { rig, r, goalId } = await running();
    const ok = rig.engine.openDecision(goalId, "A", "payment_approval", { amountMicro: "800000" });
    const big = rig.engine.openDecision(goalId, "B", "budget_raise", { addMicro: "2000000" }); // float 2 + 2 > 3
    await r.process(rig.soko.task("t1"));
    expect(ok.status).toBe("approved");
    expect(big.status).toBe("open");
    const asks = rig.soko.calls.filter((c) => c.op === "comment");
    expect(asks).toHaveLength(1);
    expect(String(asks[0].arg)).toMatch(/approve 2 tUSDM/);

    await r.process(rig.soko.task("t1")); // still waiting: no second ask
    expect(rig.soko.count("comment")).toBe(1);

    rig.soko.userComment("t1", "approve 1 tUSDM");
    await r.handleComments(rig.soko.task("t1"));
    await r.process(rig.soko.task("t1"));
    expect(big.status).toBe("approved"); // 2 + 2 ≤ 3 + 1
  });

  it("rejects an asked decision after the ask timeout", async () => {
    const { rig, r, goalId } = await running();
    const d = rig.engine.openDecision(goalId, "A", "quarantine_release", { url: "x" });
    await r.process(rig.soko.task("t1"));
    expect(d.status).toBe("open");
    rig.clock.t += 11 * 60_000;
    await r.process(rig.soko.task("t1"));
    expect(d.status).toBe("rejected");
  });

  it("an uncertain decision write is not repeated", async () => {
    const { rig, r, goalId } = await running();
    const d = rig.engine.openDecision(goalId, "A", "payment_approval", { amountMicro: "1" });
    rig.engine.fail.decide = new Error("socket hang up");
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/hang up/);
    delete rig.engine.fail.decide;
    await r.process(rig.soko.task("t1"));
    expect(rig.engine.count("decide")).toBe(1);
    expect(d.status).toBe("open");
    expect(rig.store.load("t1")!.decisions[d.id].state).toBe("uncertain");
  });
});
