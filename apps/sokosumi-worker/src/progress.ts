// Live progress on the Sokosumi Task: concise Coworker comments on milestones, so a paid Task never sits on
// "Running" with no visible updates.
//
// Sources (restart-safe):
//  - the Task journal itself (escrow locked, crew funded, result saved), re-derived on every pass;
//  - the Task's engine goal events, replayed from a saved cursor through `GET /events/stream?goalId=…&after=N`
//    (the engine serves persisted events first, then live ones; the follower reads until the backlog is drained).
//
// Posting rules: comments are ≥ minGapMs apart (default 10 s); everything queued in between is coalesced into ONE
// comment; at most maxComments per Task (the last `reserve` are kept for critical items: funding, errors, done).
// Every milestone has a key recorded in the journal BEFORE its post and is never posted twice (an uncertain post is
// not repeated, like every other external write in this worker).
import { createHash } from "node:crypto";
import { explorerTx, microToTusd, tusdToMicro } from "@bulkhead/shared";
import type { BulkheadEvent, Plan, TreeDTO, TreeNode } from "@bulkhead/shared";
import type { EnginePort } from "./engine";
import { clip, type SokosumiPort } from "./sokosumi";
import type { MpsPayment, MpsTx, PlannedCrewMember, ProgressState, TaskJournal } from "./types";

export interface GoalEventSource {
  /** Persisted + live events of one goal with id > afterId, oldest first. */
  since(userId: string, goalId: string, afterId: number): Promise<BulkheadEvent[]>;
}

export interface ProgressOptions {
  minGapMs?: number; // default 10 s
  maxComments?: number; // default 15
  reserve?: number; // comments kept for critical items (default 2)
  errorGraceMs?: number; // a worker error must persist this long before it is posted (default 2 min)
  maxChars?: number; // one coalesced comment (default 1800)
}

export interface ProgressDeps extends ProgressOptions {
  soko: Pick<SokosumiPort, "postComment">;
  events: GoalEventSource;
  engine?: Pick<EnginePort, "tree">;
  engineUserId: () => Promise<string>;
  save: (j: TaskJournal) => TaskJournal;
  now?: () => number;
  log?: (msg: string) => void;
}

const LETTER = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`);
const isHash = (h: unknown): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const tusd = (micro: string | bigint | undefined | null) => {
  try {
    return microToTusd(BigInt(micro ?? "0"));
  } catch {
    return "?";
  }
};
const shortHash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const PAST_ESCROW = new Set(["escrow-confirmed", "submit-pending", "awaiting-result", "complete-ready", "awaiting-withdrawal", "settled"]);
/** Captain moves worth telling the Task owner (routine reads / handback passing / reports are not). */
const CAPTAIN_VERB: Record<string, string> = {
  kill_session: "stopped",
  message_session: "redirected",
  pause_session: "paused",
  resume_session: "resumed",
  spawn_session: "added",
};
export const PICKUP_TEXT = 'Got it — reading the Task and preparing a quote… Progress (payment, crew plan, funding, results) will be posted here. Reply "status" any time.';

export function newProgress(): ProgressState {
  return { keys: {}, queue: [], count: 0 };
}

/** Remember the crew plan from POST /goals (compact; the plan text is posted later as a milestone). */
export function recordPlan(j: TaskJournal, plan: Plan | undefined): void {
  if (!plan?.sessions?.length) return;
  const p = (j.progress ??= newProgress());
  p.plan = plan.sessions.map((s, i) => ({
    letter: LETTER(i),
    role: s.role,
    name: s.name,
    budgetTUSD: s.budgetTUSD,
    after: (s.contextFrom ?? []).filter((x) => x < plan.sessions.length && x !== i).map(LETTER),
  }));
}

/** "Crew of 3: A researcher — prices, B writer — job ad (parallel), C designer — flyer (after A,B). Budget split: …" */
export function planText(crew: PlannedCrewMember[], j: TaskJournal): string {
  const roots = crew.filter((c) => !c.after.length).length;
  const parts = crew.map((c) => {
    const what = c.name && c.name.toLowerCase() !== c.role.toLowerCase() ? ` — ${clip(c.name, 60)}` : "";
    const when = c.after.length ? ` (after ${c.after.join(",")})` : roots > 1 ? " (parallel)" : "";
    return `${c.letter} ${c.role}${what}${when}`;
  });
  const split = crew.map((c) => `${c.letter} ${c.budgetTUSD}`).join(" + ");
  let total = 0n;
  for (const c of crew) {
    try {
      total += tusdToMicro(c.budgetTUSD);
    } catch {
      /* skip */
    }
  }
  const o = j.order;
  const quote = o ? ` (crew budget ${tusd(o.crewBudgetMicro)} + Bulkhead fee ${tusd(o.feeMicro)})` : "";
  return `Crew of ${crew.length}: ${parts.join(", ")}. Budget split: ${split} = ${microToTusd(total)} tUSDM${quote}.`;
}

function planFromTree(tree: TreeDTO): PlannedCrewMember[] {
  const nodes = tree.nodes.filter((n): n is TreeNode => n.kind === "session");
  const letterOf = new Map(nodes.map((n) => [n.id, n.letter ?? "?"]));
  return nodes.map((n) => ({
    letter: n.letter ?? "?",
    role: n.role ?? "session",
    name: n.label ?? "",
    budgetTUSD: tusd(n.budgetMicro),
    after: tree.edges.filter((e) => e.kind === "handback" && e.to === n.id && letterOf.has(e.from)).map((e) => letterOf.get(e.from)!),
  }));
}

function escrowTx(p: MpsPayment | undefined): string | null {
  if (!p) return null;
  const all: MpsTx[] = [...(p.TransactionHistory ?? []), ...(p.CurrentTransaction ? [p.CurrentTransaction] : [])];
  const locked = all.find((t) => t?.newOnChainState === "FundsLocked" && t.status === "Confirmed" && isHash(t.txHash));
  return locked?.txHash ?? null;
}

/** Plain-language error with what the Task owner can do (raw errors are never posted). */
export function plainError(message: string): string {
  const m = message.toLowerCase();
  let what: string;
  if (/insufficient|shortfall|treasury|top up/.test(m)) what = "The Bulkhead treasury is short of funds for this crew; the operator has to top it up. Nothing needed from you — the crew starts automatically once funded.";
  else if (/outcome unknown|uncertain|inspect/.test(m)) what = "An earlier step's outcome could not be confirmed, so Bulkhead paused this Task for an operator check (nothing is ever done twice). Nothing needed from you.";
  else if (/payment service|mps|escrow/.test(m)) what = "The Masumi payment service is not responding right now; Bulkhead keeps retrying automatically. Nothing needed from you.";
  else if (/econnrefused|fetch failed|enotfound|timeout|timed out|aborted|socket|engine/.test(m)) what = "The Bulkhead engine is temporarily unreachable; the worker keeps retrying automatically. Nothing needed from you.";
  else what = "Bulkhead hit an internal problem on this Task and keeps retrying automatically. Nothing needed from you.";
  return `Delay: ${what} Reply "status" any time.`;
}

/** Current state in plain words + what (if anything) needs the Task owner. Used for "status" / "go" / "approve" replies. */
export function describeTask(j: TaskJournal): { now: string; needs: string | null } {
  const p = j.progress;
  const pay = j.payment;
  const asked = Object.values(j.decisions ?? {}).filter((d) => d.state === "asked");
  const needsDecision = asked.length
    ? asked.map((d) => `a crew session asks for ${d.kind.replace(/_/g, " ")}${d.amountMicro ? ` (${tusd(d.amountMicro)} tUSDM)` : ""} — reply "approve ${d.amountMicro ? tusd(d.amountMicro) : "<amount>"} tUSDM" to allow it`).join("; ")
    : null;
  switch (j.phase) {
    case "starting":
    case "started":
    case "goal-pending":
    case "goal-created":
    case "approve-pending": {
      if (j.orderError) return { now: "Bulkhead could not accept this Task as written.", needs: null };
      if (j.mode === "paid" && pay && !PAST_ESCROW.has(pay.stage)) {
        if (pay.stage === "awaiting-escrow") {
          const by = Number(pay.payment?.payByTime);
          return { now: "Waiting for your payment to lock in escrow.", needs: `pay the payment request above${Number.isFinite(by) ? ` before ${new Date(by).toISOString()}` : ""} to start the crew` };
        }
        return { now: "Preparing the quote and payment request.", needs: null };
      }
      if (j.mode === "paid") return { now: "Payment locked in escrow; planning and funding the crew.", needs: null };
      return { now: "Planning and funding the crew.", needs: null };
    }
    case "running": {
      if (p?.stall && !p.stall.resolvedAt && !j.fundingTx && !p.fundingTx)
        return { now: `Crew planned but not funded yet: ${p.stall.text}`, needs: needsDecision ?? null };
      return { now: "The crew is working.", needs: needsDecision };
    }
    case "result-saved":
    case "complete-pending":
      return { now: `Crew finished; delivering the result${j.result ? ` (sha256 ${j.result.sha256})` : ""}.`, needs: null };
    case "completed":
      return { now: `Completed${j.result ? ` (result sha256 ${j.result.sha256})` : ""}.`, needs: null };
    case "failed":
      return { now: `Stopped: ${j.failedReason ?? "an unrecoverable problem"}. An operator will review it.`, needs: null };
  }
}

export function needsLine(d: { needs: string | null }): string {
  return d.needs ? `Needs you: ${d.needs}.` : "Nothing needs your input right now.";
}

export class ProgressReporter {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly minGapMs: number;
  private readonly maxComments: number;
  private readonly reserve: number;
  private readonly errorGraceMs: number;
  private readonly maxChars: number;
  private readonly lastFetchError = new Map<string, string>();

  constructor(private readonly d: ProgressDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(m));
    this.minGapMs = d.minGapMs ?? 10_000;
    this.maxComments = d.maxComments ?? 15;
    this.reserve = d.reserve ?? 2;
    this.errorGraceMs = d.errorGraceMs ?? 120_000;
    this.maxChars = d.maxChars ?? 1800;
  }

  private enqueue(p: ProgressState, key: string, text: string, critical = false): void {
    if (p.keys[key]) return;
    p.keys[key] = "queued";
    p.queue.push({ key, text, at: this.now(), ...(critical ? { critical: true } : {}) });
  }

  /** Immediately on pickup (after `runtime start`): one informative comment. */
  async pickup(j: TaskJournal): Promise<void> {
    const p = (j.progress ??= newProgress());
    this.enqueue(p, "pickup", PICKUP_TEXT, true);
    if (!(await this.flush(j))) this.d.save(j);
  }

  /** One pass for a Task: collect milestones (journal + engine events), then post at most one coalesced comment. */
  async tick(j: TaskJournal): Promise<void> {
    if (j.phase === "starting") return;
    if (!j.progress && (j.phase === "completed" || j.phase === "failed")) return; // never narrate old Tasks
    const before = JSON.stringify(j.progress ?? null);
    const p = (j.progress ??= newProgress());
    if (j.phase === "failed") {
      // The runner's failure notice says it; drop what was still queued.
      if (p.queue.length) {
        for (const it of p.queue) p.keys[it.key] = "skipped";
        p.queue = [];
        this.d.save(j);
      }
      return;
    }
    if (!(j.phase === "completed" && p.keys.done)) {
      this.fromJournal(j, p);
      if (j.goalId && !p.keys.done) await this.fromEngine(j, p);
      this.fromJournal(j, p); // events may have filled the plan / funding
      this.trackError(j, p);
    }
    if (!(await this.flush(j)) && JSON.stringify(p) !== before) this.d.save(j);
  }

  private fromJournal(j: TaskJournal, p: ProgressState): void {
    const pay = j.payment;
    if (j.mode === "paid" && pay && PAST_ESCROW.has(pay.stage)) {
      const tx = escrowTx(pay.observed) ?? escrowTx(pay.payment);
      const amount = j.order ? `${tusd(j.order.quoteMicro)} tUSDM` : "your payment";
      this.enqueue(p, "escrow", `Payment locked in escrow: ${amount} on Cardano preprod.${tx ? ` ${explorerTx(tx)}` : ""} Planning the crew now.`);
    }
    if (j.goalId && p.plan?.length) this.enqueue(p, "plan", planText(p.plan, j));
    const funded = isHash(j.fundingTx) ? j.fundingTx : p.fundingTx;
    if (funded) {
      this.resolveStall(p);
      this.enqueue(p, "funded", `Crew funded from the Bulkhead treasury: ${explorerTx(funded)}`);
    }
    if (j.result && !j.orderError && ["result-saved", "complete-pending", "completed"].includes(j.phase)) {
      const l = j.ledger;
      const n = Object.keys(p.sessions ?? {}).length;
      const money = l ? ` Spent ${tusd(l.spentMicro)} of ${tusd(l.floatMicro)} tUSDM; ${tusd(l.refundMicro)} returned to the treasury.` : "";
      const next = j.mode === "paid" ? " Submitting the result hash to the Masumi escrow, then delivering the result here." : " Delivering the result now.";
      this.enqueue(p, "done", `Crew finished${n ? ` (${n} session${n === 1 ? "" : "s"})` : ""}.${money} Result sha256 ${j.result.sha256}.${next}`, true);
    }
  }

  private resolveStall(p: ProgressState): void {
    if (!p.stall || p.stall.resolvedAt) return;
    p.stall.resolvedAt = this.now();
    this.enqueue(p, "stall-resolved", "Funding resolved: the Bulkhead treasury was topped up and the crew is being funded.", true);
  }

  private who(p: ProgressState, sessionId: string | undefined, data: Record<string, unknown> = {}): string {
    const s = sessionId ? p.sessions?.[sessionId] : undefined;
    const letter = s?.letter ?? str(data.letter);
    const role = s?.role ?? str(data.role);
    return `${letter} ${role}`.trim();
  }

  private async fromEngine(j: TaskJournal, p: ProgressState): Promise<void> {
    let events: BulkheadEvent[];
    try {
      events = await this.d.events.since(await this.d.engineUserId(), j.goalId!, p.cursor ?? 0);
      this.lastFetchError.delete(j.taskId);
    } catch (e) {
      const msg = clip(e);
      if (this.lastFetchError.get(j.taskId) !== msg) this.log(`progress ${j.taskId}: engine events unavailable: ${msg}`);
      this.lastFetchError.set(j.taskId, msg);
      return;
    }
    const sessions = (p.sessions ??= {});
    const unknownSession = events.some((e) => e.sessionId && !sessions[e.sessionId]?.letter && e.type !== "session_created");
    if (this.d.engine && ((!p.plan?.length && !p.keys.plan) || unknownSession)) {
      try {
        const tree = await this.d.engine.tree(await this.d.engineUserId(), j.goalId!);
        for (const n of tree.nodes) if (n.kind === "session") sessions[n.id] = { letter: n.letter ?? sessions[n.id]?.letter, role: n.role ?? sessions[n.id]?.role };
        const crew = planFromTree(tree);
        if (crew.length && !p.plan?.length) p.plan = crew;
      } catch {
        /* next pass */
      }
    }
    if (p.plan?.length) this.enqueue(p, "plan", planText(p.plan, j)); // the plan reads before what happened next
    for (const e of events) {
      if (typeof e.id === "number" && e.id > (p.cursor ?? 0)) p.cursor = e.id;
      this.onEvent(p, e);
    }
  }

  /** Map one engine event to at most one milestone. */
  onEvent(p: ProgressState, e: BulkheadEvent): void {
    const d = e.data ?? {};
    const sessions = (p.sessions ??= {});
    switch (e.type) {
      case "session_created":
        if (e.sessionId) sessions[e.sessionId] = { letter: str(d.letter) || undefined, role: str(d.role) || undefined };
        return;
      case "session_transition":
        if (e.sessionId && d.letter && !sessions[e.sessionId]?.letter) sessions[e.sessionId] = { ...sessions[e.sessionId], letter: str(d.letter) };
        if (e.sessionId && d.to === "RUNNING" && d.from !== "PAUSED") this.enqueue(p, `start:${e.sessionId}`, `Session ${this.who(p, e.sessionId, d) || "?"} started.`);
        return;
      case "session_funded":
        if ((d.phase === "submitted" || d.phase === "confirmed") && isHash(d.txHash)) {
          p.fundingTx ??= d.txHash;
          this.resolveStall(p);
          this.enqueue(p, "funded", `Crew funded from the Bulkhead treasury: ${explorerTx(p.fundingTx)}`);
        }
        return;
      case "error": {
        const kind = str(d.kind);
        if ((kind === "funding_stalled" || kind === "insufficient_funds") && !p.stall) {
          const text = clip(str(d.error ?? d.message), 600);
          p.stall = { text, at: this.now() };
          this.enqueue(p, "stall", `Funding stalled: ${text} The crew starts automatically once the Bulkhead treasury is topped up; your payment stays in escrow meanwhile. Nothing needed from you.`, true);
        }
        return;
      }
      case "progress":
        if (/no longer stalled|funded \d+ waiting session/i.test(str(d.text))) this.resolveStall(p);
        return;
      case "captain_action": {
        const verb = CAPTAIN_VERB[str(d.tool)];
        if (!verb || d.ok === false) return;
        const why = clip(str(d.why), 200);
        const role = str((d.input as { role?: unknown } | undefined)?.role);
        const who = this.who(p, e.sessionId);
        const target = d.tool === "spawn_session" ? `a session${role ? ` (${role})` : ""}` : who ? `session ${who}` : "a session";
        this.enqueue(p, `act:${e.id}`, `Captain ${verb} ${target}${why ? `: ${why}` : "."}`);
        return;
      }
      case "captain_report": {
        const kind = str(d.kind);
        const headline = clip(str(d.headline), 200);
        const risk = str(d.risk);
        if (kind === "session_result" && e.sessionId) this.enqueue(p, `result:${e.sessionId}`, `${this.who(p, e.sessionId, d) || "A session"} finished: ${headline}${risk ? ` (risk: ${risk})` : ""}.`);
        else if (kind === "incident") this.enqueue(p, `incident:${str(d.dedupKey) || e.id}`, `Incident: ${headline}${risk ? ` (risk: ${risk})` : ""}.`, true);
        return;
      }
      case "agent_hired": {
        const svc = clip(str(d.serviceId), 80) || "an agent";
        const price = d.billing === "credits" ? `${str(d.credits)} Sokosumi credits` : `${str(d.priceTUSD) || tusd(str(d.priceMicro))} tUSDM`;
        this.enqueue(p, `hire:${str(d.jobRowId) || e.id}`, `${this.who(p, e.sessionId) || "A session"} hired ${svc} from the market for ${price}.`);
        return;
      }
      case "agent_job_paid":
        if (isHash(d.txHash)) this.enqueue(p, `hirepaid:${str(d.jobRowId) || e.id}`, `${this.who(p, e.sessionId) || "A session"} paid ${clip(str(d.serviceId), 80) || "the hired agent"}: ${explorerTx(d.txHash)}`);
        return;
      default:
        return;
    }
  }

  private trackError(j: TaskJournal, p: ProgressState): void {
    if (!j.lastError) {
      delete p.err;
      return;
    }
    const msg = j.lastError.message;
    if (p.err?.msg !== msg) {
      p.err = { msg, since: this.now() };
      return;
    }
    if (this.now() - p.err.since < this.errorGraceMs) return;
    const text = plainError(msg);
    // A funding shortfall already explained by the engine's exact text is not repeated as a vague delay.
    if (p.stall && !p.stall.resolvedAt && /insufficient|shortfall|treasury/i.test(msg)) return;
    this.enqueue(p, `error:${shortHash(text)}`, text, true);
  }

  /** Post everything queued as ONE comment, if the rate limit and the per-Task budget allow. True when it saved. */
  async flush(j: TaskJournal): Promise<boolean> {
    const p = j.progress;
    if (!p || !p.queue.length) return false;
    if (p.lastPostAt !== undefined && this.now() - p.lastPostAt < this.minGapMs) return false;
    const left = this.maxComments - p.count;
    const take: typeof p.queue = [];
    const keep: typeof p.queue = [];
    let size = 0;
    for (const it of p.queue) {
      const allowed = left > this.reserve || (left > 0 && it.critical);
      if (!allowed) {
        p.keys[it.key] = "skipped";
        continue;
      }
      if (take.length && size + it.text.length + 1 > this.maxChars) {
        keep.push(it);
        continue;
      }
      take.push(it);
      size += it.text.length + 1;
    }
    p.queue = keep;
    if (!take.length) {
      this.d.save(j);
      return true;
    }
    for (const it of take) p.keys[it.key] = "posting";
    p.count++;
    p.lastPostAt = this.now();
    this.d.save(j); // recorded BEFORE the post: never posted twice, even after a crash
    const text = take.map((it) => it.text).join("\n");
    try {
      await this.d.soko.postComment(j.taskId, text.length > this.maxChars + 200 ? `${text.slice(0, this.maxChars + 199)}…` : text);
      for (const it of take) p.keys[it.key] = "posted";
      this.d.save(j);
    } catch (e) {
      this.log(`progress ${j.taskId}: comment post failed (not repeated): ${clip(e)}`);
    }
    return true;
  }
}

// ───────────────────────── engine events over SSE (replay from a cursor) ─────────────────────────

export interface SseOptions {
  /** Stop reading once no frame arrived for this long after the stream became ready (backlog drained). */
  idleMs?: number;
  /** Hard cap per read. */
  maxMs?: number;
  maxEvents?: number;
}

/** Parse complete SSE frames from a buffer; returns the frames and the unparsed remainder. */
export function parseSseFrames(buf: string): { frames: { event: string; id?: string; data: string }[]; rest: string } {
  const frames: { event: string; id?: string; data: string }[] = [];
  const norm = buf.replace(/\r\n/g, "\n");
  const parts = norm.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    if (data.length || event !== "message") frames.push({ event, id, data: data.join("\n") });
  }
  return { frames, rest };
}

/** `GET /events/stream?goalId=…&after=N` read until the persisted backlog is drained (then the stream is closed). */
export class SseGoalEvents implements GoalEventSource {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: SseOptions = {},
  ) {}

  async since(userId: string, goalId: string, afterId: number): Promise<BulkheadEvent[]> {
    const idleMs = this.opts.idleMs ?? 700;
    const maxMs = this.opts.maxMs ?? 8_000;
    const maxEvents = this.opts.maxEvents ?? 2_000;
    const ac = new AbortController();
    const hard = setTimeout(() => ac.abort(), maxMs);
    const out: BulkheadEvent[] = [];
    try {
      const q = new URLSearchParams({ goalId, after: String(afterId) });
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/events/stream?${q}`, {
        headers: { accept: "text/event-stream", "x-engine-token": this.token, "x-user-id": userId },
        redirect: "error",
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`engine GET /events/stream: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let ready = false;
      let idle: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => ac.abort(), idleMs);
      };
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          buf += dec.decode(r.value, { stream: true });
          const { frames, rest } = parseSseFrames(buf);
          buf = rest;
          let stop = false;
          for (const f of frames) {
            if (f.event === "ready") ready = true;
            else if (f.event === "ping") stop = true; // the server only pings once its queue is empty
            else if (f.event === "message" && f.data) {
              try {
                const e = JSON.parse(f.data) as BulkheadEvent;
                if (typeof e.id === "number" && e.id > afterId) out.push(e);
              } catch {
                /* skip a malformed frame */
              }
            }
          }
          if (stop || out.length >= maxEvents) break;
          if (ready) arm();
        }
      } catch (e) {
        if (!ac.signal.aborted) throw e; // our own idle/hard abort ends a normal read
      } finally {
        if (idle) clearTimeout(idle);
        ac.abort();
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
      return out.sort((a, b) => a.id - b.id);
    } catch (e) {
      if (ac.signal.aborted && out.length) return out.sort((a, b) => a.id - b.id);
      if (ac.signal.aborted) return out;
      throw e;
    } finally {
      clearTimeout(hard);
    }
  }
}
