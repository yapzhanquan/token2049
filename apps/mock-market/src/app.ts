// HTTP API (Hono). Two shapes of the same routes:
//   Market-wide (used by the engine):  GET /agents, GET /availability, GET /input_schema/:id,
//                                      POST /start_job {agent_id, input}, GET /status/:job_id
//   Per agent, MIP-003 style (catalog `endpoint`): /agents/:id/{availability,input_schema,start_job,status?job_id=,status/:job_id}
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { tusdToMicro } from "@bulkhead/shared";
import { findAgent, inputSchemaFor } from "./agents";
import type { FakeChainReader } from "./chain-reader";
import { Market, MarketError } from "./market";

export interface AppOptions {
  /** Only in MARKET_TEST_MODE=fake-chain: enables POST /__test/payments. */
  fakeChain?: { reader: FakeChainReader; tusdUnit: string };
}

/** Accepts our shape { input } and MIP-003's { input_data: { text } }. */
function pickInput(body: Record<string, unknown>): unknown {
  if (body.input !== undefined) return body.input;
  const d = body.input_data;
  if (d && typeof d === "object" && !Array.isArray(d)) return (d as Record<string, unknown>).text;
  return undefined;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new MarketError(400, "body must be a JSON object");
  }
}

export function createApp(market: Market, opts: AppOptions = {}) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof MarketError) return c.json({ error: err.message }, err.status);
    console.error("[market] unhandled", err);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/agents", (c) => c.json(market.catalog()));
  app.get("/availability", (c) => c.json(market.availability()));

  const schema = (id: string) => {
    const a = findAgent(id);
    if (!a) throw new MarketError(404, `unknown agent: ${id}`);
    return inputSchemaFor(a);
  };
  app.get("/input_schema/:id", (c) => c.json(schema(c.req.param("id"))));

  app.post("/start_job", async (c) => {
    const b = await readJson(c);
    return c.json(market.startJob(b.agent_id, pickInput(b), b.identifier_from_purchaser), 201);
  });
  app.get("/status/:job_id", (c) => c.json(market.status(c.req.param("job_id"))));
  app.get("/status", (c) => {
    const id = c.req.query("job_id");
    if (!id) throw new MarketError(400, "job_id query parameter is required");
    return c.json(market.status(id));
  });

  // Per-agent MIP-003 routes.
  app.get("/agents/:id", (c) => {
    const e = market.catalog().find((a) => a.id === c.req.param("id"));
    if (!e) throw new MarketError(404, `unknown or unavailable agent: ${c.req.param("id")}`);
    return c.json(e);
  });
  app.get("/agents/:id/availability", (c) => c.json(market.agentAvailability(c.req.param("id"))));
  app.get("/agents/:id/input_schema", (c) => c.json(schema(c.req.param("id"))));
  app.post("/agents/:id/start_job", async (c) => {
    const b = await readJson(c);
    return c.json(market.startJob(c.req.param("id"), pickInput(b), b.identifier_from_purchaser), 201);
  });
  const agentStatus = (agentId: string, jobId: string | undefined) => {
    if (!jobId) throw new MarketError(400, "job_id query parameter is required");
    const s = market.status(jobId);
    if (s.agent_id !== agentId) throw new MarketError(404, `unknown job: ${jobId}`);
    return s;
  };
  // MIP-003: GET {endpoint}/status?job_id=… (what the engine's market client calls); path form kept too.
  app.get("/agents/:id/status", (c) => c.json(agentStatus(c.req.param("id"), c.req.query("job_id"))));
  app.get("/agents/:id/status/:job_id", (c) => c.json(agentStatus(c.req.param("id"), c.req.param("job_id"))));

  if (opts.fakeChain) {
    const { reader, tusdUnit } = opts.fakeChain;
    // TEST MODE ONLY: inject a fake "on-chain" payment, then run one watcher poll.
    app.post("/__test/payments", async (c) => {
      const b = await readJson(c);
      if (typeof b.address !== "string" || typeof b.amount_tusd !== "string") throw new MarketError(400, "address and amount_tusd are required");
      const txHash = typeof b.tx_hash === "string" ? b.tx_hash : randomBytes(32).toString("hex");
      reader.addPayment({
        address: b.address,
        txHash,
        amount: [
          { unit: "lovelace", quantity: "1500000" },
          { unit: typeof b.unit === "string" ? b.unit : tusdUnit, quantity: tusdToMicro(b.amount_tusd).toString() },
        ],
        metadata674: b.reference === undefined ? undefined : { msg: [String(b.reference)] },
      });
      const paid = await market.tick();
      return c.json({ tx_hash: txHash, paid_jobs: paid, test_mode: "fake-chain" });
    });
  }

  return app;
}
