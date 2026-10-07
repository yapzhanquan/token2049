// Treasury autopilot: keeps the custodial treasuries of delegated (auto-funded) engine users stocked from ONE
// custodial funding account, inside a standing 24 h cap — so a paid Sokosumi task / Standard API job never waits for
// a human to move tUSDM + tADA by hand (the incident fixed manually with scripts/fund-crew-treasury.ts).
//
//  Config (env, see treasuryAutopilotConfigFromEnv):
//    TREASURY_AUTOPILOT=off                    disable (default on)
//    TREASURY_AUTOPILOT_SOURCE_USER            email or id of the custodial funding account (default zq@demo.bulkhead.local)
//    TREASURY_AUTOPILOT_TARGETS                comma list of emails / ids (default AUTO_FUND_USER_EMAILS); "none" = nobody
//    TREASURY_AUTOPILOT_LOW_TUSDM / _LOW_ADA   low-water marks (default 5 / 15)
//    TREASURY_AUTOPILOT_REFILL_TUSDM / _REFILL_ADA   refill-to levels (default 20 / 40)
//    TREASURY_AUTOPILOT_CAP_TUSDM / _CAP_ADA   hard standing cap per rolling 24 h, all targets together (default 200 / 200)
//    TREASURY_AUTOPILOT_CHECK_MS               periodic low-water check (default 60 000; 0 = off)
//
//  Triggers: (a) the goal reconciler / auto-fund hits a shortfall for a target → ensure() refills right away, sized to
//  top the treasury up to max(need, refill level), waits for confirmation, then the reconciler funds the goal in the
//  same pass; (b) every TREASURY_AUTOPILOT_CHECK_MS targets are kept above their low-water marks.
//
//  Rules: never refill a self-custody account and never draw from a self-custody source (those need the user's wallet
//  signature); never exceed the 24 h cap — instead ONE clear escalation with the exact amount needed. A refill is ONE
//  custodial treasury tx through chain.tx.fundSessions (TreasuryQueue keyed by the source address → never races other
//  submits of the same wallet) carrying a CIP-20 label-674 memo (each msg line ≤ 64 bytes; bundled docs
//  cips/CIP-0020/README.md), plus a `treasury_refill` event {from,to,amounts,tx,reason,status}. A pending refill is
//  persisted in kv (per target), so neither concurrent triggers nor a restart can double-refill; the cap ledger is in
//  kv too (restart-safe).
import { eq } from "drizzle-orm";
import { kv, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { microToTusd, tusdToMicro } from "@bulkhead/shared";
import type { EventBus } from "./contracts";
import { assetLabelFromUnit } from "./sessions";
import { isFinal, keyedMutex, requiredConfirmations, waitForTx, type RuntimeConfig } from "./sessions-store";

export const DEFAULT_AUTOPILOT_SOURCE = "zq@demo.bulkhead.local";
const DAY_MS = 24 * 60 * 60_000;
/** Lovelace counted against the cap for the refill output's own min-ADA (the builder adds it; conservative). */
const OUTPUT_ADA_ALLOWANCE = 2_000_000n;
/** What the source must keep beyond the refill: fee + change output min-ADA (conservative). */
const SOURCE_ADA_MARGIN = 1_000_000n;

export interface TreasuryAutopilotConfig {
  enabled: boolean;
  /** Email (case-insensitive) or user id of the custodial funding account. */
  source: string;
  /** Emails (lowercase) or user ids of the auto-refilled accounts. */
  targets: string[];
  lowTusdMicro: bigint;
  lowLovelace: bigint;
  refillTusdMicro: bigint;
  refillLovelace: bigint;
  capTusdMicro: bigint;
  capLovelace: bigint;
  windowMs: number;
  /** Periodic low-water check (0 = only on demand). */
  checkMs: number;
  /** A pending refill tx not on chain after this long is treated as dropped (its TTL — 900 slots — has passed). */
  pendingStaleMs: number;
}

const amount = (raw: string | undefined, fallback: string): bigint => {
  try {
    return tusdToMicro((raw ?? "").trim() || fallback);
  } catch {
    return tusdToMicro(fallback);
  }
};

export function treasuryAutopilotConfigFromEnv(env: NodeJS.ProcessEnv, autoFundUserEmails: string[] = []): TreasuryAutopilotConfig {
  const off = /^(0|off|false|no|disabled?)$/i.test(env.TREASURY_AUTOPILOT?.trim() ?? "");
  const rawTargets = env.TREASURY_AUTOPILOT_TARGETS?.trim();
  const targets = rawTargets === undefined || rawTargets === "" ? autoFundUserEmails : rawTargets.toLowerCase() === "none" ? [] : rawTargets.split(",");
  const checkMs = Number(env.TREASURY_AUTOPILOT_CHECK_MS ?? 60_000);
  return {
    enabled: !off,
    source: (env.TREASURY_AUTOPILOT_SOURCE_USER?.trim() || DEFAULT_AUTOPILOT_SOURCE).toLowerCase(),
    targets: targets.map((t) => t.trim().toLowerCase()).filter(Boolean),
    lowTusdMicro: amount(env.TREASURY_AUTOPILOT_LOW_TUSDM, "5"),
    lowLovelace: amount(env.TREASURY_AUTOPILOT_LOW_ADA, "15"),
    refillTusdMicro: amount(env.TREASURY_AUTOPILOT_REFILL_TUSDM, "20"),
    refillLovelace: amount(env.TREASURY_AUTOPILOT_REFILL_ADA, "40"),
    capTusdMicro: amount(env.TREASURY_AUTOPILOT_CAP_TUSDM, "200"),
    capLovelace: amount(env.TREASURY_AUTOPILOT_CAP_ADA, "200"),
    windowMs: DAY_MS,
    checkMs: Number.isFinite(checkMs) && checkMs >= 0 ? checkMs : 60_000,
    pendingStaleMs: 20 * 60_000,
  };
}

type UserRow = typeof users.$inferSelect;

export type EnsureResult =
  | { status: "sufficient" }
  | { status: "refilled"; txHash: string }
  /** Submitted (wait: false) or still unconfirmed after the wait. */
  | { status: "pending"; txHash: string | null }
  | {
      status: "blocked";
      reason: "cap" | "source_low" | "self_custody" | "not_target" | "no_source" | "disabled" | "failed";
      message: string;
      /** Exact amount still needed on the target treasury (what a human would have to send). */
      neededTusdMicro: bigint;
      neededLovelace: bigint;
    };

export interface EnsureArgs {
  userId: string;
  /** What the target treasury must hold (0 = only keep it above low-water). */
  needTusdMicro?: bigint;
  needLovelace?: bigint;
  goalId?: string;
  reason: string;
  /** Wait for the refill to confirm (reconciler: then fund in the same pass). */
  wait?: boolean;
}

export interface AutopilotReport {
  checked: number;
  refilled: string[];
  blocked: string[];
}

export interface TreasuryAutopilot {
  readonly config: TreasuryAutopilotConfig;
  start(): void;
  stop(): void;
  /** True when this user's treasury is refilled automatically (custodial target, custodial source available). */
  covers(user: Pick<UserRow, "id" | "email" | "custody">): boolean;
  ensure(args: EnsureArgs): Promise<EnsureResult>;
  /** One periodic low-water pass over every target (exposed for tests / boot). */
  tick(): Promise<AutopilotReport>;
  /** Ask the goal reconciler to run soon (a shortfall was seen somewhere). */
  nudge(): void;
  /** Sum of refills counted against the cap in the current window. */
  usage(): { tusdMicro: bigint; lovelace: bigint };
}

export interface TreasuryAutopilotDeps {
  db: DB;
  bus: EventBus;
  chain: Chain;
  config: TreasuryAutopilotConfig;
  runtime: Pick<RuntimeConfig, "now" | "txConfirmTimeoutMs" | "txPollMs">;
  /** Wakes the goal reconciler (wired to runtime.goalFunding.nudge()). */
  reconcile?: () => void;
}

// One autopilot per engine DB: goal-funding.ts finds it without new plumbing through the API / runtime layers.
const registry = new WeakMap<DB, TreasuryAutopilot>();
export const autopilotFor = (db: DB): TreasuryAutopilot | undefined => registry.get(db);

interface LedgerEntry {
  at: number;
  tx: string | null;
  to: string;
  tusdMicro: string;
  /** Lovelace counted against the cap (extra lovelace + the output's min-ADA allowance). */
  lovelace: string;
  status: "submitting" | "submitted" | "confirmed";
}
interface PendingRefill {
  tx: string | null;
  at: number;
  tusdMicro: string;
  lovelace: string;
  reason: string;
  goalId?: string;
}

const LEDGER_KEY = (sourceId: string) => `treasury_autopilot:ledger:${sourceId}`;
const PENDING_KEY = (targetId: string) => `treasury_autopilot:pending:${targetId}`;
const PENDING_PREFIX = "treasury_autopilot:pending:";
const BLOCKED_KEY = (targetId: string) => `treasury_autopilot:blocked:${targetId}`;

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ada = (l: bigint) => microToTusd(l);
/** CIP-20: every msg line ≤ 64 bytes UTF-8. */
const line64 = (s: string) => {
  let out = s;
  while (Buffer.byteLength(out, "utf8") > 64) out = out.slice(0, -1);
  return out;
};

export function createTreasuryAutopilot(deps: TreasuryAutopilotDeps): TreasuryAutopilot {
  const { db, bus, chain, config: cfg, runtime } = deps;
  const now = () => runtime.now();
  const lock = keyedMutex();
  const finalizers = new Map<string, Promise<boolean>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<AutopilotReport> | null = null;
  let stopped = false;

  const ticker = () => {
    try {
      return assetLabelFromUnit(chain.tx.tusdUnit());
    } catch {
      return "tUSD";
    }
  };

  // ── kv helpers ──
  const kvGet = <T>(key: string): T | null => {
    const v = db.select().from(kv).where(eq(kv.key, key)).get()?.value;
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  };
  const kvSet = (key: string, value: unknown) => {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    db.insert(kv).values({ key, value: v }).onConflictDoUpdate({ target: kv.key, set: { value: v } }).run();
  };
  const kvDel = (key: string) => void db.delete(kv).where(eq(kv.key, key)).run();

  // ── users ──
  const findUser = (ref: string): UserRow | undefined => {
    const r = ref.trim();
    return db.select().from(users).where(eq(users.id, r)).get() ?? db.select().from(users).where(eq(users.email, r.toLowerCase())).get();
  };
  const isTarget = (u: Pick<UserRow, "id" | "email">) => cfg.targets.includes(u.id.toLowerCase()) || cfg.targets.includes(u.email.toLowerCase());
  const party = (u: UserRow) => ({ userId: u.id, email: u.email, address: u.treasuryAddress });

  // ── cap ledger (rolling window, per source) ──
  const ledger = (sourceId: string): LedgerEntry[] => (kvGet<LedgerEntry[]>(LEDGER_KEY(sourceId)) ?? []).filter((e) => now() - e.at < cfg.windowMs);
  const saveLedger = (sourceId: string, entries: LedgerEntry[]) => kvSet(LEDGER_KEY(sourceId), entries.filter((e) => now() - e.at < cfg.windowMs));
  const used = (sourceId: string) =>
    ledger(sourceId).reduce((a, e) => ({ tusdMicro: a.tusdMicro + BigInt(e.tusdMicro), lovelace: a.lovelace + BigInt(e.lovelace) }), { tusdMicro: 0n, lovelace: 0n });

  const sourceRow = (): UserRow | undefined => findUser(cfg.source);

  /** Why the autopilot cannot serve this user (null = it can). */
  function refusal(u: Pick<UserRow, "id" | "email" | "custody">): { reason: Extract<EnsureResult, { status: "blocked" }>["reason"]; message: string } | null {
    if (!cfg.enabled) return { reason: "disabled", message: "the treasury autopilot is disabled (TREASURY_AUTOPILOT=off)" };
    if (!isTarget(u)) return { reason: "not_target", message: `${u.email} is not a treasury autopilot target (TREASURY_AUTOPILOT_TARGETS)` };
    if (u.custody !== "custodial") return { reason: "self_custody", message: `${u.email} is a self-custody account: only its own wallet can fund it` };
    const src = sourceRow();
    if (!src) return { reason: "no_source", message: `the autopilot funding account ${cfg.source} does not exist` };
    if (src.custody !== "custodial") return { reason: "self_custody", message: `the autopilot funding account ${src.email} is self-custody: the autopilot never draws from a wallet that must sign` };
    if (src.id === u.id) return { reason: "not_target", message: "the funding account cannot refill itself" };
    return null;
  }

  /** One `error` notice per (target, reason) until a refill succeeds (kv-persisted, survives restarts). */
  function noteBlocked(target: UserRow, r: Extract<EnsureResult, { status: "blocked" }>, emit: boolean, goalId?: string) {
    const key = BLOCKED_KEY(target.id);
    if (kvGet<{ reason: string }>(key)?.reason === r.reason) return;
    kvSet(key, { reason: r.reason, at: now() });
    if (!emit) return;
    const src = sourceRow();
    bus.emit("error", {
      ...(goalId ? { goalId } : {}),
      data: {
        kind: "autopilot_funding_blocked",
        reason: r.reason,
        error: r.message,
        neededTusdMicro: r.neededTusdMicro.toString(),
        neededLovelace: r.neededLovelace.toString(),
        to: party(target),
        ...(src ? { from: party(src) } : {}),
      },
    });
  }

  function emitRefill(status: "submitted" | "confirmed", p: { from: UserRow; to: UserRow; tusdMicro: bigint; extraLovelace: bigint; tx: string; reason: string; goalId?: string }) {
    const use = used(p.from.id);
    bus.emit("treasury_refill", {
      ...(p.goalId ? { goalId: p.goalId } : {}),
      data: {
        status,
        from: party(p.from),
        to: party(p.to),
        amounts: { tusdMicro: p.tusdMicro.toString(), lovelace: p.extraLovelace.toString(), tusd: microToTusd(p.tusdMicro), ada: ada(p.extraLovelace), ticker: ticker() },
        tx: p.tx,
        txHash: p.tx,
        reason: p.reason,
        cap: { tusdMicro: cfg.capTusdMicro.toString(), lovelace: cfg.capLovelace.toString(), usedTusdMicro: use.tusdMicro.toString(), usedLovelace: use.lovelace.toString(), windowHours: Math.round(cfg.windowMs / 3_600_000) },
      },
    });
  }

  /** The refill tx confirmed: clear the pending marker, mark the ledger, announce, wake the reconciler. */
  function confirmed(targetId: string, tx: string) {
    const p = kvGet<PendingRefill>(PENDING_KEY(targetId));
    if (p?.tx !== tx) return; // already handled (another finalizer / a restart)
    kvDel(PENDING_KEY(targetId));
    kvDel(BLOCKED_KEY(targetId));
    const src = sourceRow();
    const to = db.select().from(users).where(eq(users.id, targetId)).get();
    if (src) saveLedger(src.id, ledger(src.id).map((e) => (e.tx === tx ? { ...e, status: "confirmed" as const } : e)));
    if (src && to) emitRefill("confirmed", { from: src, to, tusdMicro: BigInt(p.tusdMicro), extraLovelace: BigInt(p.lovelace), tx, reason: p.reason, goalId: p.goalId });
    deps.reconcile?.();
  }

  /** Wait (once per tx) for the refill to reach CONFIRMATIONS depth. */
  function track(targetId: string, tx: string): Promise<boolean> {
    const cur = finalizers.get(tx);
    if (cur) return cur;
    const p = waitForTx(chain, tx, { timeoutMs: runtime.txConfirmTimeoutMs, pollMs: runtime.txPollMs })
      .then((ok) => {
        if (ok && !stopped) {
          try {
            confirmed(targetId, tx);
          } catch {
            /* DB closed during shutdown: the restart re-checks the pending marker */
          }
        }
        return ok;
      })
      .finally(() => finalizers.delete(tx));
    finalizers.set(tx, p);
    return p;
  }

  /** State of a persisted pending refill: confirmed on chain, dropped (stale), or still pending. */
  async function pendingState(targetId: string, p: PendingRefill): Promise<"confirmed" | "stale" | "pending"> {
    if (p.tx) {
      const c = await chain.provider.fetchTxConfirmation(p.tx).catch(() => null);
      if (isFinal(c, requiredConfirmations(chain))) {
        confirmed(targetId, p.tx);
        return "confirmed";
      }
    }
    if (now() - p.at > cfg.pendingStaleMs) {
      kvDel(PENDING_KEY(targetId));
      const src = sourceRow();
      // A submitted tx past its TTL can never land: it no longer counts against the cap. A marker WITHOUT a tx hash
      // (crash between submit and record) stays counted — the conservative side of the cap.
      if (src && p.tx) saveLedger(src.id, ledger(src.id).filter((e) => e.tx !== p.tx));
      bus.emit("error", { ...(p.goalId ? { goalId: p.goalId } : {}), data: { kind: "autopilot_refill_dropped", txHash: p.tx, error: `treasury autopilot refill ${p.tx ?? "(unrecorded)"} did not confirm; retrying`, to: { userId: targetId } } });
      return "stale";
    }
    return "pending";
  }

  async function ensureOnce(a: EnsureArgs): Promise<EnsureResult> {
    const target = db.select().from(users).where(eq(users.id, a.userId)).get();
    const needT = a.needTusdMicro ?? 0n;
    const needL = a.needLovelace ?? 0n;
    if (!target) return { status: "blocked", reason: "not_target", message: `user ${a.userId} not found`, neededTusdMicro: needT, neededLovelace: needL };
    const why = refusal(target);
    if (why) return { status: "blocked", ...why, neededTusdMicro: needT, neededLovelace: needL };
    const source = sourceRow()!;

    // 1. A refill already in flight for this target: never a second one.
    const pending = kvGet<PendingRefill>(PENDING_KEY(target.id));
    if (pending) {
      const st = await pendingState(target.id, pending);
      if (st === "pending") {
        if (!a.wait || !pending.tx) return { status: "pending", txHash: pending.tx };
        if (!(await track(target.id, pending.tx))) return { status: "pending", txHash: pending.tx };
      }
    }

    // 2. Size the refill: top up to max(need, refill level) for every asset below need or low-water.
    const have = await chain.tx.balanceOf(target.treasuryAddress);
    const plan = (h: bigint, need: bigint, low: bigint, refill: bigint) => {
      if (!(h < need || h < low)) return { send: 0n, min: 0n };
      const to = max(need, refill);
      return { send: to > h ? to - h : 0n, min: need > h ? need - h : 0n };
    };
    const t = plan(have.tusdMicro, needT, cfg.lowTusdMicro, cfg.refillTusdMicro);
    const l = plan(have.lovelace, needL, cfg.lowLovelace, cfg.refillLovelace);
    if (t.send === 0n && l.send === 0n) {
      kvDel(BLOCKED_KEY(target.id));
      return { status: "sufficient" };
    }
    const T = ticker();

    // 3. The standing cap (rolling window, every target together). A shortfall must fit whole; a low-water refill
    //    may be trimmed to what the cap still allows.
    const use = used(source.id);
    const remT = cfg.capTusdMicro > use.tusdMicro ? cfg.capTusdMicro - use.tusdMicro : 0n;
    const remL = cfg.capLovelace > use.lovelace ? cfg.capLovelace - use.lovelace : 0n;
    const sendT = min(t.send, remT);
    const sendL = remL > OUTPUT_ADA_ALLOWANCE ? min(l.send, remL - OUTPUT_ADA_ALLOWANCE) : 0n;
    const capBlocked = sendT < t.min || sendL < l.min || remL < OUTPUT_ADA_ALLOWANCE || (sendT === 0n && sendL === 0n);
    const neededT = t.min > 0n ? t.min : t.send;
    const neededL = l.min > 0n ? l.min : l.send;
    const owed = [neededT > 0n ? `${microToTusd(neededT)} ${T}` : "", neededL > 0n ? `${ada(neededL)} tADA` : ""].filter(Boolean).join(" + ") || `0 ${T}`;
    if (capBlocked) {
      const r: Extract<EnsureResult, { status: "blocked" }> = {
        status: "blocked",
        reason: "cap",
        message:
          `Treasury autopilot stopped at its 24 h standing cap (${microToTusd(cfg.capTusdMicro)} ${T} / ${ada(cfg.capLovelace)} tADA; ` +
          `${microToTusd(use.tusdMicro)} ${T} / ${ada(use.lovelace)} tADA already used). ${target.email}'s treasury needs ${owed} more` +
          `${a.goalId ? ` for goal ${a.goalId}` : ""}: send ${owed} to ${target.treasuryAddress}, or raise TREASURY_AUTOPILOT_CAP_TUSDM / _CAP_ADA. ` +
          `Waiting work starts automatically once it is funded.`,
        neededTusdMicro: neededT,
        neededLovelace: neededL,
      };
      noteBlocked(target, r, !a.goalId, a.goalId);
      return r;
    }

    // 4. The source must hold it (plus fee + change margin).
    const src = await chain.tx.balanceOf(source.treasuryAddress);
    const srcNeedL = sendL + OUTPUT_ADA_ALLOWANCE + SOURCE_ADA_MARGIN;
    if (src.tusdMicro < sendT || src.lovelace < srcNeedL) {
      const r: Extract<EnsureResult, { status: "blocked" }> = {
        status: "blocked",
        reason: "source_low",
        message:
          `Treasury autopilot cannot refill ${target.email}: the funding account ${source.email} holds ${microToTusd(src.tusdMicro)} ${T} / ${ada(src.lovelace)} tADA ` +
          `but the refill needs ${microToTusd(sendT)} ${T} / ${ada(srcNeedL)} tADA. Top up ${source.treasuryAddress}, or send ${owed} to ${target.treasuryAddress}.`,
        neededTusdMicro: neededT,
        neededLovelace: neededL,
      };
      noteBlocked(target, r, !a.goalId, a.goalId);
      return r;
    }

    // 5. Submit: intent first (a crash mid-submit never leads to a second refill), then ONE treasury tx.
    const counted = sendL + OUTPUT_ADA_ALLOWANCE;
    const at = now();
    const marker: PendingRefill = { tx: null, at, tusdMicro: sendT.toString(), lovelace: sendL.toString(), reason: a.reason, ...(a.goalId ? { goalId: a.goalId } : {}) };
    kvSet(PENDING_KEY(target.id), marker);
    saveLedger(source.id, [...ledger(source.id), { at, tx: null, to: target.id, tusdMicro: sendT.toString(), lovelace: counted.toString(), status: "submitting" }]);
    let txHash: string;
    try {
      const res = await chain.tx.fundSessions({
        userId: source.id,
        outputs: [{ address: target.treasuryAddress, tusdMicro: sendT, extraLovelace: sendL }],
        metadata: {
          msg: [
            line64("Bulkhead treasury autopilot refill"),
            line64(`to ${target.email}`),
            line64(`+${microToTusd(sendT)} ${T} +${ada(sendL)} tADA (cap ${microToTusd(cfg.capTusdMicro)}/24h)`),
            line64(`reason: ${a.reason}`),
          ],
        },
      });
      txHash = res.txHash;
    } catch (e) {
      kvDel(PENDING_KEY(target.id));
      saveLedger(source.id, ledger(source.id).filter((x) => !(x.at === at && x.tx === null && x.to === target.id)));
      const msg = e instanceof Error ? e.message : String(e);
      bus.emit("error", { ...(a.goalId ? { goalId: a.goalId } : {}), data: { kind: "autopilot_funding_failed", error: `treasury autopilot refill of ${target.email} failed: ${msg}`, to: party(target), from: party(source) } });
      return { status: "blocked", reason: "failed", message: `treasury autopilot refill failed: ${msg}`, neededTusdMicro: neededT, neededLovelace: neededL };
    }
    kvSet(PENDING_KEY(target.id), { ...marker, tx: txHash });
    saveLedger(source.id, ledger(source.id).map((x) => (x.at === at && x.tx === null && x.to === target.id ? { ...x, tx: txHash, status: "submitted" as const } : x)));
    emitRefill("submitted", { from: source, to: target, tusdMicro: sendT, extraLovelace: sendL, tx: txHash, reason: a.reason, goalId: a.goalId });
    const done = track(target.id, txHash);
    if (!a.wait) return { status: "pending", txHash };
    return (await done) ? { status: "refilled", txHash } : { status: "pending", txHash };
  }

  const ap: TreasuryAutopilot = {
    config: cfg,
    covers(u) {
      return refusal(u) === null;
    },
    ensure(a) {
      return lock(`target:${a.userId}`, () => ensureOnce(a));
    },
    usage() {
      const src = sourceRow();
      return src ? used(src.id) : { tusdMicro: 0n, lovelace: 0n };
    },
    nudge() {
      if (stopped || nudgeTimer || !deps.reconcile) return;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        if (!stopped) deps.reconcile?.();
      }, 250);
      nudgeTimer.unref?.();
    },
    tick() {
      if (running) return running;
      running = (async () => {
        const report: AutopilotReport = { checked: 0, refilled: [], blocked: [] };
        if (!cfg.enabled) return report;
        const seen = new Set<string>();
        for (const ref of cfg.targets) {
          const u = findUser(ref);
          if (!u || seen.has(u.id) || !ap.covers(u)) continue;
          seen.add(u.id);
          report.checked++;
          try {
            const r = await ap.ensure({ userId: u.id, reason: "low-water check", wait: false });
            if (r.status === "pending" && r.txHash) report.refilled.push(u.id);
            if (r.status === "blocked") report.blocked.push(u.id);
          } catch (e) {
            bus.emit("error", { data: { kind: "autopilot_check_failed", error: e instanceof Error ? e.message : String(e), to: party(u) } });
          }
        }
        return report;
      })().finally(() => {
        running = null;
      });
      return running;
    },
    start() {
      stopped = false;
      registry.set(db, ap);
      if (!cfg.enabled || timer) return;
      // Resume: a refill submitted before a restart is tracked again (never re-sent).
      for (const row of db.select().from(kv).all()) {
        if (!row.key.startsWith(PENDING_PREFIX)) continue;
        const p = kvGet<PendingRefill>(row.key);
        if (p?.tx) void track(row.key.slice(PENDING_PREFIX.length), p.tx);
      }
      if (cfg.checkMs > 0) {
        timer = setInterval(() => void ap.tick().catch(() => undefined), cfg.checkMs);
        timer.unref?.();
      }
      // Any funding shortfall a covered user hits (approve route, spawn top-up, …) wakes the reconciler, which
      // refills through ensure() and funds in the same pass.
      unsub = bus.subscribe((e) => {
        if (e.type !== "error" || !e.goalId || e.data.kind === "funding_stalled" || String(e.data.kind ?? "").startsWith("autopilot_")) return;
        if (!/insufficient|shortfall|top up first|cannot cover/i.test(`${String(e.data.code ?? "")} ${String(e.data.message ?? "")} ${String(e.data.error ?? "")}`)) return;
        ap.nudge();
      });
      void ap.tick().catch(() => undefined);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = null;
      unsub?.();
      unsub = null;
      if (registry.get(db) === ap) registry.delete(db);
    },
  };
  // Registered at creation so the goal reconciler / auto-fund use it even before start() (tests, boot order).
  registry.set(db, ap);
  return ap;
}
