import { afterEach, describe, expect, it } from "vitest";
import { REJECTION_REASONS, type PayDecision, type RejectionReason } from "@bulkhead/shared";
import { PAYEE_1, PAYEE_2, STRANGER, setup, spec, startPlan, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const buyer = (over = {}) =>
  spec({ taskType: "buy_pay", role: "buyer", agentType: "buyer", allowedPayees: [PAYEE_1, PAYEE_2], budgetTUSD: "10", perPaymentMaxTUSD: "5", approvalThresholdTUSD: "4", dataScope: [], ...over });

function rejected(d: PayDecision, reason: RejectionReason) {
  expect(d.kind).toBe("rejected");
  if (d.kind === "rejected") expect(d.reason).toBe(reason);
}

describe("Signer policy (spec §5.4) — every rejection reason", () => {
  it("covers each RejectionReason in order and records payment_rejected", async () => {
    h = await setup();
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    const seen = new Set<RejectionReason>();
    const check = async (req: { payee: string; amountMicro: bigint }, reason: RejectionReason) => {
      const d = await h!.signer.pay(id, { ...req, memo: "t" });
      rejected(d, reason);
      seen.add(reason);
      const ev = h!.events("payment_rejected", id).at(-1)!;
      expect(ev.data.reason).toBe(reason);
    };
    await check({ payee: PAYEE_1, amountMicro: 0n }, "invalid_amount");
    await check({ payee: STRANGER, amountMicro: 1_000_000n }, "payee_not_allowed");
    await check({ payee: PAYEE_1, amountMicro: 6_000_000n }, "over_per_payment_max");
    // spend 3 + 3 + 3 = 9, then 3 more is over the 10 budget
    for (let i = 0; i < 3; i++) expect((await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 3_000_000n, memo: "ok" })).kind).toBe("submitted");
    expect(h.sessions.get(id)!.spentMicro).toBe(9_000_000n);
    await check({ payee: PAYEE_2, amountMicro: 3_000_000n }, "over_budget");
    // build / submit failures from TxService
    h.chain.failNext("sessionPay", 1, "could not build tx: missing utxo");
    await check({ payee: PAYEE_1, amountMicro: 500_000n }, "build_failed");
    h.chain.failNext("sessionPay", 1, "submit failed: node said no");
    await check({ payee: PAYEE_1, amountMicro: 500_000n }, "submit_failed");
    // approval rejected by the user
    const h2 = h;
    const big = await setupApprovalRejected(h2);
    rejected(big, "approval_rejected");
    seen.add("approval_rejected");
    // not running (paused)
    await h.sessions.pause(id, "user");
    await check({ payee: PAYEE_1, amountMicro: 100_000n }, "session_not_running");
    // "rejected_onchain" needs a Session Vault (walletMode "vault"): covered in vault-mode.test.ts.
    expect([...seen].sort()).toEqual(REJECTION_REASONS.filter((r) => r !== "rejected_onchain").sort());
  });

  it("amount AT the approval threshold runs automatically (no decision)", async () => {
    h = await setup();
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    const d = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 4_000_000n, memo: "at threshold" });
    expect(d.kind).toBe("submitted");
    expect(h.decisions.list({ sessionId: id })).toHaveLength(0);
    expect(h.events("payment_approval_needed", id)).toHaveLength(0);
  });

  it("amount over the approval threshold waits for exactly one decision; approval submits it", async () => {
    h = await setup();
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    const d = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 4_000_001n, memo: "big" });
    expect(d.kind).toBe("needs_approval");
    expect(h.sessions.get(id)!.status).toBe("RUNNING"); // state stays RUNNING
    const open = h.decisions.list({ status: "open", sessionId: id });
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("payment_approval");
    expect(h.events("payment_approval_needed", id)).toHaveLength(1);
    const waiting = h.signer.awaitResolution(d.paymentId);
    await h.decisions.decide(open[0]!.id, "approved", "user");
    const final = await waiting;
    expect(final.kind).toBe("submitted");
    expect(h.sessions.get(id)!.spentMicro).toBe(4_000_001n);
    await waitFor(() => h!.events("payment_confirmed", id)[0], 3_000, "payment_confirmed");
    expect(h.signer.getPayment(d.paymentId)!.status).toBe("confirmed");
    expect(h.decisions.list({ status: "open" })).toHaveLength(0);
  });

  it("a tainted session needs approval for every payment", async () => {
    h = await setup();
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    await h.sessions.taint(id, { url: "https://docs.example.com", reason: "read external content", quarantine: false });
    const d = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 1_000_000n, memo: "small" });
    expect(d.kind).toBe("needs_approval");
  });
});

async function setupApprovalRejected(h: H): Promise<PayDecision> {
  const { ids } = await startPlan(h, [buyer({ name: "second" })]);
  const id = ids[0]!;
  const d = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 4_500_000n, memo: "needs approval" });
  expect(d.kind).toBe("needs_approval");
  const dec = h.decisions.list({ status: "open", sessionId: id })[0]!;
  const waiting = h.signer.awaitResolution(d.paymentId);
  await h.decisions.decide(dec.id, "rejected", "user", "too expensive");
  return waiting;
}
