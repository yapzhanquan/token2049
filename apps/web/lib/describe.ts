// Human-readable lines for engine events (activity timeline, toasts).
import type { BulkheadEvent } from "@bulkhead/shared";
import { myr } from "./money";

export type Tone = "good" | "bad" | "warn" | "run" | "msg" | "none";

const REASONS: Record<string, string> = {
  session_not_running: "session not running",
  payee_not_allowed: "payee not on allowlist",
  over_per_payment_max: "over the per-payment max",
  over_budget: "over budget",
  invalid_amount: "invalid amount",
  build_failed: "transaction build failed",
  submit_failed: "transaction submit failed",
  rejected_onchain: "rejected on-chain by the Session Vault",
  rejected_by_user: "rejected by you",
};

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function describeEvent(e: BulkheadEvent, rate: string): { tone: Tone; text: string; tx?: string } {
  const d = e.data ?? {};
  const amt = d.amountMicro !== undefined ? myr(s(d.amountMicro), rate) : "";
  const payee = s(d.payeeLabel) || (d.payee ? `${s(d.payee).slice(0, 18)}…` : "");
  switch (e.type) {
    case "progress":
      return { tone: "run", text: s(d.text) };
    case "session_created":
      return { tone: "none", text: `Session created (${s(d.taskType)})` };
    case "session_funded":
      return { tone: "good", text: d.reason ? `Wallet funded: ${s(d.reason)}${amt ? ` (${amt})` : ""}` : `Wallet funded with ${amt}`, tx: s(d.txHash) || undefined };
    case "session_transition":
      return {
        tone: ["FAILED", "KILLED", "EXPIRED"].includes(s(d.to)) ? "bad" : ["QUARANTINED", "PAUSED"].includes(s(d.to)) ? "warn" : s(d.to) === "CLOSED" ? "good" : "none",
        text: `${s(d.from)} → ${s(d.to)}${d.reason ? ` · ${s(d.reason)}` : ""}`,
      };
    case "payment_requested":
      return { tone: "none", text: `Payment requested: ${amt} to ${payee}${d.memo ? ` (“${s(d.memo)}”)` : ""}` };
    case "payment_approval_needed":
      return { tone: "warn", text: `Needs your approval: ${amt} to ${payee}` };
    case "payment_approved":
      return { tone: "good", text: `Payment approved${d.by ? ` by ${s(d.by)}` : ""}` };
    case "payment_rejected":
      return { tone: "bad", text: `Payment rejected${amt ? ` (${amt})` : ""}: ${REASONS[s(d.reason)] ?? s(d.reason)}${d.detail && s(d.detail) !== REASONS[s(d.reason)] ? ` — ${s(d.detail)}` : ""}` };
    case "payment_submitted":
      return { tone: "good", text: `Payment submitted: ${amt}`, tx: s(d.txHash) || undefined };
    case "payment_confirmed":
      return { tone: "good", text: `Payment confirmed on-chain: ${amt}${payee ? ` to ${payee}` : ""}`, tx: s(d.txHash) || undefined };
    case "web_fetch":
      return { tone: "none", text: `web_fetch ${s(d.url)}` };
    case "tainted":
      return { tone: "warn", text: `Tainted input: ${s(d.reason)}` };
    case "agent_hired":
      return { tone: "none", text: `Hired agent ${s(d.serviceId)} (job ${s(d.jobId)})` };
    case "agent_job_paid":
      return { tone: "good", text: `Agent job paid (job ${s(d.jobId)})`, tx: s(d.txHash) || undefined };
    case "agent_job_result":
      return { tone: "good", text: `Agent job result received${d.resultHash ? ` · hash ${s(d.resultHash).slice(0, 12)}…` : ""}` };
    case "handback_submitted":
      return { tone: "none", text: `Handback submitted: ${s(d.summary)}` };
    case "handback_accepted":
      return { tone: "good", text: `Handback accepted (definition of done met)` };
    case "handback_rejected":
      return { tone: "bad", text: `Handback returned: ${s(d.reason)}${d.attemptsLeft !== undefined ? ` · ${s(d.attemptsLeft)} attempt(s) left` : ""}` };
    case "handback_passed":
      return { tone: "good", text: `Handback passed as context (data): ${s(d.from).slice(0, 10)} → ${s(d.to).slice(0, 10)}` };
    case "close_submitted":
      return { tone: "none", text: d.reason ? `Sweep: ${s(d.reason)}${amt ? ` (${amt})` : ""}` : "Close / sweep tx submitted", tx: s(d.txHash) || undefined };
    case "close_confirmed":
      return { tone: "good", text: `Closed on-chain: ${d.refundMicro !== undefined ? myr(s(d.refundMicro), rate) : ""} returned to treasury, log hash anchored`, tx: s(d.txHash) || undefined };
    case "tool_denied":
      return { tone: "bad", text: `Tool denied: ${s(d.tool)}${d.reason ? ` (${s(d.reason)})` : " (not allowed for this task type)"}` };
    case "session_message":
      return { tone: "msg", text: s(d.text) };
    case "mandate_change_ignored":
      return { tone: "warn", text: s(d.text) || "A message tried to change the mandate; ignored and logged." };
    case "decision_opened":
      return { tone: "warn", text: `Decision opened: ${s(d.kind).replace(/_/g, " ")}` };
    case "decision_closed":
      return { tone: s(d.status) === "approved" ? "good" : "bad", text: `Decision ${s(d.status)}: ${s(d.kind).replace(/_/g, " ")}${d.note ? ` · ${s(d.note)}` : ""}` };
    case "heartbeat_missed":
      return { tone: "warn", text: "Missed heartbeats (session went quiet)" };
    case "deadline_near":
      return { tone: "warn", text: "Deadline is near" };
    case "session_looping":
      return { tone: "warn", text: `Stuck in a loop (${s(d.failures)} failed calls${Array.isArray(d.recent) && d.recent.length ? `: ${s(d.recent[d.recent.length - 1])}` : ""}) · captain woken, escalation ${s(d.escalation)}` };
    case "session_stalled":
      return { tone: "warn", text: `No progress for ${Math.round(Number(d.idleMs ?? 0) / 60_000)} min · captain woken, escalation ${s(d.escalation)}` };
    case "goal_completed":
      return { tone: s(d.outcome) === "all_done" ? "good" : "warn", text: `Goal complete: ${s(d.doneMet)}/${s(d.total)} session(s) met their definition of done` };
    case "captain_action": {
      const input = (d.input ?? {}) as Record<string, unknown>;
      const what = d.tool === "message_session" ? `message to session: ${s(input.text)}` : d.tool === "report_to_user" ? `report: ${s(input.text)}` : `${s(d.tool).replace(/_/g, " ")}${input.sessionId ? ` ${s(input.sessionId)}` : ""}`;
      return { tone: d.ok === false ? "bad" : "msg", text: `Captain${d.auto ? " (auto)" : ""}: ${what}${d.ok === false ? ` — refused: ${s(d.error)}` : ""}` };
    }
    case "error":
      return { tone: "bad", text: s(d.message ?? d.error ?? d.text ?? "error") };
    default:
      return { tone: "none", text: `${e.type.replace(/_/g, " ")}${d.text ? `: ${s(d.text)}` : ""}` };
  }
}

export const DECISION_WORD: Record<string, string> = {
  payment_approval: "Payment approval",
  budget_raise: "Raise budget",
  extend_expiry: "Extend expiry",
  quarantine_release: "Release from quarantine",
  widen_mandate: "Widen mandate",
};

/**
 * Status word for a session (display mapping only — the DB status is unchanged). AWAITING_APPROVAL exists only
 * BEFORE funding (plan approved but the funding tx not submitted yet, e.g. the treasury lacked tUSD/tADA), so it
 * reads "waiting for funding". A RUNNING session with an open payment decision reads "awaiting approval".
 */
export function sessionStatusWord(status: string | undefined, glyph?: string): string {
  if (status === "AWAITING_APPROVAL") return "waiting for funding";
  if (glyph === "awaiting") return "awaiting approval";
  if (glyph === "planned" || status === "PLANNED") return "planned";
  return (status ?? glyph ?? "").toLowerCase();
}

/** A goal whose plan was (or may be) approved but whose funding tx was never submitted — or a started goal with
 * sessions still waiting for funding (Approve re-runs the funding; self-custody: the wallet signs again). */
export function isGoalUnfunded(goal: { status: string; fundingTx: string | null; awaitingFunding?: number }): boolean {
  if (!goal.fundingTx && (goal.status === "planned" || goal.status === "approved")) return true;
  return (goal.status === "approved" || goal.status === "running") && (goal.awaitingFunding ?? 0) > 0;
}

export const UNFUNDED_GOAL_TEXT = "Plan not funded yet — approve or top up";
