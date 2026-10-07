// Supervisor (spec §5.3): per-session checks without busy chain polling.
//  - heartbeats: silo sends one every 5 s; 3 missed → heartbeat_missed + FAILED → CLOSING
//  - wall-clock deadline → EXPIRED → CLOSING (also on ChainWatcher expiry_reached)
//  - deadline_near once per session, ~10% of its time window before the deadline
//  - budget watcher: on chain spend/deposit events for a session address, compare on-chain balance
//    with budget − spent (Signer records) and flag a mismatch / overspend.
import { eq, inArray } from "drizzle-orm";
import { events, sessions, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { microToTusd, type SessionStatus } from "@bulkhead/shared";
import type { EventBus } from "./contracts";
import type { RuntimeSessionManager } from "./sessions";
import type { RuntimeSiloRunner } from "./silo/runner";
import type { RuntimeConfig } from "./sessions-store";

export interface Supervisor {
  start(): void;
  stop(): void;
  /** One supervision pass (exposed for tests). */
  tick(): Promise<void>;
}

const NOT_ENDED: SessionStatus[] = ["PLANNED", "AWAITING_APPROVAL", "FUNDING", "RUNNING", "PAUSED", "QUARANTINED", "COMPLETING"];
const WITH_SILO: SessionStatus[] = ["RUNNING", "PAUSED", "QUARANTINED"];

export function createSupervisor(deps: { db: DB; bus: EventBus; chain: Chain; sessions: RuntimeSessionManager; silos: RuntimeSiloRunner; config: RuntimeConfig }): Supervisor {
  const { db, bus, chain, sessions: mgr, silos, config } = deps;
  const now = () => config.now();
  let timer: NodeJS.Timeout | null = null;
  let offChain: (() => void) | null = null;
  let running = false;
  const nearSent = new Set<string>(
    db
      .select({ s: events.sessionId })
      .from(events)
      .where(eq(events.type, "deadline_near"))
      .all()
      .map((r) => r.s ?? ""),
  );
  const missedSent = new Set<string>();

  async function safe(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch {
      /* a racing transition (e.g. already closing) is fine */
    }
  }

  async function budgetCheck(address: string) {
    const r = db.select().from(sessions).where(eq(sessions.address, address)).get();
    if (!r || !NOT_ENDED.includes(r.status as SessionStatus)) return;
    const budget = BigInt(r.budgetMicro);
    const spent = BigInt(r.spentMicro);
    if (spent > budget) {
      bus.emit("error", { goalId: r.goalId, sessionId: r.id, data: { kind: "overspend", alert: true, spentMicro: r.spentMicro, budgetMicro: r.budgetMicro } });
      await safe(() => mgr.transition(r.id, "FAILED", `spent ${microToTusd(spent)} > budget ${microToTusd(budget)} tUSD`));
      return;
    }
    try {
      const b = await chain.tx.balanceOf(address);
      const expected = budget - spent;
      if (r.fundingConfirmedAt && b.tusdMicro > expected) {
        bus.emit("progress", { goalId: r.goalId, sessionId: r.id, data: { kind: "log", level: "warn", text: `wallet holds ${microToTusd(b.tusdMicro)} tUSD, more than budget − spent (${microToTusd(expected)}); the extra returns at close` } });
      }
    } catch {
      /* provider hiccup: next event retries */
    }
  }

  const sup: Supervisor = {
    start() {
      if (timer) return;
      timer = setInterval(() => void sup.tick(), config.supervisorTickMs);
      timer.unref?.();
      offChain = chain.watcher.on((e) => {
        if (e.type === "expiry_reached") {
          const r = mgr.get(e.sessionId);
          if (r && NOT_ENDED.includes(r.status)) void safe(() => mgr.transition(r.id, "EXPIRED", "session wallet expiry slot reached"));
        } else if (e.type === "spend" || e.type === "deposit") {
          void budgetCheck(e.address);
        }
      });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      offChain?.();
      offChain = null;
    },
    async tick() {
      if (running) return;
      running = true;
      try {
        const t = now();
        const rows = db.select().from(sessions).where(inArray(sessions.status, NOT_ENDED)).all();
        for (const r of rows) {
          const status = r.status as SessionStatus;
          // Wall-clock deadline.
          if (t >= r.expiresAt) {
            await safe(() => mgr.transition(r.id, "EXPIRED", "deadline reached"));
            continue;
          }
          // deadline_near ≈ 10% of the window before the deadline.
          const startAt = r.startedAt ?? r.createdAt;
          const window = Math.max(0, r.expiresAt - startAt);
          if (!nearSent.has(r.id) && window > 0 && r.expiresAt - t <= window * 0.1) {
            nearSent.add(r.id);
            bus.emit("deadline_near", { goalId: r.goalId, sessionId: r.id, data: { expiresAt: r.expiresAt, msLeft: r.expiresAt - t, status } });
          }
          // Heartbeats (only while a silo should be alive).
          if (WITH_SILO.includes(status) && silos.isAlive(r.id)) {
            const last = silos.lastHeartbeat(r.id) ?? t;
            const missed = Math.floor((t - last) / config.heartbeatMs);
            if (missed >= config.missedHeartbeats && !missedSent.has(r.id)) {
              missedSent.add(r.id);
              bus.emit("heartbeat_missed", { goalId: r.goalId, sessionId: r.id, data: { missed, lastHeartbeat: last } });
              await safe(() => mgr.transition(r.id, "FAILED", `${missed} missed heartbeats`));
            }
          }
        }
      } finally {
        running = false;
      }
    },
  };
  return sup;
}
