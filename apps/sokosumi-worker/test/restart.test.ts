import { describe, expect, it } from "vitest";
import { goalMarker } from "../src/task-runner";
import { Worker } from "../src/worker";
import { COWORKER, makeRig } from "./fakes";

describe("restart resume", () => {
  it("a new process resumes a running Task without re-starting it or re-creating its goal", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Compare three preprod explorers\nBudget: 2");
    const j1 = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(j1.phase).toBe("running");
    expect(rig.engine.goals[0].rules).toContain(goalMarker("t1"));

    // "Restart": fresh runner + store over the same directory.
    rig.engine.closeAll(j1.goalId!);
    const j2 = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(j2.phase).toBe("completed");
    expect(rig.soko.count("start")).toBe(1);
    expect(rig.engine.count("createGoal")).toBe(1);
    expect(rig.engine.count("approve")).toBe(1);
    expect(rig.soko.count("complete")).toBe(1);
  });

  it("goal-pending is resolved by finding the goal's marker, not by creating a second goal", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Something useful");
    rig.engine.fail.approve = new Error("crash before approve");
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow();
    // Pretend the crash happened right after POST /goals: phase still goal-pending.
    const j = rig.store.load("t1")!;
    j.phase = "goal-pending";
    delete j.goalId;
    rig.store.save(j);
    delete rig.engine.fail.approve;
    const out = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(out.phase).toBe("running");
    expect(rig.engine.count("createGoal")).toBe(1);
    expect(out.goalId).toBe(rig.engine.goals[0].id);
  });

  it("approve-pending re-approves only when the goal is still planned", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Something useful");
    rig.engine.fail.approve = new Error("lost response");
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow(/lost/);
    expect(rig.store.load("t1")!.phase).toBe("approve-pending");
    delete rig.engine.fail.approve;
    const out = (await rig.runner().process(rig.soko.task("t1")))!; // goal still "planned" ⇒ not applied
    expect(out.phase).toBe("running");
    expect(rig.engine.count("approve")).toBe(2);
  });

  it("an interrupted runtime start is retried only after the Task is seen READY again", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Something useful");
    rig.soko.fail.start = new Error("cli timeout");
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow(/timeout/);
    delete rig.soko.fail.start;
    await rig.runner().process(rig.soko.task("t1")); // too soon: no retry
    expect(rig.soko.count("start")).toBe(1);
    rig.clock.t += 60_000;
    const out = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(rig.soko.count("start")).toBe(2);
    expect(out.phase).toBe("running");
  });

  it("an interrupted start whose Task is no longer READY needs a human", async () => {
    const rig = makeRig();
    rig.soko.addTask("t1", "Something useful");
    rig.soko.fail.start = new Error("cli timeout");
    await expect(rig.runner().process(rig.soko.task("t1"))).rejects.toThrow();
    delete rig.soko.fail.start;
    rig.soko.task("t1").status = "RUNNING";
    const out = (await rig.runner().process(rig.soko.task("t1")))!;
    expect(out.phase).toBe("failed");
    expect(rig.soko.count("start")).toBe(1);
  });
});

describe("worker loop", () => {
  it("one failing Task does not block others; a failing poll keeps the loop alive", async () => {
    const rig = makeRig();
    rig.soko.addTask("bad", "Goal A");
    rig.soko.addTask("good", "Goal B");
    rig.soko.tasks.push({ id: "other", status: "READY", coworkerId: "someone-else", description: "x" });
    rig.engine.fail.createGoal = undefined;
    const runner = rig.runner();
    const logs: string[] = [];
    const w = new Worker({ coworkerId: COWORKER, soko: rig.soko, runner, log: (m) => logs.push(m) });
    const origCreate = rig.engine.createGoal.bind(rig.engine);
    rig.engine.createGoal = async (u, body) => {
      if (body.goal === "Goal A") throw new Error("engine 502");
      return origCreate(u, body);
    };
    await w.pass();
    expect(rig.store.load("good")!.phase).toBe("running");
    expect(rig.store.load("bad")!.phase).toBe("goal-pending");
    expect(rig.store.load("other")).toBeNull();
    expect(logs.some((l) => l.startsWith("task bad"))).toBe(true);

    rig.soko.fail.list = new Error("ECONNRESET");
    await w.pass();
    await w.pass();
    expect(logs.filter((l) => l.startsWith("poll")).length).toBe(1); // logged once, not every pass
    delete rig.soko.fail.list;
    rig.engine.closeAll(rig.store.load("good")!.goalId!);
    await w.pass();
    expect(rig.store.load("good")!.phase).toBe("completed");
  });
});
