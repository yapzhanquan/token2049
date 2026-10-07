// Wires a Market from env. Kept separate from server.ts so tests can build one without a port.
import { FakeChainReader, HttpChainReader, type ChainReader } from "./chain-reader";
import { Market } from "./market";
import { KvJobStore, MemoryJobStore, type JobStore } from "./store";
import { defaultAgentWalletSource, StaticAgentWalletSource, type AgentWalletSource } from "./wallets";

/** Test-mode tUSD unit: zero policy id + CIP-68 (333) "tUSD" (0014df10 74555344). Only used in fake-chain mode (MARKET_TEST_MODE=fake-chain or CHAIN=fake). */
export const FAKE_TUSD_UNIT = `${"00".repeat(28)}0014df1074555344`;

/** CIP-67 label 333 prefix (fungible token). tUSD = policyId + 0014df10 + hex("tUSD"). */
const CIP68_FT_PREFIX = "0014df10";
const TUSD_CONTENT_HEX = "74555344";
/**
 * Payments are matched against the CIP-68 (333) tUSD unit only. A pre-CIP-68 TUSD_UNIT (policyId + "74555344",
 * deprecated) is upgraded to the 333 unit of the same policy so a stale .env cannot make the market wait for a unit
 * the engine no longer pays with.
 */
export function normalizeTusdUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  return /^[0-9a-f]{56}74555344$/.test(u) ? u.slice(0, 56) + CIP68_FT_PREFIX + TUSD_CONTENT_HEX : unit.trim();
}
/** Syntactically preprod-looking placeholder addresses for fake-chain mode only (never funded, never used on-chain). */
export const FAKE_AGENT_ADDRESSES = [0, 1, 2].map((i) => `addr_test1fakemarketagent${i}`);

export function marketPort(env: NodeJS.ProcessEnv = process.env): number {
  if (env.MARKET_PORT) return Number(env.MARKET_PORT);
  try {
    const u = new URL(env.MARKET_URL ?? "http://localhost:4100");
    return Number(u.port || 4100);
  } catch {
    return 4100;
  }
}

/**
 * tUSD unit (policyId + CIP-68 (333) asset name). Order: TUSD_UNIT env → @bulkhead/chain export
 * (`tusdUnit()` function or `TUSD_UNIT` string) → null (market reports agents unavailable).
 */
export async function resolveTusdUnit(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.TUSD_UNIT) return normalizeTusdUnit(env.TUSD_UNIT);
  try {
    const chain = (await import("@bulkhead/chain")) as Record<string, unknown>;
    if (typeof chain.tusdUnit === "function") return String(await (chain.tusdUnit as () => unknown)());
    if (typeof chain.TUSD_UNIT === "string") return chain.TUSD_UNIT;
  } catch {
    /* chain package not ready */
  }
  return null;
}

export interface BuiltMarket {
  market: Market;
  fakeReader?: FakeChainReader;
  tusdUnit: string | null;
}

export async function buildMarket(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<{ store: JobStore; wallets: AgentWalletSource; reader: ChainReader; workDelayMs: number; payWindowMs: number; now: () => number; log: (m: string) => void }> = {},
): Promise<BuiltMarket> {
  // CHAIN=fake (the engine's offline demo) implies the fake-chain test mode: payments arrive via POST /__test/payments
  // from the engine's FakeChain bridge. Never on-chain.
  const fake = env.MARKET_TEST_MODE === "fake-chain" || env.CHAIN === "fake";
  const baseUrl = (env.MARKET_URL ?? `http://localhost:${marketPort(env)}`).replace(/\/+$/, "");
  const fakeReader = fake ? new FakeChainReader() : undefined;
  const tusdUnit = fake ? FAKE_TUSD_UNIT : await resolveTusdUnit(env);
  const market = new Market({
    baseUrl,
    wallets: overrides.wallets ?? (fake ? new StaticAgentWalletSource(FAKE_AGENT_ADDRESSES) : await defaultAgentWalletSource()),
    reader: overrides.reader ?? fakeReader ?? new HttpChainReader(env),
    store: overrides.store ?? (env.MARKET_STORE === "memory" ? new MemoryJobStore() : new KvJobStore(env.DATABASE_PATH)),
    tusdUnit,
    pollMs: env.MARKET_POLL_MS ? Number(env.MARKET_POLL_MS) : undefined,
    workDelayMs: overrides.workDelayMs ?? (env.MARKET_WORK_MS ? Number(env.MARKET_WORK_MS) : undefined),
    payWindowMs: overrides.payWindowMs,
    now: overrides.now,
    log: overrides.log,
  });
  await market.init();
  return { market, fakeReader, tusdUnit };
}
