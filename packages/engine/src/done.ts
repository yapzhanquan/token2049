// Definition-of-done checks per task type (spec v2 §3). Pure: callers pass in what the DB/chain says.
import type { Handback, TaskType } from "@bulkhead/shared";

export interface DonePayment {
  id: string;
  status: string; // payments.status
  txHash: string | null;
}
export interface DoneJob {
  externalJobId: string | null;
  status: string; // agent_jobs.status
  resultHash: string | null;
  /** on-chain: the Signer payment is confirmed. credits: the off-chain credit charge is recorded (confirmed row). */
  paymentConfirmed: boolean;
  /** "credits" = billed off-chain (Sokosumi org credits; evidence = jobId + resultHash, no tx). Default on-chain. */
  billing?: "onchain" | "credits";
}
export interface DoneContext {
  taskType: TaskType;
  handback: Handback;
  payments: DonePayment[];
  jobs: DoneJob[];
  /** monitor: did the watched condition happen (evaluated by the orchestrator, not the silo)? */
  conditionMet?: boolean;
  deadline: number;
  startedAt: number | null;
  now: number;
}
export type DoneResult = { ok: true } | { ok: false; reason: string };

/** A monitor reports a little before the deadline (the session wallet expires AT the deadline). */
export function monitorGraceMs(startedAt: number, deadline: number): number {
  return Math.max(1_000, Math.min(60_000, Math.floor((deadline - startedAt) * 0.1)));
}

export function checkDone(c: DoneContext): DoneResult {
  const h = c.handback;
  if (!h.summary?.trim()) return { ok: false, reason: "summary is empty" };
  switch (c.taskType) {
    case "research": {
      if (!h.result?.trim()) return { ok: false, reason: "result is empty" };
      if (h.sources.filter((s) => s.trim()).length < 1) return { ok: false, reason: "research needs at least 1 source" };
      return { ok: true };
    }
    case "buy_pay": {
      const listed = new Set(h.txHashes ?? []);
      if (listed.size === 0) return { ok: false, reason: "no payment tx hashes listed in the handback" };
      const made = c.payments.filter((p) => p.txHash && (p.status === "submitted" || p.status === "confirmed"));
      if (made.length === 0) return { ok: false, reason: "no payment was made" };
      const unconfirmed = made.filter((p) => p.status !== "confirmed");
      if (unconfirmed.length) return { ok: false, reason: `${unconfirmed.length} payment(s) not yet confirmed on-chain` };
      const missing = made.filter((p) => !listed.has(p.txHash!));
      if (missing.length) return { ok: false, reason: `handback is missing tx hash(es): ${missing.map((p) => p.txHash!.slice(0, 12)).join(", ")}` };
      const known = new Set(made.map((p) => p.txHash!));
      const bogus = [...listed].filter((t) => !known.has(t));
      if (bogus.length) return { ok: false, reason: `handback lists tx hash(es) this session never paid: ${bogus.map((t) => t.slice(0, 12)).join(", ")}` };
      return { ok: true };
    }
    case "hire_agent": {
      if (!h.job) return { ok: false, reason: "handback has no job { jobId, resultHash }" };
      if (!h.result?.trim()) return { ok: false, reason: "result is empty" };
      const job = c.jobs.find((j) => j.externalJobId === h.job!.jobId);
      if (!job) return { ok: false, reason: `job ${h.job.jobId} was not hired by this session` };
      if (job.billing === "credits") {
        // Sokosumi: credits are charged off-chain to the configured organization; the evidence is the job id +
        // sha256(raw result) recorded by the market, plus the confirmed credit row (no tx hash).
        if (!job.paymentConfirmed) return { ok: false, reason: "the Sokosumi credit charge for this job is not recorded" };
        if (!job.resultHash || !/^[0-9a-f]{64}$/.test(job.resultHash)) return { ok: false, reason: "the Sokosumi job has no result hash" };
      } else if (!job.paymentConfirmed) return { ok: false, reason: "the job payment is not confirmed on-chain" };
      if (job.status !== "completed") return { ok: false, reason: `job is ${job.status}, not completed` };
      if (!job.resultHash || job.resultHash !== h.job.resultHash) return { ok: false, reason: "result_hash does not match the paid agent's response" };
      return { ok: true };
    }
    case "monitor": {
      if (!h.result?.trim()) return { ok: false, reason: "monitor report is empty" };
      if (c.conditionMet) return { ok: true };
      const start = c.startedAt ?? c.now;
      const reportWindowOpens = c.deadline - monitorGraceMs(start, c.deadline) - 2_000; // 2 s clock slack
      if (c.now >= reportWindowOpens) return { ok: true };
      return { ok: false, reason: "the watched condition has not happened and the deadline has not passed" };
    }
  }
}

/**
 * monitor: evaluate the plan's `watch` against the chain (read-only). Supported shapes:
 *   { kind: "deposit" | "balance", address, minTUSD?, minADA? }  — address holds at least that much
 *   { kind: "tx", txHash }                                        — tx is confirmed
 *   { kind: "slot", slot }                                        — chain tip reached the slot
 * Anything else → false (the monitor then reports at the deadline).
 */
export async function evaluateWatch(
  chain: Pick<import("@bulkhead/chain").Chain, "tx" | "provider">,
  watch: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  if (!watch) return false;
  try {
    const kind = String(watch.kind ?? "");
    if ((kind === "deposit" || kind === "balance") && typeof watch.address === "string") {
      const b = await chain.tx.balanceOf(watch.address);
      const minT = watch.minTUSD !== undefined ? BigInt(Math.round(Number(watch.minTUSD) * 1_000_000)) : 1n;
      const minL = watch.minADA !== undefined ? BigInt(Math.round(Number(watch.minADA) * 1_000_000)) : 0n;
      return b.tusdMicro >= minT && b.lovelace >= minL;
    }
    if (kind === "tx" && typeof watch.txHash === "string") return (await chain.provider.fetchTxConfirmation(watch.txHash)) !== null;
    if (kind === "slot" && watch.slot !== undefined) return (await chain.provider.fetchTip()).slot >= Number(watch.slot);
  } catch {
    return false;
  }
  return false;
}
