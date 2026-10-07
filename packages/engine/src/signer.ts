// Signer + policy engine (spec §5.4). The ONLY component that asks TxService to sign a session payment.
// Order of checks: RUNNING → valid amount → payee allowlist → per-payment max → budget → approval threshold
// (tainted sessions: every payment needs approval) → build/evaluate/sign/submit (TxService) → record.
// Approval threshold: amounts AT or UNDER it run automatically; only amounts ABOVE it open a payment_approval
// decision. (Refines spec §5.4 step 4 "under the threshold" to "at or under", so a plan whose threshold equals
// its per-payment max never needs clicks for in-policy payments.)
// walletMode "vault": the same pre-checks give fast feedback, but the CHAIN is the final authority: the tx is a
// Session Vault `Pay`, and a validator failure becomes payment_rejected { reason: "rejected_onchain" }.
import { and, eq, inArray } from "drizzle-orm";
import { payments, sessions, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { microToTusd, type PayDecision, type RejectionReason } from "@bulkhead/shared";
import type { EventBus, Signer } from "./contracts";
import type { RuntimeDecisionLedger } from "./decisions";
import { getSessionDb, keyedMutex, newId, toSessionRow, type RuntimeConfig } from "./sessions-store";
import { isScriptFailure, requireVault } from "./vault";

type PaymentRow = typeof payments.$inferSelect;

export interface RuntimeSigner extends Signer {
  /** Resolves when a payment that needed approval is finally submitted or rejected. */
  awaitResolution(paymentId: string): Promise<PayDecision>;
  /** Session ended: reject every payment still waiting for approval. */
  cancelPending(sessionId: string, reason: string): void;
  /** Re-attach confirmation tracking for submitted payments (boot reconcile). */
  trackPending(sessionId?: string): Promise<void>;
  getPayment(paymentId: string): PaymentRow | null;
  /** Narrow budget (spec §5.8): send excess from the session wallet back to the OWNER treasury only. */
  returnToTreasury(sessionId: string, treasuryAddress: string, amountMicro: bigint, memo: string): Promise<{ txHash: string }>;
}

export function createSigner(deps: { db: DB; bus: EventBus; chain: Chain; decisions: RuntimeDecisionLedger; config: Pick<RuntimeConfig, "now"> }): RuntimeSigner {
  const { db, bus, chain, decisions } = deps;
  const now = deps.config.now;
  const lock = keyedMutex();
  const waiters = new Map<string, ((d: PayDecision) => void)[]>();
  const tracked = new Set<string>();

  const getPayment = (id: string) => db.select().from(payments).where(eq(payments.id, id)).get() ?? null;
  const setPayment = (id: string, patch: Partial<PaymentRow>) => db.update(payments).set({ ...patch, updatedAt: now() }).where(eq(payments.id, id)).run();
  const settle = (paymentId: string, d: PayDecision) => {
    const ws = waiters.get(paymentId) ?? [];
    waiters.delete(paymentId);
    for (const w of ws) w(d);
    return d;
  };

  const reject = (sessionId: string, goalId: string | undefined, paymentId: string, reason: RejectionReason, detail: string, payee: string, amountMicro: bigint): PayDecision => {
    setPayment(paymentId, { status: "rejected", rejectionReason: reason });
    bus.emit("payment_rejected", { goalId, sessionId, data: { paymentId, reason, detail, payee, amountMicro: amountMicro.toString(), amountTUSD: amountMicro > 0n ? microToTusd(amountMicro) : String(amountMicro) } });
    return settle(paymentId, { kind: "rejected", paymentId, reason, detail });
  };

  /** Spend that counts against the budget: everything submitted/confirmed (spentMicro). */
  const policyCheck = (sessionId: string, payee: string, amountMicro: bigint): { reason: RejectionReason; detail: string } | { address: string } => {
    const raw = getSessionDb(db, sessionId);
    if (!raw) return { reason: "session_not_running", detail: "session not found" };
    const s = toSessionRow(raw);
    // 1. RUNNING (not PAUSED / QUARANTINED / closing)
    if (s.status !== "RUNNING") return { reason: "session_not_running", detail: `session is ${s.status}` };
    if (s.expiresAt <= now()) return { reason: "session_not_running", detail: "session expired" };
    if (amountMicro <= 0n) return { reason: "invalid_amount", detail: "amount must be > 0" };
    // 2. payee allowlist (by catalog id or address)
    const p = s.allowedPayees.find((x) => x.address === payee || x.id === payee);
    if (!p) return { reason: "payee_not_allowed", detail: "payee not on allowlist" };
    // 3. per-payment max, then budget
    if (amountMicro > s.perPaymentMaxMicro) return { reason: "over_per_payment_max", detail: `${microToTusd(amountMicro)} tUSD > per-payment max ${microToTusd(s.perPaymentMaxMicro)} tUSD` };
    if (s.spentMicro + amountMicro > s.budgetMicro) return { reason: "over_budget", detail: `spent ${microToTusd(s.spentMicro)} + ${microToTusd(amountMicro)} > budget ${microToTusd(s.budgetMicro)} tUSD` };
    return { address: p.address };
  };

  const execute = async (paymentId: string): Promise<PayDecision> => {
    const pay = getPayment(paymentId)!;
    const sessionId = pay.sessionId;
    const raw = getSessionDb(db, sessionId)!;
    const goalId = raw.goalId;
    const amountMicro = BigInt(pay.amountMicro);
    // TxService builds → evaluates (preview) → signs with the session key → submits.
    const vault = raw.walletMode === "vault";
    let res;
    try {
      const args = { sessionId, payee: pay.payee, tusdMicro: amountMicro, memo: pay.memo, ...(refOf(paymentId, pay.memo) ? { reference: refOf(paymentId, pay.memo) } : {}) };
      res = vault ? await requireVault(chain).pay(args) : await chain.tx.sessionPay(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const onchain = vault && isScriptFailure(err);
      const reason: RejectionReason = onchain ? "rejected_onchain" : /submit/i.test(msg) || (err as { code?: string })?.code === "SUBMIT_FAILED" ? "submit_failed" : "build_failed";
      setPayment(paymentId, { status: onchain ? "rejected" : "failed", rejectionReason: reason });
      bus.emit("payment_rejected", { goalId, sessionId, data: { paymentId, reason, detail: msg, payee: pay.payee, amountMicro: pay.amountMicro, amountTUSD: microToTusd(amountMicro), ...(onchain ? { enforcedBy: "Bulkhead Session Vault", walletMode: "vault" } : {}) } });
      return settle(paymentId, { kind: "rejected", paymentId, reason, detail: msg });
    }
    setPayment(paymentId, { status: "submitted", txHash: res.txHash, feeLovelace: res.feeLovelace.toString() });
    const fresh = getSessionDb(db, sessionId)!;
    db.update(sessions)
      .set({
        spentMicro: (BigInt(fresh.spentMicro) + amountMicro).toString(),
        feesLovelace: (BigInt(fresh.feesLovelace) + res.feeLovelace).toString(),
        updatedAt: now(),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    bus.emit("payment_submitted", { goalId, sessionId, data: { paymentId, txHash: res.txHash, payee: pay.payee, amountMicro: pay.amountMicro, amountTUSD: microToTusd(amountMicro), feeLovelace: res.feeLovelace.toString(), memo: pay.memo } });
    track(paymentId, res.txHash);
    return settle(paymentId, { kind: "submitted", paymentId, txHash: res.txHash });
  };

  const paymentRef = new Map<string, string>();
  /** Masumi-style payment reference: in memory, or recovered from the memo ("… ref:<id>") after a restart. */
  const refOf = (paymentId: string, memo: string) => paymentRef.get(paymentId) ?? /(?:^|\s)ref:(\S+)/.exec(memo)?.[1];

  const track = (paymentId: string, txHash: string) => {
    if (tracked.has(txHash)) return;
    tracked.add(txHash);
    chain.watcher.watchTx(txHash);
    void chain.provider.fetchTxConfirmation(txHash).then(
      (c) => c && markConfirmed(txHash),
      () => undefined,
    );
  };
  const markConfirmed = (txHash: string) => {
    const p = db.select().from(payments).where(and(eq(payments.txHash, txHash), eq(payments.status, "submitted"))).get();
    if (!p) return;
    setPayment(p.id, { status: "confirmed" });
    tracked.delete(txHash);
    const goalId = getSessionDb(db, p.sessionId)?.goalId;
    bus.emit("payment_confirmed", { goalId, sessionId: p.sessionId, data: { paymentId: p.id, txHash, payee: p.payee, amountMicro: p.amountMicro, amountTUSD: microToTusd(BigInt(p.amountMicro)) } });
  };
  chain.watcher.on((e) => {
    if (e.type === "tx_confirmed" && tracked.has(e.txHash)) markConfirmed(e.txHash);
  });

  const signer: RuntimeSigner = {
    getPayment,
    async returnToTreasury(sessionId, treasuryAddress, amountMicro, memo) {
      return lock(sessionId, async () => {
        const raw = getSessionDb(db, sessionId);
        if (!raw) throw new Error("session not found");
        const owner = db.select({ a: users.treasuryAddress }).from(users).where(eq(users.id, raw.userId)).get();
        if (!owner || owner.a !== treasuryAddress) throw new Error("returnToTreasury: destination must be the owner's treasury");
        if (amountMicro <= 0n) throw new Error("returnToTreasury: amount must be > 0");
        if (raw.walletMode === "vault") throw new Error("returnToTreasury: a Session Vault pays allowlisted payees only; the excess returns to the treasury at close (Revoke)");
        const res = await chain.tx.sessionPay({ sessionId, payee: treasuryAddress, tusdMicro: amountMicro, memo });
        db.update(sessions).set({ feesLovelace: (BigInt(getSessionDb(db, sessionId)!.feesLovelace) + res.feeLovelace).toString(), updatedAt: now() }).where(eq(sessions.id, sessionId)).run();
        return { txHash: res.txHash };
      });
    },
    async pay(sessionId, req) {
      return lock(sessionId, async () => {
        const raw = getSessionDb(db, sessionId);
        const goalId = raw?.goalId;
        const paymentId = newId("pay");
        const amountMicro = req.amountMicro;
        db.insert(payments)
          .values({ id: paymentId, sessionId, payee: req.payee, amountMicro: amountMicro.toString(), memo: req.memo.slice(0, 200), status: "requested", createdAt: now(), updatedAt: now() })
          .run();
        if (req.reference) paymentRef.set(paymentId, req.reference);
        bus.emit("payment_requested", { goalId, sessionId, data: { paymentId, payee: req.payee, amountMicro: amountMicro.toString(), memo: req.memo.slice(0, 200), reference: req.reference ?? null } });
        const check = policyCheck(sessionId, req.payee, amountMicro);
        if ("reason" in check) return reject(sessionId, goalId, paymentId, check.reason, check.detail, req.payee, amountMicro);
        setPayment(paymentId, { payee: check.address });
        // 4. approval threshold (amount AT or UNDER it runs automatically; ABOVE it waits), or a tainted session:
        // payment waits for a decision, state stays RUNNING.
        const s = toSessionRow(getSessionDb(db, sessionId)!);
        if (amountMicro > s.approvalThresholdMicro || s.tainted) {
          setPayment(paymentId, { status: "awaiting_approval" });
          const d = decisions.open({
            sessionId,
            kind: "payment_approval",
            requestedBy: "session",
            refKey: paymentId,
            details: { paymentId, payee: check.address, amountMicro: amountMicro.toString(), amountTUSD: microToTusd(amountMicro), memo: req.memo.slice(0, 200), why: s.tainted ? "session is tainted (read external content)" : `amount above the approval threshold ${microToTusd(s.approvalThresholdMicro)} tUSD` },
          });
          bus.emit("payment_approval_needed", { goalId, sessionId, data: { paymentId, decisionId: d.id, payee: check.address, amountMicro: amountMicro.toString(), amountTUSD: microToTusd(amountMicro), tainted: s.tainted } });
          return { kind: "needs_approval", paymentId };
        }
        setPayment(paymentId, { status: "approved" });
        return execute(paymentId);
      });
    },
    async resolveApproval(paymentId, approved) {
      const pay = getPayment(paymentId);
      if (!pay) throw new Error(`payment ${paymentId} not found`);
      return lock(pay.sessionId, async () => {
        const p = getPayment(paymentId)!;
        const goalId = getSessionDb(db, p.sessionId)?.goalId;
        if (p.status !== "awaiting_approval") {
          if (p.status === "submitted" || p.status === "confirmed") return { kind: "submitted", paymentId, txHash: p.txHash! } as PayDecision;
          return { kind: "rejected", paymentId, reason: (p.rejectionReason as RejectionReason) ?? "approval_rejected", detail: `payment is ${p.status}` } as PayDecision;
        }
        const amountMicro = BigInt(p.amountMicro);
        if (!approved) return reject(p.sessionId, goalId, paymentId, "approval_rejected", "rejected by the user", p.payee, amountMicro);
        // Re-check policy at approval time (session may have been paused, budget may be used up).
        const check = policyCheck(p.sessionId, p.payee, amountMicro);
        if ("reason" in check) return reject(p.sessionId, goalId, paymentId, check.reason, check.detail, p.payee, amountMicro);
        setPayment(paymentId, { status: "approved" });
        bus.emit("payment_approved", { goalId, sessionId: p.sessionId, data: { paymentId, amountMicro: p.amountMicro, amountTUSD: microToTusd(amountMicro), payee: p.payee } });
        return execute(paymentId);
      });
    },
    awaitResolution(paymentId) {
      const p = getPayment(paymentId);
      if (p && p.status !== "awaiting_approval" && p.status !== "approved" && p.status !== "requested") {
        if (p.status === "submitted" || p.status === "confirmed") return Promise.resolve({ kind: "submitted", paymentId, txHash: p.txHash! });
        return Promise.resolve({ kind: "rejected", paymentId, reason: (p.rejectionReason as RejectionReason) ?? "approval_rejected", detail: `payment is ${p.status}` });
      }
      return new Promise((resolve) => {
        const ws = waiters.get(paymentId) ?? [];
        ws.push(resolve);
        waiters.set(paymentId, ws);
      });
    },
    cancelPending(sessionId, reason) {
      const pending = db.select().from(payments).where(and(eq(payments.sessionId, sessionId), inArray(payments.status, ["awaiting_approval", "requested"]))).all();
      const goalId = getSessionDb(db, sessionId)?.goalId;
      for (const p of pending) reject(sessionId, goalId, p.id, "session_not_running", reason, p.payee, BigInt(p.amountMicro));
    },
    async trackPending(sessionId) {
      const conds = [eq(payments.status, "submitted")];
      if (sessionId) conds.push(eq(payments.sessionId, sessionId));
      for (const p of db.select().from(payments).where(and(...conds)).all()) if (p.txHash) track(p.id, p.txHash);
    },
  };
  return signer;
}
