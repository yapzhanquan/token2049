// Engine process: openDb → wire → reconcile → chain watcher → wake filter → HTTP (Hono) on ENGINE_URL.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openDb } from "@bulkhead/db";
import { createApi } from "./api";
import { wireEngine } from "./wire";

const log = (msg: string) => console.log(`[engine] ${msg}`);

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(env.ENGINE_URL ?? "http://localhost:4000");
  const port = Number(url.port || 4000);
  const hostname = engineHostname(env, url);
  if (/mainnet/i.test(env.NETWORK ?? "")) throw new Error("Bulkhead runs on Cardano preprod only");

  const db = openDb();
  const engine = await wireEngine({ db, env });
  log(`chain: ${env.CHAIN === "fake" ? "FakeChain (offline demo — NOT on-chain)" : `${engine.chain.provider.name} (${engine.chain.provider.network})`}`);
  log(`llm: ${engine.llm.name} · captain model ${engine.captainInfo().model}`);
  if (!env.ENGINE_TOKEN) log("WARNING: ENGINE_TOKEN is not set — API auth is disabled (local dev only)");

  // Restart-proof boot: chain watcher → reconcile non-CLOSED sessions with DB + chain (spec §5.2) →
  // supervisor → the captain's zero-token wake filter (replays actionable events missed while down).
  await engine.boot();

  const app = createApi({
    engine,
    onramp: engine.onramp,
    signing: engine.signing,
    topupFeePct: engine.config.topupFeePct,
    chainLabel: env.CHAIN === "fake" ? "fake" : undefined,
    token: env.ENGINE_TOKEN,
    myrPerTusd: engine.config.myrPerTusd,
    captainInfo: engine.captainInfo,
    wakeStats: () => engine.wake.stats,
    autoFundUserEmails: engine.config.autoFundUserEmails,
    workDeadlineSeconds: Math.round(engine.config.workDeadlineMs / 1000),
  });
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => log(`listening on http://${hostname}:${info.port} (loopback only unless ENGINE_HOST says otherwise)`));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down`);
    server.close();
    await engine.shutdown().catch((e) => log(`shutdown error: ${(e as Error).message}`));
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return { engine, app, server };
}

/** Bind address: ENGINE_HOST if set, else ENGINE_URL's host with "localhost" mapped to 127.0.0.1 — loopback by
 * default, never all interfaces unless asked for explicitly (ENGINE_HOST=0.0.0.0). */
export function engineHostname(env: NodeJS.ProcessEnv, url: URL): string {
  const explicit = env.ENGINE_HOST?.trim();
  if (explicit) return explicit;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  return !h || h === "localhost" ? "127.0.0.1" : h;
}

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error("[engine] fatal:", err);
    process.exit(1);
  });
}
