// Shared runtime plumbing: config (env defaults), session row access, tx confirmation waits.
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { SessionStatus, TaskType, WalletMode } from "@bulkhead/shared";
import type { SessionRow } from "./contracts";

export interface RuntimeConfig {
  now: () => number;
  /** MAX_PARALLEL_SESSIONS (default 5): sessions with a live silo. Extra sessions queue in FUNDING. */
  maxParallelSessions: number;
  /** A real provider ("anthropic" / "openai") when its key is set; silos then route completions through the orchestrator. */
  llmMode: "anthropic" | "openai" | "mock";
  heartbeatMs: number;
  missedHeartbeats: number;
  supervisorTickMs: number;
  /** Override for the extra lovelace per session wallet; default: sessionFloatFor(taskType) in sessions.ts. */
  sessionFloatLovelace?: bigint;
  closeRetryBaseMs: number;
  closeRetryMaxMs: number;
  /** Emit an alert `error` event after this many failed close attempts (keeps retrying). */
  closeAlertAfter: number;
  /** Give up retrying (session stays CLOSING for reconcile / `pnpm recover`). */
  closeMaxAttempts: number;
  txConfirmTimeoutMs: number;
  txPollMs: number;
  /** reviewHandback waits this long for pending payments to confirm before judging. */
  doneConfirmWaitMs: number;
  jobPollMs: number;
  jobTimeoutMs: number;
  webFetchMaxBytes: number;
  webFetchTimeoutMs: number;
  /** Hostnames allowed even though they resolve to private IPs (dev only, e.g. the mock market). */
  allowPrivateHosts: string[];
  /** URLs matching these are "flagged untrusted" → QUARANTINED. */
  untrustedUrlPatterns: RegExp[];
  myrPerTusd: string;
  topupFeePct: string;
  /** Lovelace sent with every top-up (TOPUP_ADA, default 25 tADA; never below the spec's 2 ADA). */
  topupLovelace: bigint;
  marketUrl: string;
  /** Path of the silo child entry (default src/silo/child.ts). */
  childEntry?: string;
  /** WALLET_MODE (default "vault" since the on-chain layer passed verify:chain + e2e:preprod; "native" = fallback): wallet type for NEW sessions. "vault" = Bulkhead Session Vault
   * (on-chain enforcement). Self-custody users get vaults too: their wallet signs the unsigned vault funding (CIP-30),
   * falling back to "native" only when the chain cannot build unsigned vault funding (e.g. Koios). */
  walletMode: WalletMode;
}

export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  const marketUrl = env.MARKET_URL ?? "http://localhost:4100";
  let marketHost = "localhost";
  try {
    marketHost = new URL(marketUrl).hostname;
  } catch {
    /* keep default */
  }
  return {
    now: Date.now,
    maxParallelSessions: Number(env.MAX_PARALLEL_SESSIONS ?? 5) || 5,
    llmMode: env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "mock",
    heartbeatMs: 5_000,
    missedHeartbeats: 3,
    supervisorTickMs: 1_000,
    closeRetryBaseMs: 2_000,
    closeRetryMaxMs: 60_000,
    closeAlertAfter: 5,
    closeMaxAttempts: 30,
    txConfirmTimeoutMs: 10 * 60_000,
    txPollMs: 10_000,
    doneConfirmWaitMs: 5 * 60_000,
    jobPollMs: 3_000,
    jobTimeoutMs: 10 * 60_000,
    webFetchMaxBytes: 256 * 1024,
    webFetchTimeoutMs: 15_000,
    allowPrivateHosts: env.NODE_ENV === "production" ? [] : [marketHost],
    untrustedUrlPatterns: [/untrusted/i],
    myrPerTusd: env.MYR_PER_TUSD ?? "4.70",
    topupFeePct: env.TOPUP_FEE_PCT ?? "1.5",
    topupLovelace: (() => {
      const ada = Number(env.TOPUP_ADA ?? 25);
      const l = BigInt(Math.round((Number.isFinite(ada) ? ada : 25) * 1_000_000));
      return l < 2_000_000n ? 2_000_000n : l;
    })(),
    marketUrl,
    walletMode: env.WALLET_MODE?.trim().toLowerCase() === "native" ? "native" : "vault",
    ...overrides,
  };
}

export type SessionDbRow = typeof sessions.$inferSelect;

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Sessions that hold a live silo slot. */
export const ACTIVE_STATUSES: readonly SessionStatus[] = ["RUNNING", "PAUSED", "QUARANTINED", "COMPLETING"];

export function getSessionDb(db: DB, id: string): SessionDbRow | null {
  return db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
}

export function updateSessionDb(db: DB, id: string, patch: Partial<SessionDbRow>, now: number): void {
  db.update(sessions).set({ ...patch, updatedAt: now }).where(eq(sessions.id, id)).run();
}

export function toSessionRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    goalId: r.goalId,
    userId: r.userId,
    parentSessionId: r.parentSessionId,
    letter: r.letter,
    name: r.name,
    role: r.role,
    taskType: r.taskType as TaskType,
    status: r.status as SessionStatus,
    budgetMicro: BigInt(r.budgetMicro),
    spentMicro: BigInt(r.spentMicro),
    perPaymentMaxMicro: BigInt(r.perPaymentMaxMicro),
    approvalThresholdMicro: BigInt(r.approvalThresholdMicro),
    allowedPayees: JSON.parse(r.allowedPayeesJson),
    expiresAt: r.expiresAt,
    address: r.address,
    tainted: r.tainted,
    tokensUsed: r.tokensUsed,
    doneAttempts: r.doneAttempts,
  };
}

/** CONFIRMATIONS (default 2): blocks on top before a tx counts as confirmed. The real chain exposes it. */
export const requiredConfirmations = (chain: Pick<Chain, "confirmations">, override?: number): number =>
  Math.max(1, Math.floor(override ?? chain.confirmations ?? 1));

/** A confirmation reading counts only at depth ≥ N. Readings without a depth come from a provider that already
 * applies the rule (createChain's FinalityProvider) or from a fake chain where "confirmed" means final. */
export const isFinal = (c: { confirmations?: number } | null | undefined, need: number): boolean =>
  !!c && (c.confirmations === undefined || c.confirmations >= need);

/**
 * Wait until a tx is confirmed with CONFIRMATIONS blocks on top (funding, payment, close, top-up — every engine
 * wait goes through here or through chain.provider, which applies the same rule): ChainWatcher events first
 * (event-driven; tx_confirmed is emitted only at depth ≥ N), plus a slow fetchTxConfirmation poll as a safety net.
 * A tx that is rolled back before N simply stays pending (the watcher keeps it watched; the poll sees null).
 * `onDepth` reports each new depth below N (tx_pending). Resolves false on timeout.
 */
export function waitForTx(
  chain: Chain,
  txHash: string,
  opts: { timeoutMs: number; pollMs: number; confirmations?: number; onDepth?: (confirmations: number) => void },
): Promise<boolean> {
  const need = requiredConfirmations(chain, opts.confirmations);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      off();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(ok);
    };
    const off = chain.watcher.on((e) => {
      if (!("txHash" in e) || e.txHash !== txHash) return;
      if (e.type === "tx_confirmed" && isFinal(e, need)) finish(true);
      else if (e.type === "tx_pending") opts.onDepth?.(e.confirmations);
      else if (e.type === "tx_rolled_back") opts.onDepth?.(0);
    });
    const check = () =>
      chain.provider.fetchTxConfirmation(txHash).then(
        (c) => isFinal(c, need) && finish(true),
        () => undefined,
      );
    const poll = setInterval(check, opts.pollMs);
    const timer = setTimeout(() => finish(false), opts.timeoutMs);
    chain.watcher.watchTx(txHash);
    void check();
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Per-key async mutex (payments per session, transitions per session). */
export function keyedMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
