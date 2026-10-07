// Session tree DTO builder (spec §6.4). Closed / killed sessions are never removed: they become
// muted "ghost" nodes that keep their handback summary, spend, refund and close-tx link.
import { and, asc, eq, inArray } from "drizzle-orm";
import { agentJobs, decisions, events, goals, sessions, type DB } from "@bulkhead/db";
import { TIMEBOXED_CLOSE_STATUS, glyphFor, microToMyr, type Glyph, type SessionStatus, type TaskType, type TreeDTO, type TreeEdge, type TreeNode } from "@bulkhead/shared";

const ENDED: SessionStatus[] = ["FAILED", "KILLED", "EXPIRED"];

function fmtLeft(ms: number): string {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.ceil(ms / 1000)}s left`;
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m left`;
  return `${Math.floor(h / 24)}d left`;
}
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** opts.workDeadlineMs (WORK_DEADLINE_SECONDS × 1000, 0/absent = none): running sessions show their work time left. */
export function buildTree(db: DB, goalId: string, opts: { myrPerTusd: string; now: number; workDeadlineMs?: number }): TreeDTO {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) throw new Error(`goal ${goalId} not found`);
  const rows = db.select().from(sessions).where(eq(sessions.goalId, goalId)).orderBy(asc(sessions.createdAt), asc(sessions.letter)).all();
  const ids = rows.map((r) => r.id);
  const rm = (micro: bigint) => `RM${microToMyr(micro, opts.myrPerTusd)}`;

  // Per-session latest activity + last rejection, from the event log.
  const latest = new Map<string, string>();
  const lastRejection = new Map<string, string>();
  const handbackEdges: TreeEdge[] = [];
  if (ids.length) {
    const evs = db
      .select()
      .from(events)
      .where(and(eq(events.goalId, goalId), inArray(events.type, ["progress", "payment_rejected", "handback_passed", "handback_rejected"])))
      .orderBy(asc(events.id))
      .all();
    for (const e of evs) {
      const d = JSON.parse(e.dataJson) as Record<string, unknown>;
      if (e.type === "progress" && e.sessionId && d.kind !== "log" && typeof d.text === "string") latest.set(e.sessionId, d.text);
      if ((e.type === "payment_rejected" || e.type === "handback_rejected") && e.sessionId) lastRejection.set(e.sessionId, String(d.detail ?? d.reason ?? ""));
      if (e.type === "handback_passed" && typeof d.from === "string" && typeof d.to === "string") {
        if (!handbackEdges.some((x) => x.from === d.from && x.to === d.to)) handbackEdges.push({ from: d.from, to: d.to, kind: "handback" });
      }
    }
  }
  const openDec = new Map<string, { total: number; payments: number }>();
  if (ids.length) {
    for (const d of db.select().from(decisions).where(and(inArray(decisions.sessionId, ids), eq(decisions.status, "open"))).all()) {
      const c = openDec.get(d.sessionId) ?? { total: 0, payments: 0 };
      c.total++;
      if (d.kind === "payment_approval") c.payments++;
      openDec.set(d.sessionId, c);
    }
  }

  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const anyActive = rows.some((r) => r.status !== "CLOSED");
  const totalSpent = rows.reduce((s, r) => s + BigInt(r.spentMicro), 0n);
  const goalGlyph: Glyph = goal.status === "planned" ? "planned" : anyActive ? "running" : "closed";
  nodes.push({
    id: goal.id,
    kind: "goal",
    parentId: null,
    label: clip(goal.goal, 90),
    glyph: goalGlyph,
    ghost: false,
    lines: [`${rm(BigInt(goal.budgetMicro))} budget · due ${new Date(goal.deadline).toISOString().slice(0, 16).replace("T", " ")}`, `${rows.length} session(s) · spent ${rm(totalSpent)}`],
    budgetMicro: goal.budgetMicro,
    spentMicro: totalSpent.toString(),
    startedAt: goal.createdAt,
  });

  const jobRows = ids.length ? db.select().from(agentJobs).where(inArray(agentJobs.sessionId, ids)).orderBy(asc(agentJobs.createdAt)).all() : [];

  for (const r of rows) {
    const status = r.status as SessionStatus;
    const closeStatus = (r.closeStatus ?? null) as string | null;
    // TIMEBOXED (work deadline reached; partial handback kept) is not a failure: it shows its partial summary.
    const endedBadly = ENDED.includes(status) || ((status === "CLOSED" || status === "CLOSING") && closeStatus !== null && closeStatus !== "COMPLETED" && closeStatus !== TIMEBOXED_CLOSE_STATUS);
    const workDeadlineAt = opts.workDeadlineMs && opts.workDeadlineMs > 0 && r.startedAt ? r.startedAt + opts.workDeadlineMs : undefined;
    const ghost = status === "CLOSED" || status === "CLOSING" || ENDED.includes(status);
    const dec = openDec.get(r.id);
    const glyph: Glyph = endedBadly ? "failed" : glyphFor(status, (dec?.payments ?? 0) > 0);
    const budget = BigInt(r.budgetMicro);
    const spent = BigInt(r.spentMicro);
    const hb = r.handbackJson ? (JSON.parse(r.handbackJson) as { summary?: string }) : null;
    let lines: string[];
    if (endedBadly) {
      lines = [clip(r.endReason ?? lastRejection.get(r.id) ?? closeStatus ?? status), r.refundMicro !== null ? `spent ${rm(spent)} · ${rm(BigInt(r.refundMicro))} returned` : `spent ${rm(spent)}`];
    } else if (ghost || status === "COMPLETING") {
      lines = [clip(hb?.summary ?? "handback pending"), r.refundMicro !== null ? `spent ${rm(spent)} · ${rm(BigInt(r.refundMicro))} returned` : `spent ${rm(spent)} · closing`];
    } else if (status === "PLANNED" || status === "AWAITING_APPROVAL" || status === "FUNDING") {
      // AWAITING_APPROVAL only exists before the funding tx: shown as "waiting for funding" (display mapping).
      const first = status === "AWAITING_APPROVAL" ? "waiting for funding — approve or top up" : (latest.get(r.id) ?? (status === "FUNDING" ? "funding…" : r.goal));
      lines = [clip(first), `${rm(budget)} budget · ${fmtLeft(r.expiresAt - opts.now)}`];
    } else {
      const rejection = status === "QUARANTINED" ? "quarantined: awaiting your review" : undefined;
      const left = workDeadlineAt !== undefined ? `work ${fmtLeft(workDeadlineAt - opts.now).replace("expired", "time up")}` : fmtLeft(r.expiresAt - opts.now);
      lines = [clip(rejection ?? latest.get(r.id) ?? "starting…"), `${rm(budget - spent)} of ${rm(budget)} left · ${left}`];
    }
    const parentId = r.parentSessionId && ids.includes(r.parentSessionId) ? r.parentSessionId : goal.id;
    nodes.push({
      id: r.id,
      kind: "session",
      parentId,
      letter: r.letter,
      role: r.role,
      label: `${r.letter} ${r.role} - ${status}`,
      status,
      glyph,
      ghost,
      lines,
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(workDeadlineAt !== undefined ? { workDeadlineAt } : {}),
      tokensUsed: r.tokensUsed,
      spentMicro: r.spentMicro,
      budgetMicro: r.budgetMicro,
      ...(r.refundMicro !== null ? { refundMicro: r.refundMicro } : {}),
      ...(r.address ? { address: r.address } : {}),
      ...(r.closeTx ? { closeTx: r.closeTx } : {}),
      ...(hb?.summary ? { handbackSummary: hb.summary } : {}),
      taskType: r.taskType as TaskType,
      openDecisions: dec?.total ?? 0,
    });
    edges.push({ from: parentId, to: r.id, kind: "parent" });
  }

  for (const j of jobRows) {
    const owner = rows.find((r) => r.id === j.sessionId)!;
    const ownerGhost = owner.status === "CLOSED" || owner.status === "CLOSING" || ENDED.includes(owner.status as SessionStatus);
    const glyph: Glyph = j.status === "completed" ? "closed" : j.status === "failed" ? "failed" : "running";
    const id = `job_${j.id}`;
    nodes.push({
      id,
      kind: "agent_job",
      parentId: j.sessionId,
      label: `${j.serviceId} - ${j.status}`,
      glyph,
      ghost: ownerGhost || j.status === "completed" || j.status === "failed",
      lines: [clip(j.result ?? (j.status === "started" ? "awaiting payment" : j.status === "paid" || j.status === "running" ? "working…" : j.status)), `paid ${rm(BigInt(j.priceMicro))}${j.resultHash ? ` · hash ${j.resultHash.slice(0, 10)}…` : ""}`],
      spentMicro: j.priceMicro,
      startedAt: j.createdAt,
      ...(j.status === "completed" || j.status === "failed" ? { endedAt: j.updatedAt } : {}),
    });
    edges.push({ from: j.sessionId, to: id, kind: "parent" });
  }

  return { goalId, nodes, edges: [...edges, ...handbackEdges.filter((e) => ids.includes(e.from) && ids.includes(e.to))] };
}
