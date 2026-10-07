// Entry point: `pnpm --filter @bulkhead/mock-market dev` (port from MARKET_URL, default 4100).
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { buildMarket, marketPort } from "./config";

const { market, fakeReader, tusdUnit } = await buildMarket(process.env);
const app = createApp(market, fakeReader && tusdUnit ? { fakeChain: { reader: fakeReader, tusdUnit } } : {});
const port = marketPort(process.env);

market.start();
// Loopback by default (MARKET_HOST overrides, e.g. 0.0.0.0 to expose it on purpose).
const hostname = process.env.MARKET_HOST?.trim() || "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(
    `[market] listening on ${hostname}:${port}${fakeReader ? " (fake-chain test mode — OFFLINE DEMO, payments are NOT on-chain)" : ""}; ` +
      `${market.catalog().length} agent(s) available`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    market.stop();
    server.close();
    process.exit(0);
  });
}
