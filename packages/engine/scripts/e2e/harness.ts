// e2e harness: temp SQLite DB, chain (preprod or FakeChain), engine "lives" (wireEngine → boot → API),
// a tiny in-process API client, and DB-polling waits that survive engine restarts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, sessions as sessionsT, transitions, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { BulkheadEvent, EventType } from "@bulkhead/shared";
import { createApi } from "../../src/api";
import { createEventBus } from "../../src/bus";
import { wireEngine, type WiredEngine } from "../../src/wire";
import { MockLLM } from "../../src/llm/mock";
import type { RuntimeConfig } from "../../src/sessions-store";
import { getSessionDb, type SessionDbRow } from "../../src/sessions-store";
import { createFakeChain, type FakeChain } from "../../test/fake-chain";
import { log } from "./report";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Timing {
  /** Poll interval for waits. */
  pollMs: number;
  /** Generic chain-bound wait (funding / payment / close). */
  chainMs: number;
  /** Short local waits (silo reacts, API effects). */
  localMs: number;
}

export const DRY_TIMING: Timing = { pollMs: 150, chainMs: 60_000, localMs: 30_000 };
export const PREPROD_TIMING: Timing = { pollMs: 3_000, chainMs: 15 * 60_000, localMs: 3 * 60_000 };

export interface Harness {
  dry: boolean;
  env: NodeJS.ProcessEnv;
  db: DB;
  dbPath: string;
  timing: Timing;
  /** Independent observer chain for assertions (balances, metadata, confirmations, tip). */
  observer: Chain;
  fakeChain?: FakeChain;
  reader: ReturnType<typeof createEventBus>;
  config: Partial<RuntimeConfig>;
  marketUrl: string;
  engine: WiredEngine | null;
  api: ApiClient | null;
  lives: number;
}

export function openTempDb(): { db: DB; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "bulkhead-e2e-"));
  const dbPath = join(dir, "e2e.sqlite");
  return { db: openDb(dbPath), dbPath };
}

/** Runtime config for the e2e: MockLLM silos (deterministic #mock hooks), local fixture hosts allowed. */
export function runtimeOverrides(dry: boolean, marketUrl: string): Partial<RuntimeConfig> {
  const base: Partial<RuntimeConfig> = {
    llmMode: "mock",
    marketUrl,
    // The fixture page server and the market listen on 127.0.0.1 (egress normally blocks private IPs).
    allowPrivateHosts: ["127.0.0.1", "localhost"],
    // This run verifies the on-chain windows themselves (planned expiry, owner Recover after expiry, restarts), so
    // the crew is not time-boxed here unless E2E_WORK_DEADLINE_SECONDS asks for it (the app default is 60 s).
    workDeadlineMs: Math.max(0, Number(process.env.E2E_WORK_DEADLINE_SECONDS ?? 0) || 0) * 1000,
  };
  if (!dry) return { ...base, jobPollMs: 5_000 };
  return {
    ...base,
    heartbeatMs: 1_000,
    supervisorTickMs: 250,
    txPollMs: 200,
    txConfirmTimeoutMs: 60_000,
    doneConfirmWaitMs: 30_000,
    closeRetryBaseMs: 200,
    closeRetryMaxMs: 2_000,
    jobPollMs: 300,
  };
}

export function createDryChain(): FakeChain {
  // Treasuries start EMPTY: the simulated top-up is the only inflow, like a fresh preprod user.
  const chain = createFakeChain({ autoConfirmMs: 500 });
  // The FakeChain provider has no metadata lookup; expose the metadata it recorded per tx (same shape as Blockfrost).
  chain.provider.fetchTxMetadata = async (txHash: string) => {
    const t = chain.txs.find((x) => x.txHash === txHash);
    if (!t?.metadata) return null;
    return Object.fromEntries(Object.entries(t.metadata).map(([k, v]) => [String(k), v]));
  };
  return chain;
}

/** One engine "life": wire on the shared DB, boot (reconcile → supervisor → wake filter), API on top. */
export async function startEngine(h: Harness): Promise<WiredEngine> {
  h.lives++;
  const engine = await wireEngine({
    db: h.db,
    env: { ...h.env, ...(h.dry ? { CHAIN: "fake" } : {}) },
    ...(h.fakeChain ? { chain: h.fakeChain } : {}),
    llm: new MockLLM(),
    config: h.config,
  });
  await engine.boot();
  h.engine = engine;
  h.api = apiClient(engine, h.dry);
  log(`engine life #${h.lives} booted (${h.dry ? "FakeChain" : `${engine.chain.provider.name} preprod`}, MockLLM captain + silos)`);
  return engine;
}

export async function stopEngine(h: Harness, why: string) {
  const e = h.engine;
  if (!e) return;
  h.engine = null;
  h.api = null;
  log(`engine life #${h.lives}: shutting down (${why})`);
  await Promise.race([e.shutdown(), sleep(30_000)]).catch((err) => log(`shutdown error: ${(err as Error).message}`));
}

// ───────────────────────── API client (same routes the web app uses) ─────────────────────────
export interface ApiClient {
  call<T = any>(method: string, path: string, opts?: { user?: string; body?: unknown; okStatus?: number[] }): Promise<T>;
}

const TOKEN = "e2e-token";

function apiClient(engine: WiredEngine, dry: boolean): ApiClient {
  const app = createApi({
    engine,
    onramp: engine.onramp,
    token: TOKEN,
    myrPerTusd: engine.config.myrPerTusd,
    captainInfo: engine.captainInfo,
    wakeStats: () => engine.wake.stats,
    ...(dry ? { chainLabel: "fake" } : {}),
  });
  return {
    async call(method, path, opts = {}) {
      const res = await app.request(path, {
        method,
        headers: { "x-engine-token": TOKEN, "content-type": "application/json", ...(opts.user ? { "x-user-id": opts.user } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      const ok = opts.okStatus ? opts.okStatus.includes(res.status) : res.status < 400;
      if (!ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      return body;
    },
  };
}

// ───────────────────────── DB reads + waits (independent of the engine instance) ─────────────────────────
export function events(h: Harness, filter: { sessionId?: string; goalId?: string; type?: EventType } = {}): BulkheadEvent[] {
  const all = h.reader.since(0, { ...(filter.sessionId ? { sessionId: filter.sessionId } : {}), ...(filter.goalId ? { goalId: filter.goalId } : {}) });
  return filter.type ? all.filter((e) => e.type === filter.type) : all;
}

export function row(h: Harness, id: string): SessionDbRow {
  const r = getSessionDb(h.db, id);
  if (!r) throw new Error(`session ${id} not found`);
  return r;
}

export function transitionsOf(h: Harness, id: string) {
  return h.db.select().from(transitions).where(eq(transitions.sessionId, id)).all().sort((a, b) => a.id - b.id);
}

export async function waitFor<T>(h: Harness, label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  let lastNote = t0;
  let lastError: string | null = null;
  for (;;) {
    let v: T | null | undefined | false = null;
    try {
      v = await fn();
    } catch (e) {
      // Transient provider errors (rate limits, 5xx, not-yet-indexed) count as "not yet".
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for: ${label}${lastError ? ` (last error: ${lastError})` : ""}`);
    if (Date.now() - lastNote > (h.dry ? 10_000 : 30_000)) {
      lastNote = Date.now();
      log(`  … still waiting (${Math.round((Date.now() - t0) / 1000)} s): ${label}`);
    }
    await sleep(h.timing.pollMs);
  }
}

export function waitStatus(h: Harness, id: string, statuses: string[], timeoutMs: number) {
  return waitFor(h, `session ${letterOf(h, id)} → ${statuses.join("|")}`, () => (statuses.includes(row(h, id).status) ? row(h, id) : null), timeoutMs);
}

export function letterOf(h: Harness, id: string) {
  const r = getSessionDb(h.db, id);
  return r ? `${r.letter}/${r.taskType}` : id;
}

export function userRow(h: Harness, id: string) {
  return h.db.select().from(users).where(eq(users.id, id)).get();
}

export function sessionsOfGoal(h: Harness, goalId: string) {
  return h.db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all();
}
