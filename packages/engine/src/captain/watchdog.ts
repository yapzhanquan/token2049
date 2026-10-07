// Crew watchdog — the deterministic half of Firstmate's watcher (no LLM, no tokens).
// It reads the same EventBus stream the wake filter classifies and turns "the crew is not moving" into
// ACTIONABLE events the captain is woken for:
//   session_looping  — N consecutive failed tool calls (HTTP >= 400 / blocked fetches, denied tools, invalid
//                      handbacks), the same URL fetched over and over, or the silo itself reporting "stuck:"
//   session_stalled  — a RUNNING session produced no activity for stallMs (not while it legitimately waits:
//                      an open decision, a paid agent job in flight, or a monitor session watching the chain)
//   goal_completed   — every session of a goal is CLOSED: the captain verifies the definition of done and
//                      writes the final report (one event per goal; `timeBoxed` when the work deadline cut it)
//   work_deadline_reached — a session's work time (WORK_DEADLINE_SECONDS from RUNNING) is over. ACTIONABLE and
//                      acted on here, deterministically: after a short grace (the silo submits its own partial
//                      handback at the deadline) the watchdog collects a partial handback itself and the session
//                      closes (captain Revoke) — right after the work deadline, not at the vault expiry.
// Each signal carries an escalation count so the captain can climb a ladder (redirect → wrap up → kill).
// Restart-proof enough: the per-session counters are soft state; after a restart a session simply gets a fresh
// grace period, and goal_completed is de-duplicated against the events table.
import { agentJobs, decisions, sessions as sessionsT, type DB } from "@bulkhead/db";
import { TIMEBOXED_CLOSE_STATUS, isTimeLimitPartial, type BulkheadEvent, type Handback } from "@bulkhead/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { EventBus } from "../contracts";

/** The watchdog's hands for the work deadline (the SessionManager's timeBox; absent = report only). */
export interface WorkDeadlineActions {
  /** A session's work deadline (startedAt + WORK_DEADLINE_SECONDS) or null (not started / no limit). */
  deadlineOf: (sessionId: string) => number | null;
  /** Wait this long after the deadline for the silo's own partial handback before collecting one (default 5 s). */
  graceMs?: number;
  timeBox?: (sessionId: string, reason: string) => Promise<unknown>;
}

export interface WatchdogOptions {
  /** Consecutive failed tool calls before session_looping (default CAPTAIN_LOOP_FAILURES or 4). */
  loopFailures?: number;
  /** The same URL fetched this many times counts as a loop signal (default 3). */
  repeatLimit?: number;
  /** No activity for this long → session_stalled (default CAPTAIN_STALL_MS or 4 min). */
  stallMs?: number;
  now?: () => number;
  /** Work deadline enforcement (see WorkDeadlineActions). */
  work?: WorkDeadlineActions;
}

export interface SessionHealth {
  consecutiveFailures: number;
  recentErrors: string[];
  idleMs: number;
  escalation: number;
}

interface Track {
  lastActivity: number;
  failures: number;
  errors: string[];
  urls: Map<string, number>;
  escalation: number;
  lastStallAt: number;
}

const SUCCESS = new Set(["payment_submitted", "payment_confirmed", "agent_hired", "agent_job_paid", "agent_job_result", "handback_submitted", "handback_accepted"]);
/** Events that say nothing about the session's own progress. */
const IGNORE = new Set(["llm_usage", "tainted", "captain_woken", "captain_absorbed", "captain_action", "captain_report", "session_stalled", "session_looping", "goal_completed", "work_deadline_reached"]);
/** Sessions whose work time can still run out (they have not handed back / closed yet). */
const WORKING = ["RUNNING", "PAUSED", "QUARANTINED"] as const;
const TERMINAL = new Set(["CLOSING", "CLOSED", "FAILED", "KILLED", "EXPIRED"]);
const JOB_IN_FLIGHT: ("started" | "paid" | "running")[] = ["started", "paid", "running"];

const envNum = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export class CrewWatchdog {
  private readonly track = new Map<string, Track>();
  private readonly completedGoals = new Set<string>();
  private readonly loopFailures: number;
  private readonly repeatLimit: number;
  readonly stallMs: number;
  private readonly now: () => number;
  readonly work: WorkDeadlineActions | null;
  private readonly workNoticed = new Set<string>();
  private readonly timeBoxTried = new Map<string, number>();

  constructor(
    private readonly deps: { bus: EventBus; db: DB },
    opts: WatchdogOptions = {},
  ) {
    this.loopFailures = opts.loopFailures ?? envNum("CAPTAIN_LOOP_FAILURES", 4);
    this.repeatLimit = opts.repeatLimit ?? 3;
    this.stallMs = opts.stallMs ?? envNum("CAPTAIN_STALL_MS", 4 * 60_000);
    this.now = opts.now ?? Date.now;
    this.work = opts.work ?? null;
  }

  /**
   * Work-deadline pass (the wake filter calls it every second). For each session whose work time is over:
   * emit work_deadline_reached once; after the grace, if it still has not handed back, collect a partial handback
   * and close it (timeBox). Returns the sessions it acted on.
   */
  scanWork(): string[] {
    const w = this.work;
    if (!w) return [];
    const { db, bus } = this.deps;
    const now = this.now();
    const grace = w.graceMs ?? 5_000;
    // Only sessions still working: one that handed back (COMPLETING) is closed by its review.
    const rows = db
      .select()
      .from(sessionsT)
      .where(inArray(sessionsT.status, [...WORKING]))
      .all();
    const acted: string[] = [];
    for (const r of rows) {
      const end = r.startedAt ? w.deadlineOf(r.id) : null;
      if (end === null || now < end) continue;
      const secs = Math.round((end - r.startedAt!) / 1000);
      if (!this.workNoticed.has(r.id)) {
        this.workNoticed.add(r.id);
        if (!bus.since(0, { sessionId: r.id }).some((x) => x.type === "work_deadline_reached")) {
          bus.emit("work_deadline_reached", {
            goalId: r.goalId,
            sessionId: r.id,
            data: { letter: r.letter, taskType: r.taskType, status: r.status, workDeadlineAt: end, workSeconds: secs, action: "partial handback collected; the session closes and its funds return to the treasury" },
          });
        }
      }
      if (!w.timeBox || now < end + grace) continue; // the silo hands back its own partial at the deadline
      const tried = this.timeBoxTried.get(r.id);
      if (tried !== undefined && now - tried < 10_000) continue; // in flight / retry at most every 10 s
      this.timeBoxTried.set(r.id, now);
      acted.push(r.id);
      void w
        .timeBox(r.id, `work time (${secs} s) is over`)
        .catch((e) => bus.emit("error", { goalId: r.goalId, sessionId: r.id, data: { kind: "timebox_failed", error: e instanceof Error ? e.message : String(e) } }));
    }
    for (const id of [...this.timeBoxTried.keys()]) if (!rows.some((r) => r.id === id)) this.timeBoxTried.delete(id);
    return acted;
  }

  /** Read-only view for the captain's state snapshot. */
  health(sessionId: string): SessionHealth | null {
    const t = this.track.get(sessionId);
    if (!t) return null;
    return { consecutiveFailures: t.failures, recentErrors: t.errors.slice(-5), idleMs: this.now() - t.lastActivity, escalation: t.escalation };
  }

  private get(sessionId: string): Track {
    let t = this.track.get(sessionId);
    if (!t) {
      t = { lastActivity: this.now(), failures: 0, errors: [], urls: new Map(), escalation: 0, lastStallAt: 0 };
      this.track.set(sessionId, t);
    }
    return t;
  }

  /** Feed one bus event. May emit session_looping / goal_completed (synchronously, through the bus). */
  observe(e: BulkheadEvent): void {
    if (IGNORE.has(e.type)) return;
    if (e.type === "session_transition") return this.onTransition(e);
    const sid = e.sessionId;
    if (!sid || e.type === "heartbeat_missed") return;
    const d = e.data ?? {};
    const t = this.get(sid);
    t.lastActivity = this.now();
    switch (e.type) {
      case "web_fetch": {
        const url = String(d.url ?? "");
        const status = Number(d.status ?? 0);
        const n = (t.urls.get(url) ?? 0) + 1;
        t.urls.set(url, n);
        if (d.blocked) this.fail(e, t, `blocked ${clip(url)} (${clip(String(d.reason ?? ""), 80)})`);
        else if (status >= 400) this.fail(e, t, `HTTP ${status} ${clip(url)}`);
        else if (n >= this.repeatLimit) this.fail(e, t, `fetched ${clip(url)} ${n}x`);
        else this.succeed(t, false);
        return;
      }
      case "tool_denied":
        return this.fail(e, t, `tool denied: ${String(d.tool ?? "?")} (not allowed for ${String(d.taskType ?? "this task type")})`);
      case "error":
        if (d.kind === "handback_invalid") this.fail(e, t, `invalid handback: ${clip(String(d.error ?? ""), 100)}`);
        return;
      case "progress":
        if (d.kind === "log" && d.level === "warn" && /^stuck:/i.test(String(d.text ?? ""))) {
          // The silo's own loop guard: escalate at once.
          t.failures = Math.max(t.failures, this.loopFailures - 1);
          this.fail(e, t, clip(String(d.text), 160));
        }
        return;
      case "session_message":
        // A redirect gives the session a fresh start on the failure counter.
        t.failures = 0;
        t.errors = [];
        return;
      default:
        if (SUCCESS.has(e.type)) this.succeed(t, true);
    }
  }

  private succeed(t: Track, realProgress: boolean) {
    t.failures = 0;
    if (realProgress) {
      t.escalation = 0;
      t.errors = [];
    }
  }

  private fail(e: BulkheadEvent, t: Track, why: string) {
    t.failures++;
    t.errors = [...t.errors, why].slice(-8);
    if (t.failures < this.loopFailures) return;
    t.escalation++;
    const recent = t.errors.slice(-this.loopFailures);
    t.failures = 0;
    t.errors = [];
    const row = this.row(e.sessionId!);
    this.deps.bus.emit("session_looping", {
      goalId: e.goalId ?? row?.goalId,
      sessionId: e.sessionId,
      data: {
        letter: row?.letter,
        taskType: row?.taskType,
        failures: recent.length,
        recent,
        escalation: t.escalation,
        hint: hintFor(row?.taskType, recent),
      },
    });
  }

  private onTransition(e: BulkheadEvent) {
    const sid = e.sessionId;
    const to = String(e.data?.to ?? "");
    if (sid && to === "RUNNING") {
      const t = this.get(sid);
      t.lastActivity = this.now();
      t.lastStallAt = 0;
    }
    if (sid && TERMINAL.has(to)) this.track.delete(sid);
    if (to === "CLOSED") this.checkGoalCompleted(e.goalId ?? (sid ? this.row(sid)?.goalId : undefined));
  }

  /** Emit goal_completed once when every session of the goal is CLOSED. Exposed for tests. */
  checkGoalCompleted(goalId: string | undefined): boolean {
    if (!goalId || this.completedGoals.has(goalId)) return false;
    const rows = this.deps.db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all();
    if (!rows.length || rows.some((r) => r.status !== "CLOSED")) return false;
    this.completedGoals.add(goalId);
    const history = this.deps.bus.since(0, { goalId });
    if (history.some((x) => x.type === "goal_completed")) return false;
    const partialOf = (json: string | null) => {
      try {
        return json ? isTimeLimitPartial(JSON.parse(json) as Handback) : false;
      } catch {
        return false;
      }
    };
    const view = rows
      .sort((a, b) => a.letter.localeCompare(b.letter))
      .map((r) => ({ sessionId: r.id, letter: r.letter, name: r.name, taskType: r.taskType, closeStatus: r.closeStatus ?? "UNKNOWN", doneMet: r.closeStatus === "COMPLETED", spentMicro: r.spentMicro, hasHandback: !!r.handbackJson, timeBoxed: r.closeStatus === TIMEBOXED_CLOSE_STATUS || partialOf(r.handbackJson) }));
    const met = view.filter((v) => v.doneMet).length;
    // Time-boxed: the work deadline cut at least one session (partial handback / watchdog collected it).
    const timeBoxed = view.some((v) => v.timeBoxed) || history.some((x) => x.type === "work_deadline_reached");
    const timed = rows.find((r) => r.startedAt && this.work?.deadlineOf(r.id));
    const workSeconds = timed ? Math.round((this.work!.deadlineOf(timed.id)! - timed.startedAt!) / 1000) : 0;
    this.deps.bus.emit("goal_completed", {
      goalId,
      data: {
        sessions: view,
        doneMet: met,
        total: view.length,
        outcome: met === view.length ? "all_done" : met > 0 ? "partial" : "failed",
        ...(workSeconds ? { workSeconds } : {}),
        ...(timeBoxed ? { timeBoxed: true, timeBoxedSessions: view.filter((v) => v.timeBoxed).map((v) => v.letter) } : {}),
      },
    });
    return true;
  }

  /** Stall scan over RUNNING sessions (called on a timer by the wake filter). Returns the sessions flagged. */
  scan(): string[] {
    const { db, bus } = this.deps;
    const now = this.now();
    const running = db.select().from(sessionsT).where(eq(sessionsT.status, "RUNNING")).all();
    const flagged: string[] = [];
    const liveIds = new Set(running.map((r) => r.id));
    for (const id of [...this.track.keys()]) if (!liveIds.has(id) && !this.row(id)) this.track.delete(id);
    if (!running.length) return flagged;
    const ids = running.map((r) => r.id);
    const waitingDecision = new Set(
      db
        .select({ s: decisions.sessionId })
        .from(decisions)
        .where(and(inArray(decisions.sessionId, ids), eq(decisions.status, "open")))
        .all()
        .map((r) => r.s),
    );
    const jobInFlight = new Set(
      db
        .select({ s: agentJobs.sessionId })
        .from(agentJobs)
        .where(and(inArray(agentJobs.sessionId, ids), inArray(agentJobs.status, JOB_IN_FLIGHT)))
        .all()
        .map((r) => r.s),
    );
    for (const r of running) {
      const t = this.get(r.id);
      if (r.taskType === "monitor" || waitingDecision.has(r.id) || jobInFlight.has(r.id)) {
        t.lastActivity = Math.max(t.lastActivity, now - Math.floor(this.stallMs / 2)); // legit wait: keep a grace
        continue;
      }
      const idle = now - t.lastActivity;
      if (idle < this.stallMs || now - t.lastStallAt < this.stallMs) continue;
      t.lastStallAt = now;
      t.escalation++;
      flagged.push(r.id);
      bus.emit("session_stalled", {
        goalId: r.goalId,
        sessionId: r.id,
        data: { letter: r.letter, taskType: r.taskType, idleMs: idle, escalation: t.escalation, lastCheckpoint: safeParse(r.lastCheckpoint) },
      });
    }
    return flagged;
  }

  private row(sessionId: string) {
    return this.deps.db.select().from(sessionsT).where(eq(sessionsT.id, sessionId)).get() ?? null;
  }
}

/** A deterministic redirect the captain can use (and falls back to when its LLM does nothing). */
export function hintFor(taskType: string | undefined, recent: string[]): string {
  const joined = recent.join(" ");
  if (/tool denied/i.test(joined)) return `Only use the tools allowed for a ${taskType ?? "task"} session; do the task with those tools and submit_handback.`;
  if (/HTTP 4\d\d|blocked/i.test(joined))
    return "Stop guessing URL paths that return errors. Use the pages that already worked (or the root URLs of your dataScope), then submit_handback with what you have and list any gaps in flags.";
  if (/fetched .* \dx/i.test(joined)) return "You are re-reading the same page. Use what you already have and submit_handback now.";
  if (/invalid handback/i.test(joined)) return "Fix the handback shape: result and summary (<= 280 chars) are required; sources is an array of URLs.";
  return "You seem stuck. Change approach, and if the goal cannot be completed, submit_handback with what you have and explain the gaps in flags.";
}

function clip(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function safeParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
