"use client";
// "Why this plan": the captain's rationale (goal/plan `rationale` from the engine, when present) plus
// the facts of the plan itself — which sessions run in parallel, which wait for whose handback, and
// which on-chain guards bound each one. Shown at the approve step, before anything is funded.
import type { Plan, TreeDTO } from "@bulkhead/shared";
import { tusdToMicro } from "@bulkhead/shared";
import { myr } from "@/lib/money";

export interface PlanStep {
  letter: string;
  role: string;
  taskType?: string;
  why?: string;
  budgetMicro?: string;
  perPaymentMaxMicro?: string;
  approvalThresholdMicro?: string;
  payees?: number;
  /** Letters whose handbacks this step waits for. */
  after: string[];
}

const L = (i: number) => String.fromCharCode(65 + i);

export function stepsFromPlan(plan: Plan): PlanStep[] {
  return plan.sessions.map((s, i) => ({
    letter: L(i),
    role: s.role,
    taskType: s.taskType,
    why: typeof (s as { why?: unknown }).why === "string" ? (s as { why?: string }).why : undefined,
    budgetMicro: tusdToMicro(s.budgetTUSD).toString(),
    perPaymentMaxMicro: tusdToMicro(s.perPaymentMaxTUSD).toString(),
    approvalThresholdMicro: tusdToMicro(s.approvalThresholdTUSD).toString(),
    payees: s.allowedPayees.length,
    after: [...new Set([...(s.contextFrom ?? []), ...(s.parent !== undefined ? [s.parent] : [])])].map(L),
  }));
}

export function stepsFromTree(tree: TreeDTO | null | undefined): PlanStep[] {
  if (!tree) return [];
  const sessions = tree.nodes.filter((n) => n.kind === "session");
  const byId = new Map(sessions.map((n) => [n.id, n]));
  return sessions.map((n, i) => {
    const after = tree.edges.filter((e) => e.to === n.id && byId.has(e.from)).map((e) => byId.get(e.from)!.letter ?? "?");
    if (n.parentId && byId.has(n.parentId)) after.push(byId.get(n.parentId)!.letter ?? "?");
    return { letter: n.letter ?? L(i), role: n.role ?? n.label, taskType: n.taskType, budgetMicro: n.budgetMicro, after: [...new Set(after)] };
  });
}

/** Shape of shared `PlanRationale` (packages/shared/src/bridge.ts), read defensively. */
interface RationaleObj {
  summary?: string;
  sessions?: { letter?: string; name?: string; why?: string; runs?: "parallel" | "after"; after?: string[]; budgetTUSD?: string; sharePct?: number; taskType?: string }[];
  parallelism?: string;
  budget?: string;
  guards?: string[];
  adjustments?: string[];
  source?: "planner" | "deterministic";
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);

/** Pull `rationale` off a goal / plan response / plan, whichever has it. */
export function rationaleOf(...sources: unknown[]): unknown {
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (o.rationale) return o.rationale;
  }
  return undefined;
}

export function PlanRationale({ rationale, steps: stepsIn, rate, compact }: { rationale?: unknown; steps: PlanStep[]; rate: string; compact?: boolean }) {
  const r: RationaleObj = typeof rationale === "string" ? { summary: rationale } : rationale && typeof rationale === "object" ? (rationale as RationaleObj) : {};
  const rs = Array.isArray(r.sessions) ? r.sessions : [];
  // Steps from the plan/tree; the rationale's own session list fills in when the tree has no edges yet.
  const steps: PlanStep[] = stepsIn.length
    ? stepsIn.map((s) => {
        const m = rs.find((x) => x.letter === s.letter);
        return { ...s, why: s.why ?? m?.why, after: s.after.length ? s.after : m?.runs === "after" ? list(m.after) : s.after };
      })
    : rs.map((x, i) => ({ letter: x.letter ?? String.fromCharCode(65 + i), role: x.name ?? "", taskType: x.taskType, why: x.why, after: x.runs === "after" ? list(x.after) : [] }));
  const share = new Map(rs.map((x) => [x.letter ?? "", x.sharePct]));
  const parallel = steps.filter((s) => s.after.length === 0);
  const later = steps.filter((s) => s.after.length > 0);
  const capPerPay = steps.filter((s) => s.perPaymentMaxMicro && s.perPaymentMaxMicro !== "0");
  const guards = list(r.guards);
  const adjustments = list(r.adjustments);
  if (!steps.length && !r.summary) return null;
  return (
    <div className={`flex flex-col gap-2 ${compact ? "text-[12.5px]" : "text-[13px]"}`}>
      <div className="flex items-center gap-2">
        <div className="section-title m-0">Why this plan</div>
        {r.source && (
          <span className="text-[10.5px] muted" title={r.source === "planner" ? "The planner model's own words" : "Written deterministically by the engine from the plan"}>
            {r.source === "planner" ? "planner's reasoning" : "engine summary"}
          </span>
        )}
      </div>
      {r.summary ? <div className="whitespace-pre-wrap">{r.summary}</div> : <div className="mid">This is the plan the captain proposed; nothing is funded until you approve.</div>}
      {steps.length > 0 && (
        <ul className="m-0 pl-4 flex flex-col gap-1">
          {parallel.length > 0 && (
            <li>
              <b>In parallel:</b> {parallel.map((s) => `${s.letter} ${s.role}`.trim()).join(", ")}
              {parallel.length > 1 ? " — no dependency between them, so they start together." : " — starts first."}
            </li>
          )}
          {later.map((s) => (
            <li key={s.letter}>
              <b>
                {s.letter} {s.role}
              </b>{" "}
              waits for {s.after.join(", ")} and receives their handback as data, never as instructions.
            </li>
          ))}
          {r.parallelism && <li className="mid">{r.parallelism}</li>}
          {steps.map((s) =>
            s.why ? (
              <li key={`why${s.letter}`}>
                <b>{s.letter}</b>
                {share.get(s.letter) !== undefined ? <span className="muted"> ({share.get(s.letter)}% of budget)</span> : null}: {s.why}
              </li>
            ) : null,
          )}
          {r.budget && <li className="mid">{r.budget}</li>}
        </ul>
      )}
      <div>
        <div className="label mb-0.5">Guards that hold whatever an agent says</div>
        <ul className="m-0 pl-4 flex flex-col gap-0.5">
          {guards.length > 0 ? (
            guards.map((g, i) => <li key={`g${i}`}>{g}</li>)
          ) : (
            <>
              <li>
                Each session gets its own wallet holding exactly its budget
                {steps.some((s) => s.budgetMicro) ? ` (${steps.filter((s) => s.budgetMicro).map((s) => `${s.letter} ${myr(s.budgetMicro!, rate)}`).join(", ")})` : ""} — it cannot spend more.
              </li>
              {steps.some((s) => s.payees !== undefined) && <li>Payees are allowlisted per session ({steps.map((s) => `${s.letter}: ${s.payees ?? 0}`).join(", ")}); anything else is refused before signing.</li>}
              <li>Wallets expire at the deadline; on close, leftovers sweep back to your treasury and a hash of the log is anchored on Cardano.</li>
            </>
          )}
          {capPerPay.length > 0 && (
            <li>
              Per-payment caps / ask-me thresholds: {capPerPay.map((s) => `${s.letter} ≤ ${myr(s.perPaymentMaxMicro!, rate)}${s.approvalThresholdMicro ? `, asks above ${myr(s.approvalThresholdMicro, rate)}` : ""}`).join("; ")}.
            </li>
          )}
        </ul>
      </div>
      {adjustments.length > 0 && (
        <div className="text-[12px] mid">
          <span className="label">Engine adjusted the model's plan: </span>
          {adjustments.join(" · ")}
        </div>
      )}
    </div>
  );
}
