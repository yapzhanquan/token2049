// Builds the Engine from env: chain (real preprod via @bulkhead/chain, or the FakeChain when CHAIN=fake
// for offline UI demos), runtime services, the captain (LLM agent) and its zero-token wake filter.
import type { DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { AgentMarket, Engine, LLM } from "./contracts";
import { createRuntime, type Runtime } from "./sessions-runtime";
import type { RuntimeSessionManager } from "./sessions";
import type { RuntimeConfig } from "./sessions-store";
import type { OnRamp } from "./onramp";
import { createLLM, modelLabel } from "./llm";
import { createPlanner, type Planner } from "./planner";
import { CaptainAgent, wrapHandback } from "./captain/captain";
import { WakeFilter } from "./captain/wake";
import { SigningBroker } from "./self-custody";
import { bridgeFakeChainToMarket, type FakeChainLedger } from "./market";
import { createMasumiMarket, dbFundingLookup, dbMasumiStore, dbSweepTarget, masumiConfigFromEnv, type MasumiMarket } from "./market-masumi";
import { fileURLToPath } from "node:url";

export interface WiredEngine extends Engine {
  sessions: RuntimeSessionManager;
  captainAgent: CaptainAgent;
  planner: Planner;
  wake: WakeFilter;
  config: RuntimeConfig;
  runtime: Runtime;
  onramp: OnRamp;
  /** Self-custody signing: treasury spends of "Connect wallet" users wait for a browser signature. */
  signing: SigningBroker;
  /** Boot order: runtime (on-ramp resume → reconcile → supervisor), then the captain's wake filter. */
  boot(): Promise<void>;
  captainInfo(): { name: string; model: string; contextTokens: number; totalTokens: number };
  shutdown(): Promise<void>;
}

export interface WireOptions {
  db: DB;
  env?: NodeJS.ProcessEnv;
  /** Inject a chain (tests); otherwise from env (CHAIN=fake → FakeChain). */
  chain?: Chain;
  llm?: LLM;
  market?: AgentMarket;
  config?: Partial<RuntimeConfig>;
}

/** Real preprod chain, or the in-memory FakeChain when CHAIN=fake (local UI demos; labelled in /health). */
export async function chainFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Chain> {
  if (env.CHAIN === "fake") {
    const { createFakeChain } = await import("../test/fake-chain");
    return createFakeChain({ autoConfirmMs: 1_500, treasuryStart: { tusdMicro: 100_000_000n, lovelace: 50_000_000n } });
  }
  const lib = await import("@bulkhead/chain");
  const chain = await lib.createChain({ env });
  // Session Vault client (walletMode "vault"): expose applyVaultParams on the chain so the engine's
  // vault adapter (src/vault.ts) finds it next to tx.vaultFund/vaultPay/vaultRevoke/vaultRecover.
  const apply = (lib as unknown as Record<string, unknown>).applyVaultParams;
  if (typeof apply === "function" && !(chain as unknown as Record<string, unknown>).applyVaultParams) Object.assign(chain, { applyVaultParams: apply });
  return chain;
}

export async function wireEngine(opts: WireOptions): Promise<WiredEngine> {
  const env = opts.env ?? process.env;
  const db = opts.db;
  const rawChain = opts.chain ?? (await chainFromEnv(env));
  // Self-custody users' treasury spends are built unsigned and wait for the browser wallet's signature.
  const signing = new SigningBroker({ db }).bind(rawChain);
  const chain = signing.wrapChain(rawChain);
  const llm = opts.llm ?? createLLM(env);
  // MARKET=masumi: hire REAL Masumi registry agents through MPS purchases (market-masumi.ts). Default: mock market.
  let masumi: MasumiMarket | null = null;
  let runtimeRef: Runtime | null = null;
  let configOverrides = opts.config;
  if (!opts.market && env.MARKET === "masumi") {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    masumi = createMasumiMarket(masumiConfigFromEnv(env, chain.tx.tusdUnit(), repoRoot), {
      store: dbMasumiStore(db),
      funding: dbFundingLookup(db),
      sweepTarget: dbSweepTarget(db),
      // The runtime's bus exists only after createRuntime; the market emits nothing before boot.
      emit: (type, sessionId, data) => void runtimeRef?.bus.emit(type, { ...(sessionId ? { sessionId, goalId: runtimeRef.sessions.get(sessionId)?.goalId } : {}), data }),
    });
    // Escrow lock + seller run + on-chain result take longer than a mock job.
    configOverrides = { jobTimeoutMs: Number(env.MASUMI_JOB_TIMEOUT_MS ?? 45 * 60_000), jobPollMs: 10_000, ...opts.config };
  }
  const runtime = createRuntime({ db, chain, llm, config: configOverrides, ...(opts.market ? { market: opts.market } : masumi ? { market: masumi } : {}) });
  runtimeRef = runtime;
  const { config, bus, decisions, signer, market, silos, sessions, onramp } = runtime;
  signing.attachBus(bus);
  // CHAIN=fake (offline demo only): forward confirmed FakeChain hire payments to the mock market's test-mode
  // route so hired jobs complete. Never active with a real chain or an injected (test) chain.
  const fakeLedger = !opts.chain && env.CHAIN === "fake" && Array.isArray((rawChain as unknown as FakeChainLedger).txs) ? (rawChain as unknown as FakeChainLedger) : null;
  let stopBridge: (() => void) | null = null;

  const planner = createPlanner({ llm, market, chain, db });
  const captainAgent = new CaptainAgent({ db, chain, bus, sessions, decisions, market, llm, planner, wrapHandback });
  const wake = new WakeFilter({ bus, captain: captainAgent, db, sessions });

  const engine: WiredEngine = {
    db,
    chain,
    bus,
    sessions,
    silos,
    signer,
    decisions,
    market,
    llm,
    captain: captainAgent,
    captainAgent,
    planner,
    wake,
    config,
    runtime,
    onramp,
    signing,
    wrapHandback,
    captainInfo: () => ({
      name: captainAgent.name,
      model: modelLabel(llm),
      contextTokens: captainAgent.contextTokens(),
      totalTokens: captainAgent.totalTokens(),
    }),
    async boot() {
      await chain.watcher.start();
      await runtime.boot();
      masumi?.start();
      if (fakeLedger && !stopBridge && !opts.market && !masumi) stopBridge = bridgeFakeChainToMarket(fakeLedger, { marketUrl: config.marketUrl });
      // Zero-token watcher for the captain; replays actionable events missed while the engine was down.
      wake.start();
    },
    async shutdown() {
      await wake.stop();
      masumi?.stop();
      stopBridge?.();
      stopBridge = null;
      signing.shutdown();
      await runtime.shutdown();
      await chain.watcher.stop().catch(() => undefined);
    },
  };
  return engine;
}
