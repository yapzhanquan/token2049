import { describe, expect, it } from "vitest";
import { TUSDM_UNIT } from "../src/payment-gate";
import { sellerNetReceipt, verifySettlement, type TxUtxos } from "../src/settlement";
import type { MpsPayment } from "../src/types";
import { makeRig } from "./fakes";

const SELLER = "addr_test1seller";
const TX = "e".repeat(64);
const amt = (q: string) => [{ unit: TUSDM_UNIT, quantity: q }, { unit: "lovelace", quantity: "2000000" }];
const UTXOS: TxUtxos = {
  inputs: [
    { address: "addr_test1script", amount: amt("4500000") },
    { address: SELLER, amount: amt("100") }, // seller's own funds (fees/change)
    { address: SELLER, amount: amt("999"), collateral: true },
  ],
  outputs: [
    { address: SELLER, amount: amt("4275100") }, // 4.5 − 5 % network fee + seller change 100
    { address: "addr_test1network", amount: amt("225000") },
  ],
};
const payment = (over: Partial<MpsPayment> = {}): MpsPayment =>
  ({
    blockchainIdentifier: "bi_1",
    onChainState: "Withdrawn",
    submitResultTime: "0",
    unlockTime: "0",
    externalDisputeUnlockTime: "0",
    RequestedFunds: [],
    CurrentTransaction: { status: "Confirmed", newOnChainState: "Withdrawn", txHash: TX },
    TransactionHistory: [],
    ...over,
  }) as MpsPayment;

describe("settlement check (fixtures)", () => {
  it("seller change does not inflate the receipt; collateral is ignored", () => {
    expect(sellerNetReceipt(UTXOS, SELLER, TUSDM_UNIT)).toBe(4_275_000n);
  });

  it("verifies when Core receipt, MPS withdrawal and Blockfrost agree", async () => {
    const ev = await verifySettlement({ receipt: { settled: true, txHash: TX, blockchainIdentifier: "bi_1" }, payment: payment(), sellerAddress: SELLER, unit: TUSDM_UNIT, fetchUtxos: async () => UTXOS, now: 1 });
    expect(ev).toMatchObject({ verified: true, txHash: TX, netAtomicUnits: "4275000" });
  });

  it("does not verify on an unsettled receipt, an unmatched or unconfirmed MPS tx, or missing UTxOs", async () => {
    const base = { sellerAddress: SELLER, unit: TUSDM_UNIT, fetchUtxos: async () => UTXOS };
    expect((await verifySettlement({ ...base, receipt: { settled: false }, payment: payment() })).verified).toBe(false);
    expect((await verifySettlement({ ...base, receipt: { settled: true, txHash: "f".repeat(64), blockchainIdentifier: "bi_1" }, payment: payment() })).reason).toMatch(/No confirmed MPS withdrawal/);
    expect((await verifySettlement({ ...base, receipt: { settled: true, txHash: TX, blockchainIdentifier: "bi_1" }, payment: payment({ CurrentTransaction: { status: "Pending", newOnChainState: "Withdrawn", txHash: TX } }) })).verified).toBe(false);
    expect((await verifySettlement({ ...base, fetchUtxos: async () => null, receipt: { settled: true, txHash: TX, blockchainIdentifier: "bi_1" }, payment: payment() })).reason).toMatch(/not determinable/);
    const noGain: TxUtxos = { inputs: [{ address: SELLER, amount: amt("5") }], outputs: [{ address: SELLER, amount: amt("5") }] };
    expect((await verifySettlement({ ...base, fetchUtxos: async () => noGain, receipt: { settled: true, txHash: TX, blockchainIdentifier: "bi_1" }, payment: payment() })).verified).toBe(false);
  });

  it("a receipt for another payment is a hard error", async () => {
    await expect(verifySettlement({ receipt: { settled: true, txHash: TX, blockchainIdentifier: "other" }, payment: payment(), sellerAddress: SELLER, unit: TUSDM_UNIT, fetchUtxos: async () => UTXOS })).rejects.toThrow(/does not match/);
  });

  it("records reimbursement and margin in the Task ledger once verified", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", "Paid job\nBudget: 4");
    const r = rig.runner();
    // swap in a Blockfrost fixture
    (r as unknown as { d: { fetchUtxos: unknown } }).d.fetchUtxos = async () => UTXOS;
    let j = (await r.process(rig.soko.task("t1")))!;
    rig.gate.lockFunds("bi_1");
    j = (await r.process(rig.soko.task("t1")))!;
    rig.engine.closeAll(j.goalId!);
    await r.process(rig.soko.task("t1"));
    rig.gate.confirmResult("bi_1");
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.payment!.stage).toBe("awaiting-withdrawal");
    rig.gate.withdraw("bi_1", TX);
    rig.soko.receipts.t1 = { settled: true, txHash: TX, blockchainIdentifier: "bi_1" };
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.payment!.stage).toBe("settled");
    expect(j.ledger).toMatchObject({ reimbursementAtomic: "4275000", settlementTx: TX, treasuryNetOutMicro: "600000", marginMicro: "3675000" });
  });
});
