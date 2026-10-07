// Fixture-mode GET /activity: a simplified mapping of the sample events (no collapsing, no chain reads).
// The real feed is built by the engine (packages/engine/src/api-activity.ts).
import type { ActivityDTO, ActivityKind, ActivityRowDTO, BulkheadEvent } from "@bulkhead/shared";
import { describeEvent } from "./describe";

const KIND: Partial<Record<string, ActivityKind>> = {
  payment_requested: "payment",
  payment_approved: "payment",
  payment_submitted: "payment",
  payment_confirmed: "payment",
  payment_approval_needed: "payment",
  payment_rejected: "rejection",
  tool_denied: "rejection",
  mandate_change_ignored: "rejection",
  error: "rejection",
  session_funded: "funding",
  close_submitted: "close",
  close_confirmed: "close",
  agent_hired: "hire",
  agent_job_paid: "hire",
  agent_job_result: "hire",
  handback_submitted: "handback",
  handback_passed: "handback",
  handback_accepted: "handback",
  handback_rejected: "handback",
  decision_opened: "decision",
  decision_closed: "decision",
  topup_pending: "topup",
  topup_submitted: "topup",
  topup_confirmed: "topup",
  deposit_seen: "topup",
  session_transition: "transition",
  session_created: "transition",
  session_message: "message",
  user_message: "message",
};
const GROUPS: Record<string, ActivityKind[]> = {
  payments: ["payment", "rejection"],
  agents: ["hire", "handback", "progress", "transition", "message"],
  decisions: ["decision"],
  funding: ["funding", "close", "topup", "staking"],
  captain: ["captain"],
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function fixtureActivity(events: BulkheadEvent[], q: URLSearchParams): ActivityDTO {
  const query = (q.get("q") ?? "").trim();
  const type = q.get("type") ?? "all";
  const kinds = type === "all" ? null : new Set(GROUPS[type] ?? []);
  const goalId = q.get("goalId");
  const rows: ActivityRowDTO[] = [];
  for (const e of [...events].reverse()) {
    if (e.type === "llm_usage") continue;
    if (goalId && e.goalId && e.goalId !== goalId) continue;
    if (query && e.sessionId !== query && !JSON.stringify(e.data ?? {}).includes(query)) continue;
    const d = e.data ?? {};
    const kind: ActivityKind = KIND[e.type] ?? (e.type.startsWith("captain_") || e.type.startsWith("plan_") || e.type === "goal_created" ? "captain" : "progress");
    if (kinds && !kinds.has(kind)) continue;
    const dir = kind === "payment" || kind === "hire" ? "out" : kind === "topup" || kind === "close" ? "in" : null;
    rows.push({
      id: `ev:${e.id}`,
      eventId: e.id,
      at: e.at,
      kind,
      title: describeEvent(e, "4.70").text,
      goalId: e.goalId ?? null,
      sessionId: e.sessionId ?? null,
      letter: str(d.letter),
      txHash: str(d.txHash),
      paymentId: str(d.paymentId),
      decisionId: str(d.decisionId),
      agentJobId: str(d.jobRowId),
      address: str(d.payee) ?? str(d.address),
      amountMicro: str(d.amountMicro) ?? str(d.refundMicro) ?? str(d.tusdMicro),
      direction: dir,
      status: e.type.endsWith("confirmed") ? "confirmed" : e.type.endsWith("rejected") ? "rejected" : e.type.endsWith("submitted") ? "pending" : "ok",
    });
    if (rows.length >= 80) break;
  }
  return { rows, match: query ? { type: "text", value: query } : null, nextBefore: null };
}
