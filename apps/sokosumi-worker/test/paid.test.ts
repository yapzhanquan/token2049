import { describe, expect, it } from "vitest";
import { buildPurchasePayload, confirmedState, escrowConfirmed } from "../src/payment-gate";
import { sha256Hex } from "../src/hash";
import { makeRig, SELLER } from "./fakes";
import type { MpsPayment } from "../src/types";

const INPUT = "Research preprod DEX liquidity\nBudget: 4 tUSDM\nDeadline: 3h";

describe("escrow proof", () => {
  it("requires a CONFIRMED transaction into the expected state", () => {
    expect(confirmedState({ CurrentTransaction: null, TransactionHistory: [{ status: "Confirmed", newOnChainState: "FundsLocked" }] }, "FundsLocked")).toBe(true);
    expect(confirmedState({ CurrentTransaction: { status: "Pending", newOnChainState: "FundsLocked" } }, "FundsLocked")).toBe(false);
    expect(confirmedState({ CurrentTransaction: { status: "Confirmed", newOnChainState: "Withdrawn" } }, "FundsLocked")).toBe(false);
    expect(escrowConfirmed({ onChainState: null, CurrentTransaction: { status: "Confirmed", newOnChainState: "FundsLocked" } } as MpsPayment)).toBe(false);
  });
});

describe("paid Task flow", () => {
  it("quotes dynamically, waits for confirmed escrow, then runs the crew", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    let j = (await r.process(rig.soko.task("t1")))!;
    expect(j.mode).toBe("paid");
    expect(j.payment!.stage).toBe("awaiting-escrow");
    const terms = rig.gate.calls.find((c) => c.op === "terms")!.arg as { amountAtomic: string; inputHash: string };
    expect(terms.amountAtomic).toBe("4500000"); // 4 crew + 0.5 fee
    expect(terms.inputHash).toBe(sha256Hex(INPUT));
    expect(rig.soko.count("payment-event")).toBe(1);

    // Not locked, then locked-but-pending: no goal is created.
    j = (await r.process(rig.soko.task("t1")))!;
    rig.gate.lockFunds("bi_1", false);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(rig.engine.count("createGoal")).toBe(0);
    expect(j.payment!.stage).toBe("awaiting-escrow");

    rig.gate.lockFunds("bi_1", true);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    expect(rig.engine.count("createGoal")).toBe(1);
    expect((rig.engine.calls.find((c) => c.op === "createGoal")!.arg as { budgetTUSD: string }).budgetTUSD).toBe("4");

    rig.engine.closeAll(j.goalId!);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("result-saved");
    expect(j.payment!.stage).toBe("awaiting-result");
    expect(rig.gate.count("submit")).toBe(1);
    expect(rig.soko.count("complete-event")).toBe(0); // not before ResultSubmitted is confirmed

    rig.gate.confirmResult("bi_1");
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("completed");
    const posted = rig.soko.calls.find((c) => c.op === "complete-event")!.arg as string;
    expect(sha256Hex(posted)).toBe(j.result!.sha256);
    expect(rig.gate.payments.get("bi_1")!.resultHash).toBe(j.result!.sha256);
    expect(j.payment!.stage).toBe("awaiting-withdrawal");
    expect(rig.soko.count("complete")).toBe(0); // paid path completes via the Core event, not the CLI
  });

  it("an expired result deadline after the escrow read stops before any crew work", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    await r.process(rig.soko.task("t1"));
    rig.gate.lockFunds("bi_1");
    rig.clock.t += 4 * 3_600_000; // past submitResultTime
    const j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("failed");
    expect(rig.engine.count("createGoal")).toBe(0);
  });

  it("an uncertain purchase event is never re-posted", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", INPUT);
    rig.soko.fail["payment-event"] = new Error("timeout");
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow(/timeout/);
    delete rig.soko.fail["payment-event"];
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow(/outcome unknown/);
    expect(rig.soko.count("payment-event")).toBe(1);
    expect(rig.store.load("t1")!.payment!.stage).toBe("purchase-pending");
  });

  it("signed terms are saved before validation; bad terms fail the Task without posting", async () => {
    const rig = makeRig({ paid: true });
    rig.gate.tamper = (p) => (p.forceLayer = "L1");
    rig.soko.addTask("t1", INPUT);
    const j = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("failed");
    expect(j.payment!.payment!.blockchainIdentifier).toBe("bi_1");
    expect(rig.soko.count("payment-event")).toBe(0);
  });

  it("buildPurchasePayload preserves signed fields and rejects mismatches", () => {
    const p = {
      blockchainIdentifier: "signed",
      agentIdentifier: SELLER.agentIdentifier,
      inputHash: "h",
      payByTime: "1",
      submitResultTime: "2",
      unlockTime: "3",
      externalDisputeUnlockTime: "4",
      sellerReturnAddress: null,
      RequestedFunds: [{ amount: "1500000", unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }],
      PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: "addr_test1c", policyId: "pp" },
      SmartContractWallet: { id: SELLER.sellerWalletId, walletVkey: "vk" },
    } as MpsPayment; // forceLayer absent: older MPS build, accepted
    const out = buildPurchasePayload(p, "nonce", SELLER, "1500000", "h");
    expect(out).toMatchObject({ blockchainIdentifier: "signed", sellerVkey: "vk", unlockTime: "3", identifierFromPurchaser: "nonce", supportedPaymentSourceIndex: 0 });
    expect(() => buildPurchasePayload(p, "n", SELLER, "1000000", "h")).toThrow(/quote/);
    expect(() => buildPurchasePayload(p, "n", SELLER, "1500000", "other")).toThrow(/inputHash/);
    expect(() => buildPurchasePayload({ ...p, sellerReturnAddress: "addr_test1s" }, "n", SELLER, "1500000", "h")).toThrow(/cannot preserve/);
    expect(() => buildPurchasePayload({ ...p, SmartContractWallet: { id: "x" } }, "n", SELLER, "1500000", "h")).toThrow(/seller wallet/);
  });
});
