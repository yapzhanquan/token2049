import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/intents";
import { parseSseFrames, PICKUP_TEXT, SseGoalEvents } from "../src/progress";
import { engineError, makeRig, type Rig } from "./fakes";

const INPUT = "Opening pack for a bakery\nBudget: 4 tUSDM\nDeadline: 3h";
const SHORT =
  "2 session wallet(s) of this goal are waiting for funding. Your treasury has 1.5 tUSDM; this plan needs 4 tUSDM (≈ RM 18.80). Top up first. Shortfall: 2.5 tUSDM (asset abc123) + 3 tADA — send it to treasury addr_test1qtreasury000.";

const comments = (rig: Rig) => rig.soko.calls.filter((c) => c.op === "comment").map((c) => String(c.arg));
const once = (rig: Rig, needle: string) => comments(rig).join("\n").split(needle).length - 1;
const tick = (rig: Rig, ms = 11_000) => (rig.clock.t += ms);

function crewPlan(rig: Rig) {
  rig.engine.plan = [
    { role: "researcher", name: "Price check", budgetMicro: 1_500_000n },
    { role: "writer", name: "Job ad", budgetMicro: 1_000_000n },
    { role: "designer", name: "Flyer", budgetMicro: 1_500_000n, contextFrom: [0, 1] },
  ];
}

describe("progress milestones", () => {
  it("posts pickup, escrow, plan, funding, sessions, captain, hires, results and done — each exactly once", async () => {
    const rig = makeRig({ paid: true, progress: true });
    crewPlan(rig);
    rig.soko.addTask("t1", INPUT);
    let r = rig.runner();
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toEqual([PICKUP_TEXT]); // immediately on pickup

    rig.gate.lockFunds("bi_1", true);
    tick(rig);
    let j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    expect(comments(rig)).toHaveLength(2); // escrow + plan + funding coalesced into ONE comment
    const second = comments(rig)[1];
    expect(second).toContain(`Payment locked in escrow: 4.5 tUSDM on Cardano preprod. https://preprod.cardanoscan.io/transaction/${"1".repeat(64)}`);
    expect(second).toContain("Crew of 3: A researcher — Price check (parallel), B writer — Job ad (parallel), C designer — Flyer (after A,B). Budget split: A 1.5 + B 1 + C 1.5 = 4 tUSDM (crew budget 4 + Bulkhead fee 0.5).");
    expect(second).toContain(`Crew funded from the Bulkhead treasury: https://preprod.cardanoscan.io/transaction/${"f".repeat(64)}`);

    const g = j.goalId!;
    const [a, b] = [`${g}_s0`, `${g}_s1`];
    rig.events.push(g, "session_created", { letter: "A", role: "researcher" }, a);
    rig.events.push(g, "session_created", { letter: "B", role: "writer" }, b);
    rig.events.push(g, "session_transition", { from: "FUNDING", to: "RUNNING", letter: "A" }, a);
    rig.events.push(g, "session_transition", { from: "FUNDING", to: "RUNNING", letter: "B" }, b);
    rig.events.push(g, "captain_action", { tool: "read_status", ok: true, why: "routine" });
    rig.events.push(g, "captain_action", { tool: "kill_session", ok: true, why: "looping on the same failed fetch for 4 minutes" }, b);
    rig.events.push(g, "agent_hired", { jobRowId: "job_1", serviceId: "flyer-designer", billing: "credits", credits: 3 }, a);
    rig.events.push(g, "captain_report", { kind: "session_result", headline: "Priced 8 Bangsar bakeries", risk: "low", dedupKey: "sr:a" }, a);
    await r.process(rig.soko.task("t1")); // inside the 10 s window: nothing posted yet
    expect(comments(rig)).toHaveLength(2);
    tick(rig);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(3);
    const third = comments(rig)[2];
    expect(third).toContain("Session A researcher started.");
    expect(third).toContain("Session B writer started.");
    expect(third).toContain("Captain stopped session B writer: looping on the same failed fetch for 4 minutes");
    expect(third).not.toContain("routine");
    expect(third).toContain("A researcher hired flyer-designer from the market for 3 Sokosumi credits.");
    expect(third).toContain("A researcher finished: Priced 8 Bangsar bakeries (risk: low).");

    rig.engine.closeAll(g);
    tick(rig);
    j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("result-saved");
    expect(comments(rig).at(-1)).toContain(`Result sha256 ${j.result!.sha256}`);
    expect(comments(rig).at(-1)).toContain("Submitting the result hash to the Masumi escrow");

    rig.gate.confirmResult("bi_1");
    for (let i = 0; i < 3; i++) {
      tick(rig);
      await r.process(rig.soko.task("t1"));
    }
    r = rig.runner(); // restart
    for (let i = 0; i < 3; i++) {
      tick(rig);
      await r.process(rig.soko.task("t1"));
    }
    expect(rig.store.load("t1")!.phase).toBe("completed");
    for (const needle of ["Got it", "Payment locked", "Crew of 3", "Crew funded", "Session A researcher started", "Captain stopped", "hired flyer-designer", "A researcher finished", "Result sha256"]) expect(once(rig, needle)).toBe(1);
    expect(comments(rig)).toHaveLength(4);
  });

  it("rate-limits: bursts are coalesced and comments stay ≥ 10 s apart", async () => {
    const rig = makeRig({ progress: true });
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 2");
    const r = rig.runner();
    const j = (await r.process(rig.soko.task("t1")))!;
    expect(j.phase).toBe("running");
    expect(comments(rig)).toEqual([PICKUP_TEXT]); // plan + funding wait for the gap
    tick(rig, 5_000);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(1);
    tick(rig, 6_000);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(2);
    expect(comments(rig)[1]).toMatch(/Crew of 2[\s\S]*Crew funded/);

    for (const l of ["A", "B"]) rig.events.push(j.goalId!, "captain_action", { tool: "message_session", ok: true, why: `focus ${l}` }, `${j.goalId}_s${l === "A" ? 0 : 1}`);
    tick(rig, 3_000);
    await r.process(rig.soko.task("t1"));
    rig.events.push(j.goalId!, "captain_action", { tool: "pause_session", ok: true, why: "waiting for A" }, `${j.goalId}_s1`);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(2);
    tick(rig, 8_000);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(3);
    expect(comments(rig)[2].split("\n")).toHaveLength(3); // one coalesced comment for the burst
  });

  it("caps comments per Task and keeps the last ones for critical news", async () => {
    const rig = makeRig({ progress: { maxComments: 4, reserve: 1 } });
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 2");
    const r = rig.runner();
    const j = (await r.process(rig.soko.task("t1")))!;
    for (let i = 0; i < 6; i++) {
      tick(rig);
      rig.events.push(j.goalId!, "captain_action", { tool: "message_session", ok: true, why: `nudge ${i}` }, `${j.goalId}_s0`);
      await r.process(rig.soko.task("t1"));
    }
    expect(comments(rig)).toHaveLength(3); // pickup, plan+funding, one action; the rest skipped (reserve)
    rig.engine.closeAll(j.goalId!);
    tick(rig);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(4);
    expect(comments(rig)[3]).toContain("Crew finished");
    tick(rig);
    rig.events.push(j.goalId!, "captain_action", { tool: "kill_session", ok: true, why: "late" }, `${j.goalId}_s0`);
    await r.process(rig.soko.task("t1"));
    expect(comments(rig)).toHaveLength(4);
  });

  it("dedups across restarts, including a post whose outcome is unknown", async () => {
    const rig = makeRig({ progress: true });
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 2");
    await rig.runner().process(rig.soko.task("t1"));
    const g = rig.store.load("t1")!.goalId!;
    rig.events.push(g, "captain_action", { tool: "kill_session", ok: true, why: "stuck" }, `${g}_s0`);
    rig.soko.fail.comment = new Error("post timeout");
    tick(rig);
    await rig.runner().process(rig.soko.task("t1")); // plan + funding + action: post fails (uncertain)
    delete rig.soko.fail.comment;
    for (let i = 0; i < 3; i++) {
      tick(rig);
      await rig.runner().process(rig.soko.task("t1")); // a fresh runner each pass = a restart
    }
    expect(comments(rig)).toHaveLength(2); // pickup + ONE attempt: the uncertain post is never repeated
    expect(once(rig, "Captain stopped session A researcher: stuck")).toBe(1);
    const p = rig.store.load("t1")!.progress!;
    expect(p.keys.plan).toBe("posting");
    expect(p.cursor).toBe(1);
    rig.events.push(g, "captain_report", { kind: "session_result", headline: "Venues shortlisted", risk: "low" }, `${g}_s0`);
    tick(rig);
    await rig.runner().process(rig.soko.task("t1"));
    tick(rig);
    await rig.runner().process(rig.soko.task("t1"));
    expect(comments(rig).slice(2)).toEqual(["A researcher finished: Venues shortlisted (risk: low)."]);
  });
});

describe("funding stalled", () => {
  it("posts the engine's exact shortfall once, answers 'approve' with it, and posts once when resolved", async () => {
    const rig = makeRig({ progress: true });
    rig.soko.addTask("t1", "Plan a meetup\nBudget: 4");
    rig.engine.fail.approve = engineError(409, "engine POST /goals/g_1/approve: Your treasury has 1.5 tUSDM; this plan needs 4 tUSDM");
    const r = rig.runner();
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow(/treasury/);
    const g = rig.store.load("t1")!.goalId!;
    rig.engine.goals.find((x) => x.id === g)!.status = "approved"; // the engine marks the goal approved before funding
    rig.events.push(g, "error", { kind: "funding_stalled", reason: "insufficient_funds", error: SHORT });
    for (let i = 0; i < 3; i++) {
      tick(rig);
      await r.process(rig.soko.task("t1"));
    }
    expect(rig.store.load("t1")!.phase).toBe("running");
    expect(once(rig, SHORT)).toBe(1);
    expect(comments(rig).find((c) => c.includes(SHORT))).toContain("Funding stalled: ");
    expect(comments(rig).join("\n")).not.toMatch(/Delay:/); // no vague error on top of the exact shortfall

    rig.soko.userComment("t1", "approve");
    await r.handleComments(rig.soko.task("t1"));
    const reply = comments(rig).at(-1)!;
    expect(reply).toContain(`Crew planned but not funded yet: ${SHORT}`);
    expect(reply).toContain("Nothing needs your input right now.");
    expect(rig.engine.count("captain")).toBe(0);

    rig.events.push(g, "session_funded", { phase: "submitted", txHash: "e".repeat(64) }, `${g}_s0`);
    rig.events.push(g, "progress", { kind: "log", text: "goal reconciler funded 2 waiting session wallet(s)" });
    for (let i = 0; i < 3; i++) {
      tick(rig);
      await r.process(rig.soko.task("t1"));
    }
    expect(once(rig, "Funding resolved")).toBe(1);
    expect(once(rig, `Crew funded from the Bulkhead treasury: https://preprod.cardanoscan.io/transaction/${"e".repeat(64)}`)).toBe(1);
    expect(once(rig, SHORT)).toBe(2); // the stall comment + the 'approve' reply only
  });

  it("explains a persisting worker error once, in plain language", async () => {
    const rig = makeRig({ progress: true });
    rig.soko.addTask("t1", "Plan a meetup");
    rig.engine.fail.approve = new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:4000");
    const r = rig.runner();
    await expect(r.process(rig.soko.task("t1"))).rejects.toThrow();
    for (let i = 0; i < 20; i++) {
      tick(rig);
      await r.process(rig.soko.task("t1")).catch(() => undefined);
    }
    expect(once(rig, "The Bulkhead engine is temporarily unreachable")).toBe(1);
    expect(comments(rig).join("\n")).not.toContain("127.0.0.1");
  });
});

describe("approval-like comments", () => {
  it("parses nudges separately from instructions", () => {
    for (const w of ["approve", "Auto approve", "auto-approve", "go", "Go ahead!", "ok", "yes please", "continue"]) expect(parseIntent(w).kind).toBe("nudge");
    expect(parseIntent("?")).toEqual({ kind: "status" });
    expect(parseIntent("approve 3 tUSDM")).toEqual({ kind: "approve", amountTusdm: "3" });
    expect(parseIntent("go with the cheaper venue")).toEqual({ kind: "captain", text: "go with the cheaper venue" });
  });

  it("replies with status and what needs the owner; real instructions still reach the captain", async () => {
    const rig = makeRig({ paid: true, progress: true });
    rig.soko.addTask("t1", INPUT);
    const r = rig.runner();
    await r.process(rig.soko.task("t1"));
    rig.soko.userComment("t1", "go");
    await r.handleComments(rig.soko.task("t1"));
    expect(comments(rig).at(-1)).toMatch(/^Waiting for your payment to lock in escrow\. Needs you: pay the payment request above before \S+ to start the crew\.$/);

    rig.gate.lockFunds("bi_1", true);
    tick(rig);
    await r.process(rig.soko.task("t1"));
    const j = rig.store.load("t1")!;
    j.decisions.d_x = { state: "asked", kind: "payment_approval", reason: "over the per-payment threshold", amountMicro: "3000000", askedAt: rig.clock.t };
    rig.store.save(j);
    rig.soko.userComment("t1", "auto approve");
    rig.soko.userComment("t1", "?");
    rig.soko.userComment("t1", "Prefer bakeries near LRT stations");
    await r.handleComments(rig.soko.task("t1"));
    const [approve, status, captain] = comments(rig).slice(-3);
    expect(approve).toContain("The crew is working.");
    expect(approve).toContain('Needs you: a crew session asks for payment approval (3 tUSDM) — reply "approve 3 tUSDM" to allow it.');
    expect(approve).toContain("Spending inside the crew budget (crew budget 4 tUSDM) is approved automatically");
    expect(status).toMatch(/The crew is working\. Phase: running\./);
    expect(status).toContain("Needs you:");
    expect(captain).toBe("Passed to the Bulkhead captain.");
    expect(rig.engine.count("captain")).toBe(1);
  });
});

describe("engine events over SSE", () => {
  it("parses frames and stops once the replayed backlog is drained", async () => {
    expect(parseSseFrames("event: ready\ndata: {}\n\nid: 3\ndata: {\"id\":3}\n\nid: 4\nda").frames.map((f) => f.event)).toEqual(["ready", "message"]);
    const ev = (id: number) => `id: ${id}\ndata: ${JSON.stringify({ id, at: 1, type: "progress", goalId: "g", data: {} })}\n\n`;
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: ready\ndata: {"at":1}\n\n${ev(5)}`));
          c.enqueue(enc.encode(ev(6)));
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        }, // never closes: a live stream
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const src = new SseGoalEvents("http://engine.test/", "tok", fakeFetch, { idleMs: 30, maxMs: 2_000 });
    const got = await src.since("u1", "g", 4);
    expect(got.map((e) => e.id)).toEqual([5, 6]);
    expect(seenUrl).toBe("http://engine.test/events/stream?goalId=g&after=4");
    expect(seenHeaders["x-user-id"]).toBe("u1");
  });
});
