// Entry point: `pnpm --filter @bulkhead/mock-market dev` (port from MARKET_URL, default 4100).
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { buildMarket, marketPort } from "./config";

const { market, fakeReader, tusdUnit } = await buildMarket(process.env);
const app = createApp(market, fakeReader && tusdUnit ? { fakeChain: { reader: fakeReader, tusdUnit } } : {});
const port = marketPort(process.env);

market.start();
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(
    `[market] listening on :${port}${fakeReader ? " (fake-chain test mode — OFFLINE DEMO, payments are NOT on-chain)" : ""}; ` +
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
