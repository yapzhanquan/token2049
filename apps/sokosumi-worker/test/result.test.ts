import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAW_UTF8_SHA256, sha256Hex } from "../src/hash";
import { JournalStore, ResultImmutableError } from "../src/journal";
import { makeRig, tmpDir } from "./fakes";

describe("result hashing (direct Task payments: raw UTF-8 SHA-256)", () => {
  it("matches known vectors and does not escape newlines", () => {
    expect(RAW_UTF8_SHA256.result(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a\nb")).toBe("7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78");
    expect(sha256Hex("a\\nb")).toBe("b5b65540b7c88230a6d62d928cd450d3be458c25e870d4750f754404324797b4");
    expect(RAW_UTF8_SHA256.input("café")).toBe(sha256Hex(Buffer.from("café", "utf8")));
  });
});

describe("result bytes are saved once and never change", () => {
  it("same bytes may be re-saved, different bytes are refused", () => {
    const s = new JournalStore(tmpDir());
    s.saveResultOnce("t1", "hello\n");
    expect(() => s.saveResultOnce("t1", "hello\n")).not.toThrow();
    expect(() => s.saveResultOnce("t1", "hello!\n")).toThrow(ResultImmutableError);
    expect(readFileSync(s.resultPath("t1"), "utf8")).toBe("hello\n");
  });

  it("the runner saves the exact bytes before completing and completes with exactly those bytes", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Write a haiku about Cardano — 日本語 ok\nBudget: 1");
    const r = rig.runner();
    let j = (await r.process(rig.soko.task("t1")))!;
    rig.engine.closeAll(j.goalId!);
    rig.soko.fail.complete = new Error("network down");
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/network down/);
    j = rig.store.load("t1")!;
    expect(j.phase).toBe("complete-pending");
    const saved = readFileSync(rig.store.resultPath("t1"));
    expect(sha256Hex(saved)).toBe(j.result!.sha256);
    expect(j.result!.hashRule).toBe("raw-utf8-sha256");
    expect(saved.toString("utf8")).toMatch(/Bulkhead crew result/);
    expect(saved.toString("utf8")).toMatch(/Refunded to the Bulkhead treasury: 1\.4 tUSD/); // 2 sessions × (1 − 0.3)
    expect(saved.toString("utf8")).toMatch(/https:\/\/preprod\.cardanoscan\.io\/transaction\//);
    expect(j.ledger).toMatchObject({ floatMicro: "2000000", spentMicro: "600000", refundMicro: "1400000", treasuryNetOutMicro: "600000", quoteMicro: "1500000" });

    // complete-pending is never repeated automatically, even after the fault clears…
    delete rig.soko.fail.complete;
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/outcome unknown/);
    expect(rig.soko.count("complete")).toBe(1);
    // …but inspection (Task observed COMPLETED) resolves it without a second write.
    rig.soko.task("t1").status = "COMPLETED";
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("completed");
    expect(rig.soko.count("complete")).toBe(1);
  });

  it("tampered result bytes block completion", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Do a thing");
    const r = rig.runner();
    const j = (await r.process(rig.soko.task("t1")))!;
    rig.engine.closeAll(j.goalId!);
    rig.soko.fail.complete = new Error("pause here");
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow();
    // Simulate an edit of a result whose completion never started: reset phase, tamper file.
    const jj = rig.store.load("t1")!;
    jj.phase = "result-saved";
    rig.store.save(jj);
    writeFileSync(rig.store.resultPath("t1"), "edited");
    delete rig.soko.fail.complete;
    const out = (await r.process(rig.soko.task("t1")))!;
    expect(out.phase).toBe("failed");
    expect(out.failedReason).toMatch(/changed/);
    expect(rig.soko.count("complete")).toBe(1);
  });

  it("invalid input is answered (no payment, no goal)", async () => {
    const rig = makeRig({ paid: true });
    rig.soko.addTask("t1", "   ");
    const j = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("completed");
    expect(rig.gate.count("terms")).toBe(0);
    expect(rig.engine.count("createGoal")).toBe(0);
    expect(String(rig.soko.calls.find((c) => c.op === "complete")!.arg)).toMatch(/could not accept/);
  });
});
