// In-memory fakes: Sokosumi (CLI + Coworker client), Bulkhead engine, payment gate.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApproveResponse, BulkheadEvent, CaptainMessageBody, ControlAction, DecisionDTO, GoalSummary, PlanBody, PlanResponse, SessionDetailDTO, TreeDTO, TreeNode } from "@bulkhead/shared";
import type { EnginePort } from "../src/engine";
import { EngineHttpError } from "../src/engine";
import { RAW_UTF8_SHA256 } from "../src/hash";
import { JournalStore } from "../src/journal";
import { TUSDM_UNIT, type PaymentGate, type SellerIdentity, type TermsRequest } from "../src/payment-gate";
import { ProgressReporter, type GoalEventSource, type ProgressOptions } from "../src/progress";
import type { QuoteConfig } from "../src/quote";
import type { SokosumiPort } from "../src/sokosumi";
import { TaskRunner, type RunnerConfig } from "../src/task-runner";
import type { CoreReceipt, MpsPayment, SokoEvent, SokoTask, StartedTask } from "../src/types";

export const COWORKER = "cw_1";
export const tmpDir = () => mkdtempSync(join(tmpdir(), "soko-worker-"));

export class FakeSoko implements SokosumiPort {
  tasks: SokoTask[] = [];
  events: Record<string, SokoEvent[]> = {};
  calls: { op: string; taskId: string; arg?: unknown }[] = [];
  fail: Partial<Record<string, Error>> = {};
  private n = 0;

  addTask(id: string, description: string, status = "READY") {
    this.tasks.push({ id, status, coworkerId: COWORKER, name: `Task ${id}`, description });
  }
  task(id: string) {
    return this.tasks.find((t) => t.id === id)!;
  }
  userComment(taskId: string, comment: string) {
    (this.events[taskId] ??= []).push({ id: `ev_${++this.n}`, comment, actor: { type: "user", id: "u1" } });
  }
  private check(op: string) {
    const e = this.fail[op];
    if (e) throw e;
  }
  count(op: string, taskId?: string) {
    return this.calls.filter((c) => c.op === op && (!taskId || c.taskId === taskId)).length;
  }
  async listTasks() {
    this.check("list");
    return this.tasks.map((t) => ({ ...t }));
  }
  async startTask(id: string): Promise<StartedTask> {
    this.calls.push({ op: "start", taskId: id });
    this.check("start");
    const t = this.task(id);
    t.status = "RUNNING";
    return { id, name: t.name ?? null, description: t.description ?? null, status: "RUNNING" };
  }
  async completeTask(id: string, resultFile: string) {
    const { readFileSync } = await import("node:fs");
    this.calls.push({ op: "complete", taskId: id, arg: readFileSync(resultFile, "utf8") });
    this.check("complete");
    this.task(id).status = "COMPLETED";
    return { eventId: `done_${id}` };
  }
  async listEvents(id: string) {
    this.check("events");
    return [...(this.events[id] ?? [])];
  }
  private push(taskId: string, ev: Omit<SokoEvent, "id">) {
    const e = { id: `ev_${++this.n}`, actor: { type: "coworker", id: COWORKER }, ...ev };
    (this.events[taskId] ??= []).push(e);
    return { eventId: e.id };
  }
  async postComment(id: string, comment: string) {
    this.calls.push({ op: "comment", taskId: id, arg: comment });
    this.check("comment");
    return this.push(id, { comment });
  }
  async postPaymentEvent(id: string, comment: string, masumiPayment: Record<string, unknown>) {
    this.calls.push({ op: "payment-event", taskId: id, arg: masumiPayment });
    this.check("payment-event");
    return this.push(id, { comment });
  }
  async postCompletionEvent(id: string, result: string) {
    this.calls.push({ op: "complete-event", taskId: id, arg: result });
    this.check("complete-event");
    this.task(id).status = "COMPLETED";
    return this.push(id, { status: "COMPLETED", comment: result });
  }
  receipts: Record<string, CoreReceipt> = {};
  async getReceipt(id: string) {
    return this.receipts[id] ?? null;
  }
}

interface FakeSession {
  id: string;
  goalId: string;
  letter: string;
  role: string;
  status: string;
  budgetMicro: bigint;
  spentMicro: bigint;
  refundMicro: bigint | null;
  closeTx: string | null;
}

export class FakeEngine implements EnginePort {
  users = new Map<string, string>();
  goals: (GoalSummary & { userId: string })[] = [];
  sessions: FakeSession[] = [];
  decisionsList: DecisionDTO[] = [];
  calls: { op: string; arg?: unknown }[] = [];
  fail: Partial<Record<string, Error>> = {};
  /** Session plan per goal: roles and budgets (micro). */
  plan: { role: string; budgetMicro: bigint; name?: string; contextFrom?: number[] }[] = [{ role: "researcher", budgetMicro: 1_000_000n }, { role: "writer", budgetMicro: 1_000_000n }];
  private n = 0;
  private check(op: string) {
    const e = this.fail[op];
    if (e) throw e;
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
  async ensureUser(email: string) {
    this.calls.push({ op: "ensureUser", arg: email });
    if (!this.users.has(email)) this.users.set(email, `u_${this.users.size + 1}`);
    return this.users.get(email)!;
  }
  async createGoal(userId: string, body: PlanBody): Promise<PlanResponse> {
    this.calls.push({ op: "createGoal", arg: body });
    this.check("createGoal");
    const id = `g_${++this.n}`;
    this.goals.push({ id, userId, goal: body.goal, budgetMicro: String(Math.round(Number(body.budgetTUSD) * 1e6)), deadline: Date.parse(body.deadline), rules: body.rules, status: "planned", fundingTx: null, createdAt: Date.now() });
    const sessions = this.plan.map((p) => ({ name: p.name ?? p.role, role: p.role, budgetTUSD: (Number(p.budgetMicro) / 1e6).toString(), contextFrom: p.contextFrom ?? [] }));
    return { goalId: id, plan: { sessions } as never, fundingPreview: { feeLovelace: "0", totalTusd: body.budgetTUSD, totalLovelace: "0" } };
  }
  async listGoals(userId: string) {
    return this.goals.filter((g) => g.userId === userId).map(({ userId: _u, ...g }) => g);
  }
  async approveGoal(_u: string, goalId: string): Promise<ApproveResponse> {
    this.calls.push({ op: "approve", arg: goalId });
    this.check("approve");
    const g = this.goals.find((x) => x.id === goalId)!;
    g.status = "running";
    g.fundingTx = "f".repeat(64);
    this.plan.forEach((p, i) =>
      this.sessions.push({ id: `${goalId}_s${i}`, goalId, letter: String.fromCharCode(65 + i), role: p.role, status: "RUNNING", budgetMicro: p.budgetMicro, spentMicro: 0n, refundMicro: null, closeTx: null }),
    );
    return { ok: true, fundingTx: g.fundingTx, sessionIds: this.sessions.filter((s) => s.goalId === goalId).map((s) => s.id) };
  }
  async tree(_u: string, goalId: string): Promise<TreeDTO> {
    const nodes: TreeNode[] = this.sessions
      .filter((s) => s.goalId === goalId)
      .map((s) => ({
        id: s.id,
        kind: "session",
        parentId: goalId,
        letter: s.letter,
        role: s.role,
        label: s.role,
        status: s.status as never,
        glyph: "dot" as never,
        ghost: s.status === "CLOSED",
        lines: [],
        spentMicro: s.spentMicro.toString(),
        budgetMicro: s.budgetMicro.toString(),
        ...(s.refundMicro !== null ? { refundMicro: s.refundMicro.toString() } : {}),
        ...(s.closeTx ? { closeTx: s.closeTx } : {}),
      }));
    return { goalId, nodes: [{ id: goalId, kind: "goal", parentId: null, label: "goal", glyph: "dot" as never, ghost: false, lines: [] }, ...nodes], edges: [] };
  }
  async session(_u: string, id: string): Promise<SessionDetailDTO> {
    const s = this.sessions.find((x) => x.id === id)!;
    return {
      id,
      goalId: s.goalId,
      letter: s.letter,
      role: s.role,
      status: s.status,
      endReason: null,
      wallet: { address: "addr_test1x", spentMicro: s.spentMicro.toString(), budgetMicro: s.budgetMicro.toString(), feesLovelace: "200000", fundingTx: null },
      handback: { result: `Result from ${s.role}`, summary: `${s.role} done`, sources: [], flags: [], txHashes: s.spentMicro > 0n ? ["a".repeat(64)] : [] },
      close: { refundMicro: s.refundMicro?.toString() ?? null, closeTx: s.closeTx, logSha256: null, handbackSha256: null },
    } as unknown as SessionDetailDTO;
  }
  async decisions(_u: string, status?: "open") {
    return this.decisionsList.filter((d) => !status || d.status === status);
  }
  async decide(_u: string, id: string, status: "approved" | "rejected") {
    this.calls.push({ op: "decide", arg: { id, status } });
    this.check("decide");
    const d = this.decisionsList.find((x) => x.id === id)!;
    d.status = status;
    return d;
  }
  async control(_u: string, sessionId: string, action: ControlAction) {
    this.calls.push({ op: "control", arg: { sessionId, action } });
    this.check("control");
    const s = this.sessions.find((x) => x.id === sessionId)!;
    if (action === "pause") s.status = "PAUSED";
    if (action === "resume") s.status = "RUNNING";
    return { ok: true };
  }
  async captainMessage(_u: string, body: CaptainMessageBody) {
    this.calls.push({ op: "captain", arg: body });
    this.check("captain");
    return { ok: true };
  }
  async activity() {
    return [{ id: "ev:1", at: 1, kind: "payment" as const, title: "pay", letter: "A", txHash: "b".repeat(64), direction: "out" as const }];
  }
  /** Close every session of a goal: spend some, refund the rest. */
  closeAll(goalId: string, spentMicro = 300_000n) {
    let i = 0;
    for (const s of this.sessions.filter((x) => x.goalId === goalId)) {
      s.status = "CLOSED";
      s.spentMicro = spentMicro;
      s.refundMicro = s.budgetMicro - spentMicro;
      s.closeTx = String(i++).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "c");
    }
    const g = this.goals.find((x) => x.id === goalId)!;
    g.status = "done";
  }
  openDecision(goalId: string, sessionLetter: string, kind: DecisionDTO["kind"], details: Record<string, unknown>) {
    const s = this.sessions.find((x) => x.goalId === goalId && x.letter === sessionLetter)!;
    const d = { id: `d_${++this.n}`, sessionId: s.id, kind, requestedBy: "session", refKey: `r${this.n}`, details, status: "open", createdAt: Date.now(), goalId, letter: s.letter, role: s.role } as DecisionDTO;
    this.decisionsList.push(d);
    return d;
  }
}

export const SELLER: SellerIdentity = { agentIdentifier: "a".repeat(80), supportedPaymentSourceIndex: 0, sellerWalletId: "seller-wallet", sellerAddress: "addr_test1seller" };

export class FakeGate implements PaymentGate {
  ready = true;
  payments = new Map<string, MpsPayment>();
  calls: { op: string; arg?: unknown }[] = [];
  /** Mutate the next signed terms (e.g. to add a forceLayer). */
  tamper?: (p: MpsPayment) => void;
  /** Next requestTerms throws this (after creating the payment when `applied`). */
  failNext?: { error: Error; applied: boolean };
  readiness() {
    return this.ready ? { ready: true } : { ready: false, reason: "test: off" };
  }
  seller() {
    return SELLER;
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
  async requestTerms(r: TermsRequest): Promise<MpsPayment> {
    this.calls.push({ op: "terms", arg: r });
    const fail = this.failNext;
    this.failNext = undefined;
    if (fail && !fail.applied) throw fail.error;
    const bi = `bi_${this.payments.size + 1}`;
    const p: MpsPayment = {
      blockchainIdentifier: bi,
      agentIdentifier: SELLER.agentIdentifier,
      onChainState: null,
      resultHash: null,
      inputHash: r.inputHash,
      payByTime: String(r.payByTime.getTime()),
      submitResultTime: String(r.submitResultTime.getTime()),
      unlockTime: String(r.unlockTime.getTime()),
      externalDisputeUnlockTime: String(r.externalDisputeUnlockTime.getTime()),
      sellerReturnAddress: null,
      forceLayer: null,
      RequestedFunds: [{ amount: r.amountAtomic, unit: TUSDM_UNIT }],
      PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: "addr_test1contract", policyId: "p".repeat(56) },
      SmartContractWallet: { id: SELLER.sellerWalletId, walletVkey: "v".repeat(56), walletAddress: SELLER.sellerAddress },
      CurrentTransaction: null,
      TransactionHistory: [],
      metadata: r.metadata,
    };
    this.tamper?.(p);
    this.payments.set(bi, p);
    if (fail) throw fail.error;
    return structuredClone(p);
  }
  async findPayments(inputHash: string) {
    this.calls.push({ op: "find", arg: inputHash });
    return [...this.payments.values()].filter((p) => p.inputHash === inputHash).map((p) => structuredClone(p));
  }
  async resolve(bi: string) {
    this.calls.push({ op: "resolve", arg: bi });
    return structuredClone(this.payments.get(bi)!);
  }
  async submitResult(bi: string, hash: string) {
    this.calls.push({ op: "submit", arg: { bi, hash } });
    const p = this.payments.get(bi)!;
    p.resultHash = hash;
    return structuredClone(p);
  }
  /** Simulate chain progress. */
  lockFunds(bi: string, confirmed = true) {
    const p = this.payments.get(bi)!;
    p.onChainState = "FundsLocked";
    p.CurrentTransaction = { status: confirmed ? "Confirmed" : "Pending", newOnChainState: "FundsLocked", txHash: "1".repeat(64) };
  }
  confirmResult(bi: string) {
    const p = this.payments.get(bi)!;
    p.onChainState = "ResultSubmitted";
    p.TransactionHistory = [...(p.TransactionHistory ?? []), p.CurrentTransaction!];
    p.CurrentTransaction = { status: "Confirmed", newOnChainState: "ResultSubmitted", txHash: "2".repeat(64) };
  }
  withdraw(bi: string, txHash: string) {
    const p = this.payments.get(bi)!;
    p.onChainState = "Withdrawn";
    p.TransactionHistory = [...(p.TransactionHistory ?? []), p.CurrentTransaction!];
    p.CurrentTransaction = { status: "Confirmed", newOnChainState: "Withdrawn", txHash };
  }
}

export const QUOTE_CFG: QuoteConfig = {
  feeMicro: 500_000n,
  maxQuoteMicro: 20_000_000n,
  defaultBudgetMicro: 2_000_000n,
  defaultDeadlineMs: 120 * 60_000,
  minDeadlineMs: 15 * 60_000,
  maxDeadlineMs: 168 * 3_600_000,
};
export const RUNNER_CFG: RunnerConfig = { quote: QUOTE_CFG, goalRules: "test rules", payByMs: 5 * 60_000, resultMarginMs: 20 * 60_000, askTimeoutMs: 10 * 60_000, commentWindowMs: 72 * 3_600_000 };

/** Engine goal events (what GET /events/stream replays), in id order. */
export class FakeGoalEvents implements GoalEventSource {
  list: BulkheadEvent[] = [];
  fail?: Error;
  reads = 0;
  private n = 0;
  push(goalId: string, type: BulkheadEvent["type"], data: Record<string, unknown> = {}, sessionId?: string) {
    const e: BulkheadEvent = { id: ++this.n, at: Date.now(), type, goalId, ...(sessionId ? { sessionId } : {}), data };
    this.list.push(e);
    return e;
  }
  async since(_u: string, goalId: string, after: number) {
    this.reads++;
    if (this.fail) throw this.fail;
    return this.list.filter((e) => e.goalId === goalId && e.id > after).map((e) => structuredClone(e));
  }
}

export interface Rig {
  dir: string;
  soko: FakeSoko;
  engine: FakeEngine;
  gate: FakeGate;
  store: JournalStore;
  clock: { t: number };
  runner: () => TaskRunner;
  logs: string[];
  /** What the Blockfrost fetcher returns (null = not determinable). */
  utxos: import("../src/settlement").TxUtxos | null;
  events: FakeGoalEvents;
}

/** A fresh runner over shared state; call `rig.runner()` again to simulate a process restart. */
export function makeRig(opts: { paid?: boolean; dir?: string; progress?: boolean | ProgressOptions; cfg?: Partial<RunnerConfig> } = {}): Rig {
  const dir = opts.dir ?? tmpDir();
  const soko = new FakeSoko();
  const engine = new FakeEngine();
  const gate = new FakeGate();
  gate.ready = !!opts.paid;
  const clock = { t: Date.parse("2026-10-07T10:00:00Z") };
  const logs: string[] = [];
  const events = new FakeGoalEvents();
  const engineUserId = async () => engine.ensureUser("sokosumi-coworker@bulkhead.local");
  const progress = () =>
    opts.progress
      ? new ProgressReporter({ soko, events, engine, engineUserId, save: (j) => new JournalStore(dir).save(j), now: () => clock.t, log: (m) => logs.push(m), ...(typeof opts.progress === "object" ? opts.progress : {}) })
      : undefined;
  const rig: Rig = {
    events,
    dir,
    soko,
    engine,
    gate,
    store: new JournalStore(dir),
    clock,
    logs,
    utxos: null,
    runner: () =>
      new TaskRunner({
        soko,
        engine,
        gate,
        store: new JournalStore(dir),
        cfg: { ...RUNNER_CFG, ...opts.cfg },
        hashRule: RAW_UTF8_SHA256,
        fetchUtxos: async () => rig.utxos,
        engineUserId,
        now: () => clock.t,
        log: (m) => logs.push(m),
        progress: progress(),
      }),
  };
  return rig;
}

export const engineError = (status: number, msg = "bad") => new EngineHttpError(status, msg);
