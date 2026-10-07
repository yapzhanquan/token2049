import { describe, expect, it } from "vitest";
import { TUSDM_UNIT } from "../src/payment-gate";
import { makeRig, SELLER } from "./fakes";

const INPUT = "Research preprod DEX liquidity\nBudget: 2 tUSDM\nDeadline: 3h";
const WTX = "a".repeat(64);

describe("float + reimbursement bridge", () => {
  it("after a verified withdrawal the seller's net tUSDM is recorded against the treasury float (accounting only)", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    let j = (await r.process(rig.soko.task("t1")))!;
    expect(rig.engine.count("createGoal")).toBe(0); // no crew before escrow is locked
    rig.gate.lockFunds("bi_1");
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    rig.engine.closeAll(j.goalId!);
    await r.process(rig.soko.task("t1"));
    rig.gate.confirmResult("bi_1");
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.payment!.stage).toBe("awaiting-withdrawal");

    // Withdrawn on MPS, but Core receipt not settled yet → no reimbursement entry.
    rig.gate.withdraw("bi_1", WTX);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.payment!.stage).toBe("awaiting-withdrawal");
    expect(j.ledger!.reimbursementEntry).toBeUndefined();

    rig.soko.receipts["t1"] = { settled: true, txHash: WTX, blockchainIdentifier: "bi_1" };
    rig.utxos = {
      inputs: [{ address: "addr_test1contract", amount: [{ unit: TUSDM_UNIT, quantity: "2500000" }] }],
      outputs: [{ address: SELLER.sellerAddress, amount: [{ unit: TUSDM_UNIT, quantity: "2375000" }] }],
    };
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.payment!.stage).toBe("settled");
    const e = j.ledger!.reimbursementEntry!;
    expect(e).toMatchObject({ kind: "float-reimbursement", unit: TUSDM_UNIT, atomic: "2375000", settlementTx: WTX, sellerAddress: SELLER.sellerAddress, onChainTransferToTreasury: false });
    expect(BigInt(e.marginMicro)).toBe(2375000n - BigInt(j.ledger!.treasuryNetOutMicro));
  });
});
