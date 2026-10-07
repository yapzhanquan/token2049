// Contract test: the ENGINE's market client (packages/engine/src/market.ts) against the REAL mock-market
// Hono app, in-process (app.request as fetch), MARKET_TEST_MODE=fake-chain. The "payment" is injected
// through the test-only /__test/payments route — nothing here is on-chain.
import { createHash } from "node:crypto";
import { tusdToMicro } from "@bulkhead/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentMarket } from "../../../packages/engine/src/market";
import { createApp } from "../src/app";
import { buildMarket, type BuiltMarket } from "../src/config";

const BASE = "http://market.test:4100";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let built: BuiltMarket;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  built = await buildMarket({ MARKET_TEST_MODE: "fake-chain", MARKET_URL: BASE, MARKET_STORE: "memory" } as NodeJS.ProcessEnv, { workDelayMs: 20, log: () => {} });
  app = createApp(built.market, { fakeChain: { reader: built.fakeReader!, tusdUnit: built.tusdUnit! } });
});
afterAll(() => built.market.stop());

const inProcessFetch = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;

describe("engine market client ↔ mock market", () => {
  it("catalog → start_job → (payment) → status until completed, with a matching result hash", async () => {
    const m = createAgentMarket({ baseUrl: BASE, fetchImpl: inProcessFetch, cacheMs: 0 });
    const catalog = await m.catalog();
    expect(catalog.map((a) => a.id).sort()).toEqual(["fact-checker", "market-research", "summariser"]);
    const entry = catalog.find((a) => a.id === "summariser")!;
    expect(entry.endpoint).toBe(`${BASE}/agents/summariser`);

    const input = "Bulkhead runs agent sessions in parallel. Each has its own wallet. Leftovers return to the treasury.";
    const job = await m.startJob("summariser", input);
    expect(job.paymentAddress).toBe(entry.paymentAddress);
    expect(job.amountMicro).toBe(tusdToMicro(entry.priceTUSD));
    expect(job.reference.length).toBeGreaterThan(0);
    expect((await m.status("summariser", job.jobId)).status).toBe("awaiting_payment");

    // Fake-chain payment carrying the reference in metadata 674 (what the Signer's session payment does on preprod).
    const pay = await app.request("/__test/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: job.paymentAddress, amount_tusd: entry.priceTUSD, reference: job.reference }),
    });
    expect(((await pay.json()) as { paid_jobs: string[] }).paid_jobs).toEqual([job.jobId]);

    await vi.waitFor(async () => expect((await m.status("summariser", job.jobId)).status).toBe("completed"), { timeout: 2_000, interval: 20 });
    const done = await m.status("summariser", job.jobId);
    expect(done.result).toBeTruthy();
    expect(done.resultHash).toBe(sha256(done.result!));
  });

  it("per-agent status rejects another agent's job; both status URL forms work", async () => {
    const m = createAgentMarket({ baseUrl: BASE, fetchImpl: inProcessFetch, cacheMs: 0 });
    const job = await m.startJob("fact-checker", "The sky is blue. Water is wet.");
    await expect(m.status("summariser", job.jobId)).rejects.toThrow(/404/);
    expect((await app.request(`/agents/fact-checker/status/${job.jobId}`)).status).toBe(200);
    expect((await app.request(`/agents/fact-checker/status?job_id=${job.jobId}`)).status).toBe(200);
    await expect(m.startJob("nope", "x")).rejects.toThrow(/unknown agent service/);
  });
});
