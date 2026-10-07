// Activity feed (Hono sub-router), mounted by createApi after its auth middleware (userId = acting user).
//   GET /activity?goalId=&q=&type=&limit=&before=  → ActivityDTO
// One newest-first feed built from the append-only `events` table (the source of truth), enriched with the
// current state of payments / decisions / top-ups / agent jobs, plus staking txs (kv). Without `q` the
// lifecycle of one payment / top-up / job / decision / close collapses into a single row showing its latest
// state; with `q` (an id, letter, tx hash or address) the full, uncollapsed history of that entity is returned.
// A tx hash that is not in the DB gets a live chain summary (server-side provider / Blockfrost).
import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, like, lt, or, type SQL } from "drizzle-orm";
import { agentJobs, decisions as decisionsT, events, goals, kv, payments, sessions as sessionsT, topups, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { microToTusd, type ActivityDTO, type ActivityKind, type ActivityMatchDTO, type ActivityRowDTO, type BulkheadEvent } from "@bulkhead/shared";
import { rowToEvent } from "./bus";
import { stakingKvKey, type StakingRecord } from "./staking";
import { toJsonSafe } from "./captain/tools";

type Vars = { Variables: { userId: string } };

export interface TxSummary {
  found: boolean;
  blockHeight?: number | null;
  slot?: number | null;
  confirmations?: number | null;
  feeLovelace?: string | null;
  blockTime?: number | null;
  error?: string;
}

export interface ActivityApiDeps {
  db: DB;
  chain: Chain;
  /** Live tx lookup for hashes that are not in the DB. Default: Blockfrost /txs/{hash} when
   * BLOCKFROST_PREPROD_PROJECT_ID is set (and the chain is real), else the provider's confirmation read. */
  lookupTx?: (hash: string) => Promise<TxSummary>;
  /** true for the offline FakeChain demo: never call Blockfrost. */
  simulated?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Filter tabs → kinds. A comma list of kinds is also accepted. */
export const ACTIVITY_GROUPS: Record<string, ActivityKind[]> = {
  payments: ["payment", "rejection"],
  agents: ["hire", "handback", "progress", "transition", "message"],
  decisions: ["decision"],
  funding: ["funding", "close", "topup", "staking"],
  captain: ["captain"],
};

const SKIP = new Set(["llm_usage"]);
const HEX64 = /^[0-9a-f]{64}$/i;
const SAFE_Q = /^[A-Za-z0-9_:.$-]{1,140}$/;
const BLOCKFROST_URL = "https://cardano-preprod.blockfrost.io/api/v0";

interface SessInfo {
  id: string;
  goalId: string;
  letter: string;
  role: string;
  name: string;
  address: string | null;
}

const s = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const sOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);
const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const tusd = (micro: unknown) => {
  try {
    return `${microToTusd(BigInt(s(micro) || "0"))} tUSD`;
  } catch {
    return "? tUSD";
  }
};
const short = (a: string) => (a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a);

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Map one event to an activity row (null = not shown). `collapseKey` groups a lifecycle into one row. */
export function eventToRow(e: BulkheadEvent, sess: Map<string, SessInfo>): (ActivityRowDTO & { collapseKey?: string }) | null {
  if (SKIP.has(e.type)) return null;
  const d = e.data ?? {};
  const si = e.sessionId ? sess.get(e.sessionId) : undefined;
  const who = si ? `${si.letter} · ${si.role}` : "";
  const base: ActivityRowDTO = {
    id: `ev:${e.id}`,
    eventId: e.id,
    at: e.at,
    kind: "progress",
    title: e.type,
    goalId: e.goalId ?? si?.goalId ?? null,
    sessionId: e.sessionId ?? null,
    letter: si?.letter ?? sOrNull(d.letter),
    role: si?.role ?? null,
    direction: null,
    status: null,
  };
  const r = (patch: Partial<ActivityRowDTO> & { collapseKey?: string }) => ({ ...base, ...patch });
  const sessName = si ? `Session ${si.letter} (${si.role})` : "Session";
  switch (e.type) {
    case "goal_created":
      return r({ kind: "captain", title: `Goal created: ${clip(s(d.goal), 120)}`, status: "ok" });
    case "plan_proposed":
      return r({ kind: "captain", title: `Captain proposed a plan with ${s(d.sessions)} session(s)`, status: "open" });
    case "plan_approved":
      return r({ kind: "captain", title: "Plan approved — sessions starting", status: "approved" });
    case "session_created":
      return r({ kind: "transition", title: `${sessName} created${d.taskType ? ` · ${s(d.taskType)}` : ""}`, address: sOrNull(d.address), amountMicro: sOrNull(d.budgetMicro), status: "ok" });
    case "session_transition":
      return r({ kind: "transition", title: `${sessName}: ${s(d.from)} → ${s(d.to)}${d.reason ? ` — ${clip(s(d.reason), 100)}` : ""}`, status: s(d.to).toLowerCase() });
    case "session_funded": {
      const phase = s(d.phase);
      const pending = phase.endsWith("submitted") || phase === "submitted";
      const titles: Record<string, string> = {
        submitted: `Funding ${sessName} with ${tusd(d.budgetMicro)} — submitted`,
        confirmed: `${sessName} funded with ${tusd(d.budgetMicro)}`,
        raise_submitted: `Budget raise +${tusd(d.addMicro)} for ${sessName} — submitted`,
        raise_confirmed: `Budget raised +${tusd(d.addMicro)} for ${sessName}`,
        extend_submitted: `Expiry extension for ${sessName} — submitted`,
        extend_confirmed: `Expiry extended for ${sessName}`,
        rotate_submitted: `Wallet rotation for ${sessName} — submitted`,
        rotate_confirmed: `Wallet rotated for ${sessName}`,
        rotate_revoked: `Old wallet revoked for ${sessName}`,
        narrowed: `Mandate narrowed for ${sessName}${d.returnedMicro && d.returnedMicro !== "0" ? `, ${tusd(d.returnedMicro)} returned` : ""}`,
      };
      const amount = phase.startsWith("raise") ? sOrNull(d.addMicro) : phase === "narrowed" ? sOrNull(d.returnedMicro) : phase === "submitted" || phase === "confirmed" ? sOrNull(d.budgetMicro) : null;
      return r({
        kind: "funding",
        title: titles[phase] ?? `${sessName} funding: ${phase}`,
        txHash: sOrNull(d.txHash),
        address: sOrNull(d.newAddress) ?? sOrNull(d.address),
        amountMicro: amount && amount !== "0" ? amount : null,
        direction: amount && amount !== "0" ? (phase === "narrowed" ? "in" : "out") : null,
        status: pending ? "pending" : "confirmed",
        decisionId: sOrNull(d.decisionId),
        collapseKey: d.txHash ? `fund:${s(d.txHash)}` : undefined,
      });
    }
    case "progress": {
      const level = s(d.level);
      const sig = d.kind === "signature_needed";
      return r({ kind: "progress", title: `${who ? `${who}: ` : ""}${clip(s(d.text ?? d.line ?? ""), 200)}`, txHash: sOrNull(d.txHash), status: sig ? "pending" : level === "warn" || level === "error" ? level : "ok" });
    }
    case "heartbeat_missed":
      return r({ kind: "progress", title: `${sessName} missed ${s(d.missed)} heartbeat(s)`, status: "warn" });
    case "deadline_near":
      return r({ kind: "progress", title: `${sessName} deadline near (${Math.round(Number(d.msLeft ?? 0) / 60000)} min left)`, status: "warn" });
    case "web_fetch":
      return r({ kind: "progress", title: `${who ? `${who}: ` : ""}${d.blocked ? "blocked fetch" : "fetched"} ${clip(s(d.url), 120)}`, status: d.blocked ? "warn" : "ok" });
    case "tainted":
      return r({ kind: "progress", title: `${sessName} tainted by ${clip(s(d.url), 100)}${d.quarantine ? " — quarantined" : ""}`, status: "warn" });
    case "payment_requested":
    case "payment_approval_needed":
    case "payment_approved":
    case "payment_submitted":
    case "payment_confirmed": {
      const st = { payment_requested: "requested", payment_approval_needed: "awaiting_approval", payment_approved: "approved", payment_submitted: "pending", payment_confirmed: "confirmed" }[e.type];
      return r({
        kind: "payment",
        title: `${who ? `${who} ` : ""}paid ${tusd(d.amountMicro)} to ${short(s(d.payee))}${d.memo ? ` — ${clip(s(d.memo), 60)}` : ""}`,
        paymentId: sOrNull(d.paymentId),
        decisionId: sOrNull(d.decisionId),
        txHash: sOrNull(d.txHash),
        address: sOrNull(d.payee),
        amountMicro: sOrNull(d.amountMicro),
        direction: "out",
        status: st,
        collapseKey: d.paymentId ? `pay:${s(d.paymentId)}` : undefined,
      });
    }
    case "payment_rejected":
      return r({
        kind: "rejection",
        title: `Payment of ${tusd(d.amountMicro)} to ${short(s(d.payee))} rejected: ${s(d.reason)}${d.detail ? ` (${clip(s(d.detail), 80)})` : ""}`,
        paymentId: sOrNull(d.paymentId),
        address: sOrNull(d.payee),
        amountMicro: sOrNull(d.amountMicro),
        direction: null,
        status: "rejected",
      });
    case "agent_hired":
    case "agent_job_paid":
    case "agent_job_result": {
      const st = { agent_hired: "started", agent_job_paid: "paid", agent_job_result: "completed" }[e.type];
      const title =
        e.type === "agent_hired"
          ? `${who ? `${who} ` : ""}hired ${s(d.serviceId)} for ${tusd(d.priceMicro)}`
          : e.type === "agent_job_paid"
            ? `${who ? `${who} ` : ""}paid agent ${s(d.serviceId)} (job ${s(d.jobId)})`
            : `Agent ${s(d.serviceId)} delivered: ${clip(s(d.preview), 100)}`;
      return r({
        kind: "hire",
        title,
        agentJobId: sOrNull(d.jobRowId),
        externalJobId: sOrNull(d.jobId),
        paymentId: sOrNull(d.paymentId),
        txHash: sOrNull(d.txHash),
        address: sOrNull(d.paymentAddress),
        amountMicro: sOrNull(d.priceMicro),
        direction: d.priceMicro ? "out" : null,
        status: st,
        collapseKey: d.jobRowId ? `job:${s(d.jobRowId)}` : undefined,
      });
    }
    case "handback_submitted":
      return r({ kind: "handback", title: `${sessName} handed back: ${clip(s(d.summary), 140)}`, status: "pending" });
    case "handback_accepted":
      return r({ kind: "handback", title: `Handback accepted from ${sessName}`, status: "approved" });
    case "handback_rejected":
      return r({ kind: "handback", title: `Handback from ${sessName} returned: ${clip(s(d.reason), 120)}`, status: "rejected" });
    case "handback_passed":
      return r({ kind: "handback", title: `Handback passed ${s(d.fromLetter)} → ${s(d.toLetter)}`, status: "ok" });
    case "close_submitted":
    case "close_confirmed": {
      const refund = sOrNull(d.refundMicro);
      return r({
        kind: "close",
        title: `${sessName} closed${refund && refund !== "0" ? `, ${tusd(refund)} refunded to treasury` : ""}${e.type === "close_submitted" ? " — submitted" : ""}`,
        txHash: sOrNull(d.txHash),
        amountMicro: refund && refund !== "0" ? refund : null,
        direction: refund && refund !== "0" ? "in" : null,
        status: e.type === "close_confirmed" ? "confirmed" : "pending",
        collapseKey: e.sessionId ? `close:${e.sessionId}` : undefined,
      });
    }
    case "topup_pending":
    case "topup_submitted":
    case "topup_confirmed":
    case "deposit_seen": {
      const st = { topup_pending: "pending", topup_submitted: "pending", topup_confirmed: "confirmed", deposit_seen: "confirmed" }[e.type];
      const amount = sOrNull(d.tusdMicro);
      return r({
        kind: "topup",
        title: e.type === "topup_pending" ? `Top-up of RM ${s(d.amountMyr)} started${d.simulated ? " (simulated fiat)" : ""}` : `Treasury top-up${amount ? ` +${tusd(amount)}` : ""}${st === "pending" ? " — submitted" : ""}`,
        txHash: sOrNull(d.txHash),
        address: sOrNull(d.address),
        amountMicro: amount,
        direction: "in",
        status: st,
        collapseKey: d.topupId ? `top:${s(d.topupId)}` : undefined,
      });
    }
    case "treasury_refill": {
      // Treasury autopilot (treasury-autopilot.ts): funding account → delegated treasury, one tx with a CIP-20 memo.
      const amounts = (d.amounts ?? {}) as Record<string, unknown>;
      const to = (d.to ?? {}) as Record<string, unknown>;
      const from = (d.from ?? {}) as Record<string, unknown>;
      const lov = sOrNull(amounts.lovelace);
      return r({
        kind: "topup",
        title: `Treasury autopilot: ${tusd(amounts.tusdMicro)}${lov && lov !== "0" ? ` + ${s(amounts.ada)} tADA` : ""} ${s(from.email) || "funding account"} → ${s(to.email) || "treasury"}${d.reason ? ` (${clip(s(d.reason), 60)})` : ""}${d.status === "submitted" ? " — submitted" : ""}`,
        txHash: sOrNull(d.tx),
        address: sOrNull(to.address),
        amountMicro: sOrNull(amounts.tusdMicro),
        direction: null,
        status: d.status === "confirmed" ? "confirmed" : "pending",
        collapseKey: d.tx ? `refill:${s(d.tx)}` : undefined,
      });
    }
    case "tool_denied":
      return r({ kind: "rejection", title: `${sessName}: tool ${s(d.tool)} denied${d.reason ? ` (${clip(s(d.reason), 80)})` : ""}`, status: "denied" });
    case "mandate_change_ignored":
      return r({ kind: "rejection", title: `${sessName}: mandate change ignored`, status: "ignored" });
    case "session_message":
      return r({ kind: "message", title: `${s(d.from)} → ${si ? si.letter : "session"}: ${clip(s(d.text), 160)}`, status: "ok" });
    case "user_message":
      return r({ kind: "message", title: `You → captain: ${clip(s(d.text), 160)}`, status: "ok" });
    case "decision_opened":
    case "decision_closed": {
      const kind = s(d.kind).replace(/_/g, " ");
      const details = (d.details ?? {}) as Record<string, unknown>;
      const amount = sOrNull(details.amountMicro) ?? sOrNull(details.addMicro);
      return r({
        kind: "decision",
        title: e.type === "decision_opened" ? `Decision needed: ${kind}${amount ? ` ${tusd(amount)}` : ""}${si ? ` for ${si.letter}` : ""}` : `Decision ${s(d.status)}: ${kind}${d.note ? ` — ${clip(s(d.note), 80)}` : ""}`,
        decisionId: sOrNull(d.decisionId),
        paymentId: sOrNull(details.paymentId),
        amountMicro: amount,
        direction: null,
        status: e.type === "decision_opened" ? "open" : s(d.status),
        collapseKey: d.decisionId ? `dec:${s(d.decisionId)}` : undefined,
      });
    }
    case "captain_woken":
      return r({ kind: "captain", title: `Captain woken by ${s(d.trigger) || "event"}`, status: "ok" });
    case "captain_absorbed":
      return r({ kind: "captain", title: `Captain absorbed ${s(d.count)} routine event(s) without an LLM call`, status: "ok" });
    case "captain_action":
      return r({ kind: "captain", title: `Captain → ${s(d.tool)}${d.ok === false ? ` failed: ${clip(s(d.error), 80)}` : ""}`, status: d.ok === false ? "error" : "ok" });
    case "captain_report":
      return r({ kind: "captain", title: `Captain: ${clip(s(d.text), 200)}`, status: "ok" });
    case "error":
      return r({
        kind: /fund|insufficient|startPlan|close|refund|sweep/i.test(`${s(d.kind)} ${s(d.where)}`) ? "funding" : "rejection", title: `${si ? `${sessName}: ` : ""}${s(d.kind || d.where || "error")}: ${clip(s(d.error ?? d.message), 140)}`, txHash: sOrNull(d.txHash), status: "error" });
    default:
      return r({ kind: "progress", title: e.type, status: "ok" });
  }
}

export function createActivityRoutes(deps: ActivityApiDeps) {
  const { db, chain } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const app = new Hono<Vars>();
  app.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 400) as 400));

  // ── live chain reads (cached; never block the feed for long) ──
  const confCache = new Map<string, { conf: number | null; at: number }>();
  let tipCache: { height: number; at: number } | null = null;
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  const tipHeight = async () => {
    if (tipCache && now() - tipCache.at < 15_000) return tipCache.height;
    const t = await withTimeout(chain.provider.fetchTip(), 2_500);
    if (t) tipCache = { height: t.height, at: now() };
    return tipCache?.height ?? null;
  };
  const confirmationsOf = async (hash: string): Promise<number | null> => {
    const c = confCache.get(hash);
    if (c && (c.conf !== null && c.conf >= 15 ? true : now() - c.at < 20_000)) return c.conf;
    const r = await withTimeout(chain.provider.fetchTxConfirmation(hash), 2_500);
    let conf: number | null = null;
    if (r) {
      if (typeof r.confirmations === "number") conf = r.confirmations;
      else {
        const h = await tipHeight();
        conf = h !== null ? Math.max(1, h - r.blockHeight + 1) : 1;
      }
    }
    confCache.set(hash, { conf, at: now() });
    return conf;
  };
  const lookupTx =
    deps.lookupTx ??
    (async (hash: string): Promise<TxSummary> => {
      const key = env.BLOCKFROST_PREPROD_PROJECT_ID?.trim();
      if (key && !deps.simulated && key.startsWith("preprod")) {
        try {
          const res = await fetch(`${BLOCKFROST_URL}/txs/${hash}`, { headers: { project_id: key }, signal: AbortSignal.timeout(5_000) });
          if (res.status === 404) return { found: false };
          if (!res.ok) return { found: false, error: `Blockfrost ${res.status}` };
          const j = (await res.json()) as { block_height?: number; slot?: number; fees?: string; block_time?: number };
          const h = await tipHeight();
          return {
            found: true,
            blockHeight: j.block_height ?? null,
            slot: j.slot ?? null,
            feeLovelace: j.fees ?? null,
            blockTime: j.block_time ? j.block_time * 1000 : null,
            confirmations: h !== null && j.block_height ? Math.max(1, h - j.block_height + 1) : null,
          };
        } catch (e) {
          return { found: false, error: (e as Error).message };
        }
      }
      const r = await withTimeout(chain.provider.fetchTxConfirmation(hash), 4_000);
      if (!r) return { found: false };
      return { found: true, blockHeight: r.blockHeight, slot: r.slot, confirmations: r.confirmations ?? (await confirmationsOf(hash)) };
    });

  app.get("/activity", async (c: Context<Vars>) => {
    const userId = c.get("userId");
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw httpError(401, "unknown user");
    const goalId = c.req.query("goalId") || null;
    if (goalId) {
      const g = db.select({ userId: goals.userId }).from(goals).where(eq(goals.id, goalId)).get();
      if (!g || g.userId !== userId) throw httpError(404, "goal not found");
    }
    const qRaw = (c.req.query("q") ?? "").trim();
    if (qRaw && !SAFE_Q.test(qRaw)) throw httpError(400, "q must be an id, letter, tx hash or address");
    const typeQ = (c.req.query("type") ?? "all").toLowerCase();
    const kinds: Set<string> | null = typeQ === "all" || !typeQ ? null : new Set(ACTIVITY_GROUPS[typeQ] ?? typeQ.split(","));
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 60) || 60));
    const before = Number(c.req.query("before") ?? NaN);

    const sessRows = db
      .select({ id: sessionsT.id, goalId: sessionsT.goalId, letter: sessionsT.letter, role: sessionsT.role, name: sessionsT.name, address: sessionsT.address, fundingTx: sessionsT.fundingTx, closeTx: sessionsT.closeTx })
      .from(sessionsT)
      .where(eq(sessionsT.userId, userId))
      .all();
    const sess = new Map<string, SessInfo>(sessRows.map((r) => [r.id, r]));
    const goalRows = db.select({ id: goals.id, goal: goals.goal, fundingTx: goals.fundingTx, createdAt: goals.createdAt }).from(goals).where(eq(goals.userId, userId)).all();
    const goalIds = goalRows.map((g) => g.id);
    const sessionIds = [...sess.keys()];
    const ownScope = or(
      sessionIds.length ? inArray(events.sessionId, sessionIds) : undefined,
      goalIds.length ? inArray(events.goalId, goalIds) : undefined,
      like(events.dataJson, `%"userId":"${userId}"%`),
    )!;
    const stakingRecord = (): StakingRecord | null => {
      const row = db.select().from(kv).where(eq(kv.key, stakingKvKey(userId))).get();
      try {
        return row ? (JSON.parse(row.value) as StakingRecord) : null;
      } catch {
        return null;
      }
    };
    const stakingRows = (filter?: (h: string) => boolean): ActivityRowDTO[] =>
      (stakingRecord()?.txs ?? [])
        .filter((t) => !filter || filter(t.txHash))
        .map((t) => ({
          id: `stake:${t.txHash}`,
          at: t.at,
          kind: "staking" as const,
          title: t.kind === "setup" ? `Treasury staking set up (${t.certs.join(", ").replace(/_/g, " ")})` : t.kind === "stop" ? "Treasury staking stopped, deposit refunded" : "Staking rewards withdrawn",
          txHash: t.txHash,
          address: user.treasuryAddress,
          amountMicro: null,
          direction: null,
          status: t.confirmed ? "confirmed" : "pending",
        }));

    // ── resolve q ──
    let match: ActivityMatchDTO | null = null;
    let cond: SQL | undefined;
    let extra: ActivityRowDTO[] = [];
    if (qRaw) {
      const q = qRaw;
      const ql = q.toLowerCase();
      const pref = <T extends { id: string }>(xs: T[]) => xs.find((x) => x.id === q) ?? (q.length >= 4 ? xs.filter((x) => x.id.startsWith(q)).length === 1 ? xs.find((x) => x.id.startsWith(q)) : undefined : undefined);
      const textLike = (needle: string) => and(ownScope, like(events.dataJson, `%${needle}%`));
      const sessHit = pref(sessRows);
      const goalHit = pref(goalRows);
      const letterGoal = goalId ?? [...goalRows].sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
      const letterHit = /^[A-Za-z]{1,2}$/.test(q) && letterGoal ? sessRows.find((r) => r.goalId === letterGoal && r.letter.toUpperCase() === q.toUpperCase()) : undefined;
      const ownSessIds = sessionIds.length ? sessionIds : ["-"];
      if (sessHit || letterHit) {
        const r = (sessHit ?? letterHit)!;
        match = { type: sessHit ? "session" : "letter", value: r.id, label: `Session ${r.letter} · ${r.role}` };
        cond = and(ownScope, or(eq(events.sessionId, r.id), like(events.dataJson, `%${r.id}%`)));
      } else if (goalHit) {
        match = { type: "goal", value: goalHit.id, label: clip(goalHit.goal, 80) };
        cond = and(ownScope, eq(events.goalId, goalHit.id));
      } else if (HEX64.test(q)) {
        match = { type: "tx", value: ql, label: "Transaction" };
        cond = textLike(ql);
        extra = stakingRows((h) => h === ql);
        const inDb =
          !!db.select({ id: payments.id }).from(payments).where(and(eq(payments.txHash, ql), inArray(payments.sessionId, ownSessIds))).get() ||
          !!db.select({ id: topups.id }).from(topups).where(and(eq(topups.txHash, ql), eq(topups.userId, userId))).get() ||
          sessRows.some((r) => r.fundingTx === ql || r.closeTx === ql) ||
          goalRows.some((g) => g.fundingTx === ql) ||
          extra.length > 0;
        if (!inDb && !db.select({ id: events.id }).from(events).where(cond).get()) match.chain = await lookupTx(ql);
      } else {
        const pay = db.select().from(payments).where(and(inArray(payments.sessionId, ownSessIds), or(eq(payments.id, q), like(payments.id, `${q}%`)))).all();
        const dec = db.select().from(decisionsT).where(and(inArray(decisionsT.sessionId, ownSessIds), or(eq(decisionsT.id, q), like(decisionsT.id, `${q}%`)))).all();
        const job = db.select().from(agentJobs).where(and(inArray(agentJobs.sessionId, ownSessIds), or(eq(agentJobs.id, q), like(agentJobs.id, `${q}%`), eq(agentJobs.externalJobId, q)))).all();
        const top = db.select().from(topups).where(and(eq(topups.userId, userId), or(eq(topups.id, q), like(topups.id, `${q}%`)))).all();
        if (pay.length === 1 && q.length >= 4) {
          match = { type: "payment", value: pay[0]!.id, label: `Payment ${tusd(pay[0]!.amountMicro)} → ${short(pay[0]!.payee)}` };
          cond = textLike(pay[0]!.id);
        } else if (dec.length === 1 && q.length >= 4) {
          match = { type: "decision", value: dec[0]!.id, label: `Decision · ${dec[0]!.kind.replace(/_/g, " ")} · ${dec[0]!.status}` };
          cond = textLike(dec[0]!.id);
        } else if (job.length === 1 && q.length >= 4) {
          const j = job[0]!;
          match = { type: "agent_job", value: j.id, label: `Agent job · ${j.serviceId} · ${j.status}` };
          cond = and(ownScope, or(like(events.dataJson, `%${j.id}%`), j.externalJobId ? like(events.dataJson, `%${j.externalJobId}%`) : undefined, j.paymentId ? like(events.dataJson, `%${j.paymentId}%`) : undefined));
        } else if (top.length === 1 && q.length >= 4) {
          match = { type: "topup", value: top[0]!.id, label: `Top-up RM ${top[0]!.amountMyr} · ${top[0]!.status}` };
          cond = textLike(top[0]!.id);
        } else if (/^addr_test1[0-9a-z]+$/.test(q)) {
          const owner = sessRows.find((r) => r.address === q);
          if (q === user.treasuryAddress) {
            match = { type: "address", value: q, label: "Your treasury" };
            // Everything that moved money in or out of the treasury.
            cond = and(ownScope, or(like(events.dataJson, `%${q}%`), inArray(events.type, ["session_funded", "close_confirmed", "close_submitted", "topup_pending", "topup_submitted", "topup_confirmed", "deposit_seen"])));
            extra = stakingRows();
          } else if (owner) {
            match = { type: "address", value: q, label: `Session ${owner.letter} wallet · ${owner.role}` };
            cond = and(ownScope, or(eq(events.sessionId, owner.id), like(events.dataJson, `%${q}%`)));
          } else {
            match = { type: "address", value: q, label: "Address" };
            cond = textLike(q);
          }
        } else if (/^addr1/.test(q)) {
          throw httpError(400, "mainnet addresses are not used here (preprod only)");
        } else {
          match = { type: "text", value: q };
          cond = and(ownScope, or(like(events.dataJson, `%${q}%`), like(events.sessionId, `${q}%`), like(events.goalId, `${q}%`)));
        }
      }
    } else {
      cond = goalId ? and(ownScope, or(eq(events.goalId, goalId), inArray(events.type, ["topup_pending", "topup_submitted", "topup_confirmed", "deposit_seen"]))) : ownScope;
      extra = stakingRows();
    }

    // ── scan events (newest first), map, collapse ──
    const collapse = !qRaw;
    const scanCap = Math.min(4000, limit * (collapse ? 8 : 3));
    const where = Number.isFinite(before) ? and(cond, lt(events.id, before)) : cond;
    const raw = db.select().from(events).where(where).orderBy(desc(events.id)).limit(scanCap).all();
    const seen = new Map<string, ActivityRowDTO>();
    const rows: ActivityRowDTO[] = [];
    let lastScanned: number | null = null;
    let broke = false;
    for (const ev of raw) {
      lastScanned = ev.id;
      const row = eventToRow(rowToEvent(ev), sess);
      if (!row) continue;
      if (collapse && row.collapseKey) {
        const prev = seen.get(row.collapseKey);
        if (prev) {
          // Newer row already in place: carry over any tx hash it lacks.
          if (!prev.txHash && row.txHash) prev.txHash = row.txHash;
          continue;
        }
        seen.set(row.collapseKey, row);
      }
      delete (row as { collapseKey?: string }).collapseKey;
      if (kinds && !kinds.has(row.kind)) continue;
      rows.push(row);
      if (rows.length >= limit) {
        broke = true;
        break;
      }
    }
    const firstPage = !Number.isFinite(before);
    if (firstPage) for (const x of extra) if (!kinds || kinds.has(x.kind)) rows.push(x);
    rows.sort((a, b) => b.at - a.at || (b.eventId ?? 0) - (a.eventId ?? 0));
    const out = rows.slice(0, limit);
    const more = broke || raw.length >= scanCap;

    // ── enrich with the current state of payments / decisions / top-ups / jobs ──
    const ids = (k: keyof ActivityRowDTO) => [...new Set(out.map((r) => r[k]).filter((v): v is string => typeof v === "string"))];
    const payIds = ids("paymentId");
    const payMap = new Map(payIds.length ? db.select().from(payments).where(inArray(payments.id, payIds)).all().map((p) => [p.id, p]) : []);
    const decIds = ids("decisionId");
    const decMap = new Map(decIds.length ? db.select().from(decisionsT).where(inArray(decisionsT.id, decIds)).all().map((d) => [d.id, d]) : []);
    const jobIds = ids("agentJobId");
    const jobMap = new Map(jobIds.length ? db.select().from(agentJobs).where(inArray(agentJobs.id, jobIds)).all().map((j) => [j.id, j]) : []);
    for (const r of out) {
      if (collapse && r.kind === "payment" && r.paymentId) {
        const p = payMap.get(r.paymentId);
        if (p) {
          r.status = p.status === "submitted" ? "pending" : p.status;
          r.txHash = r.txHash ?? p.txHash;
          if (p.status === "rejected") r.title = `${r.title} — rejected${p.rejectionReason ? `: ${p.rejectionReason}` : ""}`;
        }
      }
      if (collapse && r.kind === "decision" && r.decisionId) {
        const d = decMap.get(r.decisionId);
        if (d) r.status = d.status;
      }
      if (collapse && r.kind === "hire" && r.agentJobId) {
        const j = jobMap.get(r.agentJobId);
        if (j) {
          r.status = j.status;
          if (!r.paymentId && j.paymentId) r.paymentId = j.paymentId;
        }
      }
      if (r.kind === "hire" && !r.txHash && r.paymentId) r.txHash = payMap.get(r.paymentId)?.txHash ?? null;
    }

    // ── live confirmations for the newest tx hashes ──
    const hashes = [...new Set(out.map((r) => r.txHash).filter((h): h is string => !!h && HEX64.test(h)))].slice(0, qRaw ? 25 : 10);
    const confs = new Map(await Promise.all(hashes.map(async (h) => [h, await confirmationsOf(h)] as const)));
    for (const r of out) {
      if (!r.txHash) continue;
      const cf = confs.get(r.txHash);
      if (cf !== undefined) r.confirmations = cf;
      if (cf && cf > 0 && r.status === "pending" && (r.kind === "staking" || r.kind === "topup")) r.status = "confirmed";
    }

    const evIds = out.map((r) => r.eventId).filter((v): v is number => typeof v === "number");
    const nextBefore = more && lastScanned !== null ? (rows.length > limit && evIds.length ? Math.min(...evIds) : lastScanned) : null;
    const body: ActivityDTO = { rows: out, match, nextBefore };
    return c.json(toJsonSafe(body) as object);
  });

  return app;
}
