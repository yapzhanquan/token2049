// Masumi Standard API (MIP-003) server for Bulkhead — a separate process from the engine.
// Binds 127.0.0.1 only (expose it through your own HTTPS reverse proxy / tunnel if a marketplace must reach it).
//
//   pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/standard-api-server.ts
//
// Env (values are never printed):
//   STANDARD_API_PORT               default 4200
//   STANDARD_API_DATA_DIR           job files (buyer input + results), default <repo>/data/standard-jobs (gitignored)
//   ENGINE_URL, ENGINE_TOKEN        the running Bulkhead engine
//   STANDARD_API_ENGINE_USER_EMAIL  dedicated custodial engine user owning all Standard API goals
//                                   (default masumi-standard@bulkhead.local; fund its treasury via the engine)
//   STANDARD_API_GOAL_BUDGET_TUSD   tUSD budget per goal, default 2
//   STANDARD_API_RESULT_MINUTES     start_job → submitResultTime, default 60 (min 20)
//   STANDARD_API_POLL_MS            background poll interval, default 10000
//   Paid mode (all required together):
//     STANDARD_MPS_URL, STANDARD_MPS_TOKEN, STANDARD_MPS_AGENT_IDENTIFIER
//     STANDARD_MPS_PAYMENT_SOURCE_INDEX (V2 sources), STANDARD_MPS_PAYMENT_SOURCE_TYPE (default Web3CardanoV2)
//     STANDARD_MPS_PRICE_UNIT + STANDARD_MPS_PRICE_AMOUNT (optional; omit to use the registered fixed price)
//   Free mode (no payment, local dev only): STANDARD_API_FREE=1 and no STANDARD_MPS_URL.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createEngineHttpClient, createMpsPayments, createStandardApi, fileJobStore, type StandardPayments } from "../src/standard-api";

const log = (msg: string) => console.log(`[standard-api] ${msg}`);

export function paymentsFromEnv(env: NodeJS.ProcessEnv): StandardPayments | null {
  if (!env.STANDARD_MPS_URL) {
    if (env.STANDARD_API_FREE === "1") return null;
    throw new Error("Set STANDARD_MPS_URL/STANDARD_MPS_TOKEN/STANDARD_MPS_AGENT_IDENTIFIER for paid mode, or STANDARD_API_FREE=1 for local free mode");
  }
  const missing = ["STANDARD_MPS_TOKEN", "STANDARD_MPS_AGENT_IDENTIFIER"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
  const type = (env.STANDARD_MPS_PAYMENT_SOURCE_TYPE ?? "Web3CardanoV2") as "Web3CardanoV1" | "Web3CardanoV2";
  const idx = env.STANDARD_MPS_PAYMENT_SOURCE_INDEX;
  if (type === "Web3CardanoV2" && idx === undefined) throw new Error("STANDARD_MPS_PAYMENT_SOURCE_INDEX is required for Web3CardanoV2");
  const unit = env.STANDARD_MPS_PRICE_UNIT;
  const amount = env.STANDARD_MPS_PRICE_AMOUNT;
  if ((unit === undefined) !== (amount === undefined)) throw new Error("set both STANDARD_MPS_PRICE_UNIT and STANDARD_MPS_PRICE_AMOUNT, or neither");
  return createMpsPayments({
    baseUrl: env.STANDARD_MPS_URL,
    token: env.STANDARD_MPS_TOKEN!,
    agentIdentifier: env.STANDARD_MPS_AGENT_IDENTIFIER!,
    paymentSourceType: type,
    ...(idx !== undefined ? { supportedPaymentSourceIndex: Number(idx) } : {}),
    ...(unit !== undefined ? { requestedFunds: [{ unit, amount: amount! }] } : {}),
    network: "Preprod",
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  if (/mainnet/i.test(env.NETWORK ?? "")) throw new Error("Bulkhead runs on Cardano preprod only");
  const port = Number(env.STANDARD_API_PORT ?? 4200);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid STANDARD_API_PORT");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dataDir = env.STANDARD_API_DATA_DIR ?? resolve(here, "../../../data/standard-jobs");
  const payments = paymentsFromEnv(env);
  const engine = createEngineHttpClient({
    baseUrl: env.ENGINE_URL ?? "http://localhost:4000",
    token: env.ENGINE_TOKEN,
    userEmail: env.STANDARD_API_ENGINE_USER_EMAIL ?? "masumi-standard@bulkhead.local",
  });
  const api = createStandardApi({
    engine,
    payments,
    store: fileJobStore(dataDir),
    log,
    config: {
      ...(env.STANDARD_API_GOAL_BUDGET_TUSD ? { goalBudgetTUSD: env.STANDARD_API_GOAL_BUDGET_TUSD } : {}),
      ...(env.STANDARD_API_RESULT_MINUTES ? { resultMinutes: Number(env.STANDARD_API_RESULT_MINUTES) } : {}),
    },
  });
  log(`mode: ${payments ? "paid (MPS, Preprod)" : "FREE (no payment — local dev only)"}`);
  const server = serve({ fetch: api.app.fetch, port, hostname: "127.0.0.1" }, (info) => log(`listening on http://127.0.0.1:${info.port}`));
  const pollMs = Math.max(2_000, Number(env.STANDARD_API_POLL_MS ?? 10_000));
  const timer = setInterval(() => void api.tick(), pollMs);
  const stop = () => {
    clearInterval(timer);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { server, api };
}

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error("[standard-api] fatal:", (err as Error).message);
    process.exit(1);
  });
}
