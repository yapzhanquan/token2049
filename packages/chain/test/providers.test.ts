import { describe, expect, it } from "vitest";
import { fetchWithRetry, HttpError } from "../src/providers/http";
import { BlockfrostProvider, KoiosProvider, NOWNodesProvider, createProvider, createMainnetProvider } from "../src/providers";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Response>, calls: Call[] = []) {
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return r();
  }) as typeof fetch;
  return f;
}
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

describe("fetchWithRetry", () => {
  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const calls: Call[] = [];
    const res = await fetchWithRetry("http://x/y", {}, { fetchImpl: fakeFetch([json({}, 429), json({}, 503), json({ ok: 1 })], calls), sleep: noSleep });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });
  it("does not retry 400 and gives up after `retries`", async () => {
    const calls: Call[] = [];
    await expect(fetchWithRetry("http://x", {}, { fetchImpl: fakeFetch([json({ e: 1 }, 400)], calls), sleep: noSleep })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
    const calls2: Call[] = [];
    await expect(fetchWithRetry("http://x", {}, { retries: 2, fetchImpl: fakeFetch([json({}, 500)], calls2), sleep: noSleep })).rejects.toThrow(/500/);
    expect(calls2).toHaveLength(3);
  });
});

describe("BlockfrostProvider (preprod)", () => {
  it("sends project_id, maps utxos/tip/confirmation/params, 404 → empty/null", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      [
        json([{ tx_hash: "h", output_index: 1, amount: [{ unit: "lovelace", quantity: "5" }, { unit: "p74555344", quantity: "9" }] }]),
        json({ slot: 10, time: 1000, height: 3 }),
        json({}, 404),
        json({
          epoch: 200, min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, coins_per_utxo_size: "4310", key_deposit: "2000000", pool_deposit: "500000000",
          price_mem: 0.0577, price_step: 0.0000721, max_val_size: "5000", collateral_percent: 150, max_collateral_inputs: 3,
          max_block_size: 90112, max_block_header_size: 1100, min_pool_cost: "170000000", max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000",
          max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000", decentralisation_param: 0, min_fee_ref_script_cost_per_byte: 15,
        }),
        json([{ label: "674", json_metadata: { msg: ["x"] } }]),
      ],
      calls,
    );
    const p = new BlockfrostProvider("preprodABC", { retry: { fetchImpl, sleep: noSleep } });
    expect(await p.fetchUtxos("addr_test1x")).toEqual([
      { txHash: "h", outputIndex: 1, address: "addr_test1x", amount: [{ unit: "lovelace", quantity: "5" }, { unit: "p74555344", quantity: "9" }] },
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).project_id).toBe("preprodABC");
    expect(calls[0]!.url).toBe("https://cardano-preprod.blockfrost.io/api/v0/addresses/addr_test1x/utxos?count=100&page=1");
    expect(await p.fetchTip()).toEqual({ slot: 10, time: 1_000_000, height: 3 });
    expect(await p.fetchTxConfirmation("nope")).toBeNull();
    const params = (await p.fetchProtocolParameters()) as Record<string, unknown>;
    expect(params.coinsPerUtxoSize).toBe(4310);
    expect(params.minFeeA).toBe(44);
    expect(await p.fetchTxMetadata("t")).toEqual({ "674": { msg: ["x"] } });
  });
  it("refuses mainnet project ids", () => {
    expect(() => new BlockfrostProvider("mainnetXYZ")).toThrow(/MAINNET/);
  });
});

describe("KoiosProvider", () => {
  it("maps address_utxos with asset_list and bearer token", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      [json([{ tx_hash: "h", tx_index: 0, address: "addr_test1k", value: "2000000", asset_list: [{ policy_id: "pp", asset_name: "74555344", quantity: "7" }] }])],
      calls,
    );
    const p = new KoiosProvider({ token: "tok", retry: { fetchImpl, sleep: noSleep } });
    expect(await p.fetchUtxos("addr_test1k")).toEqual([
      { txHash: "h", outputIndex: 0, address: "addr_test1k", amount: [{ unit: "lovelace", quantity: "2000000" }, { unit: "pp74555344", quantity: "7" }] },
    ]);
    expect(calls[0]!.url).toBe("https://preprod.koios.rest/api/v1/address_utxos");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("provider selection", () => {
  it("Blockfrost when a key is set, else Koios; NOWNodes only as mainnet read provider", () => {
    expect(createProvider({ BLOCKFROST_PREPROD_PROJECT_ID: "preprodX" }).name).toBe("blockfrost");
    expect(createProvider({}).name).toBe("koios");
    expect(createProvider({ NOWNODES_API_KEY: "k" }).name).toBe("koios");
    const m = createMainnetProvider({ NOWNODES_API_KEY: "k" })!;
    expect(m.name).toBe("nownodes");
    expect(m.network).toBe("mainnet");
    expect(createMainnetProvider({})).toBeUndefined();
  });
  it("NOWNodes refuses to submit", async () => {
    await expect(new NOWNodesProvider("k").submitTx()).rejects.toThrow(/read-only/);
  });
});
