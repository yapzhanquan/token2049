// Decision ledger (spec v2 §4). Every escalation = exactly one OPEN row per (sessionId, kind, refKey),
// enforced by the unique `open_key` index. Answering closes it, applies the effect, relays it to the silo.
import { and, desc, eq } from "drizzle-orm";
import { decisions, type DB } from "@bulkhead/db";
import type { Decision, DecisionKind, DecisionStatus } from "@bulkhead/shared";
import type { DecisionLedger, EventBus, Signer, SiloRunner } from "./contracts";
import { getSessionDb, newId } from "./sessions-store";
import { toJson } from "./bus";

/** Mandate-widening effects the ledger applies (implemented by the runtime SessionManager). */
export interface DecisionEffects {
  signer: Signer;
  raiseBudget(sessionId: string, addMicro: bigint, decisionId: string): Promise<void>;
  extendExpiry(sessionId: string, newExpiresAt: number, decisionId: string): Promise<void>;
  widenMandate(sessionId: string, changes: Record<string, unknown>, decisionId: string): Promise<void>;
  releaseQuarantine(sessionId: string, approved: boolean, decisionId: string): Promise<void>;
  silos: SiloRunner;
}

export interface RuntimeDecisionLedger extends DecisionLedger {
  /** Late-bind the effect handlers (they depend on the ledger themselves). */
  bind(effects: DecisionEffects): void;
  get(decisionId: string): Decision | null;
  /** Mark every open decision of a session expired (session ended). Relays nothing: the silo is gone. */
  expireForSession(sessionId: string, reason: string): void;
}

type Row = typeof decisions.$inferSelect;
const toDecision = (r: Row): Decision => ({
  id: r.id,
  sessionId: r.sessionId,
  kind: r.kind as DecisionKind,
  requestedBy: r.requestedBy as Decision["requestedBy"],
  refKey: r.refKey,
  details: JSON.parse(r.detailsJson),
  status: r.status as DecisionStatus,
  ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
  ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
  createdAt: r.createdAt,
});

export function createDecisionLedger(db: DB, bus: EventBus, opts: { now?: () => number } = {}): RuntimeDecisionLedger {
  const now = opts.now ?? Date.now;
  let effects: DecisionEffects | null = null;
  const goalOf = (sessionId: string) => getSessionDb(db, sessionId)?.goalId;

  const get = (id: string) => {
    const r = db.select().from(decisions).where(eq(decisions.id, id)).get();
    return r ? toDecision(r) : null;
  };

  const ledger: RuntimeDecisionLedger = {
    bind(e) {
      effects = e;
    },
    get,
    open({ sessionId, kind, requestedBy, refKey, details }) {
      const openKey = `${sessionId}:${kind}:${refKey}`;
      const existing = db.select().from(decisions).where(eq(decisions.openKey, openKey)).get();
      if (existing) return toDecision(existing); // no duplicates for the same request
      const id = newId("dec");
      try {
        db.insert(decisions)
          .values({ id, sessionId, kind, requestedBy, refKey, detailsJson: toJson(details), status: "open", openKey, createdAt: now() })
          .run();
      } catch (err) {
        // Unique index race: someone opened it first → return theirs.
        const again = db.select().from(decisions).where(eq(decisions.openKey, openKey)).get();
        if (again) return toDecision(again);
        throw err;
      }
      const d = get(id)!;
      bus.emit("decision_opened", { goalId: goalOf(sessionId), sessionId, data: { decisionId: id, kind, requestedBy, refKey, details } });
      return d;
    },
    async decide(decisionId, status, decidedBy, note) {
      const row = db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
      if (!row) throw new Error(`decision ${decisionId} not found`);
      if (row.status !== "open") return toDecision(row); // already answered: idempotent
      // Close first (frees the open_key), then apply the effect, then relay to the session.
      const changed = db
        .update(decisions)
        .set({ status, decidedBy, decidedAt: now(), openKey: null })
        .where(and(eq(decisions.id, decisionId), eq(decisions.status, "open")))
        .run();
      if (changed.changes === 0) return get(decisionId)!; // lost a race with another answer
      const d = get(decisionId)!;
      const sessionId = d.sessionId;
      const goalId = goalOf(sessionId);
      bus.emit("decision_closed", { goalId, sessionId, data: { decisionId, kind: d.kind, status, decidedBy, note: note ?? null } });
      const approved = status === "approved";
      let effectError: string | null = null;
      if (effects) {
        try {
          switch (d.kind) {
            case "payment_approval":
              await effects.signer.resolveApproval(String(d.details.paymentId ?? d.refKey), approved);
              break;
            case "budget_raise":
              if (approved) await effects.raiseBudget(sessionId, BigInt(String(d.details.addMicro)), decisionId);
              break;
            case "extend_expiry":
              if (approved) await effects.extendExpiry(sessionId, Number(d.details.newExpiresAt), decisionId);
              break;
            case "widen_mandate":
              if (approved) await effects.widenMandate(sessionId, d.details, decisionId);
              break;
            case "quarantine_release":
              await effects.releaseQuarantine(sessionId, approved, decisionId);
              break;
          }
        } catch (err) {
          effectError = err instanceof Error ? err.message : String(err);
          bus.emit("error", { goalId, sessionId, data: { kind: "decision_effect_failed", decisionId, error: effectError } });
        }
        if (effects.silos.isAlive(sessionId)) {
          effects.silos.send(sessionId, { type: "decision", decisionId, kind: d.kind, status, ...(note || effectError ? { note: effectError ? `${note ?? ""} (effect failed: ${effectError})`.trim() : note } : {}) });
        }
      }
      return d;
    },
    list(filter = {}) {
      const conds = [];
      if (filter.status) conds.push(eq(decisions.status, filter.status));
      if (filter.sessionId) conds.push(eq(decisions.sessionId, filter.sessionId));
      return db
        .select()
        .from(decisions)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(decisions.createdAt))
        .all()
        .map(toDecision);
    },
    expireForSession(sessionId, reason) {
      const open = db.select().from(decisions).where(and(eq(decisions.sessionId, sessionId), eq(decisions.status, "open"))).all();
      for (const r of open) {
        db.update(decisions).set({ status: "expired", decidedBy: "system", decidedAt: now(), openKey: null }).where(eq(decisions.id, r.id)).run();
        bus.emit("decision_closed", { goalId: goalOf(sessionId), sessionId, data: { decisionId: r.id, kind: r.kind, status: "expired", decidedBy: "system", note: reason } });
      }
    },
  };
  return ledger;
}
