// Result text for a finished crew + the per-Task treasury ledger.
import { explorerTx, microToTusd } from "@bulkhead/shared";
import type { ActivityRowDTO, GoalSummary, SessionDetailDTO, TreeNode } from "@bulkhead/shared";
import type { Ledger, Order } from "./types";

const MAX_RESULT_BYTES = 900_000; // runtime complete accepts ≤ 1 MiB
const tusd = (micro: bigint | string) => `${microToTusd(BigInt(micro))} tUSD`;
const ada = (lovelace: bigint) => `${(Number(lovelace) / 1e6).toFixed(6).replace(/\.?0+$/, "")} ADA`;
const isHash = (h: unknown): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);

export interface CrewSnapshot {
  goal: GoalSummary | null;
  sessionNodes: TreeNode[];
  sessions: Record<string, SessionDetailDTO | undefined>;
  activity: ActivityRowDTO[];
}

export function computeLedger(order: Order, snap: CrewSnapshot): Ledger {
  let float = 0n,
    spent = 0n,
    refund = 0n,
    fees = 0n;
  for (const n of snap.sessionNodes) {
    const d = snap.sessions[n.id];
    float += BigInt(d?.wallet.budgetMicro ?? n.budgetMicro ?? "0");
    spent += BigInt(d?.wallet.spentMicro ?? n.spentMicro ?? "0");
    refund += BigInt(d?.close?.refundMicro ?? n.refundMicro ?? "0");
    fees += BigInt(d?.wallet.feesLovelace ?? "0");
  }
  return {
    floatMicro: float.toString(),
    spentMicro: spent.toString(),
    refundMicro: refund.toString(),
    feesLovelace: fees.toString(),
    treasuryNetOutMicro: (float - refund).toString(),
    quoteMicro: order.quoteMicro,
    feeMicro: order.feeMicro,
    reimbursementAtomic: null,
    settlementTx: null,
    marginMicro: null,
  };
}

export function collectTxLinks(snap: CrewSnapshot): { label: string; hash: string }[] {
  const out: { label: string; hash: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string, hash: unknown) => {
    if (isHash(hash) && !seen.has(hash)) {
      seen.add(hash);
      out.push({ label, hash });
    }
  };
  add("goal funding", snap.goal?.fundingTx);
  for (const n of snap.sessionNodes) {
    const d = snap.sessions[n.id];
    add(`${n.letter ?? "?"} funding`, d?.wallet.fundingTx);
    for (const h of d?.handback?.txHashes ?? []) add(`${n.letter ?? "?"} payment`, h);
    add(`${n.letter ?? "?"} close/refund`, d?.close?.closeTx ?? n.closeTx);
  }
  for (const r of [...snap.activity].sort((a, b) => a.at - b.at)) add(`${r.letter ? `${r.letter} ` : ""}${r.kind}`, r.txHash);
  return out;
}

export function buildResultText(taskName: string | null | undefined, order: Order, snap: CrewSnapshot, ledger: Ledger): string {
  const L: string[] = [];
  L.push(`Bulkhead crew result${taskName ? ` — ${taskName}` : ""}`);
  L.push("");
  L.push(`Goal: ${order.goal}`);
  L.push(`Quote: ${microToTusd(BigInt(order.quoteMicro))} tUSDM = crew budget ${microToTusd(BigInt(order.crewBudgetMicro))} + Bulkhead fee ${microToTusd(BigInt(order.feeMicro))}${order.capped ? " (capped)" : ""}`);
  for (const n of order.notes) L.push(`Note: ${n}`);
  L.push(`Network: Cardano preprod. Goal ${snap.goal?.id ?? "?"} status: ${snap.goal?.status ?? "unknown"}.`);
  L.push("");
  L.push("Sessions");
  const perSessionRoom = Math.floor(6000 / Math.max(1, snap.sessionNodes.length));
  for (const n of snap.sessionNodes) {
    const d = snap.sessions[n.id];
    const closeStatus = d?.endReason ? ` — ${d.endReason}` : "";
    L.push(`${n.letter ?? "?"} · ${n.role ?? d?.role ?? "session"} — ${d?.status ?? n.status ?? "?"}${closeStatus}`);
    const summary = d?.handback?.summary ?? n.handbackSummary;
    if (summary) L.push(`  Summary: ${summary}`);
    L.push(`  Spent ${tusd(d?.wallet.spentMicro ?? n.spentMicro ?? "0")} of ${tusd(d?.wallet.budgetMicro ?? n.budgetMicro ?? "0")}; refund to treasury ${tusd(d?.close?.refundMicro ?? n.refundMicro ?? "0")}; network fees ${ada(BigInt(d?.wallet.feesLovelace ?? "0"))}`);
    const closeTx = d?.close?.closeTx ?? n.closeTx;
    if (isHash(closeTx)) L.push(`  Close tx: ${explorerTx(closeTx)}`);
    if (d?.handback?.result) {
      const body = d.handback.result.length > perSessionRoom ? `${d.handback.result.slice(0, perSessionRoom)}…` : d.handback.result;
      L.push(`  Result:\n${body.replace(/^/gm, "    ")}`);
    }
    if (d?.handback?.sources?.length) L.push(`  Sources: ${d.handback.sources.slice(0, 10).join(", ")}`);
  }
  L.push("");
  L.push("Spend");
  L.push(`  Treasury float (crew wallets funded): ${tusd(ledger.floatMicro)}`);
  L.push(`  Spent by the crew: ${tusd(ledger.spentMicro)}`);
  L.push(`  Refunded to the Bulkhead treasury: ${tusd(ledger.refundMicro)}`);
  L.push(`  Network fees: ${ada(BigInt(ledger.feesLovelace))}`);
  const links = collectTxLinks(snap);
  if (links.length) {
    L.push("");
    L.push("Preprod transactions");
    for (const l of links.slice(0, 200)) L.push(`  ${l.label}: ${explorerTx(l.hash)}`);
  }
  let text = L.join("\n") + "\n";
  while (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) text = text.slice(0, Math.floor(text.length * 0.9)) + "\n…(truncated)\n";
  return text;
}

/** Short status line for "status?" comments. */
export function statusText(order: Order | undefined, phase: string, snap: CrewSnapshot | null): string {
  const parts = [`Phase: ${phase}.`];
  if (order) parts.push(`Quote ${microToTusd(BigInt(order.quoteMicro))} tUSDM, crew budget ${microToTusd(BigInt(order.crewBudgetMicro))}, deadline ${new Date(order.deadlineMs).toISOString()}.`);
  if (snap) {
    for (const n of snap.sessionNodes) parts.push(`${n.letter ?? "?"} ${n.role ?? ""}: ${n.status ?? "?"}, spent ${microToTusd(BigInt(n.spentMicro ?? "0"))}/${microToTusd(BigInt(n.budgetMicro ?? "0"))}.`);
    if (!snap.sessionNodes.length) parts.push("No crew sessions yet.");
  }
  return parts.join(" ");
}
