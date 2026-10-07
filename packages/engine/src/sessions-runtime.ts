// Runtime half of the engine, wired together. server.ts (captain agent) calls createRuntime() and adds
// the captain / LLM / API on top. Every piece is also exported as its own factory.
import type { DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { AgentMarket, EventBus, LLM } from "./contracts";
import { createEventBus } from "./bus";
import { createDecisionLedger, type RuntimeDecisionLedger } from "./decisions";
import { createSigner, type RuntimeSigner } from "./signer";
import { createAgentMarket } from "./market";
import { createSiloRunner, type RuntimeSiloRunner } from "./silo/runner";
import type { LookupFn } from "./silo/egress";
import { createSessionManager, type RuntimeSessionManager } from "./sessions";
import { createSupervisor, type Supervisor } from "./supervisor";
import { createOnRamp, type OnRamp } from "./onramp";
import { runtimeConfig, type RuntimeConfig } from "./sessions-store";

export interface Runtime {
  config: RuntimeConfig;
  bus: EventBus;
  decisions: RuntimeDecisionLedger;
  signer: RuntimeSigner;
  market: AgentMarket;
  silos: RuntimeSiloRunner;
  sessions: RuntimeSessionManager;
  supervisor: Supervisor;
  onramp: OnRamp;
  /** Boot: reconcile with the chain, then start the supervisor (call once after chain.watcher.start()). */
  boot(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createRuntime(args: {
  db: DB;
  chain: Chain;
  /** Sub-agent completions in "anthropic" mode go through this (silos never see the key). */
  llm?: LLM;
  config?: Partial<RuntimeConfig>;
  market?: AgentMarket;
  bus?: EventBus;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}): Runtime {
  const config = runtimeConfig(args.config);
  const { db, chain } = args;
  const bus = args.bus ?? createEventBus(db, { now: config.now });
  const decisions = createDecisionLedger(db, bus, { now: config.now });
  const market = args.market ?? createAgentMarket({ baseUrl: config.marketUrl });
  const signer = createSigner({ db, bus, chain, decisions, config });
  const silos = createSiloRunner({ db, bus, chain, signer, market, config, ...(args.llm ? { llm: args.llm } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.lookup ? { lookup: args.lookup } : {}) });
  const sessions = createSessionManager({ db, bus, chain, silos, signer, decisions, market, config });
  silos.bind(sessions);
  decisions.bind({
    signer,
    silos,
    raiseBudget: (id, add, d) => sessions.raiseBudget(id, add, d),
    extendExpiry: (id, at, d) => sessions.extendExpiry(id, at, d),
    widenMandate: (id, c, d) => sessions.widenMandate(id, c, d),
    releaseQuarantine: (id, ok, d) => sessions.releaseQuarantine(id, ok, d),
  });
  const supervisor = createSupervisor({ db, bus, chain, sessions, silos, config });
  const onramp = createOnRamp({ db, bus, chain, config });
  return {
    config,
    bus,
    decisions,
    signer,
    market,
    silos,
    sessions,
    supervisor,
    onramp,
    async boot() {
      onramp.resume();
      await sessions.reconcile();
      supervisor.start();
    },
    async shutdown() {
      supervisor.stop();
      onramp.stop();
      await sessions.shutdown();
      await silos.stopAll("engine shutdown");
    },
  };
}
