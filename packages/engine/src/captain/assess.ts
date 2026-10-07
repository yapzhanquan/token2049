// Deterministic judgement of an open decision: what is at stake (amount, deadline, blocked sessions), how risky it is,
// and what the captain recommends. Shared by the escalation report, /bearings (needs you) and /ahoy (ranked list).
import { microToTusd, settlementTickerFromEnv, type AhoyDecision, type Decision, type DecisionRecommendation, type RiskLevel } from "@bulkhead/shared";
import { goals, sessions as sessionsT, type DB } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import type { EventBus } from "../contracts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};
export const fmtDuration = (ms: number) =>
  ms <= 0 ? "now" : ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;

export interface AssessDeps {
  db: DB;
  bus?: EventBus;
  now?: () => number;
  ticker?: string;
}

type SessionDb = typeof sessionsT.$inferSelect;

export function assessDecision(deps: AssessDeps, d: Decision): AhoyDecision {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();
  const ticker = deps.ticker ?? settlementTickerFromEnv(process.env);
  const s = db.select().from(sessionsT).where(eq(sessionsT.id, d.sessionId)).get() ?? null;
  const g = s ? (db.select().from(goals).where(eq(goals.id, s.goalId)).get() ?? null) : null;
  const L = s?.letter ?? "?";
  const det = d.details ?? {};
  const budget = big(s?.budgetMicro);
  const spent = big(s?.spentMicro);
  const goalBudget = big(g?.budgetMicro);
  const payees = parse<{ id: string; label: string; address: string }[]>(s?.allowedPayeesJson, []);

  // Amount at risk.
  let amount = 0n;
  switch (d.kind) {
    case "payment_approval":
      amount = big(det.amountMicro);
      break;
    case "budget_raise":
      amount = big(det.addMicro);
      break;
    case "quarantine_release":
    case "extend_expiry":
    case "widen_mandate":
      amount = budget > spent ? budget - spent : 0n; // what the session could still spend once released / extended
      break;
  }

  // Deadline: the session wallet's expiry (it stops spending then), capped by the goal deadline.
  const deadlineAt = s ? Math.min(s.expiresAt, g?.deadline ?? s.expiresAt) : (g?.deadline ?? null);
  const msToDeadline = deadlineAt !== null ? deadlineAt - now : null;

  // Blocked sessions: this one (it waits on the answer) + not-yet-started sessions that need its handback.
  const blocked: string[] = s ? [L] : [];
  if (s) {
    const siblings = db.select().from(sessionsT).where(eq(sessionsT.goalId, s.goalId)).all();
    for (const o of siblings) {
      if (o.id === s.id || !["PLANNED", "AWAITING_APPROVAL", "FUNDING"].includes(o.status)) continue;
      if (parse<string[]>(o.contextFromJson, []).includes(s.id)) blocked.push(o.letter);
    }
  }

  // Impact score (higher first): money share + absolute money + deadline proximity + blocked work + security.
  const share = goalBudget > 0n ? Number((amount * 1000n) / goalBudget) / 1000 : 0;
  const amountTusd = Number(amount) / 1e6;
  let score = Math.min(40, share * 40) + Math.min(20, amountTusd);
  if (msToDeadline !== null) score += msToDeadline < 15 * 60_000 ? 30 : msToDeadline < 3_600_000 ? 20 : msToDeadline < 6 * 3_600_000 ? 10 : msToDeadline < 24 * 3_600_000 ? 5 : 0;
  score += blocked.length * 8;
  if (d.kind === "quarantine_release") score += 15;
  score = Math.round(score * 10) / 10;
  const reasons: string[] = [];
  if (amount > 0n) reasons.push(`${microToTusd(amount)} ${ticker} at stake${goalBudget > 0n ? ` (${Math.round(share * 100)}% of the goal budget)` : ""}`);
  if (msToDeadline !== null) reasons.push(msToDeadline > 0 ? `${L}'s wallet expires in ${fmtDuration(msToDeadline)}` : `${L}'s wallet has expired`);
  if (blocked.length) reasons.push(`blocks ${blocked.join(", ")}`);
  if (d.kind === "quarantine_release") reasons.push("security: flagged content");

  const payeeLabel = (addr: unknown) => payees.find((p) => p.address === addr || p.id === addr)?.label ?? (typeof addr === "string" ? (addr.length > 18 ? `${addr.slice(0, 14)}…` : addr) : "the payee");
  const { question, risk, recommendation } = judge();
  return {
    decisionId: d.id,
    goalId: s?.goalId ?? null,
    sessionId: d.sessionId,
    letter: s?.letter ?? null,
    kind: d.kind,
    question,
    amountAtRisk: microToTusd(amount),
    deadlineAt,
    msToDeadline,
    blockedSessions: blocked,
    impactScore: score,
    impactReason: reasons.join(" · ") || "no money or deadline at stake",
    risk,
    recommendation,
    openedAt: d.createdAt,
  };

  function judge(): { question: string; risk: RiskLevel; recommendation: DecisionRecommendation } {
    const tainted = !!s?.tainted;
    const left = budget > spent ? budget - spent : 0n;
    switch (d.kind) {
      case "payment_approval": {
        const who = payeeLabel(det.payee);
        const q = `Approve a ${microToTusd(amount)} ${ticker} payment from ${L} to ${who}?`;
        if (tainted)
          return {
            question: q,
            risk: "high",
            recommendation: { action: "review", why: `${L} read untrusted web content before asking to pay; check that ${who} and the amount match what you expect before approving.` },
          };
        if (amount > left)
          return { question: q, risk: "high", recommendation: { action: "reject", why: `${microToTusd(amount)} ${ticker} is more than ${L} has left (${microToTusd(left)} ${ticker}).` } };
        return {
          question: q,
          risk: share > 0.5 ? "medium" : "low",
          recommendation: {
            action: "approve",
            why: `${who} is on ${L}'s payee list and ${microToTusd(amount)} ${ticker} fits its remaining ${microToTusd(left)} ${ticker}; it only waits because it is above the ${microToTusd(big(s?.approvalThresholdMicro))} ${ticker} approval threshold.`,
          },
        };
      }
      case "budget_raise": {
        const committed = g ? db.select().from(sessionsT).where(eq(sessionsT.goalId, g.id)).all().reduce((a, r) => a + big(r.budgetMicro), 0n) : 0n;
        const free = goalBudget > committed ? goalBudget - committed : 0n;
        const q = `Give ${L} ${microToTusd(amount)} ${ticker} more budget?${det.reason ? ` (${clip(String(det.reason), 80)})` : ""}`;
        return amount <= free
          ? { question: q, risk: "low", recommendation: { action: "approve", why: `It fits the ${microToTusd(free)} ${ticker} the goal still has unallocated, so the goal budget does not grow.` } }
          : { question: q, risk: "medium", recommendation: { action: "review", why: `The goal has only ${microToTusd(free)} ${ticker} unallocated; this raises your total spend beyond the approved budget.` } };
      }
      case "extend_expiry": {
        const newAt = Number(det.newExpiresAt ?? 0);
        const q = `Extend ${L}'s wallet expiry${newAt ? ` to ${new Date(newAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}?`;
        const progressing = recentlyActive(deps, d.sessionId, now);
        return progressing
          ? { question: q, risk: "low", recommendation: { action: "approve", why: `${L} reported progress in the last 10 min; more time lets it finish within the same budget.` } }
          : { question: q, risk: "medium", recommendation: { action: "review", why: `${L} has shown no progress in the last 10 min; extra time may not help.` } };
      }
      case "quarantine_release":
        return {
          question: `Release ${L} from quarantine?${det.reason ? ` It was stopped for: ${clip(String(det.reason), 80)}` : ""}`,
          risk: "high",
          recommendation: { action: "reject", why: `The content it read was flagged (possible prompt injection${det.url ? ` at ${clip(String(det.url), 60)}` : ""}); keep it stopped — its funds return when it closes.` },
        };
      case "widen_mandate":
      default:
        return {
          question: `Widen ${L}'s mandate?${det.reason ? ` (${clip(String(det.reason), 80)})` : ""}`,
          risk: "medium",
          recommendation: { action: "review", why: "It changes what the session may spend or pay; check the reason before approving." },
        };
    }
  }
}

function recentlyActive(deps: AssessDeps, sessionId: string, now: number): boolean {
  if (!deps.bus) return false;
  const evs = deps.bus.since(0, { sessionId });
  for (let i = evs.length - 1; i >= 0 && i >= evs.length - 200; i--) {
    const e = evs[i];
    if (e.at < now - 10 * 60_000) break;
    if (["progress", "payment_confirmed", "agent_job_result", "web_fetch"].includes(e.type)) return true;
  }
  return false;
}

export function rankDecisions(list: AhoyDecision[]): AhoyDecision[] {
  return [...list].sort((a, b) => b.impactScore - a.impactScore || a.openedAt - b.openedAt);
}

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type { SessionDb };
