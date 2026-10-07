// Budget-bounded auto-approval of engine decisions for one Task's goal.
// The ceiling is the Task's quoted crew budget plus any extra allowance the Task owner granted by
// commenting "approve <n> tUSDM". Anything that cannot be bounded by money is asked, never approved.
import type { DecisionDTO } from "@bulkhead/shared";

export type Verdict = { action: "approve" | "reject" | "ask"; reason: string; amountMicro?: bigint };

export interface ApprovalContext {
  crewBudgetMicro: bigint;
  extraAllowanceMicro: bigint;
  /** Σ session budgets currently funded (the treasury float). */
  floatMicro: bigint;
  /** Σ spent across the goal's sessions. */
  spentMicro: bigint;
  /** Task deadline (epoch ms). */
  deadlineMs: number;
}

const big = (v: unknown): bigint | null => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
};

export function judgeDecision(d: Pick<DecisionDTO, "kind" | "details">, ctx: ApprovalContext): Verdict {
  const ceiling = ctx.crewBudgetMicro + ctx.extraAllowanceMicro;
  const det = (d.details ?? {}) as Record<string, unknown>;
  switch (d.kind) {
    case "payment_approval": {
      const amount = big(det.amountMicro);
      if (amount === null) return { action: "ask", reason: "payment amount unreadable" };
      if (ctx.spentMicro + amount <= ceiling) return { action: "approve", reason: "within the Task's quoted budget", amountMicro: amount };
      return { action: "ask", reason: "payment would exceed the Task's quoted budget", amountMicro: amount };
    }
    case "budget_raise": {
      const add = big(det.addMicro);
      if (add === null) return { action: "ask", reason: "raise amount unreadable" };
      if (ctx.floatMicro + add <= ceiling) return { action: "approve", reason: "raise stays within the Task's quoted budget", amountMicro: add };
      return { action: "ask", reason: "raise would exceed the Task's quoted budget", amountMicro: add };
    }
    case "extend_expiry": {
      const ms = typeof det.newExpiresAt === "number" ? det.newExpiresAt : Number(det.newExpiresAt);
      if (Number.isFinite(ms) && ms <= ctx.deadlineMs) return { action: "approve", reason: "new expiry within the Task deadline" };
      return { action: "ask", reason: "new expiry is past the Task deadline" };
    }
    default:
      // quarantine_release, widen_mandate, unknown kinds: never automatic.
      return { action: "ask", reason: `${d.kind} needs the Task owner` };
  }
}
