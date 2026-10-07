// Zero-token wake filter (Firstmate's watcher): classifies every EventBus event in plain code.
//   actionable (isActionable) → coalesce per goal for a short debounce → captain.wake(), serialized
//   routine               → counted and logged as `captain_absorbed` (batched), no LLM call
// Restart-proof: the last handled event id is stored in kv; on start, actionable events missed while the
// engine was down are replayed (coalesced per goal).
import { isActionable, type BulkheadEvent, type EventType } from "@bulkhead/shared";
import { kv, type DB } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import type { Captain, EventBus, SessionManager } from "../contracts";

/** The captain's own bookkeeping events: never classified (that would loop). */
const SELF_EVENTS: readonly EventType[] = ["captain_woken", "captain_absorbed", "captain_action", "captain_report"];
const CURSOR_KEY = "captain:wakeCursor";

export interface WakeFilterOptions {
  /** Coalescing window per goal (ms). */
  debounceMs?: number;
  /** How often absorbed counts are flushed to the events table (ms). */
  absorbFlushMs?: number;
  /** Replay at most this many missed actionable events on start. */
  replayLimit?: number;
}

export class WakeFilter {
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, { events: BulkheadEvent[]; timer: NodeJS.Timeout | null }>();
  private absorbed = new Map<string, { goalId?: string; byType: Record<string, number>; count: number; lastEventId: number }>();
  private absorbTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private inflight = 0;
  private maxSeen = 0;
  readonly stats = { woken: 0, absorbed: 0 };
  private readonly debounceMs: number;
  private readonly absorbFlushMs: number;
  private readonly replayLimit: number;

  constructor(
    private readonly deps: { bus: EventBus; captain: Captain; db: DB; sessions?: SessionManager },
    opts: WakeFilterOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.absorbFlushMs = opts.absorbFlushMs ?? 2_000;
    this.replayLimit = opts.replayLimit ?? 50;
  }

  start({ replay = true }: { replay?: boolean } = {}): void {
    if (this.unsubscribe) return;
    if (replay) this.replayMissed();
    this.unsubscribe = this.deps.bus.subscribe((e) => this.onEvent(e));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.idle();
    this.flushAbsorbed();
  }

  /** Classify one event. Pure code — never calls the LLM itself. */
  onEvent(e: BulkheadEvent): void {
    if (SELF_EVENTS.includes(e.type)) return;
    this.maxSeen = Math.max(this.maxSeen, e.id);
    if (isActionable(e)) this.enqueue(e);
    else this.absorb(e);
  }

  /** Fire all pending (debounced) wakes now and wait until every wake has finished. */
  async idle(): Promise<void> {
    for (const key of [...this.pending.keys()]) this.fire(key);
    while (this.inflight > 0 || this.pending.size > 0) {
      await this.chain;
      for (const key of [...this.pending.keys()]) this.fire(key);
    }
  }

  /** Write the batched absorbed counts as `captain_absorbed` events. */
  flushAbsorbed(): void {
    if (this.absorbTimer) clearTimeout(this.absorbTimer);
    this.absorbTimer = null;
    const batches = [...this.absorbed.values()];
    this.absorbed.clear();
    for (const b of batches) {
      this.deps.bus.emit("captain_absorbed", { goalId: b.goalId, data: { count: b.count, byType: b.byType, lastEventId: b.lastEventId } });
    }
    const last = Math.max(0, ...batches.map((b) => b.lastEventId));
    if (last && !this.pending.size && !this.inflight) this.setCursor(last);
  }

  private goalOf(e: BulkheadEvent): string | undefined {
    return e.goalId ?? (e.sessionId ? this.deps.sessions?.get(e.sessionId)?.goalId : undefined);
  }

  private goalKey(e: BulkheadEvent): string {
    return this.goalOf(e) ?? (e.sessionId ? `session:${e.sessionId}` : `user:${String(e.data.userId ?? "global")}`);
  }

  private absorb(e: BulkheadEvent) {
    this.stats.absorbed++;
    const key = this.goalKey(e);
    const b = this.absorbed.get(key) ?? { goalId: this.goalOf(e), byType: {}, count: 0, lastEventId: 0 };
    b.count++;
    b.byType[e.type] = (b.byType[e.type] ?? 0) + 1;
    b.lastEventId = Math.max(b.lastEventId, e.id);
    this.absorbed.set(key, b);
    if (!this.absorbTimer) {
      this.absorbTimer = setTimeout(() => this.flushAbsorbed(), this.absorbFlushMs);
      this.absorbTimer.unref?.();
    }
  }

  private enqueue(e: BulkheadEvent) {
    const key = this.goalKey(e);
    const p = this.pending.get(key) ?? { events: [], timer: null };
    p.events.push(e);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.fire(key), this.debounceMs);
    p.timer.unref?.();
    this.pending.set(key, p);
  }

  private fire(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(key);
    // user messages and decisions take priority as the primary trigger; the rest ride along.
    const prio: EventType[] = ["user_message", "decision_opened", "payment_rejected", "handback_submitted"];
    const sorted = [...p.events].sort((a, b) => {
      const pa = prio.indexOf(a.type), pb = prio.indexOf(b.type);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.id - b.id;
    });
    const [trigger, ...rest] = sorted;
    this.inflight++;
    // Serialized: wakes never overlap (one captain, one turn at a time).
    this.chain = this.chain.then(async () => {
      try {
        this.stats.woken++;
        this.deps.bus.emit("captain_woken", {
          goalId: trigger.goalId,
          sessionId: trigger.sessionId,
          data: { trigger: trigger.type, triggerEventId: trigger.id, coalesced: rest.map((e) => ({ id: e.id, type: e.type })) },
        });
        await this.deps.captain.wake(trigger, rest);
      } catch (err) {
        this.deps.bus.emit("error", { goalId: trigger.goalId, data: { where: "captain.wake", message: (err as Error).message } });
      } finally {
        this.inflight--;
        // Only advance the cursor when nothing older is still waiting (crash-safe replay).
        try {
          if (!this.pending.size && !this.inflight) this.setCursor(Math.max(this.maxSeen, ...p.events.map((e) => e.id)));
        } catch {
          /* DB closed during shutdown: the next boot simply replays this wake */
        }
      }
    });
  }

  private replayMissed() {
    const cursor = Number(this.deps.db.select().from(kv).where(eq(kv.key, CURSOR_KEY)).get()?.value ?? NaN);
    if (Number.isNaN(cursor)) {
      // First boot: start from "now" — history is not re-litigated.
      const all = this.deps.bus.since(0);
      this.setCursor(all.length ? all[all.length - 1].id : 0);
      return;
    }
    const missed = this.deps.bus
      .since(cursor)
      .filter((e) => !SELF_EVENTS.includes(e.type) && isActionable(e))
      .slice(-this.replayLimit);
    for (const e of missed) this.enqueue(e);
  }

  private setCursor(id: number) {
    const cur = Number(this.deps.db.select().from(kv).where(eq(kv.key, CURSOR_KEY)).get()?.value ?? 0);
    if (id <= cur) return;
    this.deps.db.insert(kv).values({ key: CURSOR_KEY, value: String(id) }).onConflictDoUpdate({ target: kv.key, set: { value: String(id) } }).run();
  }
}
