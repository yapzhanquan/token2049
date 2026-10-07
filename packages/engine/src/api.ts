// Engine HTTP API (Hono) — every route in ENGINE_ROUTES (@bulkhead/shared). Request bodies and response
// shapes are the DTOs in @bulkhead/shared (src/api.ts): the web app and its fixture engine use the same.
// Auth: `x-engine-token` (shared secret with the web app) + `x-user-id` (acting user). Everything is
// scoped to that user. Money-moving routes only ever go through SessionManager / DecisionLedger /
// OnRamp / the self-custody SigningBroker; nothing here signs.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { agentJobs, goals, messages, payments, sessions as sessionsT, topups, users } from "@bulkhead/db";
import { tusdTokenFromUnit } from "@bulkhead/chain";
import {
  DEFINITION_OF_DONE,
  ENDING_STATUSES,
  NETWORK,
  PREPROD_FAUCET_URL,
  PlanSchema,
  glyphFor,
  microToTusd,
  tusdToMicro,
  type AgentCardDTO,
  type AgentMapDTO,
  type ApiErrorBody,
  type ApproveOk,
  type BulkheadEvent,
  type CaptainLogDTO,
  type CaptainLogEntry,
  type ContextIn,
  type ControlOk,
  type CreateUserResponse,
  type Decision,
  type DecisionDTO,
  type EventType,
  type GoalSummary,
  type Handback,
  type HealthDTO,
  type LogbookEntryDTO,
  type MeDTO,
  type TusdTokenDTO,
  type MessageResponse,
  type NeedsSignatureResponse,
  type PauseAllResponse,
  type PaymentDecisionResponse,
  type PayeeDTO,
  type PeekLine,
  type PendingPaymentDTO,
  type PendingSignatureDTO,
  type SessionDetailDTO,
  type SessionStatus,
  type SpendingDTO,
  type TaskType,
  type TopupConfirmResponse,
  type TopupDTO,
  type TopupStartResponse,
} from "@bulkhead/shared";
import type { Engine } from "./contracts";
import { SIMULATION_LABEL, type OnRamp } from "./onramp";
import type { SigningBroker } from "./self-custody";
import { toJsonSafe } from "./captain/tools";
import { createStakingRoutes } from "./api-staking";
import { createWalletRoutes } from "./api-wallet";
import { createActivityRoutes } from "./api-activity";

/** The parts of the runtime OnRamp the API uses. */
export type TopupService = Pick<OnRamp, "start" | "confirm" | "quote">;

export interface ApiDeps {
  engine: Engine;
  onramp?: TopupService;
  /** Self-custody signing broker (wireEngine().signing). Without it self-custody funding is refused. */
  signing?: SigningBroker;
  /** ENGINE_TOKEN. When unset, auth is skipped (local dev only; a warning is printed at boot). */
  token?: string;
  myrPerTusd: string;
  topupFeePct?: string;
  /** Captain card info for the Agent Map. */
  captainInfo: () => { name: string; model: string; contextTokens: number; totalTokens: number };
  /** Overrides the chain label in /health (e.g. "fake" for the offline FakeChain demo). */
  chainLabel?: string;
  /** Live wake-filter counters (in-memory; the event log has the durable counts). */
  wakeStats?: () => { woken: number; absorbed: number };
}

type Vars = { Variables: { userId: string } };
type Body = Record<string, unknown>;

const RUNNING_GROUP: SessionStatus[] = ["RUNNING", "FUNDING", "COMPLETING"];
const CLOSED_GROUP: SessionStatus[] = ["CLOSING", "CLOSED", ...ENDING_STATUSES];
const PEEK: EventType[] = ["progress", "session_message", "mandate_change_ignored", "tool_denied", "web_fetch", "payment_rejected", "error"];

export function createApi(deps: ApiDeps) {
  const { engine, signing } = deps;
  const { db, bus, sessions, decisions, captain, chain, market } = engine;
  const app = new Hono<Vars>();
  const json = <T>(c: Context, v: T, status = 200) => c.json(toJsonSafe(v) as object, status as 200);

  app.onError((err, c) => {
    const e = err as Error & { status?: number; code?: string };
    if (e.code === "insufficient_funds") {
      const body: ApiErrorBody = { error: e.message, code: e.code, faucetUrl: PREPROD_FAUCET_URL };
      return c.json(body, 409);
    }
    const body: ApiErrorBody = { error: e.message, ...(e.code ? { code: e.code } : {}) };
    return c.json(body, (e.status ?? 400) as 400);
  });

  app.get("/health", (c) => {
    const h: HealthDTO = { ok: true, network: NETWORK, llm: engine.llm.name, chain: deps.chainLabel ?? chain.provider.name, simulatedChain: deps.chainLabel === "fake", at: Date.now() };
    return c.json(h);
  });

  app.route("/", createWalletRoutes({ db, chain, decisions, token: deps.token })); // wallet identity (api-wallet.ts): own token check, before auth
  // ── auth ──
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (deps.token) {
      const got = Buffer.from(c.req.header("x-engine-token") ?? "");
      const want = Buffer.from(deps.token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
    }
    if (c.req.method === "POST" && c.req.path === "/users") return next();
    const userId = c.req.header("x-user-id");
    if (!userId) return c.json({ error: "x-user-id required" }, 401);
    if (!db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) return c.json({ error: "unknown user" }, 401);
    c.set("userId", userId);
    return next();
  });

  // ── helpers ──
  const userRow = (userId: string) => db.select().from(users).where(eq(users.id, userId)).get()!;
  const userGoalIds = (userId: string) => new Set(db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId)).all().map((g) => g.id));
  const userSessionIds = (userId: string) => new Set(db.select({ id: sessionsT.id }).from(sessionsT).where(eq(sessionsT.userId, userId)).all().map((s) => s.id));
  const ownGoal = (userId: string, goalId: string) => {
    const g = db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!g || g.userId !== userId) throw httpError(404, "goal not found");
    return g;
  };
  const ownSession = (userId: string, sessionId: string) => {
    const r = sessions.get(sessionId);
    if (!r || r.userId !== userId) throw httpError(404, "session not found");
    return r;
  };
  const visibleTo = (userId: string) => {
    let goalIds = userGoalIds(userId);
    let sessionIds = userSessionIds(userId);
    let refreshedAt = Date.now();
    return (e: BulkheadEvent) => {
      if (Date.now() - refreshedAt > 2_000 && ((e.goalId && !goalIds.has(e.goalId)) || (e.sessionId && !sessionIds.has(e.sessionId)))) {
        goalIds = userGoalIds(userId);
        sessionIds = userSessionIds(userId);
        refreshedAt = Date.now();
      }
      if (e.data?.userId !== undefined) return e.data.userId === userId;
      return (!!e.goalId && goalIds.has(e.goalId)) || (!!e.sessionId && sessionIds.has(e.sessionId));
    };
  };
  const readBody = async (c: Context): Promise<Body> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
    } catch {
      return {};
    }
  };
  const balance = async (address: string): Promise<{ tusdMicro: bigint; lovelace: bigint; legacyTusdMicro?: bigint } | { error: string }> => {
    try {
      const b = await chain.tx.balanceOf(address);
      return { tusdMicro: b.tusdMicro, lovelace: b.lovelace, ...(b.legacyTusdMicro ? { legacyTusdMicro: b.legacyTusdMicro } : {}) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  /** tUSD token facts for /me (CIP-68 333 unit + CIP-14 fingerprint); omitted when the unit is not resolvable. */
  const tusdTokenField = (): { tusdToken?: TusdTokenDTO } => {
    try {
      return { tusdToken: tusdTokenFromUnit(chain.tx.tusdUnit()) };
    } catch {
      return {};
    }
  };
  const openDecisionCount = (userId: string) => {
    const sids = userSessionIds(userId);
    return decisions.list({ status: "open" }).filter((d) => sids.has(d.sessionId)).length;
  };

  // ── self-custody signing ──
  const needsSig = (p: PendingSignatureDTO): NeedsSignatureResponse => ({
    ok: false,
    needsSignature: true,
    pendingId: p.pendingId,
    unsignedTx: p.unsignedTx,
    txHash: p.txHash,
    purpose: p.purpose,
    feeLovelace: p.feeLovelace,
    expiresAt: p.expiresAt,
  });
  /**
   * Run a possibly treasury-spending action. Self-custody: if it reaches a funding tx, answer
   * needsSignature; the browser POSTs again with { pendingId, signedTx }, we submit and answer the
   * action's normal result. `state` rebuilds that result when the continuation is gone (engine restart).
   */
  const signable = async <T>(
    c: Context<Vars>,
    b: Body,
    tag: { goalId?: string; sessionId?: string; purpose?: string },
    action: () => Promise<T>,
    respond: (v: T) => unknown,
    state: () => unknown,
  ) => {
    const userId = c.get("userId");
    if (typeof b.pendingId === "string" && typeof b.signedTx === "string") {
      if (!signing) throw httpError(400, "self-custody signing is not available");
      const { continuation } = await signing.complete(userId, b.pendingId, b.signedTx);
      return json(c, continuation ? respond((await continuation) as T) : state());
    }
    if (!signing || !signing.selfWallet(userId)) return json(c, respond(await action()));
    const existing = signing.find(userId, (p) => (!!tag.goalId && p.goalId === tag.goalId) || (!!tag.sessionId && p.sessionId === tag.sessionId));
    if (existing) return json(c, needsSig(existing));
    const r = await signing.run(userId, tag, action);
    return json(c, r.kind === "done" ? respond(r.value) : needsSig(r.pending));
  };

  app.post("/signatures/:pendingId", async (c) => {
    if (!signing) throw httpError(400, "self-custody signing is not available");
    const b = await readBody(c);
    if (typeof b.signedTx !== "string") throw httpError(400, "signedTx required");
    const { tx } = await signing.complete(c.get("userId"), c.req.param("pendingId"), b.signedTx);
    return json(c, { ok: true, txHash: tx.txHash });
  });

  // ── staking + vote delegation (api-staking.ts) ──
  app.route("/", createStakingRoutes({ db, chain, signing }));
  app.route("/", createActivityRoutes({ db, chain, simulated: deps.chainLabel === "fake" })); // activity feed (api-activity.ts)

  // ── users ──
  app.post("/users", async (c) => {
    const b = await readBody(c);
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw httpError(400, "valid email required");
    const name = typeof b.name === "string" ? b.name.slice(0, 120) : null;
    const wantCustody = b.custody === "self" ? "self" : b.custody === "custodial" ? "custodial" : null;
    const selfKeys = () => {
      const walletAddress = str(b.walletAddress);
      if (!/^addr_test1[0-9a-z]+$/.test(walletAddress)) throw httpError(400, "walletAddress must be a preprod addr_test1 address");
      if (!chain.addressKeyHashes) throw httpError(400, "this chain cannot read wallet key hashes");
      let h: { paymentKeyHash: string; stakeKeyHash: string | null };
      try {
        h = chain.addressKeyHashes(walletAddress);
      } catch (e) {
        throw httpError(400, (e as Error).message);
      }
      return { treasuryAddress: walletAddress, ownerKeyHash: h.paymentKeyHash, stakeKeyHash: h.stakeKeyHash };
    };
    const existing = db.select().from(users).where(eq(users.email, email)).get();
    if (existing) {
      // Upsert: custody switches only when the body asks for one (sign-in omits custody).
      const patch: Partial<typeof users.$inferInsert> = {};
      if (name && name !== existing.name) patch.name = name;
      if (wantCustody === "self") Object.assign(patch, { custody: "self", ...selfKeys() });
      else if (wantCustody === "custodial" && existing.custody !== "custodial") {
        const t = await chain.keys.treasury(existing.id, existing.accountIndex);
        Object.assign(patch, { custody: "custodial", treasuryAddress: t.address, ownerKeyHash: t.keyHash, stakeKeyHash: t.stakeKeyHash });
      }
      if (Object.keys(patch).length) db.update(users).set(patch).where(eq(users.id, existing.id)).run();
      const u = userRow(existing.id);
      if (u.treasuryAddress !== existing.treasuryAddress) watch(u.treasuryAddress);
      const out: CreateUserResponse = { userId: u.id, custody: u.custody, treasuryAddress: u.treasuryAddress, created: false };
      return json(c, out);
    }
    const custody = wantCustody ?? "custodial";
    const id = `u_${randomUUID()}`;
    const accountIndex = (db.select({ m: max(users.accountIndex) }).from(users).get()?.m ?? -1) + 1;
    let keys: { treasuryAddress: string; ownerKeyHash: string; stakeKeyHash: string | null };
    if (custody === "custodial") {
      const t = await chain.keys.treasury(id, accountIndex);
      keys = { treasuryAddress: t.address, ownerKeyHash: t.keyHash, stakeKeyHash: t.stakeKeyHash };
    } else keys = selfKeys();
    db.insert(users).values({ id, email, name, custody, accountIndex, ...keys, createdAt: Date.now() }).run();
    watch(keys.treasuryAddress);
    const out: CreateUserResponse = { userId: id, custody, treasuryAddress: keys.treasuryAddress, created: true };
    return json(c, out, 201);
  });
  const watch = (address: string) => {
    try {
      chain.watcher.watchAddress(address);
    } catch {
      /* watcher optional */
    }
  };

  app.get("/me", async (c) => {
    const u = userRow(c.get("userId"));
    const bal = await balance(u.treasuryAddress);
    const me: MeDTO = {
      userId: u.id,
      email: u.email,
      name: u.name,
      custody: u.custody,
      treasuryAddress: u.treasuryAddress,
      network: NETWORK,
      balances:
        "error" in bal
          ? { tusdMicro: "0", lovelace: "0" }
          : { tusdMicro: bal.tusdMicro.toString(), lovelace: bal.lovelace.toString(), ...(bal.legacyTusdMicro ? { legacyTusdMicro: bal.legacyTusdMicro.toString() } : {}) },
      ...tusdTokenField(), // tUSD CIP-68 (workstream C)
      ...("error" in bal ? { balanceError: bal.error } : {}),
      myrPerTusd: deps.myrPerTusd,
      ...(deps.topupFeePct ? { topupFeePct: deps.topupFeePct } : {}),
      openDecisions: openDecisionCount(u.id),
      ...(signing && u.custody === "self" ? { pendingSignatures: signing.list(u.id) } : {}),
      llm: engine.llm.name,
      chain: deps.chainLabel ?? chain.provider.name,
    };
    return json(c, me);
  });

  // ── top-ups (runtime OnRamp; fiat→crypto is the only simulated step) ──
  const topupDTO = (t: typeof topups.$inferSelect): TopupDTO => ({
    id: t.id,
    amountMyr: t.amountMyr,
    feeMyr: t.feeMyr,
    tusdMicro: t.tusdMicro,
    simulated: t.simulated,
    status: t.status,
    txHash: t.txHash,
    createdAt: t.createdAt,
  });

  app.post("/topups", async (c) => {
    if (!deps.onramp) throw httpError(503, "on-ramp not configured");
    const b = await readBody(c);
    const amountMYR = String(b.amountMYR ?? "");
    if (!/^\d+(\.\d{1,2})?$/.test(amountMYR) || Number(amountMYR) <= 0) throw httpError(400, "amountMYR must be a positive amount");
    const row = deps.onramp.start({
      userId: c.get("userId"),
      amountMYR,
      simulated: b.simulated === true || typeof b.stripeSessionId !== "string",
      stripeSessionId: typeof b.stripeSessionId === "string" ? b.stripeSessionId : undefined,
    });
    const out: TopupStartResponse = { topupId: row.id, amountMyr: row.amountMyr, feeMyr: row.feeMyr, tusdMicro: row.tusdMicro, simulated: row.simulated, simulatedNote: SIMULATION_LABEL };
    return json(c, out, 201);
  });

  app.post("/topups/:id/confirm", async (c) => {
    if (!deps.onramp) throw httpError(503, "on-ramp not configured");
    const id = c.req.param("id");
    const t = db.select().from(topups).where(eq(topups.id, id)).get();
    if (!t || t.userId !== c.get("userId")) throw httpError(404, "top-up not found");
    const b = await readBody(c);
    // Idempotent by stripeEventId; the labelled simulated checkout uses "simulated_<topupId>".
    const stripeEventId = typeof b.stripeEventId === "string" && b.stripeEventId ? b.stripeEventId : `simulated_${id}`;
    if (stripeEventId.startsWith("simulated_") && stripeEventId !== `simulated_${id}`) throw httpError(400, "simulated event id must be simulated_<topupId>");
    const duplicate = !!t.stripeEventId && (t.status === "submitted" || t.status === "confirmed");
    const row = await deps.onramp.confirm(id, { stripeEventId });
    const out: TopupConfirmResponse = { ok: true, topup: topupDTO(row), ...(duplicate ? { duplicate: true } : {}), simulatedNote: SIMULATION_LABEL };
    return json(c, out);
  });

  // ── goals ──
  app.post("/goals", async (c) => {
    const b = await readBody(c);
    const r = await captain.plan({
      userId: c.get("userId"),
      goal: String(b.goal ?? ""),
      budgetTUSD: String(b.budgetTUSD ?? ""),
      deadline: String(b.deadline ?? ""),
      rules: typeof b.rules === "string" ? b.rules : "",
    });
    return json(c, r, 201);
  });

  app.post("/goals/:id/approve", async (c) => {
    const userId = c.get("userId");
    const g = ownGoal(userId, c.req.param("id"));
    const b = await readBody(c);
    const approvedState = (alreadyApproved = false): ApproveOk => {
      const goal = db.select().from(goals).where(eq(goals.id, g.id)).get()!;
      const ss = sessions.list({ goalId: g.id });
      return { ok: true, fundingTx: goal.fundingTx ?? null, sessionIds: ss.map((s) => s.id), ...(alreadyApproved ? { alreadyApproved: true } : {}) };
    };
    const signed = typeof b.pendingId === "string" && typeof b.signedTx === "string";
    const existing = sessions.list({ goalId: g.id });
    const unfunded = existing.filter((s) => s.status === "PLANNED" || s.status === "AWAITING_APPROVAL");
    const needsStart = g.status === "planned" || (existing.length === 0 && g.status === "approved") || (unfunded.length > 0 && unfunded.length === existing.length);
    if (!signed && !needsStart) return json(c, approvedState(true));
    const plan = PlanSchema.parse(JSON.parse(g.planJson));
    const start = async () => {
      if (g.status === "planned") {
        db.update(goals).set({ status: "approved" }).where(eq(goals.id, g.id)).run();
        bus.emit("plan_approved", { goalId: g.id, data: { userId, sessions: plan.sessions.length } });
      }
      try {
        await sessions.startPlan(g.id, plan);
      } catch (err) {
        bus.emit("error", { goalId: g.id, data: { where: "startPlan", message: (err as Error).message } });
        const e = err as Error & { code?: string };
        if (e.code === "insufficient_funds") throw e;
        throw httpError(502, `could not start the plan: ${e.message}`);
      }
      const now = db.select({ status: goals.status }).from(goals).where(eq(goals.id, g.id)).get();
      if (now?.status === "approved") db.update(goals).set({ status: "running" }).where(eq(goals.id, g.id)).run();
    };
    return signable(c, b, { goalId: g.id, purpose: `Fund ${plan.sessions.length} session wallet${plan.sessions.length === 1 ? "" : "s"} for "${clip(g.goal, 60)}"` }, start, () => approvedState(), () => approvedState());
  });

  app.get("/goals", (c) => {
    const userId = c.get("userId");
    const rows = db.select().from(goals).where(eq(goals.userId, userId)).orderBy(desc(goals.createdAt)).all();
    const out: GoalSummary[] = rows.map((g) => {
      const ss = sessions.list({ goalId: g.id });
      return {
        id: g.id,
        goal: g.goal,
        budgetMicro: g.budgetMicro,
        deadline: g.deadline,
        rules: g.rules,
        status: g.status,
        fundingTx: g.fundingTx,
        createdAt: g.createdAt,
        sessions: ss.length,
        running: ss.filter((s) => RUNNING_GROUP.includes(s.status)).length,
        closed: ss.filter((s) => s.status === "CLOSED").length,
      };
    });
    return json(c, out);
  });

  app.get("/goals/:id/tree", (c) => {
    const g = ownGoal(c.get("userId"), c.req.param("id"));
    return json(c, sessions.tree(g.id));
  });

  // ── sessions ──
  app.post("/sessions/pause-all", async (c) => {
    const userId = c.get("userId");
    const running = sessions.list({ status: ["RUNNING"] }).filter((s) => s.userId === userId);
    const results = await Promise.allSettled(running.map((s) => sessions.pause(s.id, "user")));
    const out: PauseAllResponse = { ok: true, paused: results.filter((r) => r.status === "fulfilled").length, failed: results.filter((r) => r.status === "rejected").length };
    return json(c, out);
  });

  app.get("/sessions/:id", (c) => {
    const userId = c.get("userId");
    const row = ownSession(userId, c.req.param("id"));
    const d = db.select().from(sessionsT).where(eq(sessionsT.id, row.id)).get()!;
    const payees: PayeeDTO[] = row.allowedPayees.map((p: { id: string; label: string; address: string; handle?: string; resolvedAt?: number }) => ({
      id: p.id,
      label: p.label,
      address: p.address,
      ...(p.handle ? { handle: p.handle, resolvedAt: p.resolvedAt } : {}),
    }));
    const decs = decisions.list({ sessionId: row.id });
    const pendingPayments: PendingPaymentDTO[] = db
      .select()
      .from(payments)
      .where(and(eq(payments.sessionId, row.id), eq(payments.status, "awaiting_approval")))
      .all()
      .map((p) => {
        const dec = decs.find((x) => x.kind === "payment_approval" && x.status === "open" && (x.refKey === p.id || x.details.paymentId === p.id));
        const label = payees.find((x) => x.address === p.payee)?.label;
        return { id: p.id, payee: p.payee, ...(label ? { payeeLabel: label } : {}), amountMicro: p.amountMicro, memo: p.memo, ...(dec ? { decisionId: dec.id } : {}) };
      });
    const out: SessionDetailDTO = {
      id: row.id,
      goalId: row.goalId,
      parentSessionId: row.parentSessionId,
      letter: row.letter,
      name: row.name,
      role: row.role,
      agentType: d.agentType,
      taskType: row.taskType,
      definitionOfDone: DEFINITION_OF_DONE[row.taskType],
      goal: d.goal,
      status: row.status,
      tainted: row.tainted,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      tokensUsed: row.tokensUsed,
      doneAttempts: row.doneAttempts,
      endReason: d.endReason,
      mandate: {
        budgetMicro: row.budgetMicro.toString(),
        perPaymentMaxMicro: row.perPaymentMaxMicro.toString(),
        approvalThresholdMicro: row.approvalThresholdMicro.toString(),
        allowedPayees: payees,
        expiresAt: row.expiresAt,
      },
      wallet: { address: row.address, mode: d.walletMode, scriptHash: d.scriptHash ?? null, spentMicro: row.spentMicro.toString(), budgetMicro: row.budgetMicro.toString(), feesLovelace: d.feesLovelace, fundingTx: d.fundingTx },
      contextIn: parseJson<ContextIn[]>(d.contextInJson, []),
      activity: bus
        .since(0, { sessionId: row.id })
        .filter((e) => !e.type.startsWith("captain_") && e.type !== "llm_usage")
        .slice(-300),
      messages: db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, row.id))
        .orderBy(messages.createdAt)
        .all()
        .map((m) => ({ id: m.id, from: m.from, text: m.text, createdAt: m.createdAt })),
      pendingPayments,
      decisions: decs,
      handback: parseJson<Handback | null>(d.handbackJson, null),
      close: d.closeTx || d.refundMicro !== null ? { refundMicro: d.refundMicro, closeTx: d.closeTx, logSha256: d.logSha256, handbackSha256: d.handbackSha256 } : null,
    };
    return json(c, out);
  });

  app.post("/sessions/:id/messages", async (c) => {
    const row = ownSession(c.get("userId"), c.req.param("id"));
    const text = String((await readBody(c)).text ?? "").trim();
    if (!text) throw httpError(400, "text required");
    const r = await sessions.message(row.id, "user", text.slice(0, 4_000));
    const ignored = bus.since(0, { sessionId: row.id }).some((e) => e.type === "mandate_change_ignored" && e.data.messageId === r.messageId);
    const out: MessageResponse = { messageId: r.messageId, ...(ignored ? { mandateChangeIgnored: true } : {}) };
    return json(c, out, 201);
  });

  app.get("/sessions/:id/peek", (c) => {
    const row = ownSession(c.get("userId"), c.req.param("id"));
    return streamSSE(c, async (stream) => {
      const queue: BulkheadEvent[] = bus
        .since(0, { sessionId: row.id })
        .filter((e) => PEEK.includes(e.type))
        .slice(-50);
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe((e) => {
        if (e.sessionId === row.id && PEEK.includes(e.type)) {
          queue.push(e);
          wake?.();
        }
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          // No `event:` name: the browser reads these with EventSource.onmessage.
          await stream.writeSSE({ id: String(e.id), data: JSON.stringify(peekLine(e)) });
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15_000);
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
      unsub();
    });
  });

  app.post("/sessions/:id/:action", async (c) => {
    const userId = c.get("userId");
    const row = ownSession(userId, c.req.param("id"));
    const action = c.req.param("action");
    const b = await readBody(c);
    const ok = (decision?: Decision): ControlOk => ({ ok: true, status: sessions.get(row.id)!.status, ...(decision ? { decision: decisions.list({ sessionId: row.id }).find((x) => x.id === decision.id) ?? decision } : {}) });
    switch (action) {
      case "pause":
        await sessions.pause(row.id, "user");
        return json(c, ok());
      case "resume":
        await sessions.resume(row.id, "user");
        return json(c, ok());
      case "kill":
        await sessions.kill(row.id, "user", typeof b.reason === "string" && b.reason.trim() ? b.reason.slice(0, 200) : "killed by user");
        return json(c, ok());
      case "narrow": {
        const newBudget = tusdToMicro(String(b.newBudgetTUSD ?? ""));
        await sessions.narrowBudget(row.id, newBudget);
        return json(c, ok());
      }
      case "raise":
      case "extend": {
        // Widening the mandate always goes through the decision ledger. confirm:true = the user's explicit
        // approval in the UI: the decision is approved by them at once (self-custody: they also sign).
        let opened: Decision | undefined;
        if (typeof b.decisionId === "string") {
          opened = decisions.list({ sessionId: row.id }).find((x) => x.id === b.decisionId);
          if (!opened) throw httpError(404, "decision not found");
        } else if (typeof b.pendingId !== "string") {
          if (action === "raise") {
            const add = tusdToMicro(String(b.addTUSD ?? ""));
            if (add <= 0n) throw httpError(400, "addTUSD must be > 0");
            opened = decisions.open({
              sessionId: row.id,
              kind: "budget_raise",
              requestedBy: "captain",
              refKey: `budget_raise:${add}`,
              details: { initiator: "user", amountTUSD: microToTusd(add), addMicro: add.toString(), newBudgetMicro: (row.budgetMicro + add).toString(), reason: typeof b.reason === "string" ? b.reason : "raised by user" },
            });
          } else {
            const ms = typeof b.newExpiresAt === "number" ? b.newExpiresAt : Date.parse(String(b.newExpiresAt ?? ""));
            if (!Number.isFinite(ms) || ms <= row.expiresAt) throw httpError(400, "newExpiresAt must be later than the current expiry");
            opened = decisions.open({
              sessionId: row.id,
              kind: "extend_expiry",
              requestedBy: "captain",
              refKey: `extend_expiry:${ms}`,
              details: { initiator: "user", newExpiresAt: ms, oldExpiresAt: row.expiresAt, newExpiresAtIso: new Date(ms).toISOString(), reason: typeof b.reason === "string" ? b.reason : "extended by user" },
            });
          }
        }
        const approveNow = b.confirm === true || typeof b.decisionId === "string" || typeof b.pendingId === "string";
        if (!approveNow) return json(c, ok(opened));
        const d = opened;
        return signable(
          c,
          b,
          { sessionId: row.id, purpose: `${action === "raise" ? "Raise the budget" : "Extend the expiry"} of ${row.letter} ${row.role}` },
          async () => (d && d.status === "open" ? decisions.decide(d.id, "approved", userId, "approved by the user in the session panel") : d),
          (v) => ok(v),
          () => ok(),
        );
      }
      default:
        throw httpError(404, `unknown action ${action}`);
    }
  });

  // ── payments + decisions ──
  const decidePayment = async (c: Context<Vars>, status: "approved" | "rejected") => {
    const userId = c.get("userId");
    const paymentId = String(c.req.param("id") ?? "");
    const p = db.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!p) throw httpError(404, "payment not found");
    ownSession(userId, p.sessionId);
    const d = decisions.list({ status: "open", sessionId: p.sessionId }).find((x) => x.kind === "payment_approval" && (x.refKey === paymentId || x.details.paymentId === paymentId));
    let decided: Decision | undefined;
    if (d) decided = await decisions.decide(d.id, status, userId, `${status} from the payment card`);
    else if (p.status === "awaiting_approval") await engine.signer.resolveApproval(paymentId, status === "approved");
    else throw httpError(409, `payment is ${p.status}`);
    const now = db.select().from(payments).where(eq(payments.id, paymentId)).get()!;
    const out: PaymentDecisionResponse = { ok: true, paymentId, status: now.status, ...(decided ? { decision: decided } : {}) };
    return json(c, out);
  };
  app.post("/payments/:id/approve", (c) => decidePayment(c, "approved"));
  app.post("/payments/:id/reject", (c) => decidePayment(c, "rejected"));

  app.get("/decisions", (c) => {
    const userId = c.get("userId");
    const q = c.req.query("status");
    const status = q === "open" || q === "approved" || q === "rejected" || q === "expired" ? q : undefined;
    if (q && !status) throw httpError(400, "status must be open | approved | rejected | expired");
    const sids = userSessionIds(userId);
    const list: DecisionDTO[] = decisions
      .list(status ? { status } : {})
      .filter((d) => sids.has(d.sessionId))
      .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.createdAt - a.createdAt)
      .map((d) => {
        const s = sessions.get(d.sessionId);
        return { ...d, ...(s ? { goalId: s.goalId, letter: s.letter, role: s.role } : {}) };
      });
    return json(c, list);
  });

  app.post("/decisions/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const sids = userSessionIds(userId);
    const d = decisions.list({}).find((x) => x.id === id && sids.has(x.sessionId));
    if (!d) throw httpError(404, "decision not found");
    const b = await readBody(c);
    if (typeof b.pendingId !== "string" && b.status !== "approved" && b.status !== "rejected") throw httpError(400, "status must be approved | rejected");
    const note = typeof b.note === "string" ? b.note.slice(0, 500) : undefined;
    const current = () => decisions.list({ sessionId: d.sessionId }).find((x) => x.id === id)!;
    if (b.status === "rejected") return json(c, await decisions.decide(id, "rejected", userId, note));
    const s = sessions.get(d.sessionId);
    return signable(
      c,
      b,
      { sessionId: d.sessionId, purpose: `${d.kind.replace(/_/g, " ")} for ${s ? `${s.letter} ${s.role}` : "a session"}` },
      () => decisions.decide(id, "approved", userId, note),
      () => current(),
      () => current(),
    );
  });

  // ── captain ──
  app.post("/captain/messages", async (c) => {
    const b = await readBody(c);
    const text = String(b.text ?? "").trim();
    if (!text) throw httpError(400, "text required");
    const goalId = typeof b.goalId === "string" && b.goalId ? ownGoal(c.get("userId"), b.goalId).id : null;
    await captain.userMessage(c.get("userId"), goalId, text);
    return json(c, { ok: true, queued: true }, 202);
  });

  app.get("/captain/log", (c) => {
    const userId = c.get("userId");
    const goalId = c.req.query("goalId");
    if (goalId) ownGoal(userId, goalId);
    const visible = visibleTo(userId);
    const evs = bus.since(0, goalId ? { goalId } : {}).filter((e) => e.type.startsWith("captain_") || e.type === "user_message");
    const mine = evs.filter((e) => visible(e) || (e.type === "captain_absorbed" && !e.goalId && !goalId));
    const entries: CaptainLogEntry[] = mine.map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.type === "captain_woken" ? "woken" : e.type === "captain_absorbed" ? "absorbed" : e.type === "captain_action" ? "action" : e.type === "captain_report" ? "report" : "user_message",
      text: captainLine(e),
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.goalId ? { goalId: e.goalId } : {}),
    }));
    const out: CaptainLogDTO = {
      woken: mine.filter((e) => e.type === "captain_woken").length,
      absorbed: mine.filter((e) => e.type === "captain_absorbed").reduce((s, e) => s + Number(e.data.count ?? 0), 0),
      entries: entries.slice(-200),
    };
    return json(c, out);
  });

  app.get("/agents", async (c) => json(c, await market.catalog()));

  // ── Agent Map (spec §6.7) ──
  app.get("/agent-map", async (c) => {
    const userId = c.get("userId");
    const goalId = c.req.query("goalId");
    if (goalId) ownGoal(userId, goalId);
    const u = userRow(userId);
    const rows = db
      .select()
      .from(sessionsT)
      .where(goalId ? and(eq(sessionsT.userId, userId), eq(sessionsT.goalId, goalId)) : eq(sessionsT.userId, userId))
      .all();
    const open = decisions.list({ status: "open" });
    const latest = new Map<string, string>();
    for (const r of rows) {
      const last = bus
        .since(0, { sessionId: r.id })
        .filter((e) => e.type === "progress" && typeof e.data.text === "string")
        .pop();
      if (last) latest.set(r.id, String(last.data.text));
    }
    const jobs = rows.length ? db.select().from(agentJobs).where(inArray(agentJobs.sessionId, rows.map((r) => r.id))).all() : [];
    const cards: AgentCardDTO[] = rows.map((r) => {
      const status = r.status as SessionStatus;
      const pendingPayment = open.some((d) => d.sessionId === r.id && d.kind === "payment_approval");
      const handback = parseJson<{ summary?: string } | null>(r.handbackJson, null);
      return {
        id: r.id,
        goalId: r.goalId,
        parentId: r.parentSessionId,
        kind: "session",
        letter: r.letter,
        role: r.role,
        shortGoal: clip(r.goal, 120),
        status,
        glyph: glyphFor(status, pendingPayment),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        createdAt: r.createdAt,
        tokensUsed: r.tokensUsed,
        spentMicro: r.spentMicro,
        budgetMicro: r.budgetMicro,
        refundMicro: r.refundMicro,
        latest: CLOSED_GROUP.includes(status) && r.endReason ? clip(r.endReason, 120) : latest.has(r.id) ? clip(latest.get(r.id)!, 120) : null,
        handbackSummary: handback?.summary ? clip(handback.summary, 120) : null,
      };
    });
    const goalOf = new Map(rows.map((r) => [r.id, r.goalId]));
    for (const j of jobs) {
      const done = j.status === "completed" || j.status === "failed";
      const st: SessionStatus = j.status === "completed" ? "CLOSED" : j.status === "failed" ? "FAILED" : "RUNNING";
      cards.push({
        id: j.id,
        goalId: goalOf.get(j.sessionId) ?? "",
        parentId: j.sessionId,
        kind: "agent_job",
        role: "Agent job",
        shortGoal: `agent: ${j.serviceId}`,
        status: st,
        glyph: glyphFor(st),
        startedAt: j.createdAt,
        endedAt: done ? j.updatedAt : null,
        createdAt: j.createdAt,
        tokensUsed: 0,
        spentMicro: j.status === "started" ? "0" : j.priceMicro,
        budgetMicro: j.priceMicro,
        refundMicro: null,
        latest: done ? null : `job ${j.status}`,
        handbackSummary: j.status === "completed" ? `Result delivered (hash ${String(j.resultHash ?? "").slice(0, 12)}…)` : null,
      });
    }
    const info = deps.captainInfo();
    const bal = await balance(u.treasuryAddress);
    const out: AgentMapDTO = {
      captain: {
        name: info.name,
        model: info.model,
        contextTokens: info.contextTokens,
        treasuryMicro: "error" in bal ? "0" : bal.tusdMicro.toString(),
        running: rows.filter((r) => RUNNING_GROUP.includes(r.status as SessionStatus)).length,
        closed: rows.filter((r) => CLOSED_GROUP.includes(r.status as SessionStatus)).length,
      },
      cards,
    };
    return json(c, out);
  });

  // ── Spending + Logbook tabs (spec §6.6) ──
  app.get("/spending", async (c) => {
    const userId = c.get("userId");
    const u = userRow(userId);
    const rows = db.select().from(sessionsT).where(eq(sessionsT.userId, userId)).all();
    const tops = db.select().from(topups).where(eq(topups.userId, userId)).orderBy(topups.createdAt).all();
    const pays = rows.length ? db.select().from(payments).where(inArray(payments.sessionId, rows.map((r) => r.id))).all() : [];
    // Treasury balance over time: deltas (top-ups in, session funding out, refunds in), anchored to the
    // live balance at "now" when it can be read.
    const deltas: { at: number; d: bigint }[] = [];
    for (const t of tops) if (t.status === "confirmed") deltas.push({ at: t.updatedAt, d: BigInt(t.tusdMicro) });
    for (const r of rows) {
      const at = r.fundingConfirmedAt ?? r.startedAt;
      if (at && r.fundingTx) deltas.push({ at, d: -BigInt(r.budgetMicro) });
      if (r.refundMicro && r.endedAt) deltas.push({ at: r.endedAt, d: BigInt(r.refundMicro) });
    }
    deltas.sort((a, b) => a.at - b.at);
    const bal = await balance(u.treasuryAddress);
    const sumAll = deltas.reduce((s, x) => s + x.d, 0n);
    let running = "error" in bal ? 0n : bal.tusdMicro - sumAll; // balance before the first known delta
    const first = deltas[0]?.at ?? u.createdAt;
    const balanceHistory: SpendingDTO["balanceHistory"] = [{ at: Math.min(first - 1, u.createdAt), tusdMicro: (running < 0n ? 0n : running).toString() }];
    for (const x of deltas) {
      running += x.d;
      balanceHistory.push({ at: x.at, tusdMicro: (running < 0n ? 0n : running).toString() });
    }
    balanceHistory.push({ at: Date.now(), tusdMicro: ("error" in bal ? running : bal.tusdMicro).toString() });
    const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
    const sen = (myr: string) => BigInt(Math.round(Number(myr) * 100));
    const feeSen = sum(tops.filter((t) => t.status === "confirmed").map((t) => sen(t.feeMyr)));
    const out: SpendingDTO = {
      balanceHistory,
      perSession: rows.map((r) => ({
        sessionId: r.id,
        goalId: r.goalId,
        letter: r.letter,
        role: r.role,
        status: r.status as SessionStatus,
        budgetMicro: r.budgetMicro,
        spentMicro: r.spentMicro,
        refundMicro: r.refundMicro,
        feesLovelace: (BigInt(r.feesLovelace) + sum(pays.filter((p) => p.sessionId === r.id).map((p) => BigInt(p.feeLovelace ?? "0")))).toString(),
      })),
      topups: tops.map(topupDTO),
      totals: {
        spentMicro: sum(rows.map((r) => BigInt(r.spentMicro))).toString(),
        refundMicro: sum(rows.map((r) => BigInt(r.refundMicro ?? "0"))).toString(),
        feesLovelace: (sum(rows.map((r) => BigInt(r.feesLovelace))) + sum(pays.map((p) => BigInt(p.feeLovelace ?? "0")))).toString(),
        topupFeesMyr: `${feeSen / 100n}.${(feeSen % 100n).toString().padStart(2, "0")}`,
      },
    };
    return json(c, out);
  });

  app.get("/logbook", (c) => {
    const userId = c.get("userId");
    const goalId = c.req.query("goalId");
    const rows = db
      .select()
      .from(sessionsT)
      .where(goalId ? and(eq(sessionsT.userId, userId), eq(sessionsT.goalId, goalId)) : eq(sessionsT.userId, userId))
      .orderBy(desc(sessionsT.endedAt))
      .all()
      .filter((r) => r.status === "CLOSED");
    const goalText = new Map(db.select({ id: goals.id, goal: goals.goal }).from(goals).where(eq(goals.userId, userId)).all().map((g) => [g.id, g.goal]));
    const out: LogbookEntryDTO[] = rows.map((r) => ({
      sessionId: r.id,
      goalId: r.goalId,
      goalText: goalText.get(r.goalId) ?? "",
      letter: r.letter,
      role: r.role,
      taskType: r.taskType as TaskType,
      status: r.status as SessionStatus,
      handback: parseJson<Handback | null>(r.handbackJson, null),
      spentMicro: r.spentMicro,
      refundMicro: r.refundMicro,
      closeTx: r.closeTx,
      logSha256: r.logSha256,
      handbackSha256: r.handbackSha256,
      endedAt: r.endedAt,
      closeStatus: r.closeStatus,
      endReason: r.endReason,
    }));
    return json(c, out);
  });

  // ── live events (SSE) ──
  app.get("/events/stream", (c) => {
    const userId = c.get("userId");
    const goalId = c.req.query("goalId");
    if (goalId) ownGoal(userId, goalId);
    const visible = visibleTo(userId);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? NaN);
    return streamSSE(c, async (stream) => {
      const match = (e: BulkheadEvent) => (!goalId || e.goalId === goalId) && visible(e);
      const queue: BulkheadEvent[] = Number.isFinite(after) ? bus.since(after, goalId ? { goalId } : {}).filter(match) : [];
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe((e) => {
        if (match(e)) {
          queue.push(e);
          wake?.();
        }
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: Date.now() }) });
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ id: String(e.id), data: JSON.stringify(e) });
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15_000);
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
      unsub();
    });
  });

  return app;
}

export function peekLine(e: BulkheadEvent): PeekLine {
  const d = e.data ?? {};
  let text: string;
  switch (e.type) {
    case "progress":
      text = String(d.text ?? d.line ?? "");
      break;
    case "session_message":
      text = `message from ${String(d.from ?? "?")}: ${String(d.text ?? "")}`;
      break;
    case "mandate_change_ignored":
      text = `mandate change ignored: ${String(d.note ?? "messages never change the mandate")}`;
      break;
    case "tool_denied":
      text = `tool denied: ${String(d.tool ?? "")} ${d.reason ? `(${String(d.reason)})` : ""}`.trim();
      break;
    case "web_fetch":
      text = `web_fetch ${String(d.url ?? "")}`;
      break;
    case "payment_rejected":
      text = `payment rejected: ${String(d.reason ?? "")}${d.detail ? ` (${String(d.detail)})` : ""}`;
      break;
    default:
      text = String(d.message ?? d.error ?? e.type);
  }
  const level: PeekLine["level"] = e.type === "error" || d.level === "error" ? "error" : e.type === "tool_denied" || e.type === "payment_rejected" || e.type === "mandate_change_ignored" || d.level === "warn" ? "warn" : "info";
  return { id: e.id, at: e.at, level, kind: e.type, text };
}

function captainLine(e: BulkheadEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "captain_woken":
      return `Woken by ${String(d.trigger ?? "event")}${Array.isArray(d.coalesced) && d.coalesced.length ? ` (+${d.coalesced.length} coalesced)` : ""}`;
    case "captain_absorbed": {
      const by = Object.entries((d.byType as Record<string, number>) ?? {})
        .map(([k, v]) => `${k} ×${v}`)
        .join(", ");
      return `Absorbed ${Number(d.count ?? 0)} routine event${Number(d.count ?? 0) === 1 ? "" : "s"} without an LLM call${by ? ` (${by})` : ""}`;
    }
    case "captain_action":
      return `${String(d.tool ?? "tool")}(${clip(JSON.stringify(d.input ?? {}), 140)})${d.ok === false ? ` failed: ${String(d.error ?? "")}` : ""}`;
    default:
      return String(d.text ?? "");
  }
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
