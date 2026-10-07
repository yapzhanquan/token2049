// Boot reconciliation (spec §5.2): load every non-CLOSED session and reconcile it against the chain
// (address balance, pending funding / payment / close tx hashes) BEFORE resuming anything.
// A live session whose process died is restarted from its last checkpoint, or FAILED → CLOSING.
import { ne } from "drizzle-orm";
import { sessions, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { SessionStatus } from "@bulkhead/shared";
import type { EventBus } from "./contracts";
import type { RuntimeSessionManager } from "./sessions";
import type { RuntimeSigner } from "./signer";
import type { RuntimeSiloRunner } from "./silo/runner";
import { getSessionDb, updateSessionDb, waitForTx, type RuntimeConfig } from "./sessions-store";
import type { ContextIn } from "@bulkhead/shared";

export interface ReconcileReport {
  checked: number;
  restarted: string[];
  failed: string[];
  closing: string[];
  funding: string[];
}

export async function reconcileSessions(deps: {
  db: DB;
  bus: EventBus;
  chain: Chain;
  silos: RuntimeSiloRunner;
  signer: RuntimeSigner;
  sessions: RuntimeSessionManager;
  config: RuntimeConfig;
}): Promise<ReconcileReport> {
  const { db, bus, chain, silos, signer, sessions: mgr, config } = deps;
  const now = () => config.now();
  const report: ReconcileReport = { checked: 0, restarted: [], failed: [], closing: [], funding: [] };
  const rows = db.select().from(sessions).where(ne(sessions.status, "CLOSED")).all();
  await signer.trackPending();

  for (const r0 of rows) {
    report.checked++;
    const id = r0.id;
    const status = r0.status as SessionStatus;
    try {
      if (r0.address) {
        chain.watcher.watchAddress(r0.address);
        chain.watcher.watchExpiry(id, r0.expirySlot ?? chain.slotFromTime(r0.expiresAt));
      }
      let bal: Awaited<ReturnType<Chain["tx"]["balanceOf"]>> | null = null;
      if (r0.address) {
        try {
          bal = await chain.tx.balanceOf(r0.address);
        } catch {
          bal = null;
        }
      }
      // Funding status from the chain, not from memory.
      if (r0.fundingTx && !r0.fundingConfirmedAt) {
        const c = await chain.provider.fetchTxConfirmation(r0.fundingTx).catch(() => null);
        if (c) updateSessionDb(db, id, { fundingConfirmedAt: now() }, now());
        else chain.watcher.watchTx(r0.fundingTx);
      }
      if (r0.closeTx) chain.watcher.watchTx(r0.closeTx);
      // An unfunded PLANNED / AWAITING_APPROVAL session has nothing to resume: logging it on every restart was
      // pure noise. The goal reconciler (goal-funding.ts) reports such goals ONCE with the exact shortfall.
      const idleUnfunded = (status === "PLANNED" || status === "AWAITING_APPROVAL") && !r0.fundingTx && !(bal && (bal.tusdMicro > 0n || bal.utxoCount > 0));
      if (!idleUnfunded) bus.emit("progress", {
        goalId: r0.goalId,
        sessionId: id,
        data: { kind: "log", level: "info", text: `reconcile after restart: ${status}${bal ? `, wallet ${bal.tusdMicro} µtUSD / ${bal.lovelace} lovelace` : ""}` },
      });

      if (expiredNow(r0.expiresAt) && !["CLOSING", "FAILED", "KILLED", "EXPIRED"].includes(status)) {
        await mgr.transition(id, "EXPIRED", "deadline passed while the server was down");
        report.closing.push(id);
        continue;
      }
      switch (status) {
        case "PLANNED":
        case "AWAITING_APPROVAL":
          // Not funded yet: leave it for a re-approve (startPlan resumes it). If the chain shows the wallet was
          // funded (crash between submit and DB write), treat it as funded instead of funding twice.
          if (bal && (bal.tusdMicro > 0n || bal.utxoCount > 0)) {
            if (status === "PLANNED") await mgr.transition(id, "AWAITING_APPROVAL", "resume");
            updateSessionDb(db, id, { fundingConfirmedAt: now() }, now());
            await mgr.transition(id, "FUNDING", "funding found on-chain after restart");
            report.funding.push(id);
          }
          break;
        case "FUNDING": {
          const r = getSessionDb(db, id)!;
          if (!r.fundingTx) {
            await mgr.transition(id, "FAILED", "funding tx never submitted (server restart)");
            report.failed.push(id);
          } else {
            report.funding.push(id);
            if (r.fundingConfirmedAt) await mgr.onFundingConfirmed(r.fundingTx);
            else {
              const tx = r.fundingTx;
              void waitForTx(chain, tx, { timeoutMs: config.txConfirmTimeoutMs, pollMs: config.txPollMs }).then((ok) => (ok ? mgr.onFundingConfirmed(tx) : undefined), () => undefined);
            }
          }
          break;
        }
        case "RUNNING":
        case "PAUSED":
        case "QUARANTINED": {
          if (silos.isAlive(id)) break;
          if (bal && bal.utxoCount === 0 && r0.fundingConfirmedAt) {
            await mgr.transition(id, "FAILED", "session wallet is empty after restart");
            report.failed.push(id);
            break;
          }
          try {
            const r = getSessionDb(db, id)!;
            await silos.start({ sessionId: id, taskType: r.taskType as never, allowWebFetch: r.allowWebFetch, contextIn: JSON.parse(r.contextInJson) as ContextIn[], dataScope: JSON.parse(r.dataScopeJson) as string[] });
            if (status === "PAUSED" || status === "QUARANTINED") silos.send(id, { type: "pause" });
            report.restarted.push(id);
          } catch (e) {
            await mgr.transition(id, "FAILED", `could not restart silo: ${e instanceof Error ? e.message : String(e)}`);
            report.failed.push(id);
          }
          break;
        }
        case "COMPLETING":
          // The handback is stored: just review it again (idempotent).
          void mgr.reviewHandback(id).catch(() => undefined);
          break;
        case "FAILED":
        case "KILLED":
        case "EXPIRED":
          await mgr.transition(id, "CLOSING", "resume close after restart");
          report.closing.push(id);
          break;
        case "CLOSING":
          void mgr.close(id);
          report.closing.push(id);
          break;
      }
    } catch (e) {
      bus.emit("error", { goalId: r0.goalId, sessionId: id, data: { kind: "reconcile_failed", error: e instanceof Error ? e.message : String(e) } });
    }
  }
  await mgr.drainQueue();
  return report;

  function expiredNow(expiresAt: number) {
    return now() >= expiresAt;
  }
}
