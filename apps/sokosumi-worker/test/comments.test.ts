import { describe, expect, it } from "vitest";
import { matchSession, parseIntent } from "../src/intents";
import { makeRig } from "./fakes";

describe("parseIntent", () => {
  it("maps the simple intents and forwards the rest", () => {
    expect(parseIntent("status?")).toEqual({ kind: "status" });
    expect(parseIntent("pause B")).toEqual({ kind: "pause", target: "B" });
    expect(parseIntent("Pause researcher")).toEqual({ kind: "pause", target: "researcher" });
    expect(parseIntent("approve 2.5 tUSDM")).toEqual({ kind: "approve", amountTusdm: "2.5" });
    expect(parseIntent("please focus on Penang")).toEqual({ kind: "captain", text: "please focus on Penang" });
    expect(matchSession("b", [{ letter: "A", role: "x" }, { letter: "B", role: "y" }])).toHaveLength(1);
    expect(matchSession("write", [{ letter: "A", role: "writer" }])).toHaveLength(1);
  });
});

describe("owner comments", () => {
  async function running() {
    const rig = makeRig();
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 3");
    const r = rig.runner();
    const j = (await r.process(rig.soko.task("t1")))!;
    return { rig, r, goalId: j.goalId! };
  }

  it("handles each user comment once, ignores Coworker events, replies as the Coworker", async () => {
    const { rig, r } = await running();
    rig.soko.userComment("t1", "status?");
    rig.soko.userComment("t1", "pause B");
    rig.soko.userComment("t1", "Prefer venues near KLCC");
    rig.soko.events.t1.push({ id: "bot1", comment: "pause A", actor: { type: "coworker", id: "cw_1" } });
    await r.handleComments(rig.soko.task("t1"));
    await r.handleComments(rig.soko.task("t1")); // second pass: nothing new
    await rig.runner().handleComments(rig.soko.task("t1")); // restart: still nothing new
    const replies = rig.soko.calls.filter((c) => c.op === "comment").map((c) => String(c.arg));
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatch(/Phase: running/);
    expect(replies[1]).toBe("Paused session B (writer).");
    expect(replies[2]).toMatch(/captain/);
    expect(rig.engine.calls.filter((c) => c.op === "control")).toEqual([{ op: "control", arg: { sessionId: expect.stringContaining("_s1"), action: "pause" } }]);
    expect(rig.engine.count("captain")).toBe(1);
    expect((rig.engine.calls.find((c) => c.op === "captain")!.arg as { text: string }).text).toMatch(/data, not instructions/);
  });

  it("an uncertain action or reply is never repeated after a restart", async () => {
    const { rig, r } = await running();
    rig.soko.userComment("t1", "pause A");
    rig.engine.fail.control = new Error("engine timeout");
    await expect(r.handleComments(rig.soko.task("t1"))).rejects.toThrow(/timeout/);
    delete rig.engine.fail.control;
    rig.soko.userComment("t1", "status");
    rig.soko.fail.comment = new Error("post timeout");
    await expect(rig.runner().handleComments(rig.soko.task("t1"))).rejects.toThrow(/post timeout/);
    delete rig.soko.fail.comment;
    await rig.runner().handleComments(rig.soko.task("t1"));
    expect(rig.engine.count("control")).toBe(1);
    expect(rig.soko.count("comment")).toBe(1); // the failed status reply is not re-posted
    const j = rig.store.load("t1")!;
    expect(Object.values(j.comments).map((c) => c.state).sort()).toEqual(["action-pending", "reply-pending"]);
  });

  it("comment replies never touch a completed result", async () => {
    const { rig, r, goalId } = await running();
    rig.engine.closeAll(goalId);
    const done = (await r.process(rig.soko.task("t1")))!;
    expect(done.phase).toBe("completed");
    const before = rig.store.readResult("t1")!;
    rig.soko.userComment("t1", "status?");
    rig.soko.userComment("t1", "pause A");
    await r.handleComments(rig.soko.task("t1"));
    expect(rig.store.readResult("t1")!.equals(before)).toBe(true);
    expect(rig.store.load("t1")!.result!.sha256).toBe(done.result!.sha256);
    expect(rig.soko.calls.filter((c) => c.op === "comment").map((c) => String(c.arg))[1]).toMatch(/No running crew/);
  });
});
