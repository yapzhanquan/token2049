// EventBus: append-only `events` table + in-process emitter (spec §5.1).
// Persist first, then notify — a subscriber never sees an event that is not in the DB.
import { and, asc, eq, gt } from "drizzle-orm";
import { events, type DB } from "@bulkhead/db";
import type { BulkheadEvent, EventType } from "@bulkhead/shared";
import type { EventBus } from "./contracts";

/** JSON with bigints as decimal strings (events, handbacks, hashes). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

export function rowToEvent(r: typeof events.$inferSelect): BulkheadEvent {
  return {
    id: r.id,
    at: r.at,
    type: r.type as EventType,
    ...(r.goalId ? { goalId: r.goalId } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    data: JSON.parse(r.dataJson) as Record<string, unknown>,
  };
}

export function createEventBus(db: DB, opts: { now?: () => number } = {}): EventBus {
  const now = opts.now ?? Date.now;
  const subs = new Set<(e: BulkheadEvent) => void>();
  return {
    emit(type, fields) {
      const row = db
        .insert(events)
        .values({ at: now(), type, goalId: fields.goalId ?? null, sessionId: fields.sessionId ?? null, dataJson: toJson(fields.data ?? {}) })
        .returning()
        .get();
      const e = rowToEvent(row);
      for (const fn of [...subs]) {
        try {
          fn(e);
        } catch (err) {
          // A broken subscriber must never break the emitter (or the caller's state change).
          console.error(`[bus] subscriber failed on ${type}:`, err instanceof Error ? err.message : err);
        }
      }
      return e;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    since(afterId, filter = {}) {
      const conds = [gt(events.id, afterId)];
      if (filter.goalId) conds.push(eq(events.goalId, filter.goalId));
      if (filter.sessionId) conds.push(eq(events.sessionId, filter.sessionId));
      return db.select().from(events).where(and(...conds)).orderBy(asc(events.id)).all().map(rowToEvent);
    },
  };
}
