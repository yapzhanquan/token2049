import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@bulkhead/db";
import type { AgentCatalogEntry, JobStatusResponse, StartJobResponse } from "@bulkhead/shared";
import { createApp } from "../src/app";
import { TUSDM_PREPROD } from "@bulkhead/shared";
import { buildMarket, FAKE_TUSD_UNIT, normalizeTusdUnit, resolveTusdUnit, type BuiltMarket } from "../src/config";
import { AGENTS } from "../src/agents";
import { HttpChainReader, metadataHasReference } from "../src/chain-reader";
import { KvJobStore, MemoryJobStore } from "../src/store";
import { ChainAgentWalletSource, EnvAgentWalletSource, FallbackAgentWalletSource } from "../src/wallets";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const quiet = () => {};

let built: BuiltMarket;
let app: ReturnType<typeof createApp>;
const dbPath = join(mkdtempSync(join(tmpdir(), "bh-market-")), "test.sqlite");
const env = { MARKET_TEST_MODE: "fake-chain", MARKET_URL: "http://localhost:4999", DATABASE_PATH: dbPath } as NodeJS.ProcessEnv;

beforeAll(async () => {
  built = await buildMarket(env, { workDelayMs: 30, log: quiet });
  app = createApp(built.market, { fakeChain: { reader: built.fakeReader!, tusdUnit: built.tusdUnit! } });
});
afterAll(() => {
  built.market.stop();
  closeDb();
});

async function json<T>(res: Response | Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T };
}
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const start = (agent_id: string, input: string) => json<StartJobResponse & { input_hash: string }>(post("/start_job", { agent_id, input }));
const status = (id: string) => json<JobStatusResponse & { error?: string }>(app.request(`/status/${id}`));
const pay = (b: Record<string, unknown>) => json<{ tx_hash: string; paid_jobs: string[] }>(post("/__test/payments", b));

describe("catalog + MIP-003 metadata routes", () => {
  it("lists 3 mock agents as AgentCatalogEntry", async () => {
    const { status: s, body } = await json<AgentCatalogEntry[]>(app.request("/agents"));
    expect(s).toBe(200);
    expect(body.map((a) => a.id).sort()).toEqual(["fact-checker", "market-research", "summariser"]);
    for (const a of body) {
      expect(a.source).toBe("mock");
      expect(a.paymentAddress).toMatch(/^addr_test1/);
      expect(a.endpoint).toBe(`http://localhost:4999/agents/${a.id}`);
      expect(Number(a.priceTUSD)).toBeGreaterThan(0);
      expect(a.skills.length).toBeGreaterThan(0);
    }
    expect(new Set(body.map((a) => a.paymentAddress)).size).toBe(3);
  });

  it("availability + input_schema", async () => {
    const av = await json<{ status: string; type: string }>(app.request("/availability"));
    expect(av.body).toMatchObject({ status: "available", type: "masumi-agent" });
    const one = await json<{ status: string }>(app.request("/agents/summariser/availability"));
    expect(one.body.status).toBe("available");
    const sch = await json<{ input_data: { id: string; type: string }[] }>(app.request("/input_schema/summariser"));
    expect(sch.body.input_data[0]).toMatchObject({ id: "text", type: "string" });
    expect((await app.request("/input_schema/nope")).status).toBe(404);
  });

  it("rejects bad start_job requests", async () => {
    expect((await post("/start_job", { agent_id: "nope", input: "x" })).status).toBe(404);
    expect((await post("/start_job", { agent_id: "summariser", input: "" })).status).toBe(400);
    expect((await post("/start_job", { input: "x" })).status).toBe(400);
    expect((await app.request("/start_job", { method: "POST", body: "not json" })).status).toBe(400);
  });
});

describe("job lifecycle (fake-chain)", () => {
  it("awaiting_payment → running → completed, with result_hash = sha256(result)", async () => {
    const input = "Cardano stablecoin payments for Malaysian SMEs. SMEs pay 3% card fees today. Stablecoins could cut fees.";
    const s = await start("market-research", input);
    expect(s.status).toBe(201);
    expect(s.body.amount_tusd).toBe("2");
    expect(s.body.payment_address).toBe((await json<AgentCatalogEntry[]>(app.request("/agents"))).body.find((a) => a.id === "market-research")!.paymentAddress);
    expect(s.body.payment_reference.length).toBeLessThanOrEqual(64);
    expect(s.body.input_hash).toBe(sha256(input));
    const id = s.body.job_id;

    expect((await status(id)).body.status).toBe("awaiting_payment");
    // Polling without any payment changes nothing.
    expect(await built.market.tick()).toEqual([]);
    expect((await status(id)).body.status).toBe("awaiting_payment");
    expect((await status(id)).body.result).toBeUndefined();

    const p = await pay({ address: s.body.payment_address, amount_tusd: "2", reference: s.body.payment_reference });
    expect(p.body.paid_jobs).toEqual([id]);
    const running = (await status(id)).body;
    expect(running.status).toBe("running");
    expect(running.payment_tx).toBe(p.body.tx_hash);
    expect(running.result).toBeUndefined();

    await vi.waitFor(async () => expect((await status(id)).body.status).toBe("completed"), { timeout: 2000, interval: 20 });
    const done = (await status(id)).body;
    expect(done.result).toContain("# Market research note");
    expect(done.result_hash).toBe(sha256(done.result!));
    // Deterministic: same input → same result.
    expect(done.result).toBe(AGENTS.find((a) => a.id === "market-research")!.work(input));

    // MIP-003 per-agent status route returns the same job.
    const viaAgent = await json<JobStatusResponse>(app.request(`/agents/market-research/status?job_id=${id}`));
    expect(viaAgent.body.result_hash).toBe(done.result_hash);
    expect((await app.request(`/agents/summariser/status?job_id=${id}`)).status).toBe(404);
  });

  it("accepts an overpayment and a CIP-20 chunked reference", async () => {
    const s = await start("summariser", "One sentence here. Another one there.");
    const ref = s.body.payment_reference;
    built.fakeReader!.addPayment({
      address: s.body.payment_address,
      txHash: "ab".repeat(32),
      amount: [{ unit: FAKE_TUSD_UNIT, quantity: "5000000" }],
      metadata674: { msg: ["bulkhead hire ", ref.slice(0, 10), ref.slice(10)] },
    });
    expect(await built.market.tick()).toEqual([s.body.job_id]);
  });

  it("does not accept a wrong amount, wrong reference, wrong unit, or wrong address", async () => {
    const s = await start("fact-checker", "All crypto is always 100% safe. Fees may fall.");
    const { job_id, payment_address: addr, payment_reference: ref } = s.body;
    expect(s.body.amount_tusd).toBe("1.5");

    expect((await pay({ address: addr, amount_tusd: "1.499999", reference: ref })).body.paid_jobs).toEqual([]);
    expect((await pay({ address: addr, amount_tusd: "1.5", reference: "bhm-000000000000000000000000" })).body.paid_jobs).toEqual([]);
    expect((await pay({ address: addr, amount_tusd: "1.5" })).body.paid_jobs).toEqual([]); // no metadata at all
    expect((await pay({ address: addr, amount_tusd: "1.5", reference: ref, unit: `${"11".repeat(28)}0014df1074555344` })).body.paid_jobs).toEqual([]);
    // deprecated pre-CIP-68 unit of the SAME policy is not accepted either
    expect((await pay({ address: addr, amount_tusd: "1.5", reference: ref, unit: `${"00".repeat(28)}74555344` })).body.paid_jobs).toEqual([]);
    const other = (await json<AgentCatalogEntry[]>(app.request("/agents"))).body.find((a) => a.id === "summariser")!.paymentAddress;
    expect((await pay({ address: other, amount_tusd: "1.5", reference: ref })).body.paid_jobs).toEqual([]);

    expect((await status(job_id)).body.status).toBe("awaiting_payment");
    // Wait past the work delay: still no result.
    await new Promise((r) => setTimeout(r, 80));
    expect((await status(job_id)).body).not.toHaveProperty("result");

    // The correct payment then works.
    expect((await pay({ address: addr, amount_tusd: "1.5", reference: ref })).body.paid_jobs).toEqual([job_id]);
  });

  it("one UTxO cannot pay for two jobs", async () => {
    const a = await start("summariser", "Same text.");
    const b = await start("summariser", "Same text.");
    const tx = "cd".repeat(32);
    built.fakeReader!.addPayment({
      address: a.body.payment_address,
      txHash: tx,
      amount: [{ unit: FAKE_TUSD_UNIT, quantity: "1000000" }],
      metadata674: { msg: [a.body.payment_reference, b.body.payment_reference] },
    });
    const paid = await built.market.tick();
    expect(paid).toHaveLength(1);
    expect(paid[0]).toBe(a.body.job_id);
    expect((await status(b.body.job_id)).body.status).toBe("awaiting_payment");
  });

  it("unknown job → 404", async () => {
    expect((await app.request("/status/does-not-exist")).status).toBe(404);
    expect((await app.request("/status?job_id=does-not-exist")).status).toBe(404);
    expect((await app.request("/status")).status).toBe(400);
  });

  it("jobs persist in the kv table across a restart", async () => {
    const s = await start("summariser", "Persist me. Please.");
    const store2 = new KvJobStore(dbPath);
    expect(store2.get(s.body.job_id)?.status).toBe("awaiting_payment");
    expect(store2.get(s.body.job_id)?.payment_reference).toBe(s.body.payment_reference);
  });
});

describe("expiry", () => {
  it("awaiting_payment → failed after the pay window", async () => {
    let now = 1_000_000;
    const { market } = await buildMarket({ ...env, MARKET_STORE: "memory" }, { now: () => now, payWindowMs: 1000, log: quiet });
    const s = market.startJob("summariser", "x y z.");
    now += 1001;
    await market.tick();
    expect(market.status(s.job_id)).toMatchObject({ status: "failed" });
  });
});

describe("tUSD unit (CIP-68 333)", () => {
  it("fake unit is policy + 0014df10 + hex('tUSD'); a legacy TUSD_UNIT is upgraded to the 333 unit", async () => {
    expect(FAKE_TUSD_UNIT.slice(56)).toBe("0014df1074555344");
    const pol = "ab".repeat(28);
    expect(normalizeTusdUnit(pol + "74555344")).toBe(pol + "0014df1074555344");
    expect(normalizeTusdUnit(pol + "0014df1074555344")).toBe(pol + "0014df1074555344");
    expect(await resolveTusdUnit({ SETTLEMENT_ASSET: "tusd", TUSD_UNIT: pol + "74555344" })).toBe(pol + "0014df1074555344");
  });
  it("matches the engine's settlement unit: tUSDM by default (even with TUSD_UNIT set), tUSD only with SETTLEMENT_ASSET=tusd", async () => {
    const pol = "ab".repeat(28);
    expect(await resolveTusdUnit({ TUSD_UNIT: pol + "0014df1074555344" })).toBe(TUSDM_PREPROD.unit);
    expect(await resolveTusdUnit({ SETTLEMENT_ASSET: "tusd", TUSD_UNIT: pol + "0014df1074555344" })).toBe(pol + "0014df1074555344");
    expect(await resolveTusdUnit({ SETTLEMENT_UNIT: pol + "01" })).toBe(pol + "01");
  });
});

describe("unavailable agents (no address / no tUSD unit)", () => {
  it("agents without an address are hidden and start_job → 503", async () => {
    const { market } = await buildMarket(
      { MARKET_STORE: "memory", TUSD_UNIT: FAKE_TUSD_UNIT },
      { wallets: new EnvAgentWalletSource({}), store: new MemoryJobStore(), log: quiet },
    );
    expect(market.catalog()).toEqual([]);
    expect(() => market.startJob("summariser", "hi")).toThrow(/unavailable/);
    const a = createApp(market);
    expect((await a.request("/start_job", { method: "POST", body: JSON.stringify({ agent_id: "summariser", input: "hi" }) })).status).toBe(503);
  });
});

describe("wallet sources", () => {
  it("chain helper first, env fallback, refuses mainnet", async () => {
    const chain = new ChainAgentWalletSource((i) => (i === 0 ? { address: "addr_test1qchain0" } : null));
    const envSrc = new EnvAgentWalletSource({ MARKET_AGENT_ADDRESS_1: "addr_test1qenv1", MARKET_AGENT_ADDRESS_2: "addr1qmainnet" });
    const s = new FallbackAgentWalletSource([chain, envSrc]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await s.address(0)).toBe("addr_test1qchain0");
    expect(await s.address(1)).toBe("addr_test1qenv1");
    expect(await s.address(2)).toBeNull();
    warn.mockRestore();
  });
});

describe("HttpChainReader (offline, mocked fetch)", () => {
  it("parses Blockfrost UTxOs and 674 metadata", async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/utxos")) return new Response(JSON.stringify([{ tx_hash: "aa", output_index: 1, amount: [{ unit: "lovelace", quantity: "2000000" }] }]));
      if (u.includes("/metadata")) return new Response(JSON.stringify([{ label: "674", json_metadata: { msg: ["bhm-abc"] } }]));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = new HttpChainReader({ BLOCKFROST_PREPROD_PROJECT_ID: "preprodXXX" }, f);
    expect(r.name).toBe("blockfrost-preprod");
    expect(await r.fetchUtxos("addr_test1x")).toEqual([{ txHash: "aa", outputIndex: 1, address: "addr_test1x", amount: [{ unit: "lovelace", quantity: "2000000" }] }]);
    expect(metadataHasReference(await r.fetchMetadata674("aa"), "bhm-abc")).toBe(true);
  });

  it("parses Koios UTxOs (lovelace + assets) and metadata", async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/address_utxos"))
        return new Response(JSON.stringify([{ tx_hash: "bb", tx_index: 0, value: "1500000", asset_list: [{ policy_id: "p".repeat(56), asset_name: "74555344", quantity: "2000000" }] }]));
      if (u.endsWith("/tx_metadata")) return new Response(JSON.stringify([{ tx_hash: "bb", metadata: { "674": { msg: ["x bhm-k y"] } } }]));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = new HttpChainReader({}, f);
    expect(r.name).toBe("koios-preprod");
    const [u] = await r.fetchUtxos("addr_test1y");
    expect(u.amount).toEqual([
      { unit: "lovelace", quantity: "1500000" },
      { unit: `${"p".repeat(56)}74555344`, quantity: "2000000" },
    ]);
    expect(metadataHasReference(await r.fetchMetadata674("bb"), "bhm-k")).toBe(true);
    expect(metadataHasReference(null, "bhm-k")).toBe(false);
  });
});
