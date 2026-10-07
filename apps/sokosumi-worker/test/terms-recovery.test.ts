import { describe, expect, it } from "vitest";
import { MpsHttpError, MpsPaymentGate } from "../src/payment-gate";
import { TERMS_INSPECT_GRACE_MS } from "../src/task-runner";
import { makeRig } from "./fakes";

const INPUT = "Draft a launch checklist\nBudget: 2 tUSDM\nDeadline: 40m";

describe("payment terms request: refusal and recovery", () => {
  it("an MPS 4xx validation refusal fails the Task with the MPS reason and leaves no pending marker", async () => {
    const rig = makeRig({ paid: true });
    rig.gate.failNext = { error: new MpsHttpError(400, "sellerReturnAddress must be a Cardano base or enterprise address", "MPS /payment failed (HTTP 400)"), applied: false };
    rig.soko.addTask("t1", INPUT);
    const j = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("failed");
    expect(j.payment).toBeUndefined();
    expect(j.failedReason).toMatch(/sellerReturnAddress/);
    expect(rig.soko.count("payment-event")).toBe(0);
  });

  it("a lost response whose request did not apply is re-quoted only after inspection proves absence", async () => {
    const rig = makeRig({ paid: true });
    rig.gate.failNext = { error: new Error("socket hang up"), applied: false };
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/socket/);
    expect(rig.store.load("t1")!.payment!.stage).toBe("terms-pending");
    // Within the grace period: nothing happens (no inspection, no new request).
    await r.process(rig.soko.task("t1"));
    expect(rig.gate.count("find")).toBe(0);
    expect(rig.gate.count("terms")).toBe(1);
    rig.clock.t += TERMS_INSPECT_GRACE_MS + 1;
    const j = (await r.process(rig.soko.task("t1")))!;
    expect(rig.gate.count("find")).toBe(1);
    expect(rig.gate.count("terms")).toBe(2);
    expect(j.payment!.stage).toBe("awaiting-escrow");
  });

  it("a lost response whose request DID apply adopts the existing MPS payment (no second request)", async () => {
    const rig = makeRig({ paid: true });
    rig.gate.failNext = { error: new Error("timeout"), applied: true };
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/timeout/);
    rig.clock.t += TERMS_INSPECT_GRACE_MS + 1;
    const j = (await r.process(rig.soko.task("t1")))!;
    expect(rig.gate.count("terms")).toBe(1);
    expect(j.payment!.payment!.blockchainIdentifier).toBe("bi_1");
    expect(j.payment!.stage).toBe("awaiting-escrow");
    expect(rig.soko.count("payment-event")).toBe(1);
  });

  it("MpsPaymentGate surfaces the MPS error message and never the token", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ status: "error", error: { message: "Pay by time must be in the future" } }), { status: 400 })) as typeof fetch;
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "rt.env"), "MPS_RUNTIME_TOKEN=secret-token-value\n");
    const gate = new MpsPaymentGate({
      enabled: true,
      mpsUrl: "http://127.0.0.1:1",
      runtimeEnvPath: join(dir, "rt.env"),
      registrationConfirmed: true,
      seller: { agentIdentifier: "a".repeat(60), supportedPaymentSourceIndex: 0, sellerWalletId: "w", sellerAddress: "addr_test1x" },
      fetchImpl,
    });
    const err = await gate.resolve("bi").catch((e) => e);
    expect(err).toBeInstanceOf(MpsHttpError);
    expect(err.message).toMatch(/HTTP 400\): Pay by time/);
    expect(err.message).not.toMatch(/secret-token-value/);
    expect(err.refused && err.deterministic).toBe(true);
  });
});
