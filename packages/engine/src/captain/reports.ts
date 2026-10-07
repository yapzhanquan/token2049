// Outcome reports (Firstmate: "PR ready for review, captain: <link> (fix flaky login test - risk: low - CI green)").
// The OutcomeReporter rides the EventBus and turns real outcomes into ONE structured `captain_report` each:
//   handback_accepted                         → session_result  (what it delivered + DoD + hashes + txs)
//   goal_completed                            → goal_result     (n/m met DoD, money, close txs with handback hashes)
//   session_transition → KILLED/FAILED/EXPIRED → incident
//   decision_opened quarantine_release        → incident        (security; carries the decision + recommendation)
//   decision_opened (any other, not user-made) → escalation      (the question, what is at stake, a recommendation)
//   error insufficient_funds / funding_stalled → escalation     (top up the treasury; once per goal)
// Risk is decided by deterministic rules (riskForSession / riskForGoal); only the headline wording may come from the
// LLM, validated against the facts (wording.ts). Idempotent: one report per dedupKey (checked in the events table).
import {
  explorerAddress,
  explorerTx,
  maxRisk,
  microToTusd,
  renderReportText,
  settlementTickerFromEnv,
  DEFINITION_OF_DONE,
  TIMEBOXED_CLOSE_STATUS,
  isTimeLimitPartial,
  type BulkheadEvent,
  type CaptainReportData,
  type Decision,
  type DecisionKind,
  type Handback,
  type ReportEvidence,
  type ReportKind,
  type RiskLevel,
} from "@bulkhead/shared";
import { agentJobs, goals, payments, sessions as sessionsT, type DB } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import type { DecisionLedger, EventBus, LLM } from "../contracts";
import { sha256Hex } from "../sessions-store";
import { assessDecision } from "./assess";
import { wordLine, wordingEnabled } from "./wording";

type SessionDb = typeof sessionsT.$inferSelect;
type PaymentDb = typeof payments.$inferSelect;

export interface ReporterDeps {
  db: DB;
  bus: EventBus;
  /** The runtime ledger (its get() reads the full decision; otherwise the event data is used). */
  decisions?: DecisionLedger & { get?(id: string): Decision | null };
  llm?: LLM | null;
  /** "llm" (default unless CAPTAIN_REPORT_WORDING=deterministic) or "deterministic". */
  wording?: "llm" | "deterministic";
  now?: () => number;
  llmTimeoutMs?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};
export const ticker = () => {
  try {
    return settlementTickerFromEnv(process.env);
  } catch {
    return "tUSD";
  }
};
const parse = <T>(s: string | null | undefined, fb: T): T => {
  if (!s) return fb;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fb;
  }
};
const isHttp = (s: string) => /^https?:\/\//i.test(s);
const TERMINAL_INCIDENT = ["KILLED", "FAILED", "EXPIRED"];

/** A report before wording: everything except the rendered text / wording source. */
export type ReportDraft = Omit<CaptainReportData, "text" | "wording" | "userId"> & { facts: Record<string, unknown> };

export class OutcomeReporter {
  private unsub: (() => void) | null = null;
  private pending = new Set<Promise<void>>();
  private done = new Set<string>();
  private readonly wording: boolean;

  constructor(private readonly deps: ReporterDeps) {
    this.wording = (deps.wording ?? (wordingEnabled() ? "llm" : "deterministic")) === "llm" && !!deps.llm;
  }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.deps.bus.subscribe((e) => this.onEvent(e));
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    await this.idle();
  }

  /** Wait until every in-flight report has been emitted. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  onEvent(e: BulkheadEvent): void {
    let draft: (() => ReportDraft | null) | null = null;
    switch (e.type) {
      case "handback_accepted":
        if (e.sessionId) draft = () => this.sessionResult(e.sessionId!);
        break;
      case "goal_completed":
        if (e.goalId) draft = () => this.goalResult(e.goalId!);
        break;
      case "session_transition":
        if (e.sessionId && TERMINAL_INCIDENT.includes(String(e.data.to))) draft = () => this.endIncident(e);
        break;
      case "decision_opened":
        draft = () => (e.data.kind === "quarantine_release" ? this.quarantineIncident(e) : this.escalation(e));
        break;
      case "error":
        if ((e.data.kind === "insufficient_funds" || e.data.kind === "funding_stalled") && e.goalId) draft = () => this.fundsEscalation(e);
        break;
      default:
        return;
    }
    if (!draft) return;
    const p = this.emitDraft(draft).catch((err) => {
      try {
        this.deps.bus.emit("error", { goalId: e.goalId, sessionId: e.sessionId, data: { where: "captain.reports", message: (err as Error).message } });
      } catch {
        /* DB closed during shutdown */
      }
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private async emitDraft(build: () => ReportDraft | null): Promise<void> {
    const d = build();
    if (!d || this.seen(d)) return;
    this.done.add(d.dedupKey);
    const userId = this.userOf(d.goalId);
    if (!userId) return;
    const worded = this.wording
      ? await wordLine({ llm: this.deps.llm, bus: this.deps.bus, timeoutMs: this.deps.llmTimeoutMs }, "report", d.facts, d.headline, 120, d.goalId)
      : { text: d.headline, source: "deterministic" as const };
    if (this.seenInDb(d)) return; // a concurrent / replayed reporter wrote it while we waited for the wording
    const { facts: _facts, ...rest } = d;
    const data: CaptainReportData = { ...rest, headline: worded.text, wording: worded.source, userId, text: renderReportText({ ...rest, headline: worded.text }) };
    this.deps.bus.emit("captain_report", { goalId: d.goalId, ...(d.sessionId ? { sessionId: d.sessionId } : {}), data: data as unknown as Record<string, unknown> });
  }

  private seen(d: ReportDraft): boolean {
    return this.done.has(d.dedupKey) || this.seenInDb(d);
  }

  private seenInDb(d: ReportDraft): boolean {
    return this.deps.bus.since(0, { goalId: d.goalId }).some((x) => x.type === "captain_report" && x.data.dedupKey === d.dedupKey);
  }

  private userOf(goalId: string): string | null {
    return this.deps.db.select({ u: goals.userId }).from(goals).where(eq(goals.id, goalId)).get()?.u ?? null;
  }

  private row(sessionId: string): SessionDb | null {
    return this.deps.db.select().from(sessionsT).where(eq(sessionsT.id, sessionId)).get() ?? null;
  }

  // ─────────────── session_result ───────────────
  sessionResult(sessionId: string): ReportDraft | null {
    const { db, bus } = this.deps;
    const s = this.row(sessionId);
    if (!s) return null;
    const h = parse<Handback | null>(s.handbackJson, null);
    const pays = db.select().from(payments).where(eq(payments.sessionId, s.id)).all();
    const jobs = db.select().from(agentJobs).where(eq(agentJobs.sessionId, s.id)).all();
    const evs = bus.since(0, { sessionId: s.id });
    const attempt = Math.max(1, s.doneAttempts + 1);
    const judged = riskForSession({ session: s, handback: h, payments: pays, events: evs, attempt });
    const T = ticker();
    const paid = pays.filter((p) => p.txHash && (p.status === "confirmed" || p.status === "submitted"));
    const paidSum = paid.reduce((a, p) => a + big(p.amountMicro), 0n);
    const summary = h?.summary ? h.summary.replace(/\s+/g, " ").trim() : "handed back";
    const who = `${s.letter} (${s.role})`;
    let headline: string;
    switch (s.taskType) {
      case "buy_pay":
        headline = `${who} paid ${microToTusd(paidSum)} ${T} in ${paid.length} payment${paid.length === 1 ? "" : "s"}: ${summary}`;
        break;
      case "hire_agent": {
        const job = jobs.find((j) => j.status === "completed") ?? jobs[0];
        headline = `${who} hired ${job?.serviceId ?? "an agent"} and got the result: ${summary}`;
        break;
      }
      default:
        headline = `${who} finished: ${summary}`;
    }
    const evidence: ReportEvidence[] = [
      { label: `Definition of done met${attempt > 1 ? ` on attempt ${attempt}` : " first time"}: ${DEFINITION_OF_DONE[s.taskType as keyof typeof DEFINITION_OF_DONE] ?? s.taskType}`, kind: "dod" as const, ref: s.taskType },
      ...(s.handbackJson ? [{ label: "Handback SHA-256 (recorded in the close tx, CIP-20 label 674)", kind: "handback_hash" as const, ref: sha256Hex(s.handbackJson), ...(s.closeTx ? { url: explorerTx(s.closeTx) } : {}) }] : []),
      ...paid.map((p) => ({ label: `Payment ${microToTusd(big(p.amountMicro))} ${T} (${p.status})`, kind: "tx" as const, ref: p.txHash!, url: explorerTx(p.txHash!) })),
      ...jobs
        .filter((j) => j.resultHash)
        .map((j) => ({ label: `Paid agent's result hash (${j.serviceId})`, kind: "handback_hash" as const, ref: String(j.resultHash) })),
      ...(h?.sources ?? []).slice(0, 5).map((src) => ({ label: isHttp(src) ? `Source ${hostLabel(src)}` : "Source", kind: "source" as const, ref: src, ...(isHttp(src) ? { url: src } : {}) })),
      ...vaultEvidence(s),
    ].slice(0, 14);
    const next =
      judged.risk === "high"
        ? judged.next ?? "Check the evidence before relying on this result."
        : judged.risk === "medium"
          ? judged.next ?? "Skim the sources before relying on it; it also goes into the final report."
          : "Nothing needed — it goes into the final report.";
    return {
      kind: "session_result",
      goalId: s.goalId,
      sessionId: s.id,
      letter: s.letter,
      headline: clip(headline, 120),
      risk: judged.risk,
      riskReason: judged.reason,
      evidence,
      next,
      notify: judged.risk !== "low",
      dedupKey: `session_result:${s.id}`,
      facts: { letter: s.letter, role: s.role, taskType: s.taskType, summary: clip(summary, 280), attempt, paid: microToTusd(paidSum), payments: paid.length, sources: h?.sources.length ?? 0, flags: h?.flags ?? [], risk: judged.risk, ticker: T },
    };
  }

  // ─────────────── goal_result ───────────────
  goalResult(goalId: string): ReportDraft | null {
    const { db, bus } = this.deps;
    const g = db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!g) return null;
    const rows = db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all().sort((a, b) => a.letter.localeCompare(b.letter));
    if (!rows.length) return null;
    const T = ticker();
    const met = rows.filter((r) => r.closeStatus === "COMPLETED");
    const spent = rows.reduce((a, r) => a + big(r.spentMicro), 0n);
    const returned = rows.reduce((a, r) => a + big(r.refundMicro), 0n);
    const budget = big(g.budgetMicro);
    const perSession = rows.map((r) =>
      riskForSession({
        session: r,
        handback: parse<Handback | null>(r.handbackJson, null),
        payments: db.select().from(payments).where(eq(payments.sessionId, r.id)).all(),
        events: bus.since(0, { sessionId: r.id }),
        attempt: Math.max(1, r.doneAttempts + (r.closeStatus === "COMPLETED" ? 1 : 0)),
      }),
    );
    const failed = rows.filter((r) => r.closeStatus !== "COMPLETED");
    let risk: RiskLevel = maxRisk(...perSession.map((x) => x.risk));
    const reasons: string[] = [];
    if (met.length === 0) {
      risk = "high";
      reasons.push("no session met its definition of done");
    } else if (failed.length) {
      risk = maxRisk(risk, "medium");
      reasons.push(`${failed.map((r) => r.letter).join(", ")} did not finish (${failed.map((r) => (r.closeStatus ?? "closed").toLowerCase()).join(", ")})`);
    }
    for (const [i, x] of perSession.entries()) if (x.risk !== "low") reasons.push(`${rows[i].letter}: ${x.reason}`);
    // Time-boxed: the work deadline (WORK_DEADLINE_SECONDS) cut at least one session (from goal_completed / the rows).
    const completedEv = bus.since(0, { goalId }).filter((x) => x.type === "goal_completed").pop();
    const boxedRows = rows.filter((r) => r.closeStatus === TIMEBOXED_CLOSE_STATUS || isTimeLimitPartial(parse<Handback | null>(r.handbackJson, null)));
    const timeBoxed = completedEv?.data.timeBoxed === true || boxedRows.length > 0;
    const workSeconds = Number(completedEv?.data.workSeconds ?? 0) || null;
    const boxNote = timeBoxed ? `time-boxed to ${workSeconds ? `${workSeconds} s` : "the work time"} of work${boxedRows.length ? ` (partial: ${boxedRows.map((r) => r.letter).join(", ")})` : ""}` : "";
    const riskReason = clip(
      [reasons.length ? reasons.join("; ") : `all ${rows.length} sessions met their definition of done first time; every payment confirmed on-chain; no flagged content`, boxNote].filter(Boolean).join("; "),
      240,
    );
    const verb = met.length === rows.length ? "Goal done" : met.length ? "Goal partly done" : "Goal not done";
    const headline = `${verb}${timeBoxed ? " (time-boxed)" : ""}: ${met.length}/${rows.length} sessions met their definition of done; spent ${microToTusd(spent)} of ${microToTusd(budget)} ${T}`;
    const evidence: ReportEvidence[] = [
      { label: `${met.length}/${rows.length} sessions met their definition of done`, kind: "dod" as const, ref: rows.map((r) => `${r.letter}:${r.closeStatus ?? "?"}`).join(",") },
      ...(timeBoxed ? [{ label: `Time-boxed: ${boxNote}; sessions closed at the work deadline, funds returned right away`, kind: "dod" as const, ref: `work:${workSeconds ?? "?"}s` }] : []),
      ...rows.flatMap((r) => [
        ...(r.closeTx ? [{ label: `${r.letter} close tx (refund ${microToTusd(big(r.refundMicro))} ${T}; handback hash in CIP-20 metadata)`, kind: "tx" as const, ref: r.closeTx, url: explorerTx(r.closeTx) }] : []),
        ...(r.handbackSha256 ? [{ label: `${r.letter} handback SHA-256`, kind: "handback_hash" as const, ref: r.handbackSha256, ...(r.closeTx ? { url: explorerTx(r.closeTx) } : {}) }] : []),
      ]),
      ...(g.fundingTx ? [{ label: "Funding tx (all session wallets in one tx)", kind: "tx" as const, ref: g.fundingTx, url: explorerTx(g.fundingTx) }] : []),
    ].slice(0, 16);
    const next0 =
      met.length === rows.length
        ? `Read the merged answer in the captain's final report; ${microToTusd(returned)} ${T} came back to your treasury.`
        : met.length
          ? `Decide whether to re-run ${failed.map((r) => r.letter).join(", ")} — ask the captain; ${microToTusd(returned)} ${T} came back to your treasury.`
          : `Nothing usable came back; ${microToTusd(returned)} ${T} returned to your treasury. Ask the captain to re-plan if you still need it.`;
    const next = timeBoxed ? `${next0} The result was time-boxed${workSeconds ? ` to ${workSeconds} s of work` : ""}; for more depth, re-run a narrower goal.` : next0;
    return {
      kind: "goal_result",
      goalId,
      headline: clip(headline, 120),
      risk,
      riskReason,
      evidence,
      next,
      notify: true,
      dedupKey: `goal_result:${goalId}`,
      facts: { goal: clip(g.goal, 160), met: met.length, total: rows.length, spent: microToTusd(spent), budget: microToTusd(budget), returned: microToTusd(returned), risk, ticker: T, failed: failed.map((r) => r.letter), ...(timeBoxed ? { timeBoxed: true, workSeconds, partial: boxedRows.map((r) => r.letter) } : {}) },
    };
  }

  // ─────────────── incidents ───────────────
  endIncident(e: BulkheadEvent): ReportDraft | null {
    const s = this.row(e.sessionId!);
    if (!s) return null;
    const to = String(e.data.to);
    const reason = String(e.data.reason ?? s.endReason ?? "").replace(/\s+/g, " ").trim();
    const byUser = /^killed by user/i.test(reason);
    const T = ticker();
    const spent = big(s.spentMicro);
    const left = big(s.budgetMicro) - spent;
    const pays = this.deps.db.select().from(payments).where(eq(payments.sessionId, s.id)).all();
    const unconfirmed = pays.filter((p) => p.txHash && p.status === "submitted");
    const plainReason = clip(reason.replace(/^killed by (user|captain):\s*/i, ""), 90);
    let headline: string;
    let risk: RiskLevel;
    let riskReason: string;
    switch (to) {
      case "KILLED":
        headline = byUser ? `You stopped ${s.letter} (${s.role})` : `I stopped ${s.letter} (${s.role}): ${plainReason}`;
        risk = unconfirmed.length ? "high" : byUser ? "low" : "medium";
        riskReason = unconfirmed.length
          ? `${unconfirmed.length} payment(s) still unconfirmed on-chain`
          : byUser
            ? "stopped on your request; its leftover funds are swept back"
            : `its part of the goal is not done; ${microToTusd(spent)} ${T} was spent before stopping`;
        break;
      case "FAILED":
        headline = `${s.letter} (${s.role}) failed: ${plainReason || "definition of done not met"}`;
        risk = unconfirmed.length || pays.some((p) => p.status === "confirmed") ? "high" : "medium";
        riskReason = pays.some((p) => p.status === "confirmed")
          ? `it already paid ${microToTusd(spent)} ${T} but did not deliver a result that passes its definition of done`
          : "nothing was paid; its part of the goal is missing";
        break;
      default:
        headline = `${s.letter} (${s.role}) ran out of time before handing back`;
        risk = "medium";
        riskReason = `its wallet expired; ${microToTusd(spent)} ${T} was spent`;
    }
    return {
      kind: "incident",
      goalId: s.goalId,
      sessionId: s.id,
      letter: s.letter,
      headline: clip(headline, 120),
      risk,
      riskReason,
      evidence: [...vaultEvidence(s), ...unconfirmed.map((p) => ({ label: "Unconfirmed payment", kind: "tx" as const, ref: p.txHash!, url: explorerTx(p.txHash!) }))],
      next: `${left > 0n ? `${microToTusd(left)} ${T} returns to your treasury when it closes. ` : ""}${byUser ? "Nothing needed." : "Ask the captain if you want a replacement."}`.trim(),
      notify: !byUser,
      dedupKey: `incident:${s.id}:${to}`,
      facts: { letter: s.letter, role: s.role, to, reason: plainReason, by: byUser ? "user" : "captain", spent: microToTusd(spent), left: microToTusd(left > 0n ? left : 0n), ticker: T },
    };
  }

  quarantineIncident(e: BulkheadEvent): ReportDraft | null {
    const s = e.sessionId ? this.row(e.sessionId) : null;
    if (!s) return null;
    const det = (e.data.details ?? {}) as Record<string, unknown>;
    const url = typeof det.url === "string" ? det.url : "";
    const decision = this.assess(e);
    return {
      kind: "incident",
      goalId: s.goalId,
      sessionId: s.id,
      letter: s.letter,
      headline: clip(`${s.letter} (${s.role}) quarantined: it read flagged content${url ? ` on ${hostLabel(url)}` : ""}`, 120),
      risk: "high",
      riskReason: clip(`possible prompt injection (${String(det.reason ?? "untrusted content")}); its spending is frozen until you decide`, 200),
      evidence: [...(url ? [{ label: "Flagged source", kind: "source" as const, ref: url, ...(isHttp(url) ? { url } : {}) }] : []), ...vaultEvidence(s)],
      next: decision ? `${decision.recommendation.action === "reject" ? "Recommended: keep it stopped" : "Review it"} — ${decision.recommendation.why}` : "Decide in Decisions whether to release it.",
      decisionId: String(e.data.decisionId ?? ""),
      ...(decision ? { recommendation: decision.recommendation } : {}),
      notify: true,
      dedupKey: `incident:${s.id}:quarantine:${String(e.data.decisionId ?? e.id)}`,
      facts: { letter: s.letter, role: s.role, host: url ? hostLabel(url) : null, reason: String(det.reason ?? "") },
    };
  }

  // ─────────────── escalations ───────────────
  escalation(e: BulkheadEvent): ReportDraft | null {
    const det = (e.data.details ?? {}) as Record<string, unknown>;
    // The user opened it themselves in the UI (raise / extend): not an escalation — they are already deciding.
    if (det.initiator === "user") return null;
    const s = e.sessionId ? this.row(e.sessionId) : null;
    if (!s) return null;
    const a = this.assess(e);
    if (!a) return null;
    return {
      kind: "escalation",
      goalId: s.goalId,
      sessionId: s.id,
      letter: s.letter,
      headline: clip(a.question, 120),
      risk: a.risk,
      riskReason: clip(a.impactReason, 200),
      evidence: [
        ...vaultEvidence(s),
        ...(typeof det.payee === "string" && det.payee.startsWith("addr_test1") ? [{ label: "Payee address", kind: "vault" as const, ref: det.payee, url: explorerAddress(det.payee) }] : []),
      ],
      next: `Recommended: ${a.recommendation.action} — ${a.recommendation.why}`,
      decisionId: a.decisionId,
      recommendation: a.recommendation,
      notify: true,
      dedupKey: `escalation:${a.decisionId}`,
      facts: { question: a.question, amount: a.amountAtRisk, impact: a.impactReason, recommendation: a.recommendation.action, ticker: ticker() },
    };
  }

  fundsEscalation(e: BulkheadEvent): ReportDraft | null {
    const g = this.deps.db.select().from(goals).where(eq(goals.id, e.goalId!)).get();
    if (!g) return null;
    const need = typeof e.data.needTusdMicro === "string" ? e.data.needTusdMicro : typeof e.data.shortTusdMicro === "string" ? e.data.shortTusdMicro : null;
    return {
      kind: "escalation",
      goalId: g.id,
      headline: clip(`Your treasury cannot fund "${clip(g.goal, 50)}" yet${need ? ` (needs ${microToTusd(big(need))} ${ticker()} more)` : ""}`, 120),
      risk: "medium",
      riskReason: "the sessions wait unfunded; nothing has been spent",
      evidence: [],
      next: "Top up the treasury; the waiting sessions start automatically once it is funded.",
      notify: true,
      dedupKey: `escalation:funds:${g.id}`,
      facts: { goal: clip(g.goal, 80), error: clip(String(e.data.error ?? ""), 160) },
    };
  }

  private assess(e: BulkheadEvent) {
    const id = String(e.data.decisionId ?? "");
    const d = this.deps.decisions?.get?.(id) ?? null;
    const decision: Decision = d ?? {
      id,
      sessionId: e.sessionId!,
      kind: String(e.data.kind) as DecisionKind,
      requestedBy: (e.data.requestedBy as "captain" | "session") ?? "session",
      refKey: String(e.data.refKey ?? ""),
      details: (e.data.details ?? {}) as Record<string, unknown>,
      status: "open" as const,
      createdAt: e.at,
    };
    if (!decision.sessionId) return null;
    return assessDecision({ db: this.deps.db, bus: this.deps.bus, now: this.deps.now }, decision);
  }
}

/** Deterministic risk rules for one session's outcome. Exported for tests (and reused by bearings / the goal result).
 *  high   — it was quarantined (read flagged / untrusted content), a payment it made is not confirmed on-chain,
 *           its definition of done failed at least once, or it ended without meeting it.
 *  medium — a paying session read external web content, a payment was refused by policy / the vault, the handback
 *           lists gaps (flags), or a research result rests on a single source.
 *  low    — none of the above. */
export function riskForSession(x: { session: SessionDb; handback: Handback | null; payments: PaymentDb[]; events: BulkheadEvent[]; attempt: number }): { risk: RiskLevel; reason: string; next?: string } {
  const { session: s, handback: h } = x;
  const high: string[] = [];
  const medium: string[] = [];
  let next: string | undefined;
  const quarantined = x.events.some((e) => e.type === "tainted" && e.data.quarantine === true);
  if (quarantined) {
    high.push("it read flagged (untrusted) content and was quarantined");
    next = "Check the flagged source before using this result.";
  }
  const unconfirmed = x.payments.filter((p) => p.txHash && p.status === "submitted");
  if (unconfirmed.length) {
    high.push(`${unconfirmed.length} payment(s) not yet confirmed on-chain`);
    next ??= "Wait for the payment confirmation before relying on it.";
  }
  const rejectedDod = x.events.filter((e) => e.type === "handback_rejected").length;
  if (rejectedDod > 0 || x.attempt > 1) {
    high.push(`its first handback failed the definition of done${rejectedDod ? ` (${clip(String(x.events.find((e) => e.type === "handback_rejected")?.data.reason ?? ""), 60)})` : ""}`);
    next ??= "Check the result: it only passed on the retry.";
  }
  if (s.closeStatus === "FAILED") high.push("it failed its definition of done");
  else if (s.closeStatus && s.closeStatus !== "COMPLETED" && ["CLOSED", "CLOSING"].includes(s.status)) medium.push(`it ended ${s.closeStatus.toLowerCase()} before finishing`);
  if (s.tainted && !quarantined && (s.taskType === "buy_pay" || s.taskType === "hire_agent")) medium.push("a paying session read external web content");
  const refused = x.events.filter((e) => e.type === "payment_rejected").length;
  if (refused) medium.push(`${refused} payment attempt(s) refused by policy${x.events.some((e) => e.type === "payment_rejected" && e.data.enforcedBy) ? " / the on-chain vault" : ""}`);
  if (h?.flags?.length) medium.push(`it reports gaps: ${clip(h.flags.slice(0, 2).join("; "), 80)}`);
  if (s.taskType === "research" && h && h.sources.filter((x2) => x2.trim()).length === 1) medium.push("the result rests on a single source");
  if (high.length) return { risk: "high", reason: clip(high.concat(medium).join("; "), 200), next };
  if (medium.length) return { risk: "medium", reason: clip(medium.join("; "), 200) };
  const confirmed = x.payments.filter((p) => p.status === "confirmed").length;
  const bits = [
    "definition of done met first time",
    ...(confirmed ? [`${confirmed} payment(s) confirmed on-chain`] : []),
    ...(h && s.taskType === "research" ? [`${h.sources.length} sources`] : []),
    ...(s.taskType === "research" ? [] : ["no untrusted content"]),
  ];
  return { risk: "low", reason: bits.join("; ") };
}

function vaultEvidence(s: SessionDb): ReportEvidence[] {
  if (!s.address) return [];
  return [
    {
      label: s.walletMode === "vault" ? `${s.letter}'s Session Vault (Plutus V3: payees, per-payment max, expiry enforced on-chain)` : `${s.letter}'s session wallet (native script, expiry lock)`,
      kind: "vault",
      ref: s.address,
      url: explorerAddress(s.address),
    },
  ];
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return clip(url, 40);
  }
}

export type { ReportKind };
