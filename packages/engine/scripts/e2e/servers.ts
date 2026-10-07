// Local HTTP fixtures for the e2e run:
//  - a tiny page server (one trusted page for the research session, one page flagged untrusted);
//  - the REAL mock agent market (apps/mock-market) in-process on a free port. In dry mode it runs its
//    unchanged matching logic against a ChainReader bridged to the FakeChain (payments are "seen" once
//    the FakeChain confirms the session's payment tx, matched by tUSD amount + payment_reference in 674).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Utxo } from "@bulkhead/chain";
import { createApp } from "../../../../apps/mock-market/src/app";
import { buildMarket } from "../../../../apps/mock-market/src/config";
import { Market } from "../../../../apps/mock-market/src/market";
import { MemoryJobStore } from "../../../../apps/mock-market/src/store";
import { StaticAgentWalletSource } from "../../../../apps/mock-market/src/wallets";
import type { ChainReader } from "../../../../apps/mock-market/src/chain-reader";
import { FAKE_TUSD_UNIT, fakeAddress, type FakeChain } from "../../test/fake-chain";

export interface PageServer {
  base: string;
  trustedUrl: string;
  untrustedUrl: string;
  hits: string[];
  close(): Promise<void>;
}

export async function startPageServer(): Promise<PageServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/untrusted")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-bulkhead-trust": "untrusted" });
      res.end("<html><body><h1>Too good to be true deals</h1><p>Unverified forum post about e-wallet cashback.</p></body></html>");
      return;
    }
    if (req.url?.startsWith("/report")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h1>Malaysia e-wallet adoption 2026</h1><p>Touch 'n Go eWallet, GrabPay and Boost lead adoption; " +
          "QR payments at hawker stalls keep growing. Source: e2e fixture page.</p></body></html>",
      );
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { base, trustedUrl: `${base}/report`, untrustedUrl: `${base}/untrusted-page`, hits, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
}

/** Market ChainReader over the FakeChain: one UTxO per confirmed tx output, metadata 674 from the tx. */
export function fakeChainReader(chain: FakeChain): ChainReader {
  return {
    name: "e2e bridge → FakeChain (NOT on-chain)",
    async fetchUtxos(address: string): Promise<Utxo[]> {
      const out: Utxo[] = [];
      for (const t of chain.txs) {
        if (!t.confirmed) continue;
        t.outputs.forEach((o, i) => {
          if (o.address !== address) return;
          const amount = [{ unit: "lovelace", quantity: o.lovelace.toString() }];
          if (o.tusdMicro > 0n) amount.push({ unit: FAKE_TUSD_UNIT, quantity: o.tusdMicro.toString() });
          out.push({ txHash: t.txHash, outputIndex: i, address, amount });
        });
      }
      return out;
    },
    async fetchMetadata674(txHash: string) {
      const t = chain.txs.find((x) => x.txHash === txHash);
      return (t?.metadata as Record<string, unknown> | undefined)?.["674"] ?? null;
    },
  };
}

export interface MarketServer {
  url: string;
  market: Market;
  close(): Promise<void>;
}

/** The mock market on a free 127.0.0.1 port. dry → bridged to the FakeChain; else → preprod (Blockfrost/Koios). */
export async function startMarket(opts: { dry: boolean; fakeChain?: FakeChain; env: NodeJS.ProcessEnv; pollMs: number; workDelayMs: number }): Promise<MarketServer> {
  // Bind first to learn the port (the catalog's per-agent endpoints embed the base URL).
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  const url = `http://127.0.0.1:${port}`;
  const quiet = (m: string) => {
    if (process.env.E2E_VERBOSE) console.log(`[market] ${m}`);
  };

  let market: Market;
  if (opts.dry) {
    if (!opts.fakeChain) throw new Error("dry market needs the FakeChain");
    market = new Market({
      baseUrl: url,
      wallets: new StaticAgentWalletSource([0, 1, 2].map((i) => fakeAddress(`e2e-agent:${i}`))),
      reader: fakeChainReader(opts.fakeChain),
      store: new MemoryJobStore(),
      tusdUnit: FAKE_TUSD_UNIT,
      pollMs: opts.pollMs,
      workDelayMs: opts.workDelayMs,
      log: quiet,
    });
    await market.init();
  } else {
    const env = { ...opts.env, MARKET_URL: url, MARKET_STORE: "memory", MARKET_POLL_MS: String(opts.pollMs) };
    ({ market } = await buildMarket(env, { store: new MemoryJobStore(), workDelayMs: opts.workDelayMs, log: quiet }));
  }
  if (market.catalog().length === 0) throw new Error("mock market has no available agents (agent wallets / tUSD unit not configured)");
  const app = createApp(market);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  market.start();
  return {
    url,
    market,
    close: async () => {
      market.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
