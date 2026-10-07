// /ahoy — Firstmate's recap: what happened since the user last looked (their seen-marker, else their last message to
// the captain), grouped deterministically, plus EVERY still-open decision ranked by impact (amount at stake, deadline
// proximity, blocked sessions) with the captain's recommendation. Routine noise is counted, never listed.
import { microToTusd, explorerTx, type AhoyDTO, type AhoyGroup, type AhoyItem, type BulkheadEvent, type ReportEvidence, type RiskLevel } from "@bulkhead/shared";
import { events, goals, kv, sessions as sessionsT, type DB } from "@bulkhead/db";
import { desc, eq, gte, max } from "drizzle-orm";
import type { DecisionLedger, EventBus, LLM } from "../contracts";
import { rowToEvent } from "../bus";
import { assessDecision, fmtDuration, rankDecisions } from "./assess";
import { ticker } from "./reports";
import { wordLine } from "./wording";

export interface AhoyDeps {
  db: DB;
  bus: EventBus;
  decisions: DecisionLedger;
  llm?: LLM | null;
  now?: () => number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};
const seenKey = (userId: string) => `ahoy:seen:${userId}`;
const MAX_EVENTS = 5_000;
const QUIET_TOOLS = new Set(["read_status", "report_to_user"]);

export function latestEventId(db: DB): number {
  return db.select({ m: max(events.id) }).from(events).get()?.m ?? 0;
}

export function markSeen(db: DB, userId: string, eventId?: number): number {
  const id = Number.isFinite(eventId) && (eventId as number) >= 0 ? Math.min(Math.floor(eventId as number), latestEventId(db)) : latestEventId(db);
  db.insert(kv).values({ key: seenKey(userId), value: String(id) }).onConflictDoUpdate({ target: kv.key, set: { value: String(id) } }).run();
  return id;
}

function boundary(db: DB, userId: string, now: number): AhoyDTO["since"] {
  const marker = db.select().from(kv).where(eq(kv.key, seenKey(userId))).get()?.value;
  if (marker !== undefined && Number.isFinite(Number(marker))) {
    const id = Number(marker);
    const at = id ? (db.select({ at: events.at }).from(events).where(eq(events.id, id)).get()?.at ?? null) : null;
    return { kind: "marker", eventId: id, at };
  }
  // Fallback (Firstmate): the user's last real message to the captain.
  const msgs = db.select().from(events).where(eq(events.type, "user_message")).orderBy(desc(events.id)).limit(200).all();
  for (const m of msgs) {
    const e = rowToEvent(m);
    if (e.data.userId === userId) return { kind: "last_message", eventId: e.id, at: e.at };
  }
  // No boundary at all: a bounded window (last 24 h).
  const first = db.select({ id: events.id }).from(events).where(gte(events.at, now - 86_400_000)).orderBy(events.id).limit(1).get();
  return { kind: "none", eventId: first ? first.id - 1 : latestEventId(db), at: null };
}

export async function buildAhoy(deps: AhoyDeps, userId: string, opts: { goalId?: string | null; judge?: boolean } = {}): Promise<AhoyDTO> {
  const { db, bus } = deps;
  const now = (deps.now ?? Date.now)();
  const T = ticker();
  const goalFilter = opts.goalId ?? null;
  const myGoals = new Set(db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId)).all().map((g) => g.id));
  const mySessions = db.select({ id: sessionsT.id, goalId: sessionsT.goalId, letter: sessionsT.letter, role: sessionsT.role }).from(sessionsT).where(eq(sessionsT.userId, userId)).all();
  const sessionInfo = new Map(mySessions.map((s) => [s.id, s]));
  const visible = (e: BulkheadEvent) => {
    if (goalFilter) return e.goalId === goalFilter || (!!e.sessionId && sessionInfo.get(e.sessionId)?.goalId === goalFilter);
    if (e.data?.userId !== undefined) return e.data.userId === userId;
    return (!!e.goalId && myGoals.has(e.goalId)) || (!!e.sessionId && sessionInfo.has(e.sessionId));
  };

  const since = boundary(db, userId, now);
  const latest = latestEventId(db);
  const evs = bus
    .since(since.eventId)
    .slice(-MAX_EVENTS)
    .filter(visible)
    // The user's own message that set the boundary is not news; neither is their own chat.
    .filter((e) => e.type !== "user_message");

  const L = (sid?: string) => (sid ? (sessionInfo.get(sid)?.letter ?? "?") : "");
  const reports: AhoyItem[] = [];
  const messages: AhoyItem[] = [];
  const captain: AhoyItem[] = [];
  const decisionsAnswered: AhoyItem[] = [];
  const routine = new Map<string, number>();
  const paidBySession = new Map<string, { n: number; micro: bigint; ids: number[]; refs: ReportEvidence[]; at: number }>();
  const money: AhoyItem[] = [];

  for (const e of evs) {
    const d = e.data ?? {};
    switch (e.type) {
      case "captain_report": {
        if (typeof d.kind === "string") {
          const ev = Array.isArray(d.evidence) ? (d.evidence as ReportEvidence[]) : [];
          reports.push({ text: `${String(d.headline ?? d.text ?? "")} — risk ${String(d.risk ?? "low")}`, at: e.at, eventIds: [e.id], goalId: e.goalId, sessionId: e.sessionId, risk: d.risk as RiskLevel, refs: ev.slice(0, 4) });
        } else if (typeof d.text === "string" && d.text.trim()) {
          messages.push({ text: clip(d.text.replace(/\s+/g, " "), 240), at: e.at, eventIds: [e.id], goalId: e.goalId, refs: [] });
        }
        break;
      }
      case "captain_action": {
        if (QUIET_TOOLS.has(String(d.tool)) || d.ok === false) {
          bump(routine, "captain checks");
          break;
        }
        const why = typeof d.why === "string" && d.why ? d.why : String(d.tool ?? "action").replace(/_/g, " ");
        const prev = captain[captain.length - 1];
        if (prev && prev.text.startsWith(why)) {
          prev.eventIds.push(e.id);
          break;
        }
        captain.push({ text: `${why}${d.auto ? " (automatic)" : ""}`, at: e.at, eventIds: [e.id], goalId: e.goalId, sessionId: e.sessionId, refs: [] });
        break;
      }
      case "payment_confirmed": {
        const k = e.sessionId ?? "-";
        const p = paidBySession.get(k) ?? { n: 0, micro: 0n, ids: [], refs: [], at: e.at };
        p.n++;
        p.micro += big(d.amountMicro);
        p.ids.push(e.id);
        p.at = e.at;
        if (typeof d.txHash === "string") p.refs.push({ label: `Payment ${String(d.amountTUSD ?? "")} ${T}`, kind: "tx", ref: d.txHash, url: explorerTx(d.txHash) });
        paidBySession.set(k, p);
        break;
      }
      case "close_confirmed": {
        const tx = typeof d.txHash === "string" ? d.txHash : typeof d.closeTx === "string" ? d.closeTx : null;
        money.push({
          text: `${L(e.sessionId)} closed; ${String(d.refundTUSD ?? microToTusd(big(d.refundMicro)))} ${T} returned to your treasury`,
          at: e.at,
          eventIds: [e.id],
          goalId: e.goalId,
          sessionId: e.sessionId,
          refs: tx ? [{ label: "Close tx", kind: "tx", ref: tx, url: explorerTx(tx) }] : [],
        });
        break;
      }
      case "topup_confirmed":
        money.push({ text: `Top-up of ${String(d.tusd ?? "")} ${T} confirmed on-chain`, at: e.at, eventIds: [e.id], refs: typeof d.txHash === "string" ? [{ label: "Top-up tx", kind: "tx", ref: d.txHash, url: explorerTx(d.txHash) }] : [] });
        break;
      case "decision_closed": {
        const kind = String(d.kind ?? "decision").replace(/_/g, " ");
        const by = String(d.decidedBy ?? "");
        const text = d.status === "expired" ? `The ${kind} request for ${L(e.sessionId)} lapsed (${clip(String(d.note ?? "session ended"), 60)})` : `${by === "system" ? "The" : "You"} ${String(d.status)} the ${kind} for ${L(e.sessionId)}`;
        decisionsAnswered.push({ text, at: e.at, eventIds: [e.id], goalId: e.goalId, sessionId: e.sessionId, refs: [] });
        break;
      }
      default:
        bump(routine, routineLabel(e));
    }
  }
  for (const [sid, p] of paidBySession) {
    money.unshift({ text: `${sid === "-" ? "" : `${L(sid)}: `}${p.n} payment${p.n === 1 ? "" : "s"} confirmed on-chain (${microToTusd(p.micro)} ${T})`, at: p.at, eventIds: p.ids, sessionId: sid === "-" ? undefined : sid, refs: p.refs.slice(0, 5) });
  }

  const routineCount = [...routine.values()].reduce((a, b) => a + b, 0);
  const groups: AhoyGroup[] = [];
  const push = (key: AhoyGroup["key"], title: string, items: AhoyItem[]) => {
    if (items.length) groups.push({ key, title, count: items.reduce((a, i) => a + i.eventIds.length, 0), items });
  };
  // Highest risk first inside reports; everything else chronological.
  const rank = (r?: RiskLevel) => (r === "high" ? 0 : r === "medium" ? 1 : 2);
  push("reports", "Outcomes", [...reports].sort((a, b) => rank(a.risk) - rank(b.risk) || a.at - b.at));
  push("decisions", "Decisions answered", decisionsAnswered);
  push("money", "Money", money);
  push("captain", "What the captain did", captain.slice(-15));
  push("messages", "Captain said", messages.slice(-10));
  if (routineCount)
    groups.push({
      key: "routine",
      title: "Handled without you",
      count: routineCount,
      items: [{ text: `${routineCount} routine event${routineCount === 1 ? "" : "s"} handled without you (${[...routine].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`).join(", ")})`, at: now, eventIds: [], refs: [] }],
    });

  // Every still-open decision (including ones raised before the boundary), ranked by impact.
  const sids = new Set(mySessions.filter((s) => !goalFilter || s.goalId === goalFilter).map((s) => s.id));
  const decisions = rankDecisions(
    deps.decisions
      .list({ status: "open" })
      .filter((d) => sids.has(d.sessionId))
      .map((d) => assessDecision({ db, bus, now: () => now }, d)),
  );

  const nothingHappened = groups.every((g) => g.key === "routine");
  const ago = since.at ? ` (${fmtDuration(now - since.at)} ago)` : "";
  const sinceWhen = since.kind === "marker" ? `Since you last checked${ago}` : since.kind === "last_message" ? `Since your last message${ago}` : "In the last 24 h";
  const parts: string[] = [];
  const high = reports.filter((r) => r.risk === "high").length;
  if (reports.length) parts.push(`${reports.length} outcome${reports.length === 1 ? "" : "s"}${high ? ` (${high} high risk)` : ""}`);
  if (captain.length) parts.push(`${captain.length} captain action${captain.length === 1 ? "" : "s"}`);
  const paid = [...paidBySession.values()].reduce((a, p) => a + p.micro, 0n);
  if (paid > 0n) parts.push(`${microToTusd(paid)} ${T} paid`);
  if (decisionsAnswered.length) parts.push(`${decisionsAnswered.length} decision${decisionsAnswered.length === 1 ? "" : "s"} answered`);
  const decLine = decisions.length
    ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"} wait${decisions.length === 1 ? "s" : ""} for you — first: ${clip(decisions[0].question, 90)} (recommended: ${decisions[0].recommendation.action})`
    : "Nothing needs you.";
  const draft = nothingHappened
    ? decisions.length
      ? `Nothing new happened ${sinceWhen.toLowerCase().replace(/^since /, "since ")}, but ${decLine.charAt(0).toLowerCase()}${decLine.slice(1)}`
      : `Nothing happened ${sinceWhen.toLowerCase()}.`
    : `${sinceWhen}: ${parts.join(", ") || "only routine work"}. ${decLine}`;
  const headline = opts.judge
    ? await wordLine({ llm: deps.llm, bus }, "ahoy", { since: sinceWhen, outcomes: reports.map((r) => r.text).slice(0, 8), actions: captain.length, paid: microToTusd(paid), decisions: decisions.map((d) => d.question).slice(0, 3) }, clip(draft, 240), 240)
    : { text: clip(draft, 240), source: "deterministic" as const };

  return {
    generatedAt: now,
    since,
    latestEventId: latest,
    headline,
    nothingHappened,
    groups,
    decisions,
    counts: { events: evs.length, reports: reports.length, routine: routineCount },
  };
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function routineLabel(e: BulkheadEvent): string {
  switch (e.type) {
    case "progress":
      return "progress notes";
    case "web_fetch":
      return "web reads";
    case "tainted":
      return "web content checks";
    case "llm_usage":
      return "model calls";
    case "captain_woken":
      return "captain wake-ups";
    case "captain_absorbed":
      return "absorbed batches";
    case "session_transition":
      return "state changes";
    case "payment_submitted":
    case "payment_requested":
    case "payment_approved":
      return "payment steps";
    case "session_funded":
    case "close_submitted":
      return "wallet txs";
    case "handback_submitted":
    case "handback_accepted":
    case "handback_passed":
      return "handbacks";
    case "heartbeat_missed":
      return "missed heartbeats";
    case "session_message":
      return "session messages";
    default:
      return e.type.replace(/_/g, " ");
  }
}

