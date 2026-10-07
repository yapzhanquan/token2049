// ADA Handle resolution against mocked Blockfrost / Koios / Handle API (no network).
import { describe, expect, it } from "vitest";
import { createHandleResolver, handleUnits, parseHandle, HandleError, HANDLE_POLICY_PREPROD } from "../src/handle";

const POL = HANDLE_POLICY_PREPROD;
const A1 = "addr_test1qz" + "a".repeat(50);
const A2 = "addr_test1qz" + "b".repeat(50);

type Routes = Record<string, { status?: number; body?: unknown }>;
function mockFetch(routes: Routes, calls: string[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (url.includes("blockfrost") && headers.project_id !== "bfkey") return new Response("forbidden", { status: 403 });
    if (!key) return new Response(JSON.stringify({ status_code: 404 }), { status: 404 });
    const r = routes[key]!;
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const bf = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createHandleResolver({ blockfrostProjectId: "bfkey", fetchImpl, handleApiUrl: "https://handle.test", retry: { retries: 0 }, now: () => 1_700_000_000_000, ...extra });
const assetPath = (unit: string) => `/assets/${unit}/addresses`;

describe("ADA Handle encoding", () => {
  it("normalises $names and builds CIP-68 (000de140) + legacy units", () => {
    expect(parseHandle("$Test")).toBe("test");
    expect(parseHandle(" $hello ")).toBe("hello");
    expect(parseHandle("test")).toBeNull();
    expect(parseHandle("$")).toBeNull();
    expect(parseHandle("$has space")).toBeNull();
    expect(parseHandle("$" + "x".repeat(16))).toBeNull();
    expect(parseHandle("$sub@root")).toBe("sub@root");
    expect(handleUnits("test")).toEqual({ cip68: POL + "000de140" + "74657374", legacy: POL + "74657374" });
  });
});

describe("createHandleResolver (Blockfrost)", () => {
  it("resolves a CIP-68 handle to its single holder and records the source/unit", async () => {
    const u = handleUnits("test");
    const calls: string[] = [];
    const r = await bf(mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "1" }] } }, calls)).resolve("$Test");
    expect(r).toEqual({ handle: "$test", address: A1, resolvedAt: 1_700_000_000_000, unit: u.cip68, standard: "cip68", source: "blockfrost" });
    expect(calls.every((c) => c.startsWith("https://cardano-preprod.blockfrost.io/api/v0/assets/"))).toBe(true);
  });

  it("resolves a legacy (CIP-25, no prefix) handle", async () => {
    const u = handleUnits("oldie");
    const r = await bf(mockFetch({ [assetPath(u.legacy)]: { body: [{ address: A2, quantity: "1" }] } })).resolve("$oldie");
    expect(r).toMatchObject({ handle: "$oldie", address: A2, standard: "cip25", unit: u.legacy });
  });

  it("same holder for both encodings is fine (CIP-68 preferred)", async () => {
    const u = handleUnits("both");
    const r = await bf(
      mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "1" }] }, [assetPath(u.legacy)]: { body: [{ address: A1, quantity: "1" }] } }),
    ).resolve("$both");
    expect(r).toMatchObject({ address: A1, standard: "cip68" });
  });

  it("not found → HandleError not_found with a clear message", async () => {
    const e = await bf(mockFetch({})).resolve("$nobody").catch((x) => x);
    expect(e).toBeInstanceOf(HandleError);
    expect(e.code).toBe("not_found");
    expect(e.message).toMatch(/\$nobody was not found on preprod/);
  });

  it("ambiguous: several holders, or CIP-68 vs legacy at different addresses", async () => {
    const u = handleUnits("dup");
    const e1 = await bf(mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "1" }, { address: A2, quantity: "1" }] } }))
      .resolve("$dup")
      .catch((x) => x);
    expect(e1.code).toBe("ambiguous");
    expect(e1.message).toMatch(/held by 2 addresses/);
    const e2 = await bf(
      mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "1" }] }, [assetPath(u.legacy)]: { body: [{ address: A2, quantity: "1" }] } }),
    )
      .resolve("$dup")
      .catch((x) => x);
    expect(e2.code).toBe("ambiguous");
    expect(e2.message).toMatch(/both as a CIP-68 token and a legacy CIP-25 token/);
  });

  it("zero-quantity rows are ignored; invalid syntax and mainnet are refused", async () => {
    const u = handleUnits("burnt");
    const e = await bf(mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "0" }] } })).resolve("$burnt").catch((x) => x);
    expect(e.code).toBe("not_found");
    expect((await bf(mockFetch({})).resolve("$bad name").catch((x) => x)).code).toBe("invalid");
    expect((await bf(mockFetch({}), { network: "mainnet" }).resolve("$test").catch((x) => x)).code).toBe("wrong_network");
  });

  it("refuses a holder that is not a preprod address", async () => {
    const u = handleUnits("main");
    const e = await bf(mockFetch({ [assetPath(u.cip68)]: { body: [{ address: "addr1qxyz", quantity: "1" }] } })).resolve("$main").catch((x) => x);
    expect(e.code).toBe("wrong_network");
  });

  it("caches a resolution; crossCheck compares with the Handle API", async () => {
    const u = handleUnits("test");
    const calls: string[] = [];
    const r = bf(mockFetch({ [assetPath(u.cip68)]: { body: [{ address: A1, quantity: "1" }] }, "/handles/test": { body: { hex: "000de14074657374", resolved_addresses: { ada: A1 } } } }, calls));
    await r.resolve("$test");
    await r.resolve("$test");
    expect(calls.filter((c) => c.includes("blockfrost"))).toHaveLength(2); // cip68 + legacy, once
    const x = await r.resolve("$test", { crossCheck: true });
    expect(x.crossCheck).toBe("match");
  });

  it("falls back to the Handle API when Blockfrost is unusable (e.g. bad key)", async () => {
    const r = createHandleResolver({
      blockfrostProjectId: "wrong",
      fetchImpl: mockFetch({ "/handles/hello": { body: { hex: "000de14068656c6c6f", resolved_addresses: { ada: A2 } } } }),
      handleApiUrl: "https://handle.test",
      retry: { retries: 0 },
    });
    expect(await r.resolve("$hello")).toMatchObject({ address: A2, source: "handle-api", standard: "cip68" });
    const missing = await r.resolve("$ghost").catch((x) => x);
    expect(missing.code).toBe("not_found");
  });

  it("unavailable when neither the chain nor the Handle API answers", async () => {
    const r = createHandleResolver({ blockfrostProjectId: "wrong", fetchImpl: mockFetch({}), handleApiUrl: "", retry: { retries: 0 } });
    const e = await r.resolve("$test").catch((x) => x);
    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(/HTTP 403/);
  });
});

describe("createHandleResolver (Koios, no Blockfrost key)", () => {
  it("uses /asset_addresses with policy + hex asset name", async () => {
    const calls: string[] = [];
    const r = createHandleResolver({
      fetchImpl: mockFetch({ "_asset_name=000de14074657374": { body: [{ payment_address: A1, quantity: "1" }] }, "_asset_name=74657374": { body: [] } }, calls),
      retry: { retries: 0 },
    });
    expect(await r.resolve("$test")).toMatchObject({ address: A1, source: "koios", standard: "cip68" });
    expect(calls[0]).toBe(`https://preprod.koios.rest/api/v1/asset_addresses?_asset_policy=${POL}&_asset_name=000de14074657374`);
  });
});
