// The Bridge: how the captain talks to you (Firstmate-style). Plain-outcome reports with risk + evidence,
// a 4-section Bearings digest, an Ahoy recap of what happened since you last looked, and only the
// decisions that really need you, ranked by impact.
//
// Contract types come from packages/shared/src/bridge.ts. Every engine payload is still normalised
// defensively into small view models, and everything has a fallback derived from the live event stream
// + goal tree, so the Bridge works even when /bearings or /ahoy are unavailable (older engine, restart).
import type { BulkheadEvent, Decision, DecisionRecommendation, EvidenceKind, GoalSummary, LogbookEntryDTO, ReportEvidence, ReportKind, RiskLevel, TreeDTO, TreeNode } from "@bulkhead/shared";
import { EVIDENCE_KINDS, explorerAddress, explorerTx, tusdToMicro } from "@bulkhead/shared";
import { DECISION_WORD } from "./describe";
import { big, myr } from "./money";

export type { DecisionRecommendation, EvidenceKind, ReportKind };
export type Risk = RiskLevel;
export type Evidence = ReportEvidence;

// ───────────── view models ─────────────
/** A normalised captain_report: structured (`kind` present) or the captain's free-text chat (no kind). */
export interface CaptainReport {
  goalId?: string;
  sessionId?: string;
  letter?: string;
  kind?: ReportKind;
  headline: string;
  risk?: Risk;
  riskReason?: string;
  evidence: Evidence[];
  next?: string;
  decisionId?: string;
  recommendation?: DecisionRecommendation;
  wording?: "llm" | "deterministic";
}
/** Money in micro-units (bigint-safe strings); the engine sends decimal tUSD, converted on read. */
export interface MoneyView {
  budget: string;
  spent: string;
  inVaults: string;
  returned: string;
  pendingTx: number;
  inVaultsSource?: "chain" | "db";
  pendingTxs?: Evidence[];
}
/** One line of a Bearings / Ahoy section. */
export interface BridgeLine {
  key: string;
  text: string;
  sub?: string;
  risk?: Risk;
  riskReason?: string;
  sessionId?: string;
  decisionId?: string;
  evidence: Evidence[];
  recommendation?: DecisionRecommendation;
  /** In-flight sessions: end of the crew's work time (live countdown on the Bridge). */
  workDeadlineAt?: number;
}
export interface BearingsView {
  done: BridgeLine[];
  inFlight: BridgeLine[];
  needsYou: BridgeLine[];
  money: MoneyView;
  overall?: string;
  empty?: { needsYou?: string; done?: string; inFlight?: string };
  source: "engine" | "derived";
}
export interface AhoyDecisionView {
  decisionId: string;
  title: string;
  detail?: string;
  sessionId?: string;
  impact?: string;
  risk?: Risk;
  blocked?: string[];
  recommendation?: DecisionRecommendation;
  /** true = the recommendation came from the captain (engine); false = derived here from the facts. */
  fromCaptain: boolean;
  amountMicro?: string;
  kind?: string;
}
export interface AhoyGroupView {
  key: string;
  title: string;
  count: number;
  lines: BridgeLine[];
}
export interface AhoyView {
  since: number;
  headline?: string;
  /** Newest event id the recap covered (POST /ahoy/seen { eventId }). */
  latestEventId?: number;
  groups: AhoyGroupView[];
  /** Routine events folded away (shown as one line). */
  routine: number;
  decisions: AhoyDecisionView[];
  source: "engine" | "derived";
}

// ───────────── normalisers ─────────────
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const isRisk = (v: unknown): v is Risk => v === "low" || v === "medium" || v === "high";
const REPORT_KIND_LIST: ReportKind[] = ["session_result", "goal_result", "escalation", "incident"];

export function normEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v)) return [];
  const out: Evidence[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const kind = (EVIDENCE_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as EvidenceKind) : "source";
    const ref = str(o.ref ?? o.value ?? o.hash ?? o.url);
    if (!ref && kind !== "dod") continue;
    out.push({ kind, ref, label: str(o.label) || kind.replace("_", " "), url: typeof o.url === "string" ? o.url : undefined });
  }
  return out;
}

function normRec(v: unknown): DecisionRecommendation | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return { action: /^\s*rej/i.test(v) ? "reject" : /^\s*rev/i.test(v) ? "review" : "approve", why: v };
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const a = str(o.action ?? o.verdict).toLowerCase();
  return { action: a.startsWith("rej") ? "reject" : a.startsWith("rev") ? "review" : "approve", why: str(o.why ?? o.reason ?? o.text) };
}

export function normLine(x: unknown, i: number): BridgeLine {
  if (typeof x === "string") return { key: `l${i}`, text: x, evidence: [] };
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const text = str(o.headline ?? o.text ?? o.summary ?? o.title ?? o.question ?? o.label) || "—";
  return {
    key: `${str(o.decisionId ?? o.sessionId ?? (Array.isArray(o.eventIds) ? o.eventIds[0] : o.id))}:${i}`,
    text,
    sub: str(o.sub ?? o.detail ?? o.next) || undefined,
    risk: isRisk(o.risk) ? o.risk : undefined,
    riskReason: str(o.riskReason) || undefined,
    sessionId: str(o.sessionId) || undefined,
    decisionId: str(o.decisionId) || undefined,
    evidence: normEvidence(o.refs ?? o.evidence),
    recommendation: normRec(o.recommendation),
  };
}

/** Engine Bearings/Ahoy amounts are decimal tUSD strings ("4.5"); the view works in micro-units. */
export function decToMicro(v: unknown): string {
  if (v === undefined || v === null || v === "") return "0";
  const s = String(v).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return "0";
  try {
    return tusdToMicro(m[2] ? `${m[1]}.${m[2].slice(0, 6)}` : m[1]!).toString();
  } catch {
    return "0";
  }
}

export function normBearings(raw: unknown): BearingsView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.done) && !Array.isArray(o.inFlight) && !Array.isArray(o.needsYou)) return null;
  const m = (o.money ?? {}) as Record<string, unknown>;
  const pending = Array.isArray(m.pendingTx) ? m.pendingTx.length : Number(m.pendingTx ?? 0) || 0;
  const overall = (o.overall ?? null) as Record<string, unknown> | string | null;
  const empty = (o.empty ?? {}) as Record<string, unknown>;
  return {
    done: (Array.isArray(o.done) ? o.done : []).map(normLine),
    inFlight: (Array.isArray(o.inFlight) ? o.inFlight : []).map(normLine),
    needsYou: (Array.isArray(o.needsYou) ? o.needsYou : []).map(normLine),
    money: {
      budget: decToMicro(m.budget),
      spent: decToMicro(m.spent),
      inVaults: decToMicro(m.inVaults),
      returned: decToMicro(m.returned),
      pendingTx: pending,
      inVaultsSource: m.inVaultsSource === "chain" ? "chain" : m.inVaultsSource === "db" ? "db" : undefined,
      pendingTxs: normEvidence(m.pendingTxs),
    },
    overall: (typeof overall === "string" ? overall : str(overall?.text)) || undefined,
    empty: { needsYou: str(empty.needsYou) || undefined, done: str(empty.done) || undefined, inFlight: str(empty.inFlight) || undefined },
    source: "engine",
  };
}

export function normAhoy(raw: unknown): AhoyView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.groups) && !Array.isArray(o.decisions)) return null;
  const decisions: AhoyDecisionView[] = [];
  for (const x of Array.isArray(o.decisions) ? o.decisions : []) {
    if (!x || typeof x !== "object") continue;
    const d = x as Record<string, unknown>;
    const id = str(d.decisionId ?? d.id);
    if (!id) continue;
    const amt = d.amountAtRisk !== undefined ? decToMicro(d.amountAtRisk) : undefined;
    decisions.push({
      decisionId: id,
      title: str(d.question ?? d.title) || DECISION_WORD[str(d.kind)] || str(d.kind) || "Decision",
      sessionId: str(d.sessionId) || undefined,
      impact: str(d.impactReason) || undefined,
      risk: isRisk(d.risk) ? d.risk : undefined,
      blocked: Array.isArray(d.blockedSessions) ? d.blockedSessions.map(String) : undefined,
      recommendation: normRec(d.recommendation),
      fromCaptain: true,
      kind: str(d.kind) || undefined,
      amountMicro: amt && amt !== "0" ? amt : undefined,
    });
  }
  const groups: AhoyGroupView[] = [];
  let routine = 0;
  for (const g of Array.isArray(o.groups) ? o.groups : []) {
    if (!g || typeof g !== "object") continue;
    const gg = g as Record<string, unknown>;
    const key = str(gg.key);
    const items = Array.isArray(gg.items) ? gg.items : [];
    const count = Number(gg.count ?? items.length) || 0;
    if (key === "routine") {
      routine += count;
      continue;
    }
    if (key === "decisions" && decisions.length) continue; // shown below, ranked, with buttons
    if (!items.length) continue;
    groups.push({ key, title: str(gg.title) || key, count, lines: items.map(normLine) });
  }
  const s = o.since;
  const since = s && typeof s === "object" ? Number((s as Record<string, unknown>).at ?? 0) || 0 : Number(s ?? 0) || 0;
  const h = o.headline;
  const headline = h && typeof h === "object" ? str((h as Record<string, unknown>).text) : str(h);
  return {
    since,
    headline: headline || (o.nothingHappened === true ? "Nothing happened that needs you." : undefined),
    latestEventId: Number(o.latestEventId ?? 0) || undefined,
    groups,
    routine,
    decisions,
    source: "engine",
  };
}

// ───────────── evidence helpers ─────────────
export function evidenceHref(e: Evidence, fixture: boolean): string | null {
  if (e.url) return e.url;
  if (fixture) return null;
  if (e.kind === "tx" && /^[0-9a-f]{64}$/i.test(e.ref)) return explorerTx(e.ref);
  if (e.kind === "vault" && e.ref.startsWith("addr")) return explorerAddress(e.ref);
  if (e.kind === "source" && /^https?:\/\//.test(e.ref)) return e.ref;
  return null;
}

const TERMINAL = new Set(["CLOSED", "KILLED", "FAILED", "EXPIRED"]);
const ENDED = new Set(["CLOSED", "KILLED", "FAILED", "EXPIRED", "CLOSING", "COMPLETING"]);

/** Hard evidence for a session, straight from its on-chain / ledger events. */
export function sessionEvidence(events: BulkheadEvent[], sessionId: string | undefined): Evidence[] {
  if (!sessionId) return [];
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const add = (e: Evidence) => {
    const k = `${e.kind}:${e.ref}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    const d = e.data ?? {};
    if (e.type === "handback_accepted") add({ kind: "dod", label: "DoD ✓", ref: "definition of done met" });
    if (e.type === "payment_confirmed" && d.txHash) add({ kind: "tx", label: "payment", ref: str(d.txHash) });
    if (e.type === "agent_job_paid" && d.txHash) add({ kind: "tx", label: "agent paid", ref: str(d.txHash) });
    if (e.type === "close_confirmed") {
      if (d.txHash) add({ kind: "tx", label: "close + refund", ref: str(d.txHash) });
      if (d.handbackSha256) add({ kind: "handback_hash", label: "handback sha256", ref: str(d.handbackSha256) });
    }
    if (e.type === "handback_submitted" && Array.isArray(d.sources)) for (const u of d.sources.slice(0, 3)) add({ kind: "source", label: "source", ref: str(u) });
  }
  return out.slice(0, 8);
}

// ───────────── captain reports ─────────────
export function reportOf(e: BulkheadEvent, events: BulkheadEvent[]): CaptainReport {
  const d = e.data ?? {};
  // Structured outcome report = `kind` present (shared CaptainReportData); else the captain's free-text chat.
  const kind = REPORT_KIND_LIST.find((k) => k === d.kind);
  const sessionId = str(d.sessionId ?? e.sessionId) || undefined;
  const evidence = normEvidence(d.evidence ?? d.refs);
  return {
    goalId: e.goalId,
    sessionId,
    letter: str(d.letter) || undefined,
    kind,
    headline: (kind ? str(d.headline) : "") || str(d.text) || str(d.headline),
    risk: isRisk(d.risk) ? d.risk : undefined,
    riskReason: str(d.riskReason) || undefined,
    // A free-text report about a session: attach that session's own on-chain evidence so the claim is checkable.
    evidence: evidence.length || kind ? evidence : sessionEvidence(events, sessionId),
    next: str(d.next) || undefined,
    decisionId: str(d.decisionId) || undefined,
    recommendation: normRec(d.recommendation),
    wording: d.wording === "llm" ? "llm" : d.wording === "deterministic" ? "deterministic" : undefined,
  };
}

// ───────────── captain actions ─────────────
const ACTION_VERB: Record<string, string> = {
  message_session: "Redirected",
  pause_session: "Paused",
  resume_session: "Resumed",
  kill_session: "Stopped",
  spawn_session: "Spawned",
  pass_handback: "Passed handback",
  request_user_approval: "Escalated to you",
  plan_task: "Planned",
};
/** Captain tools that are bookkeeping, not decisions (absorbed into the routine line). */
const ROUTINE_TOOLS = new Set(["read_status", "report_to_user"]);

export interface ActionLine {
  verb: string;
  target: string;
  why?: string;
  /** "model" = the captain wrote the why; "auto" = derived deterministically from the wake evidence. */
  whySource?: "model" | "auto";
  said?: string;
  ok: boolean;
  error?: string;
  auto: boolean;
}
export function actionOf(e: BulkheadEvent, letterOf: (sid?: string) => string | undefined): ActionLine | null {
  const d = e.data ?? {};
  const tool = str(d.tool);
  if (ROUTINE_TOOLS.has(tool)) return null;
  const whySource = d.whySource === "model" ? "model" : d.whySource === "auto" ? "auto" : undefined;
  if (!tool) {
    // Older / fixture events carry only a text line.
    const text = str(d.text);
    return text ? { verb: text, target: "", why: str(d.why) || undefined, whySource, ok: d.ok !== false, error: d.ok === false ? str(d.error) : undefined, auto: d.auto === true } : null;
  }
  const input = (d.input ?? {}) as Record<string, unknown>;
  const sid = e.sessionId ?? (str(input.sessionId) || undefined);
  let target = letterOf(sid) ?? (sid && sid !== "all" ? sid.slice(0, 10) : sid === "all" ? "all sessions" : "");
  if (tool === "pass_handback") target = `${letterOf(str(input.fromSessionId)) ?? "?"} → ${letterOf(str(input.toSessionId)) ?? "?"}`;
  if (tool === "spawn_session" || tool === "plan_task") target = str(input.role ?? input.name ?? input.goal).slice(0, 60);
  return {
    verb: ACTION_VERB[tool] ?? tool.replace(/_/g, " "),
    target,
    why: str(d.why ?? input.why ?? input.reason) || undefined,
    whySource,
    said: tool === "message_session" ? str(input.text) || undefined : undefined,
    ok: d.ok !== false,
    error: d.ok === false ? str(d.error) : undefined,
    auto: d.auto === true,
  };
}

// ───────────── the feed ─────────────
export type FeedItem =
  | { kind: "report"; id: number; at: number; report: CaptainReport }
  | { kind: "action"; id: number; at: number; action: ActionLine; sessionId?: string }
  | { kind: "user"; id: number; at: number; text: string }
  | { kind: "signal"; id: number; at: number; tone: "good" | "warn" | "bad"; text: string; sessionId?: string }
  | { kind: "absorbed"; id: number; at: number; count: number; events: BulkheadEvent[] };

/** Event types that never count as "absorbed work" (meta / bookkeeping). */
const META = new Set(["captain_woken", "captain_absorbed", "llm_usage", "heartbeat"]);

export function buildFeed(events: BulkheadEvent[], letterOf: (sid?: string) => string | undefined, rate: string): FeedItem[] {
  // Structured reports already speak for some raw signals; don't say the same thing twice.
  const reportedDecisions = new Set<string>();
  const structuredAt = new Map<string, number[]>();
  for (const e of events) {
    if (e.type !== "captain_report" || !e.data?.kind) continue;
    if (e.data.decisionId) reportedDecisions.add(str(e.data.decisionId));
    const sid = str(e.data.sessionId ?? e.sessionId);
    if (sid) structuredAt.set(sid, [...(structuredAt.get(sid) ?? []), e.at]);
  }
  const coveredByReport = (sid: string | undefined, at: number) => !!sid && (structuredAt.get(sid) ?? []).some((t) => t >= at - 5_000 && t <= at + 180_000);

  const out: FeedItem[] = [];
  let group: BulkheadEvent[] = [];
  const flush = () => {
    const counted = group.filter((e) => !META.has(e.type));
    if (counted.length) out.push({ kind: "absorbed", id: counted[0]!.id, at: counted[counted.length - 1]!.at, count: counted.length, events: counted });
    group = [];
  };
  const who = (sid?: string) => letterOf(sid) ?? "a session";
  for (const e of events) {
    const d = e.data ?? {};
    let item: FeedItem | null = null;
    switch (e.type) {
      case "captain_report":
        // A free-text report the engine marked routine is absorbed like any other routine traffic.
        if (d.routine === true && !d.kind) break;
        item = { kind: "report", id: e.id, at: e.at, report: reportOf(e, events) };
        break;
      case "captain_action": {
        const a = actionOf(e, letterOf);
        if (a) item = { kind: "action", id: e.id, at: e.at, action: a, sessionId: e.sessionId };
        break;
      }
      case "user_message":
        item = { kind: "user", id: e.id, at: e.at, text: str(d.text) };
        break;
      case "decision_opened": {
        if (reportedDecisions.has(str(d.decisionId))) break;
        const amount = d.amountMicro ?? (d.details as Record<string, unknown> | undefined)?.amountMicro;
        item = { kind: "signal", id: e.id, at: e.at, tone: "warn", text: `Needs you: ${DECISION_WORD[str(d.kind)] ?? str(d.kind).replace(/_/g, " ")} for ${who(e.sessionId)}${amount ? ` (${myr(str(amount), rate)})` : ""}`, sessionId: e.sessionId };
        break;
      }
      case "session_transition":
        if (["FAILED", "KILLED", "EXPIRED", "QUARANTINED"].includes(str(d.to)) && !coveredByReport(e.sessionId, e.at))
          item = { kind: "signal", id: e.id, at: e.at, tone: str(d.to) === "QUARANTINED" ? "warn" : "bad", text: `${who(e.sessionId)} ${str(d.to).toLowerCase()}${d.reason ? ` — ${str(d.reason)}` : ""}`, sessionId: e.sessionId };
        break;
      case "payment_rejected":
        if (!coveredByReport(e.sessionId, e.at))
          item = { kind: "signal", id: e.id, at: e.at, tone: "bad", text: `Guard held: ${who(e.sessionId)}'s payment was refused (${str(d.reason).replace(/_/g, " ")})${d.detail ? ` — ${str(d.detail)}` : ""}`, sessionId: e.sessionId };
        break;
      case "goal_completed":
        if (!events.some((x) => x.type === "captain_report" && x.data?.kind === "goal_result"))
          item = { kind: "signal", id: e.id, at: e.at, tone: str(d.outcome) === "all_done" ? "good" : "warn", text: `Crew finished: ${str(d.doneMet)}/${str(d.total)} session(s) met their definition of done` };
        break;
    }
    if (item) {
      flush();
      out.push(item);
    } else group.push(e);
  }
  flush();
  return out;
}

// ───────────── derived Bearings (fallback when GET /bearings is unavailable) ─────────────
const nodeName = (n: TreeNode) => `${n.letter ?? "?"} ${n.role ?? n.label}`;

export function latestReportRisk(events: BulkheadEvent[], sessionId: string): { risk?: Risk; riskReason?: string; headline?: string } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "captain_report" || !e.data?.kind) continue;
    if (str(e.data.sessionId ?? e.sessionId) !== sessionId) continue;
    const d = e.data;
    return { risk: isRisk(d.risk) ? d.risk : undefined, riskReason: str(d.riskReason) || undefined, headline: str(d.headline) || undefined };
  }
  return {};
}

function lastProgress(events: BulkheadEvent[], sessionId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sessionId === sessionId && e.type === "progress") return str(e.data?.text);
  }
  return undefined;
}

export function deriveBearings(args: {
  goal: GoalSummary | null;
  tree: TreeDTO | null;
  events: BulkheadEvent[];
  openDecisions: (Decision & { goalId?: string; letter?: string })[];
  logbook: LogbookEntryDTO[];
  rate: string;
  decisionText: (d: Decision) => string;
}): BearingsView {
  const { goal, tree, events, openDecisions, logbook, rate, decisionText } = args;
  const sessions = (tree?.nodes ?? []).filter((n) => n.kind === "session" && n.glyph !== "planned" && !n.id.startsWith("plan:"));
  const ids = new Set(sessions.map((n) => n.id));
  const book = new Map(logbook.map((l) => [l.sessionId, l]));
  const done: BridgeLine[] = [];
  const inFlight: BridgeLine[] = [];
  for (const n of sessions) {
    const r = latestReportRisk(events, n.id);
    const ended = (n.status && ENDED.has(n.status)) || n.glyph === "closed" || n.glyph === "failed";
    if (ended) {
      const l = book.get(n.id);
      const failed = ["FAILED", "KILLED", "EXPIRED"].includes(String(l?.closeStatus ?? n.status ?? ""));
      done.push({
        key: n.id,
        sessionId: n.id,
        text: `${nodeName(n)} — ${r.headline ?? l?.handback?.summary ?? n.handbackSummary ?? n.lines[0] ?? "closed"}`,
        sub: failed ? `ended ${String(l?.closeStatus ?? n.status).toLowerCase()}${l?.endReason ? `: ${l.endReason}` : ""}` : n.refundMicro ? `${myr(n.refundMicro, rate)} returned to treasury` : undefined,
        risk: r.risk ?? (failed ? "high" : undefined),
        riskReason: r.riskReason,
        evidence: sessionEvidence(events, n.id).slice(0, 4),
      });
    } else {
      const spent = n.spentMicro ? `${myr(n.spentMicro, rate)} of ${myr(n.budgetMicro ?? "0", rate)} spent` : undefined;
      inFlight.push({
        key: n.id,
        sessionId: n.id,
        text: `${nodeName(n)} — ${lastProgress(events, n.id) ?? n.lines[0] ?? String(n.status ?? "").toLowerCase()}`,
        sub: [String(n.status ?? "").toLowerCase(), spent].filter(Boolean).join(" · ") || undefined,
        evidence: n.address ? [{ kind: "vault", label: "vault", ref: n.address }] : [],
        ...(n.workDeadlineAt && ["RUNNING", "PAUSED", "QUARANTINED"].includes(String(n.status)) ? { workDeadlineAt: n.workDeadlineAt } : {}),
      });
    }
  }
  const needsYou: BridgeLine[] = openDecisions
    .filter((d) => (goal && d.goalId === goal.id) || ids.has(d.sessionId))
    .map((d) => ({ key: d.id, decisionId: d.id, sessionId: d.sessionId, text: `${DECISION_WORD[d.kind] ?? d.kind}${d.letter ? ` for ${d.letter}` : ""}`, sub: decisionText(d), evidence: [] }));
  if (goal && !goal.fundingTx && goal.status === "planned") needsYou.unshift({ key: "approve-plan", text: "Approve the plan to fund the crew", sub: "Nothing moves on-chain until you approve.", evidence: [] });

  let spent = 0n;
  let inVaults = 0n;
  let returned = 0n;
  for (const n of sessions) {
    const s = big(n.spentMicro ?? "0");
    spent += s;
    const l = book.get(n.id);
    const refund = n.refundMicro ?? l?.refundMicro ?? null;
    if (refund) returned += big(refund);
    if (!(n.status && TERMINAL.has(n.status)) && !refund) {
      const left = big(n.budgetMicro ?? "0") - s;
      if (left > 0n) inVaults += left;
    }
  }
  const submitted = new Set<string>();
  const confirmed = new Set<string>();
  const fundingTx = new Map<string, string>();
  for (const e of events) {
    if (!ids.has(e.sessionId ?? "") && e.goalId !== goal?.id) continue;
    // The initial funding tx is confirmed when the session leaves FUNDING (there is no separate event).
    if (e.type === "session_transition" && str(e.data?.from) === "FUNDING" && e.sessionId && fundingTx.has(e.sessionId)) confirmed.add(fundingTx.get(e.sessionId)!);
    const h = str(e.data?.txHash);
    if (!h) continue;
    if (e.type === "session_funded" && str(e.data?.phase) === "submitted" && e.sessionId) fundingTx.set(e.sessionId, h);
    if (e.type === "payment_submitted" || e.type === "close_submitted" || (e.type === "session_funded" && /submitted/.test(str(e.data?.phase)))) submitted.add(h);
    if (e.type === "payment_confirmed" || e.type === "close_confirmed" || (e.type === "session_funded" && /confirmed/.test(str(e.data?.phase)))) confirmed.add(h);
  }
  const pendingTxs: Evidence[] = [];
  for (const h of submitted) if (!confirmed.has(h)) pendingTxs.push({ kind: "tx", label: "pending", ref: h });
  return {
    done,
    inFlight,
    needsYou,
    money: { budget: goal?.budgetMicro ?? "0", spent: spent.toString(), inVaults: inVaults.toString(), returned: returned.toString(), pendingTx: pendingTxs.length, inVaultsSource: "db", pendingTxs },
    source: "derived",
  };
}

// ───────────── derived Ahoy (fallback when GET /ahoy is unavailable) ─────────────
const KIND_WEIGHT: Record<string, number> = { quarantine_release: 1_000_000_000_000, widen_mandate: 500_000_000_000 };

export function rankDecision(d: Decision): number {
  const x = d.details as Record<string, unknown>;
  const amount = Number(x.amountMicro ?? x.addMicro ?? 0) || 0;
  return (KIND_WEIGHT[d.kind] ?? 0) + amount + (d.kind === "extend_expiry" ? 1 : 0);
}

/** A recommendation computed only from facts the engine already checked — labelled "suggested", never "the captain says". */
export function suggestFor(d: Decision, rate: string): DecisionRecommendation {
  const x = d.details as Record<string, unknown>;
  switch (d.kind) {
    case "payment_approval":
      return {
        action: "approve",
        why: `The payee is on the session's allowlist and ${x.amountMicro ? myr(str(x.amountMicro), rate) : "the amount"} is within its per-payment max and budget (checked before this reached you); it only crossed your ask-me threshold.`,
      };
    case "budget_raise":
      return { action: "review", why: "Only the extra amount moves from your treasury to the session wallet; the cap still holds on-chain at the new budget." };
    case "extend_expiry":
      return { action: "approve", why: "Funds move to a new wallet with the later expiry; the old script is never edited and nothing else widens." };
    case "quarantine_release":
      return { action: "reject", why: "The session read tainted input and tried something outside its mandate; rejecting closes it and sweeps the leftovers back." };
    case "widen_mandate":
      return { action: "reject", why: "Widening a mandate removes a guard; approve only if you asked for it." };
  }
  return { action: "review", why: "" };
}

export function deriveAhoy(args: {
  since: number;
  events: BulkheadEvent[];
  openDecisions: (Decision & { goalId?: string; letter?: string; role?: string })[];
  rate: string;
  letterOf: (sid?: string) => string | undefined;
  decisionText: (d: Decision) => string;
}): AhoyView {
  const { since, events, openDecisions, rate, letterOf, decisionText } = args;
  const reports: BridgeLine[] = [];
  const incidents: BridgeLine[] = [];
  let paid = 0n;
  let paidN = 0;
  let returned = 0n;
  let closed = 0;
  let routine = 0;
  let latest = 0;
  for (const e of events) {
    if (e.at <= since) continue;
    latest = Math.max(latest, e.id);
    const d = e.data ?? {};
    if (e.type === "captain_report" && !(d.routine === true && !d.kind)) {
      const r = reportOf(e, events);
      reports.push({ key: `r${e.id}`, text: r.headline, risk: r.risk, riskReason: r.riskReason, sessionId: r.sessionId, evidence: r.evidence.slice(0, 3) });
    } else if (e.type === "payment_confirmed") {
      paid += big(str(d.amountMicro) || "0");
      paidN++;
    } else if (e.type === "close_confirmed") {
      returned += big(str(d.refundMicro) || "0");
      closed++;
    } else if (e.type === "session_transition" && ["FAILED", "KILLED", "QUARANTINED"].includes(str(d.to))) {
      incidents.push({ key: `t${e.id}`, text: `${letterOf(e.sessionId) ?? "A session"} ${str(d.to).toLowerCase()}${d.reason ? ` — ${str(d.reason)}` : ""}`, risk: str(d.to) === "QUARANTINED" ? "medium" : "high", sessionId: e.sessionId, evidence: [] });
    } else if (!META.has(e.type) && !e.type.startsWith("captain_")) routine++;
  }
  const money: string[] = [];
  if (closed) money.push(`${closed} session${closed === 1 ? "" : "s"} closed on-chain (${myr(returned, rate)} returned)`);
  if (paidN) money.push(`${paidN} payment${paidN === 1 ? "" : "s"} confirmed (${myr(paid, rate)})`);
  const groups: AhoyGroupView[] = [];
  if (reports.length) groups.push({ key: "reports", title: "Captain reports", count: reports.length, lines: reports.slice(-8) });
  if (incidents.length) groups.push({ key: "incidents", title: "Incidents", count: incidents.length, lines: incidents.slice(-5) });
  if (money.length) groups.push({ key: "money", title: "Money", count: money.length, lines: money.map((t, i) => ({ key: `m${i}`, text: t, evidence: [] })) });
  const decisions: AhoyDecisionView[] = [...openDecisions]
    .sort((a, b) => rankDecision(b) - rankDecision(a))
    .map((d) => ({
      decisionId: d.id,
      title: `${DECISION_WORD[d.kind] ?? d.kind}${d.letter ? ` · ${d.letter}${d.role ? ` ${d.role}` : ""}` : letterOf(d.sessionId) ? ` · ${letterOf(d.sessionId)}` : ""}`,
      detail: decisionText(d),
      sessionId: d.sessionId,
      recommendation: suggestFor(d, rate),
      fromCaptain: false,
      kind: d.kind,
      amountMicro: str((d.details as Record<string, unknown>).amountMicro) || undefined,
    }));
  return { since, groups, routine, decisions, latestEventId: latest || undefined, source: "derived" };
}

/** Plain-text Bearings digest (for "File report" when the engine cannot file it). */
export function bearingsMarkdown(goal: GoalSummary | null, b: BearingsView, rate: string): string {
  const sec = (title: string, lines: BridgeLine[]) =>
    `## ${title}\n${lines.length ? lines.map((l) => `- ${l.text}${l.risk ? ` (risk: ${l.risk}${l.riskReason ? ` - ${l.riskReason}` : ""})` : ""}${l.sub ? `\n  ${l.sub}` : ""}${l.evidence.map((e) => `\n  - ${e.label}: ${e.ref}`).join("")}`).join("\n") : "- nothing"}\n`;
  return [
    `# Bearings — ${goal?.goal ?? "goal"}`,
    `Filed ${new Date().toISOString()} · goal ${goal?.id ?? "?"} · Cardano preprod\n`,
    b.overall ? `${b.overall}\n` : "",
    sec("Needs you", b.needsYou),
    sec("Done", b.done),
    sec("In flight", b.inFlight),
    `## Money\n- Budget ${myr(b.money.budget, rate)}\n- Spent ${myr(b.money.spent, rate)}\n- In session vaults ${myr(b.money.inVaults, rate)}\n- Returned to treasury ${myr(b.money.returned, rate)}\n- Pending txs ${b.money.pendingTx}\n`,
  ].join("\n");
}
