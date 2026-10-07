// /bearings — Firstmate's "pick up where I left off" digest, rebuilt from bounded DB + chain state every time (never
// a delta, never scraped from chat). Deterministic: no LLM is needed; ?judge=1 lets the captain re-word ONE overall
// line from the computed facts (validated in wording.ts). Read-only, except POST /bearings/file, which writes exactly
// one dated markdown report under data/reports/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { explorerTx, microToTusd, type BearingsDTO, type BearingsItem, type BearingsMoney, type Handback, type ReportEvidence } from "@bulkhead/shared";
import { events, goals, kv, payments, sessions as sessionsT, dbPath, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { and, desc, eq, gt, inArray, like } from "drizzle-orm";
import type { DecisionLedger, EventBus, LLM } from "../contracts";
import { sha256Hex } from "../sessions-store";
import { assessDecision, rankDecisions } from "./assess";
import { riskForSession, ticker } from "./reports";
import { wordLine } from "./wording";

export interface BearingsDeps {
  db: DB;
  bus: EventBus;
  chain: Chain;
  decisions: DecisionLedger;
  llm?: LLM | null;
  /** Self-custody signatures the engine waits for (SigningBroker.list). */
  pendingSignatures?: (userId: string) => { pendingId: string; purpose: string; txHash: string; goalId?: string; sessionId?: string; createdAt: number }[];
  now?: () => number;
  /** Where POST /bearings/file writes (default: <dir of DATABASE_PATH>/reports, i.e. data/reports). */
  reportsDir?: string;
}

type SessionDb = typeof sessionsT.$inferSelect;
type GoalDb = typeof goals.$inferSelect;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};
const parse = <T>(s: string | null | undefined, fb: T): T => {
  if (!s) return fb;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fb;
  }
};
const DAY = 86_400_000;
const LIMIT = 12;

/** Goals in scope: one goal, or the user's live goals + goals finished in the last 24 h (bounded). */
function scopeGoals(db: DB, userId: string, goalId: string | null, now: number): GoalDb[] {
  if (goalId) return db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId))).all();
  const rows = db.select().from(goals).where(eq(goals.userId, userId)).orderBy(desc(goals.createdAt)).limit(50).all();
  return rows
    .filter((g) => {
      if (g.status === "planned" || g.status === "approved" || g.status === "running") return true;
      if (g.status === "cancelled") return false;
      const last = db.select({ e: sessionsT.endedAt }).from(sessionsT).where(eq(sessionsT.goalId, g.id)).all().reduce((m, r) => Math.max(m, r.e ?? 0), g.createdAt);
      return now - last < DAY;
    })
    .slice(0, 10);
}

export async function buildBearings(deps: BearingsDeps, userId: string, goalId: string | null, opts: { judge?: boolean } = {}): Promise<BearingsDTO> {
  const { db, bus, chain } = deps;
  const now = (deps.now ?? Date.now)();
  const T = ticker();
  const gs = scopeGoals(db, userId, goalId, now);
  const goalIds = gs.map((g) => g.id);
  const rows: SessionDb[] = goalIds.length ? db.select().from(sessionsT).where(inArray(sessionsT.goalId, goalIds)).all() : [];
  const sids = new Set(rows.map((r) => r.id));
  const goalText = new Map(gs.map((g) => [g.id, g.goal]));
  const multi = gs.length > 1;
  const tag = (gid: string) => (multi ? ` [${clip(goalText.get(gid) ?? "", 40)}]` : "");

  // ── Needs you: open decisions (ranked by impact), plans awaiting approval, funding stalls, signatures ──
  const open = rankDecisions(
    deps.decisions
      .list({ status: "open" })
      .filter((d) => sids.has(d.sessionId))
      .map((d) => assessDecision({ db, bus, now: () => now }, d)),
  );
  const needsYou: BearingsItem[] = open.map((a) => ({
    text: `${a.question} Recommended: ${a.recommendation.action} — ${a.recommendation.why}${a.goalId ? tag(a.goalId) : ""}`,
    goalId: a.goalId ?? undefined,
    sessionId: a.sessionId,
    letter: a.letter ?? undefined,
    decisionId: a.decisionId,
    risk: a.risk,
    at: a.openedAt,
    refs: [],
    recommendation: a.recommendation,
  }));
  const blockedByDecision = new Set(open.map((a) => a.sessionId));
  for (const g of gs) {
    if (g.status === "planned") {
      const plan = parse<{ sessions?: { budgetTUSD?: string }[] }>(g.planJson, {});
      const n = plan.sessions?.length ?? 0;
      needsYou.push({ text: `The plan for "${clip(g.goal, 70)}" (${n} session${n === 1 ? "" : "s"}) waits for your "Approve & start" — nothing is funded until then.`, goalId: g.id, at: g.createdAt, refs: [], risk: "low" });
    }
    const stall = db.select().from(kv).where(eq(kv.key, `goal_stall:${g.id}`)).get()?.value;
    if (stall) needsYou.push({ text: `"${clip(g.goal, 60)}" cannot be funded: ${clip(stall.split("|").slice(1).join("|") || stall, 140)} Top up the treasury; waiting sessions start on their own.`, goalId: g.id, refs: [], risk: "medium" });
  }
  for (const p of deps.pendingSignatures?.(userId) ?? []) {
    if (goalId && p.goalId !== goalId && !(p.sessionId && sids.has(p.sessionId))) continue;
    needsYou.push({ text: `Sign in your wallet: ${clip(p.purpose, 120)}`, goalId: p.goalId, sessionId: p.sessionId, at: p.createdAt, refs: [{ label: "Unsigned tx", kind: "tx", ref: p.txHash }], risk: "low" });
  }

  // ── Done: closed sessions (newest first) + finished goals ──
  const done: BearingsItem[] = [];
  for (const g of gs.filter((x) => x.status === "done")) {
    const ss = rows.filter((r) => r.goalId === g.id);
    const met = ss.filter((r) => r.closeStatus === "COMPLETED").length;
    const spent = ss.reduce((a, r) => a + big(r.spentMicro), 0n);
    done.push({ text: `Goal "${clip(g.goal, 70)}" finished: ${met}/${ss.length} sessions met their definition of done; spent ${microToTusd(spent)} ${T}.`, goalId: g.id, refs: g.fundingTx ? [{ label: "Funding tx", kind: "tx", ref: g.fundingTx, url: explorerTx(g.fundingTx) }] : [] });
  }
  const closed = rows.filter((r) => r.status === "CLOSED").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const r of closed.slice(0, LIMIT)) {
    const h = parse<Handback | null>(r.handbackJson, null);
    const ok = r.closeStatus === "COMPLETED";
    const risk = riskForSession({
      session: r,
      handback: h,
      payments: db.select().from(payments).where(eq(payments.sessionId, r.id)).all(),
      events: bus.since(0, { sessionId: r.id }),
      attempt: Math.max(1, r.doneAttempts + (ok ? 1 : 0)),
    });
    const refs: ReportEvidence[] = [
      ...(r.closeTx ? [{ label: `Close tx (refund ${microToTusd(big(r.refundMicro))} ${T})`, kind: "tx" as const, ref: r.closeTx, url: explorerTx(r.closeTx) }] : []),
      ...(r.handbackSha256 || r.handbackJson ? [{ label: "Handback SHA-256", kind: "handback_hash" as const, ref: r.handbackSha256 ?? sha256Hex(r.handbackJson!), ...(r.closeTx ? { url: explorerTx(r.closeTx) } : {}) }] : []),
    ];
    done.push({
      text: `${r.letter} (${r.role}) ${ok ? "delivered" : `ended ${String(r.closeStatus ?? "closed").toLowerCase()}`}: ${clip((h?.summary ?? r.endReason ?? "no handback").replace(/\s+/g, " "), 110)} — risk ${risk.risk}${tag(r.goalId)}`,
      goalId: r.goalId,
      sessionId: r.id,
      letter: r.letter,
      risk: risk.risk,
      at: r.endedAt ?? undefined,
      refs,
    });
  }

  // ── In flight: everything still moving on its own (not waiting on the user) ──
  const inFlight: BearingsItem[] = [];
  const letterOf = new Map(rows.map((r) => [r.id, r.letter]));
  for (const r of rows.filter((x) => x.status !== "CLOSED" && !blockedByDecision.has(x.id)).sort((a, b) => a.letter.localeCompare(b.letter))) {
    const goal = gs.find((g) => g.id === r.goalId);
    if (goal?.status === "planned") continue; // the whole plan is under "needs you"
    const spentLine = `${microToTusd(big(r.spentMicro))}/${microToTusd(big(r.budgetMicro))} ${T}`;
    let text: string;
    switch (r.status) {
      case "RUNNING": {
        const last = lastProgress(bus, r.id);
        text = `${r.letter} (${r.role}) working${last ? `: ${clip(last, 100)}` : ""} (${spentLine})`;
        break;
      }
      case "PAUSED":
        text = `${r.letter} (${r.role}) paused — its spending is stopped until it is resumed`;
        break;
      case "FUNDING":
        text = `${r.letter} (${r.role}) funding tx submitted, waiting for confirmation`;
        break;
      case "PLANNED":
      case "AWAITING_APPROVAL": {
        const deps2 = parse<string[]>(r.contextFromJson, []).filter((id) => rows.find((x) => x.id === id)?.status !== "CLOSED");
        text = deps2.length
          ? `${r.letter} (${r.role}) queued: waits for ${deps2.map((id) => letterOf.get(id) ?? "?").join(", ")}'s handback`
          : `${r.letter} (${r.role}) queued: waiting for its funding / a free slot`;
        break;
      }
      case "COMPLETING":
        text = `${r.letter} (${r.role}) handed back; checking it against its definition of done`;
        break;
      case "QUARANTINED":
        text = `${r.letter} (${r.role}) quarantined; it closes on its own`;
        break;
      default:
        text = `${r.letter} (${r.role}) closing (${String(r.closeStatus ?? r.status).toLowerCase()}): sweeping leftover funds back to your treasury`;
    }
    inFlight.push({
      text: `${text}${tag(r.goalId)}`,
      goalId: r.goalId,
      sessionId: r.id,
      letter: r.letter,
      refs: [
        ...(r.status === "FUNDING" && r.fundingTx ? [{ label: "Funding tx", kind: "tx" as const, ref: r.fundingTx, url: explorerTx(r.fundingTx) }] : []),
        ...(r.closeTx ? [{ label: "Close tx", kind: "tx" as const, ref: r.closeTx, url: explorerTx(r.closeTx) }] : []),
      ],
    });
  }

  const money = await moneyOf({ db, chain }, gs, rows);
  const autopilot = autopilotRefills(db, userId, now);
  if (autopilot) money.autopilot = autopilot;
  const overallDraft = clip(
    `${needsYou.length ? `${needsYou.length} thing${needsYou.length === 1 ? "" : "s"} need${needsYou.length === 1 ? "s" : ""} you` : "Nothing needs you"}; ` +
      `${inFlight.length} in flight, ${done.length} done; ${money.spent} of ${money.budget} ${T} spent, ${money.returned} returned` +
      `${money.pendingTx ? `, ${money.pendingTx} tx pending` : ""}.`,
    200,
  );
  const overall = opts.judge
    ? await wordLine({ llm: deps.llm, bus }, "bearings", { needsYou: needsYou.map((n) => clip(n.text, 140)), inFlight: inFlight.length, done: done.length, money }, overallDraft, 200, goalId ?? undefined)
    : { text: overallDraft, source: "deterministic" as const };

  return {
    generatedAt: now,
    goalId,
    needsYou,
    done: done.slice(0, LIMIT),
    inFlight,
    money,
    overall,
    empty: { needsYou: "Nothing needs your action right now.", done: "Nothing has finished recently.", inFlight: "Nothing is in flight." },
  };
}

function lastProgress(bus: EventBus, sessionId: string): string | null {
  const evs = bus.since(0, { sessionId });
  for (let i = evs.length - 1; i >= 0 && i >= evs.length - 300; i--) {
    const e = evs[i];
    if (e.type === "progress" && typeof e.data.text === "string" && e.data.kind !== "log") return e.data.text.replace(/\s+/g, " ");
  }
  return null;
}

async function moneyOf(deps: { db: DB; chain: Chain }, gs: GoalDb[], rows: SessionDb[]): Promise<BearingsMoney> {
  const T = ticker();
  const committedGoals = gs.filter((g) => g.status !== "planned" && g.status !== "cancelled");
  const budget = committedGoals.reduce((a, g) => a + big(g.budgetMicro), 0n);
  const spent = rows.reduce((a, r) => a + big(r.spentMicro), 0n);
  const returned = rows.reduce((a, r) => a + big(r.refundMicro), 0n);
  const openFunded = rows.filter((r) => r.status !== "CLOSED" && r.address && r.fundingTx);
  let inVaults = 0n;
  let source: "chain" | "db" = "chain";
  const results = await Promise.all(openFunded.map((r) => withTimeout(deps.chain.tx.balanceOf(r.address!), 4_000).then((b) => b.tusdMicro).catch(() => null)));
  for (const [i, v] of results.entries()) {
    if (v === null) {
      source = "db";
      const r = openFunded[i];
      inVaults += big(r.budgetMicro) - big(r.spentMicro);
    } else inVaults += v;
  }
  const pendingTxs: ReportEvidence[] = [];
  const ids = rows.map((r) => r.id);
  const pays = ids.length ? deps.db.select().from(payments).where(and(inArray(payments.sessionId, ids), eq(payments.status, "submitted"))).all() : [];
  for (const p of pays) if (p.txHash) pendingTxs.push({ label: `Payment ${microToTusd(big(p.amountMicro))} ${T}`, kind: "tx", ref: p.txHash, url: explorerTx(p.txHash) });
  const fundingSeen = new Set<string>();
  for (const r of rows) {
    if (r.fundingTx && !r.fundingConfirmedAt && r.status === "FUNDING" && !fundingSeen.has(r.fundingTx)) {
      fundingSeen.add(r.fundingTx);
      pendingTxs.push({ label: "Funding tx", kind: "tx", ref: r.fundingTx, url: explorerTx(r.fundingTx) });
    }
    if (r.closeTx && r.status === "CLOSING") pendingTxs.push({ label: `${r.letter} close tx`, kind: "tx", ref: r.closeTx, url: explorerTx(r.closeTx) });
  }
  return {
    ticker: T,
    budget: microToTusd(budget),
    spent: microToTusd(spent),
    inVaults: microToTusd(inVaults < 0n ? 0n : inVaults),
    inVaultsSource: source,
    returned: microToTusd(returned),
    pendingTx: pendingTxs.length,
    pendingTxs,
  };
}

/** Treasury autopilot refills (treasury_refill events, latest state per tx) in the last 24 h touching this user. */
function autopilotRefills(db: DB, userId: string, now: number): BearingsMoney["autopilot"] | undefined {
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.type, "treasury_refill"), gt(events.at, now - DAY), like(events.dataJson, `%"userId":"${userId}"%`)))
    .orderBy(desc(events.id))
    .limit(200)
    .all();
  const byTx = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const d = parse<Record<string, unknown>>(r.dataJson, {});
    const tx = typeof d.tx === "string" ? d.tx : "";
    if (tx && !byTx.has(tx)) byTx.set(tx, d); // newest first: the latest status wins
  }
  if (!byTx.size) return undefined;
  let t = 0n;
  let l = 0n;
  let pending = 0;
  const txs: ReportEvidence[] = [];
  for (const [tx, d] of byTx) {
    const a = (d.amounts ?? {}) as Record<string, unknown>;
    t += big(a.tusdMicro);
    l += big(a.lovelace);
    if (d.status !== "confirmed") pending++;
    const to = (d.to ?? {}) as Record<string, unknown>;
    txs.push({ label: `Autopilot refill to ${String(to.email ?? "treasury")}${d.status === "confirmed" ? "" : " (pending)"}`, kind: "tx", ref: tx, url: explorerTx(tx) });
  }
  return { refills: byTx.size, tusd: microToTusd(t), ada: microToTusd(l), pending, txs };
}

// ───────────────────────────── file mode ─────────────────────────────
export function defaultReportsDir(): string {
  const p = dbPath();
  if (p === ":memory:" || p.startsWith("file:")) return resolve("data", "reports");
  return join(dirname(p), "reports");
}

export function renderBearingsMarkdown(b: BearingsDTO, meta: { goalText?: string | null } = {}): string {
  const d = new Date(b.generatedAt);
  const day = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const date = d.toISOString().slice(0, 10);
  const refLine = (refs: ReportEvidence[]) => (refs.length ? `\n  - ${refs.map((r) => (r.url ? `${r.label}: [${clip(r.ref, 24)}](${r.url})` : `${r.label}: \`${r.ref}\``)).join("\n  - ")}` : "");
  const section = (title: string, items: BearingsItem[], empty: string) =>
    `## ${title}\n\n${items.length ? items.map((i) => `- ${i.risk ? `**[${i.risk}]** ` : ""}${i.text}${refLine(i.refs)}`).join("\n") : empty}\n`;
  const m = b.money;
  return [
    `# Bearings - ${day} ${date}`,
    "",
    `${meta.goalText ? `Goal: "${meta.goalText}". ` : ""}${b.overall.text}`,
    "",
    section("Needs you", b.needsYou, b.empty.needsYou),
    section("Done", b.done, b.empty.done),
    section("In flight", b.inFlight, b.empty.inFlight),
    `## Money\n\n| Budget | Spent | In session vaults | Returned | Pending txs |\n|---|---|---|---|---|\n| ${m.budget} ${m.ticker} | ${m.spent} ${m.ticker} | ${m.inVaults} ${m.ticker} (${m.inVaultsSource}) | ${m.returned} ${m.ticker} | ${m.pendingTx} |\n` +
      (m.pendingTxs.length ? `\n${m.pendingTxs.map((t) => `- ${t.label}: [${clip(t.ref, 24)}](${t.url ?? ""})`).join("\n")}\n` : "") +
      (m.autopilot
        ? `\nTreasury autopilot (24 h): ${m.autopilot.refills} refill${m.autopilot.refills === 1 ? "" : "s"}, ${m.autopilot.tusd} ${m.ticker} + ${m.autopilot.ada} tADA${m.autopilot.pending ? ` (${m.autopilot.pending} pending)` : ""}.\n${m.autopilot.txs.map((t) => `- ${t.label}: [${clip(t.ref, 24)}](${t.url ?? ""})`).join("\n")}\n`
        : ""),
    `_Generated ${d.toISOString()} from the engine database and Cardano preprod; amounts in ${m.ticker}._`,
    "",
  ].join("\n");
}

/** Write (replace) today's dated bearings report. One file per day per user (and goal, when scoped). */
export function fileBearings(b: BearingsDTO, userId: string, opts: { dir?: string; goalText?: string | null } = {}): { path: string; file: string } {
  const dir = opts.dir ?? defaultReportsDir();
  mkdirSync(dir, { recursive: true });
  const date = new Date(b.generatedAt).toISOString().slice(0, 10);
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  const file = `bearings-${date}-${safe(userId)}${b.goalId ? `-${safe(b.goalId)}` : ""}.md`;
  const path = join(dir, file);
  writeFileSync(path, renderBearingsMarkdown(b, { goalText: opts.goalText }), "utf8");
  return { path, file };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

