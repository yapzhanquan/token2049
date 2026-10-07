import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions as sessionsTable } from "@bulkhead/db";
import { ENDING_STATUSES, SESSION_STATUSES, TRANSITIONS, type SessionStatus } from "@bulkhead/shared";
import { setup, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

/** Insert a bare session row in any status (no wallet), to drive the state machine directly. */
function insertSession(x: H, goalId: string, id: string, status: SessionStatus) {
  const t = Date.now();
  x.db.insert(sessionsTable)
    .values({
      id,
      goalId,
      userId: x.userId,
      letter: "A",
      name: id,
      role: "r",
      agentType: "generic",
      taskType: "research",
      goal: "g",
      status,
      budgetMicro: "1000000",
      perPaymentMaxMicro: "1000000",
      approvalThresholdMicro: "1000000",
      allowedPayeesJson: "[]",
      expiresAt: t + 3_600_000,
      keyIndex: Math.floor(Math.random() * 1e9),
      createdAt: t,
      updatedAt: t,
    })
    .run();
}

describe("session state machine (every allowed / forbidden transition)", () => {
  it("accepts exactly the TRANSITIONS table and persists each change with a reason", async () => {
    h = await setup();
    const goalId = h.newGoal();
    let n = 0;
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        const id = `s_${from}_${to}_${n++}`;
        insertSession(h, goalId, id, from);
        const allowed = from === to || TRANSITIONS[from].includes(to);
        if (allowed) {
          await h.sessions.transition(id, to, `test ${from}->${to}`);
          const rows = h.sessions.transitionsOf(id);
          if (from === to) {
            expect(rows, `${from}->${to} must be a no-op`).toHaveLength(0);
          } else {
            expect(rows[0], `${from}->${to}`).toMatchObject({ from, to, reason: `test ${from}->${to}` });
            expect(rows[0]!.at).toBeGreaterThan(0);
            const ev = h.events("session_transition", id)[0]!;
            expect(ev.data).toMatchObject({ from, to });
            // FAILED / KILLED / EXPIRED always proceed to CLOSING.
            if (ENDING_STATUSES.includes(to)) expect(rows[1]).toMatchObject({ from: to, to: "CLOSING" });
          }
        } else {
          await expect(h.sessions.transition(id, to, "nope"), `${from}->${to} must be rejected`).rejects.toThrow(/illegal transition/);
          expect(h.db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).get()!.status).toBe(from);
          expect(h.sessions.transitionsOf(id)).toHaveLength(0);
        }
      }
    }
    expect(n).toBe(SESSION_STATUSES.length ** 2);
  });

  it("is idempotent and a CLOSING session without funds ends CLOSED", async () => {
    h = await setup();
    const goalId = h.newGoal();
    insertSession(h, goalId, "s1", "RUNNING");
    await h.sessions.transition("s1", "PAUSED", "p");
    await h.sessions.transition("s1", "PAUSED", "p again");
    expect(h.sessions.transitionsOf("s1").filter((t) => t.to === "PAUSED")).toHaveLength(1);
    await h.sessions.kill("s1", "user", "test");
    await h.sessions.whenClosed("s1", 5_000);
    expect(h.sessions.transitionsOf("s1").map((t) => t.to)).toEqual(["PAUSED", "KILLED", "CLOSING", "CLOSED"]);
    expect(h.sessions.get("s1")!.status).toBe("CLOSED");
    // close_confirmed carries the log hash even when nothing had to be swept
    await waitFor(() => h!.events("close_confirmed", "s1")[0]);
    expect(h.events("close_confirmed", "s1")[0]!.data.logSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
