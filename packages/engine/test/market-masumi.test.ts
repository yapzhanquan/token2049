// MARKET=masumi: Bulkhead hires Masumi registry agents (MIP-003) and pays via MPS purchases.
// Everything here is OFFLINE: an in-process fake MPS + fake MIP-003 seller behind fetchImpl, the FakeChain,
// the real Signer / DecisionLedger / SessionManager. Nothing touches preprod or a live MPS.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, goals, openDb, payments, users, type DB } from "@bulkhead/db";
import type { BulkheadEvent, PlannedSession } from "@bulkhead/shared";
import { mip004InputHash, mip004ResultHash } from "@bulkhead/shared/mip004";
import { createEventBus } from "../src/bus";
import { createDecisionLedger } from "../src/decisions";
import { createSigner } from "../src/signer";
import { createSessionManager } from "../src/sessions";
import { runtimeConfig } from "../src/sessions-store";
import { validatePlan } from "../src/planner";
import {
  MASUMI_PURCHASING_WALLET_ALIAS,
  PREPROD_TUSDM_UNIT,
  createMasumiMarket,
  dbFundingLookup,
  dbMasumiStore,
  dbSweepTarget,
  inputFieldOf,
  masumiConfigFromEnv,
  mpsTimingError,
  registryEntryFromMetadata,
  toTusdMicro,
  type MasumiConfig,
  type MasumiMarket,
} from "../src/market-masumi";
import { createFakeChain, fakeAddress, FAKE_TUSD_UNIT, type FakeChain } from "./fake-chain";
import { FAST, createStubSilos, spec, waitFor } from "./runtime/helpers";

const MPS = "http://mps.test/api/v1";
const BUYER = "buyer-token-xyz";
const ADMIN = "admin-token-xyz";
const WALLET = fakeAddress("masumi:purchasing");
const POLICY = "ab".repeat(28);
const agentId = (n: number) => POLICY + n.toString(16).padStart(8, "0") + "cd".repeat(8);
const SELLER = (n: number) => `https://seller${n}.test`;
/** The V2 escrow contract of the fake MPS's payment source (live MPS: GET /payment-source smartContractAddress). */
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const BF = "https://cardano-preprod.blockfrost.test/api/v0";
const BF_KEY = "preprodBlockfrostKey";

// ─────────────────────────── fake MPS + fake sellers ───────────────────────────
interface FakePurchase {
  id: string;
  body: Record<string, unknown>;
  onChainState: string | null;
  resultHash: string | null;
  WithdrawnForBuyer: { unit: string; amount: string }[];
  refundRequested: boolean;
}
interface SellerJob {
  nonce: string;
  input: Record<string, unknown>;
  bcid: string;
  result?: string;
  status: string;
}

function createFakeMasumi(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const registry: Record<string, unknown>[] = [];
  const purchases = new Map<string, FakePurchase>();
  const transfers: { id: string; body: Record<string, unknown>; status: string; txHash: string | null }[] = [];
  const calls: { method: string; path: string; token: string | null; body: unknown }[] = [];
  const sellerJobs = new Map<string, SellerJob>(); // jobId → job
  const sellerCfg: Record<
    string,
    {
      tamperInputHash?: boolean;
      tamperResult?: boolean;
      dynamicAmounts?: { unit: string; amount: string }[];
      fail?: boolean;
      payByInMs?: number;
      unlockInMs?: number;
      result?: string;
      inputSchema?: unknown;
      /** extra signed fields echoed in the start_job response (sellerReturnAddress, paymentForceLayer, …) */
      extra?: Record<string, unknown>;
      /** /status returns the skill's `output` field instead of `result` */
      useOutput?: boolean;
      /** /availability answers an HTML page with HTTP 200 (seen live) */
      htmlAvailability?: boolean;
    }
  > = {};
  /** MPS GET /payment-source (live shape, 2026-10-07). */
  const paymentSources: Record<string, unknown>[] = [
    { id: "ps2", network: "Preprod", paymentSourceType: "Web3CardanoV2", policyId: POLICY, smartContractAddress: ESCROW },
    { id: "ps1", network: "Preprod", paymentSourceType: "Web3CardanoV1", policyId: POLICY, smartContractAddress: "addr_test1wzv1contract" },
  ];
  /** Blockfrost: registry NFTs per unit (onchain_metadata in CIP-25 form) + quantity. */
  const chainAssets = new Map<string, { quantity: string; meta: Record<string, unknown> | null }>();
  let purchaseFailure: number | null = null; // next POST /purchase answers this HTTP status
  let jobN = 0;
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200, headers: { "content-type": "application/json" } });
  const err = (status: number, error: string) => new Response(JSON.stringify({ status: "error", error }), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const token = (init?.headers as Record<string, string> | undefined)?.token ?? null;
    calls.push({ method, path: url.pathname + url.search, token, body });
    if (url.host === "cardano-preprod.blockfrost.test") {
      if ((init?.headers as Record<string, string> | undefined)?.project_id !== BF_KEY) return err(403, "Invalid project token.");
      const pol = /^\/api\/v0\/assets\/policy\/([0-9a-f]{56})$/.exec(url.pathname);
      if (pol) {
        const rows = [...chainAssets.entries()].filter(([u]) => u.startsWith(pol[1]!)).map(([asset, a]) => ({ asset, quantity: a.quantity }));
        const page = Number(url.searchParams.get("page") ?? "1");
        const out = rows.slice((page - 1) * 100, page * 100);
        return out.length || page === 1 ? new Response(JSON.stringify(out)) : err(404, "not found");
      }
      const one = /^\/api\/v0\/assets\/([0-9a-f]+)$/.exec(url.pathname);
      const a = one ? chainAssets.get(one[1]!) : undefined;
      if (!a) return err(404, "The requested component has not been found.");
      return new Response(JSON.stringify({ asset: one![1], quantity: a.quantity, onchain_metadata: a.meta }));
    }
    if (url.host === "mps.test") {
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const admin = token === ADMIN;
      if (token !== BUYER && !admin) return err(401, "Unauthorized");
      if (method === "GET" && path === "/wallet/list") return ok({ Wallets: [{ id: "w1", walletAddress: WALLET, walletVkey: "vk", type: "Purchasing" }] });
      if (method === "GET" && path === "/payment-source") return ok({ PaymentSources: paymentSources });
      if (method === "GET" && path === "/registry") return ok({ Assets: url.searchParams.get("filterPaymentSourceType") ? registry.filter((r) => r.paymentSourceType === "Web3CardanoV2") : registry.filter((r) => r.paymentSourceType !== "Web3CardanoV2") });
      if (method === "POST" && path === "/purchase") {
        if (purchaseFailure) {
          const s = purchaseFailure;
          purchaseFailure = null;
          return err(s, s === 409 ? "Purchase exists" : "boom");
        }
        const job = [...sellerJobs.values()].find((j) => j.bcid === body.blockchainIdentifier);
        if (!job) return err(400, "Invalid blockchain identifier");
        if (body.identifierFromPurchaser !== job.nonce) return err(400, "purchaser id mismatch");
        if (purchases.has(body.blockchainIdentifier)) return err(409, "Purchase exists");
        for (const k of ["inputHash", "sellerVkey", "agentIdentifier", "payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"]) if (typeof body[k] !== "string") return err(400, `missing ${k}`);
        const p: FakePurchase = { id: `pur_${purchases.size + 1}`, body, onChainState: null, resultHash: null, WithdrawnForBuyer: [], refundRequested: false };
        purchases.set(body.blockchainIdentifier, p);
        return ok({ id: p.id, blockchainIdentifier: body.blockchainIdentifier, onChainState: null, NextAction: { requestedAction: "FundsLockingRequested", errorType: null, errorNote: null } });
      }
      if (method === "POST" && path === "/purchase/resolve-blockchain-identifier") {
        const p = purchases.get(body.blockchainIdentifier);
        if (!p) return err(404, "Purchase not found");
        return ok({ id: p.id, blockchainIdentifier: body.blockchainIdentifier, onChainState: p.onChainState, resultHash: p.resultHash, inputHash: p.body.inputHash, WithdrawnForBuyer: p.WithdrawnForBuyer, NextAction: { requestedAction: "None", errorType: null, errorNote: null } });
      }
      if (method === "POST" && path === "/purchase/request-refund") {
        const p = purchases.get(body.blockchainIdentifier);
        if (!p) return err(404, "Purchase not found");
        p.refundRequested = true;
        p.onChainState = "RefundRequested";
        return ok({ id: p.id, onChainState: p.onChainState });
      }
      if (path === "/wallet/transfer-funds") {
        if (!admin) return err(401, "admin only");
        if (method === "POST") {
          if (BigInt(body.lovelaceAmount) < 2_000_000n) return err(400, "min 2 ADA");
          const t = { id: `tr_${transfers.length + 1}`, body, status: "Pending", txHash: null as string | null };
          transfers.push(t);
          return ok({ id: t.id, status: t.status, txHash: null, toAddress: body.toAddress, lovelaceAmount: body.lovelaceAmount });
        }
        const t = transfers.find((x) => x.id === url.searchParams.get("id"));
        return ok({ transfers: t ? [{ id: t.id, status: t.status, txHash: t.txHash }] : [] });
      }
      return err(404, `no route ${method} ${path}`);
    }
    // MIP-003 sellers: https://sellerN.test
    const n = Number(/^seller(\d+)\.test$/.exec(url.host)?.[1]);
    if (!n) return err(404, "unknown host");
    const c = sellerCfg[n] ?? {};
    if (url.pathname === "/availability") return c.htmlAvailability ? new Response("<!DOCTYPE html><html></html>", { headers: { "content-type": "text/html" } }) : new Response(JSON.stringify({ status: "available", type: "masumi-agent" }));
    if (url.pathname === "/input_schema") return new Response(JSON.stringify(c.inputSchema ?? { input_data: [{ id: "prompt", type: "string", name: "Prompt" }] }));
    if (url.pathname === "/start_job" && method === "POST") {
      const jobId = `job-${n}-${++jobN}`;
      const nonce = body.identifier_from_purchaser as string;
      const bcid = `bc1d${"0".repeat(10)}${jobN.toString(16).padStart(4, "0")}${nonce}`; // hex, like the real LZ-compressed identifier
      sellerJobs.set(jobId, { nonce, input: body.input_data, bcid, status: "awaiting_payment" });
      const t = now();
      return new Response(
        JSON.stringify({
          id: jobId,
          blockchainIdentifier: bcid,
          payByTime: String(t + (c.payByInMs ?? 10 * 60_000)),
          submitResultTime: String(t + 20 * 60_000),
          unlockTime: String(t + (c.unlockInMs ?? 36 * 60_000)),
          externalDisputeUnlockTime: String(t + 52 * 60_000),
          agentIdentifier: agentId(n),
          sellerVKey: "11".repeat(28),
          identifierFromPurchaser: nonce,
          input_hash: c.tamperInputHash ? "00".repeat(32) : mip004InputHash(body.input_data, nonce),
          paymentSourceType: "Web3CardanoV2",
          supportedPaymentSourceIndex: 0,
          ...(c.dynamicAmounts ? { amounts: c.dynamicAmounts } : {}),
          ...c.extra,
        }),
      );
    }
    if (url.pathname === "/status") {
      const j = sellerJobs.get(url.searchParams.get("job_id") ?? "");
      if (!j) return err(404, "JOB_NOT_FOUND");
      const p = purchases.get(j.bcid);
      if (c.fail && p?.onChainState) return new Response(JSON.stringify({ status: "failed" }));
      if (p?.onChainState === "FundsLocked" || p?.onChainState === "ResultSubmitted") {
        // The seller runs once the escrow is locked, then submits its MIP-004 result hash on-chain.
        j.result ??= c.result ?? `Report: ${String(Object.values(j.input)[0]).slice(0, 40)}\nline 2 "quoted" \\ end`;
        const honest = mip004ResultHash(j.result, j.nonce);
        p.resultHash = c.tamperResult ? mip004ResultHash(j.result + " (edited)", j.nonce) : honest;
        p.onChainState = "ResultSubmitted";
        return new Response(JSON.stringify(c.useOutput ? { status: "completed", output: j.result } : { status: "completed", result: j.result }));
      }
      return new Response(JSON.stringify({ status: p ? "running" : "awaiting_payment" }));
    }
    return err(404, "no route");
  };

  return {
    fetchImpl,
    registry,
    paymentSources,
    chainAssets,
    purchases,
    transfers,
    calls,
    sellerJobs,
    sellerCfg,
    failNextPurchase(status: number) {
      purchaseFailure = status;
    },
    lockAll() {
      for (const p of purchases.values()) if (!p.onChainState) p.onChainState = "FundsLocked";
    },
    refundAll() {
      for (const p of purchases.values())
        if (p.refundRequested) {
          p.onChainState = "RefundWithdrawn";
          p.WithdrawnForBuyer = [{ unit: PREPROD_TUSDM_UNIT, amount: "2000000" }];
        }
    },
    confirmTransfers() {
      for (const t of transfers) {
        t.status = "Confirmed";
        t.txHash = "f".repeat(64);
      }
    },
  };
}

const entry = (n: number, over: Record<string, unknown> = {}) => ({
  id: `reg${n}`,
  name: `Agent ${n}`,
  type: "Standard",
  apiBaseUrl: SELLER(n),
  state: "RegistrationConfirmed",
  Tags: ["research"],
  agentIdentifier: agentId(n),
  paymentSourceType: "Web3CardanoV2",
  AgentPricing: null,
  supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: PREPROD_TUSDM_UNIT, amount: "2000000" }] } }],
  ...over,
});

// ─────────────────────────── harness ───────────────────────────
type Harness = Awaited<ReturnType<typeof setupMasumi>>;
let h: Harness | null = null;
afterEach(async () => {
  h?.market.stop();
  await h?.sessions.shutdown();
  h = null;
});

async function setupMasumi(opts: { walletMode?: "native" | "vault"; cfg?: Partial<MasumiConfig>; registry?: Record<string, unknown>[] } = {}) {
  closeDb();
  const db: DB = openDb(":memory:");
  const chain: FakeChain = createFakeChain({ autoConfirmMs: 15 });
  const config = runtimeConfig({ ...FAST, walletMode: opts.walletMode ?? "native" });
  const bus = createEventBus(db, { now: config.now });
  const decisions = createDecisionLedger(db, bus, { now: config.now });
  const fake = createFakeMasumi();
  fake.registry.push(...(opts.registry ?? [entry(1)]));
  const market = createMasumiMarket(
    { network: "Preprod", mpsUrl: MPS, buyerToken: BUYER, adminToken: ADMIN, tusdUnit: FAKE_TUSD_UNIT, ...opts.cfg },
    {
      fetchImpl: fake.fetchImpl,
      store: dbMasumiStore(db),
      funding: dbFundingLookup(db),
      sweepTarget: dbSweepTarget(db),
      emit: (type, sessionId, data) => void bus.emit(type, { ...(sessionId ? { sessionId } : {}), data }),
      log: () => undefined,
    },
  );
  const signer = createSigner({ db, bus, chain, decisions, config });
  const silos = createStubSilos();
  const sessions = createSessionManager({ db, bus, chain, silos, signer, decisions, market, config });
  silos.bind(sessions);
  decisions.bind({
    signer,
    silos,
    raiseBudget: (id, a, d) => sessions.raiseBudget(id, a, d),
    extendExpiry: (id, a, d) => sessions.extendExpiry(id, a, d),
    widenMandate: (id, c, d) => sessions.widenMandate(id, c, d),
    releaseQuarantine: (id, ok, d) => sessions.releaseQuarantine(id, ok, d),
  });
  const userId = "user_test";
  const t = await chain.keys.treasury(userId, 0);
  db.insert(users).values({ id: userId, email: "t@example.com", name: "Test", custody: "custodial", accountIndex: 0, treasuryAddress: t.address, ownerKeyHash: t.keyHash, stakeKeyHash: t.stakeKeyHash, createdAt: Date.now() }).run();
  chain.credit(t.address, 1_000_000_000n, 1_000_000_000n);
  const start = async (specs: PlannedSession[]) => {
    const goalId = `goal_${Math.random().toString(36).slice(2)}`;
    db.insert(goals).values({ id: goalId, userId, goal: "hire", budgetMicro: "100000000", deadline: Date.now() + 3_600_000, status: "approved", planJson: "{}", createdAt: Date.now() }).run();
    const ids = await sessions.startPlan(goalId, { sessions: specs });
    await waitFor(() => ids.every((id) => sessions.get(id)!.status === "RUNNING"), 10_000, "sessions RUNNING");
    return ids;
  };
  const events = (type?: string): BulkheadEvent[] => bus.since(0).filter((e) => !type || e.type === type);
  /** What the silo runner does for hire_agent: startJob(ctx) → Signer pay (memo carries ref:) → poll status. */
  const hire = async (sessionId: string, serviceId: string, input = "Summarise Cardano DeFi TVL") => {
    const row = sessions.get(sessionId)!;
    const job = await market.startJob(serviceId, input, { sessionId, allowedPayees: row.allowedPayees });
    const d = await signer.pay(sessionId, { payee: job.paymentAddress, amountMicro: job.amountMicro, memo: `hire ${serviceId} ref:${job.reference}`, reference: job.reference });
    return { job, d };
  };
  const paymentOf = (sessionId: string) => db.select().from(payments).where(eq(payments.sessionId, sessionId)).all();
  return { db, chain, bus, decisions, signer, sessions, market: market as MasumiMarket, fake, treasury: t.address, start, events, hire, paymentOf };
}

const hirer = (over: Partial<PlannedSession> = {}) =>
  spec({ taskType: "hire_agent", role: "hirer", agentType: "generic", allowedPayees: [MASUMI_PURCHASING_WALLET_ALIAS], budgetTUSD: "10", perPaymentMaxTUSD: "5", approvalThresholdTUSD: "4", dataScope: [], ...over });

async function pollUntil(m: MasumiMarket, serviceId: string, jobId: string, fake: ReturnType<typeof createFakeMasumi>, want: string[], lock = true) {
  for (let i = 0; i < 200; i++) {
    const r = await m.status(serviceId, jobId);
    if (want.includes(r.status)) return r;
    if (lock) fake.lockAll();
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`status never reached ${want.join("/")}`);
}

// ─────────────────────────── tests ───────────────────────────
describe("Masumi discovery", () => {
  it("lists confirmed Preprod MIP-003 agents with converted prices; excludes what Bulkhead cannot fund", async () => {
    h = await setupMasumi({
      registry: [
        entry(1), // Fixed 2 tUSDM → 2 tUSD, equivalent
        entry(2, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: FAKE_TUSD_UNIT, amount: "1500000" }] } }] }), // exact tUSD
        entry(3, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Dynamic" } }] }),
        entry(4, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Free" } }] }),
        entry(5, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: "lovelace", amount: "5000000" }] } }] }),
        entry(6, { apiBaseUrl: "http://127.0.0.1:21950" }),
        entry(7, { state: "RegistrationRequested" }),
        entry(8, { type: "X402" }),
        entry(9, { supportedPaymentSources: [{ chain: "Cardano", network: "Mainnet", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: PREPROD_TUSDM_UNIT, amount: "1" }] } }] }),
        // V1 legacy pricing (AgentPricing) via the second /registry query
        entry(10, { paymentSourceType: "Web3CardanoV1", supportedPaymentSources: null, AgentPricing: { pricingType: "Fixed", Pricing: [{ unit: PREPROD_TUSDM_UNIT, amount: "3000000" }] } }),
        entry(11, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: PREPROD_TUSDM_UNIT, amount: "500000000" }] } }] }), // 500 > max 100
      ],
    });
    const cat = await h.market.catalog();
    expect(cat.map((a) => a.name).sort()).toEqual(["Agent 1", "Agent 10", "Agent 2", "Agent 3"]);
    const a1 = cat.find((a) => a.name === "Agent 1")!;
    expect(a1).toMatchObject({ source: "masumi", priceTUSD: "2", paymentAddress: WALLET, endpoint: SELLER(1), agentIdentifier: agentId(1), pricingType: "Fixed", fundingMode: "equivalent" });
    expect(cat.find((a) => a.name === "Agent 2")).toMatchObject({ priceTUSD: "1.5", fundingMode: "exact" });
    expect(cat.find((a) => a.name === "Agent 3")).toMatchObject({ pricingType: "Dynamic", priceTUSD: "0" });
    expect(cat.find((a) => a.name === "Agent 10")).toMatchObject({ priceTUSD: "3" });
    const why = Object.fromEntries(h.market.discoveryReport().excluded.map((x) => [x.name, x.reason]));
    expect(why["Agent 4"]).toMatch(/Free/);
    expect(why["Agent 5"]).toMatch(/MASUMI_TUSD_PER_ADA/);
    expect(why["Agent 6"]).toMatch(/http/);
    expect(why["Agent 7"]).toMatch(/RegistrationRequested/);
    expect(why["Agent 8"]).toMatch(/X402/);
    expect(why["Agent 9"]).toMatch(/Preprod/);
    expect(why["Agent 11"]).toMatch(/MAX_PRICE/);
    // the buyer token (never the admin key) is what discovery uses; tokens never appear in errors
    expect(h.fake.calls.filter((c) => c.path.startsWith("/api/v1/registry")).every((c) => c.token === BUYER)).toBe(true);
  });

  it("lovelace pricing with a declared rate; unit conversion rounds up; MIP-003 input field detection", () => {
    expect(toTusdMicro([{ unit: "", amount: "5000000" }], { tusdUnit: FAKE_TUSD_UNIT, tusdPerAda: "0.45" })).toEqual({ micro: 2_250_000n, mode: "equivalent" });
    expect(toTusdMicro([{ unit: "", amount: "1" }], { tusdUnit: FAKE_TUSD_UNIT, tusdPerAda: "0.45" })).toEqual({ micro: 1n, mode: "equivalent" });
    expect(toTusdMicro([{ unit: "beef", amount: "1" }], { tusdUnit: FAKE_TUSD_UNIT })).toHaveProperty("error");
    expect(inputFieldOf({ input_data: [{ id: "prompt", type: "string" }] })).toBe("prompt");
    expect(inputFieldOf({ input_data: [{ id: "a", type: "string" }, { id: "b", type: "string" }] })).toBeNull();
    expect(inputFieldOf({ input_data: [{ id: "text", type: "string" }, { id: "style", type: "option", validations: [{ validation: "optional", value: "true" }] }] })).toBe("text");
    expect(inputFieldOf({ type: "object", properties: { query: { type: "string" } }, required: ["query"] })).toBe("query");
  });

  it("config: preprod only, buyer token required (from env or .local/mps-buyer.env)", () => {
    expect(() => masumiConfigFromEnv({ MASUMI_NETWORK: "Mainnet", MPS_BUYER_TOKEN: "x" }, FAKE_TUSD_UNIT, "/nonexistent")).toThrow(/preprod only/);
    expect(() => masumiConfigFromEnv({}, FAKE_TUSD_UNIT, "/nonexistent")).toThrow(/MPS_BUYER_TOKEN/);
    const c = masumiConfigFromEnv({ MPS_BUYER_TOKEN: "x", MASUMI_MAX_PRICE_TUSD: "7" }, FAKE_TUSD_UNIT, "/nonexistent");
    expect(c).toMatchObject({ network: "Preprod", mpsUrl: "http://127.0.0.1:3901/api/v1", maxPriceMicro: 7_000_000n, allowHttpAgents: false, requireOnChainResult: true });
    expect(() => createMasumiMarket({ ...c, network: "Mainnet" as "Preprod" }, { store: { get: () => null, set() {}, list: () => [] }, funding: () => null, sweepTarget: () => null })).toThrow(/Preprod/);
  });
});

describe("Masumi payee alias + session filter", () => {
  it("masumi:purchasing-wallet resolves to the MPS purchasing wallet and lands in the Session Vault's on-chain payees", async () => {
    h = await setupMasumi({ walletMode: "vault" });
    const [id] = await h.start([hirer()]);
    const row = h.sessions.get(id!)!;
    expect(row.allowedPayees).toEqual([{ id: MASUMI_PURCHASING_WALLET_ALIAS, label: "Masumi purchasing wallet", address: WALLET }]);
    const v = h.chain.vaultAt(row.address!)!;
    expect(v.payees).toEqual([WALLET]);
    // planner accepts the alias only when the Masumi market is active
    const plan = (p: string[], src: "masumi" | "mock") =>
      validatePlan(JSON.stringify({ sessions: [{ ...hirer({ allowedPayees: p }), deadline: new Date(Date.now() + 600_000).toISOString() }] }), {
        totalMicro: 100_000_000n,
        deadlineMs: Date.now() + 3_600_000,
        catalog: [{ id: "masumi-x", name: "X", skills: [], priceTUSD: "1", paymentAddress: WALLET, endpoint: "https://x", source: src }],
      });
    expect(plan([MASUMI_PURCHASING_WALLET_ALIAS], "masumi").ok).toBe(true);
    expect(plan([MASUMI_PURCHASING_WALLET_ALIAS], "mock").ok).toBe(false);
  });

  it("two agents collapsing onto the purchasing wallet keep both ids; an unlisted agent or a session without the wallet is refused", async () => {
    h = await setupMasumi({ registry: [entry(1), entry(2)] });
    const cat = await h.market.catalog();
    const [a1, a2] = [cat.find((a) => a.name === "Agent 1")!, cat.find((a) => a.name === "Agent 2")!];
    const [both, only1, none] = await h.start([hirer({ allowedPayees: [a1.id, a2.id] }), hirer({ name: "Only1", allowedPayees: [a1.id] }), spec({ taskType: "hire_agent", allowedPayees: [fakeAddress("other")], dataScope: [] })]);
    expect(h.sessions.get(both!)!.allowedPayees).toEqual([expect.objectContaining({ id: a1.id, address: WALLET, also: [a2.id] })]);
    await expect(h.hire(both!, a2.id)).resolves.toBeTruthy();
    await expect(h.hire(only1!, a2.id)).rejects.toThrow(/not in this session's allowed payees/);
    await expect(h.hire(none!, a1.id)).rejects.toThrow(/may not pay the Masumi purchasing wallet/);
  });
});

describe("Masumi hire: vault funding → MPS purchase → MIP-004 verified result", () => {
  it("funds the exact quoted price to the purchasing wallet, then posts the seller's signed terms verbatim", async () => {
    h = await setupMasumi({ walletMode: "vault" });
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job, d } = await h.hire(id!, svc);
    expect(job).toMatchObject({ paymentAddress: WALLET, amountMicro: 2_000_000n });
    expect(job.reference).toMatch(/^[0-9a-f]{20}$/);
    expect(d.kind).toBe("submitted");
    // before the funding confirms: no purchase yet
    expect((await h.market.status(svc, job.jobId)).status).toBe("awaiting_payment");
    expect(h.fake.purchases.size).toBe(0);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    // the vault Pay went to the purchasing wallet for exactly the price
    const pay = h.chain.txs.find((t) => t.kind === "vaultPay")!;
    expect(pay.args).toMatchObject({ payee: WALLET, tusdMicro: 2_000_000n });

    const r = await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"]);
    expect(r.status).toBe("completed");
    const sj = [...h.fake.sellerJobs.values()][0]!;
    expect(r.resultHash).toBe(mip004ResultHash(sj.result!, job.reference));
    expect(r.result).toBe(sj.result);
    const [p] = [...h.fake.purchases.values()];
    expect(p!.body).toMatchObject({
      network: "Preprod",
      blockchainIdentifier: sj.bcid,
      identifierFromPurchaser: job.reference,
      inputHash: mip004InputHash({ prompt: "Summarise Cardano DeFi TVL" }, job.reference),
      sellerVkey: "11".repeat(28),
      agentIdentifier: agentId(1),
      Amounts: [{ unit: PREPROD_TUSDM_UNIT, amount: "2000000" }],
      buyerReturnAddress: WALLET,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: 0,
    });
    // purchase writes use the buyer key only
    expect(h.fake.calls.filter((c) => c.path.startsWith("/api/v1/purchase")).every((c) => c.token === BUYER)).toBe(true);
    expect(h.market.job(job.jobId)!.phase).toBe("completed");
    // re-polling is stable and never reposts
    await h.market.status(svc, job.jobId);
    expect(h.fake.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/purchase")).toHaveLength(1);
  });

  it("Dynamic pricing takes the seller's signed amounts; a quote above MASUMI_MAX_PRICE_TUSD or a bad input_hash is refused before any money moves", async () => {
    const dyn = entry(3, { supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Dynamic" } }] });
    h = await setupMasumi({ registry: [dyn, entry(4)], cfg: { maxPriceMicro: 3_000_000n } });
    const [id] = await h.start([hirer()]);
    const cat = await h.market.catalog();
    const d3 = cat.find((a) => a.name === "Agent 3")!.id;
    h.fake.sellerCfg[3] = { dynamicAmounts: [{ unit: PREPROD_TUSDM_UNIT, amount: "1250000" }] };
    const { job } = await h.hire(id!, d3);
    expect(job.amountMicro).toBe(1_250_000n);
    h.fake.sellerCfg[3] = { dynamicAmounts: [{ unit: PREPROD_TUSDM_UNIT, amount: "9000000" }] };
    await expect(h.hire(id!, d3)).rejects.toThrow(/above MASUMI_MAX_PRICE_TUSD/);
    h.fake.sellerCfg[3] = {};
    await expect(h.hire(id!, d3)).rejects.toThrow(/returned no amounts/);
    h.fake.sellerCfg[4] = { tamperInputHash: true };
    await expect(h.hire(id!, cat.find((a) => a.name === "Agent 4")!.id)).rejects.toThrow(/input_hash/);
    h.fake.sellerCfg[4] = { payByInMs: 60_000 };
    await expect(h.hire(id!, cat.find((a) => a.name === "Agent 4")!.id)).rejects.toThrow(/payByTime/);
    // only the first (accepted) quote produced a payment
    expect(h.paymentOf(id!)).toHaveLength(1);
  });
});

describe("Masumi hire under the session mandate", () => {
  it("price above perPaymentMax: the Signer rejects, no purchase is ever posted", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer({ perPaymentMaxTUSD: "1", approvalThresholdTUSD: "1" })]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job, d } = await h.hire(id!, svc);
    expect(d).toMatchObject({ kind: "rejected", reason: "over_per_payment_max" });
    expect((await h.market.status(svc, job.jobId)).status).toBe("failed");
    expect(h.fake.purchases.size).toBe(0);
    expect(h.market.job(job.jobId)!.phase).toBe("failed");
  });

  it("price above the approval threshold opens a decision; the purchase is made only after approval + confirmation", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer({ approvalThresholdTUSD: "1" })]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job, d } = await h.hire(id!, svc);
    expect(d.kind).toBe("needs_approval");
    const dec = h.decisions.list({ status: "open" })[0]!;
    expect(dec).toMatchObject({ kind: "payment_approval", sessionId: id });
    // waiting for the user: nothing is purchased, the watcher does not abandon it
    expect((await h.market.status(svc, job.jobId)).status).toBe("awaiting_payment");
    await h.market.tick();
    expect(h.fake.purchases.size).toBe(0);
    await h.decisions.decide(dec.id, "approved", "user");
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "approved payment confirmed");
    const r = await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"]);
    expect(r.status).toBe("completed");
    expect(h.fake.purchases.size).toBe(1);
  });

  it("rejected approval → the job fails without a purchase", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer({ approvalThresholdTUSD: "1" })]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job } = await h.hire(id!, svc);
    await h.decisions.decide(h.decisions.list({ status: "open" })[0]!.id, "rejected", "user");
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "rejected", 3_000, "payment rejected");
    expect((await h.market.status(svc, job.jobId)).status).toBe("failed");
    expect(h.fake.purchases.size).toBe(0);
  });
});

describe("Masumi MIP-004 verification + refunds", () => {
  it("on-chain result hash ≠ sha256(nonce;result) → refund requested → escrow refunded → tUSD swept back to the session owner's treasury", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    h.fake.sellerCfg[1] = { tamperResult: true };
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    const r = await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"]);
    expect(r.status).toBe("failed");
    const rec = h.market.job(job.jobId)!;
    expect(rec.phase).toBe("refund_requested");
    expect(rec.refundReason).toMatch(/MIP-004 mismatch: on-chain resultHash/);
    expect(h.fake.calls.some((c) => c.path === "/api/v1/purchase/request-refund" && c.token === BUYER)).toBe(true);
    expect(h.events("error").some((e) => e.data.kind === "masumi_hash_mismatch")).toBe(true);
    // escrow pays the buyer back (to the purchasing wallet: buyerReturnAddress) → watcher sweeps with the admin key
    h.fake.refundAll();
    await h.market.tick();
    expect(h.market.job(job.jobId)!.phase).toBe("sweep_submitted");
    const tr = h.fake.transfers[0]!;
    expect(tr.body).toEqual({ fromWalletAddress: WALLET, toAddress: h.treasury, lovelaceAmount: "2000000", assets: [{ unit: FAKE_TUSD_UNIT, quantity: "2000000" }] });
    expect(h.fake.calls.find((c) => c.path === "/api/v1/wallet/transfer-funds")!.token).toBe(ADMIN);
    h.fake.confirmTransfers();
    await h.market.tick();
    expect(h.market.job(job.jobId)!).toMatchObject({ phase: "swept", sweep: { txHash: "f".repeat(64), status: "Confirmed" } });
    await h.market.tick();
    expect(h.fake.transfers).toHaveLength(1); // never swept twice
  });

  it("seller reports failure → refund requested; without an MPS admin key the refund stays in the purchasing wallet, flagged for the operator", async () => {
    h = await setupMasumi({ cfg: { adminToken: undefined } });
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    h.fake.sellerCfg[1] = { fail: true };
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    expect((await pollUntil(h.market, svc, job.jobId, h.fake, ["failed"])).status).toBe("failed");
    expect(h.market.job(job.jobId)!.refundReason).toMatch(/seller reported/);
    h.fake.refundAll();
    await h.market.tick();
    await h.market.tick();
    expect(h.market.job(job.jobId)!.phase).toBe("unswept");
    expect(h.fake.transfers).toHaveLength(0);
    expect(h.events("error").find((e) => e.data.kind === "masumi_refund_unswept")?.data).toMatchObject({ tusd: "2", to: h.treasury });
  });

  it("uncertain POST /purchase (5xx) is resolved before any repost; MPS 409 'Purchase exists' counts as purchased", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    h.fake.failNextPurchase(502);
    await h.market.status(svc, job.jobId);
    expect(h.market.job(job.jobId)!.phase).toBe("purchase_pending");
    await h.market.status(svc, job.jobId); // resolve → 404 → post again
    expect(h.market.job(job.jobId)!.phase).toBe("purchased");
    const posts = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/purchase").length;
    const resolves = h.fake.calls.filter((c) => c.path === "/api/v1/purchase/resolve-blockchain-identifier").length;
    expect(posts).toBe(2);
    expect(resolves).toBeGreaterThanOrEqual(1);
    expect((await pollUntil(h.market, svc, job.jobId, h.fake, ["completed"])).status).toBe("completed");
  });

  it("funding that confirms after payByTime is never used for a purchase; it is swept back", async () => {
    let clock = Date.now();
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    h.fake.sellerCfg[1] = { payByInMs: 5 * 60_000 };
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    // move the record's deadline into the past (as if confirmation took too long)
    const rec = h.market.job(job.jobId)!;
    clock = Date.now() - 1;
    dbMasumiStore(h.db).set(`masumi:job:${job.jobId}`, JSON.stringify({ ...rec, terms: { ...rec.terms, payByTime: String(clock) } }));
    expect((await h.market.status(svc, job.jobId)).status).toBe("failed");
    expect(h.market.job(job.jobId)!.phase).toBe("funding_unused");
    await h.market.tick();
    expect(h.fake.purchases.size).toBe(0);
    expect(h.fake.transfers[0]!.body).toMatchObject({ toAddress: h.treasury, assets: [{ unit: FAKE_TUSD_UNIT, quantity: "2000000" }] });
  });
});

describe("Masumi persistence", () => {
  it("job records live in the kv table (restart-safe) and hold no secrets", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job } = await h.hire(id!, svc);
    const raw = dbMasumiStore(h.db).get(`masumi:job:${job.jobId}`)!;
    expect(raw).not.toContain(BUYER);
    expect(raw).not.toContain(ADMIN);
    expect(JSON.parse(raw)).toMatchObject({ phase: "quoted", sessionId: id, nonce: job.reference, amountMicro: "2000000", fundingMode: "equivalent" });
    // a fresh market instance over the same DB continues the job
    const m2 = createMasumiMarket({ network: "Preprod", mpsUrl: MPS, buyerToken: BUYER, adminToken: ADMIN, tusdUnit: FAKE_TUSD_UNIT }, { fetchImpl: h.fake.fetchImpl, store: dbMasumiStore(h.db), funding: dbFundingLookup(h.db), sweepTarget: dbSweepTarget(h.db), log: () => undefined });
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    expect((await pollUntil(m2, svc, job.jobId, h.fake, ["completed"])).status).toBe("completed");
  });
});

// ─────────────────────────── verified against the MPS source + live reads (2026-10-07) ───────────────────────────
/** CIP-25 text over 64 bytes is stored as an array of chunks (MPS metadataToString joins them). */
const chunk = (s: string): string | string[] => (s.length > 64 ? s.match(/.{1,64}/g)! : s);
const chainMeta = (n: number, over: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => ({
  name: `Chain Agent ${n}`,
  description: "on-chain registry entry",
  api_base_url: chunk(SELLER(n)),
  tags: ["research"],
  image: "https://img.test/x.png",
  metadata_version: "2",
  author: { name: "Seller" },
  supported_payment_sources: [
    {
      chain: "Cardano",
      network: "Preprod",
      settlement: { paymentSourceType: "Web3CardanoV2", address: chunk(ESCROW) },
      pricing: { pricingType: "Fixed", fixed: [{ asset: chunk(PREPROD_TUSDM_UNIT), amount: "1000000" }] },
      ...source,
    },
  ],
  ...over,
});

describe("Masumi discovery from the on-chain registry (buyer key sees no MPS /registry entries)", () => {
  it("enumerates the MPS payment source's registry policy via Blockfrost and keeps only agents purchasable on this MPS", async () => {
    h = await setupMasumi({ registry: [], cfg: { blockfrostProjectId: BF_KEY, blockfrostUrl: BF } });
    h.fake.chainAssets.set(agentId(1), { quantity: "1", meta: chainMeta(1) });
    h.fake.chainAssets.set(agentId(2), { quantity: "0", meta: chainMeta(2) }); // deregistered (burnt)
    h.fake.chainAssets.set(agentId(3), { quantity: "1", meta: chainMeta(3, { type: "OpenAPI", api_base_url: undefined, openapi_spec_url: SELLER(3) }) });
    h.fake.chainAssets.set(agentId(4), { quantity: "1", meta: chainMeta(4, {}, { settlement: { paymentSourceType: "Web3CardanoV2", address: "addr_test1wzsomeothercontract" } }) });
    h.fake.chainAssets.set(agentId(5), { quantity: "1", meta: chainMeta(5, {}, { pricing: { pricingType: "Dynamic" } }) });
    const cat = await h.market.catalog();
    expect(cat.map((a) => a.name).sort()).toEqual(["Chain Agent 1", "Chain Agent 5"]);
    expect(cat.find((a) => a.name === "Chain Agent 1")).toMatchObject({ priceTUSD: "1", fundingMode: "equivalent", endpoint: SELLER(1), agentIdentifier: agentId(1), amounts: [{ unit: PREPROD_TUSDM_UNIT, amount: "1000000" }] });
    const why = Object.fromEntries(h.market.discoveryReport().excluded.map((x) => [x.name, x.reason]));
    expect(why["Chain Agent 3"]).toMatch(/OpenApi/);
    expect(why["Chain Agent 4"]).toMatch(/escrow contract is not configured on this MPS/);
    expect(why["Chain Agent 2"]).toBeUndefined(); // burnt NFTs are not entries at all
    // Blockfrost gets the project id header, never the MPS token
    const bfCalls = () => h!.fake.calls.filter((c) => c.path.startsWith("/api/v0/"));
    expect(bfCalls().length).toBeGreaterThan(0);
    expect(bfCalls().every((c) => c.token === null)).toBe(true);
    // metadata is cached: a second catalog pass re-lists the policy but does not refetch the assets
    const assetReads = () => bfCalls().filter((c) => /^\/api\/v0\/assets\/[0-9a-f]+$/.test(c.path)).length;
    const before = assetReads();
    h.market.invalidate();
    await h.market.catalog();
    expect(assetReads()).toBe(before);

    // and the hire goes all the way through (start_job → funding → POST /purchase → verified result)
    const [id] = await h.start([hirer()]);
    const svc = cat.find((a) => a.name === "Chain Agent 1")!.id;
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    expect((await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"])).status).toBe("completed");
  });

  it("MASUMI_AGENT_IDS pins discovery; an agent on a registry policy this MPS has no payment source for is excluded", async () => {
    const foreign = "cd".repeat(28) + "00000001" + "ef".repeat(8);
    h = await setupMasumi({ registry: [], cfg: { blockfrostProjectId: BF_KEY, blockfrostUrl: BF, agentIds: [agentId(1), foreign] } });
    h.fake.chainAssets.set(agentId(1), { quantity: "1", meta: chainMeta(1) });
    h.fake.chainAssets.set(agentId(6), { quantity: "1", meta: chainMeta(6) }); // not pinned → never read
    h.fake.chainAssets.set(foreign, { quantity: "1", meta: chainMeta(7) });
    const cat = await h.market.catalog();
    expect(cat.map((a) => a.name)).toEqual(["Chain Agent 1"]);
    expect(h.market.discoveryReport().excluded).toEqual([{ name: "Chain Agent 7", agentIdentifier: foreign, reason: "registry policy has no payment source on this MPS" }]);
    expect(h.fake.calls.some((c) => c.path.includes("/assets/policy/"))).toBe(false);
  });

  it("config: a Blockfrost preprod key turns on-chain discovery on; mainnet Blockfrost is refused", () => {
    const c = masumiConfigFromEnv({ MPS_BUYER_TOKEN: "x", BLOCKFROST_PREPROD_PROJECT_ID: BF_KEY, MASUMI_AGENT_IDS: `${agentId(1)}, ${agentId(2)}` }, FAKE_TUSD_UNIT, "/nonexistent");
    expect(c).toMatchObject({ blockfrostProjectId: BF_KEY, agentIds: [agentId(1), agentId(2)] });
    expect(masumiConfigFromEnv({ MPS_BUYER_TOKEN: "x", BLOCKFROST_PREPROD_PROJECT_ID: BF_KEY, MASUMI_ONCHAIN_DISCOVERY: "0" }, FAKE_TUSD_UNIT, "/nonexistent").blockfrostProjectId).toBeUndefined();
    expect(() => createMasumiMarket({ ...c, blockfrostUrl: "https://cardano-mainnet.blockfrost.io/api/v0" }, { store: { get: () => null, set() {}, list: () => [] }, funding: () => null, sweepTarget: () => null })).toThrow(/preprod/);
  });

  it("registryEntryFromMetadata joins CIP-25 chunks and maps V1 agentPricing", () => {
    const e = registryEntryFromMetadata(agentId(9), { ...chainMeta(9), supported_payment_sources: undefined, agentPricing: { pricingType: "Fixed", fixedPricing: [{ unit: chunk(PREPROD_TUSDM_UNIT), amount: 3000000 }] } });
    expect(e).toMatchObject({ name: "Chain Agent 9", type: "Standard", apiBaseUrl: SELLER(9), supportedPaymentSources: null, AgentPricing: { pricingType: "Fixed", Pricing: [{ unit: PREPROD_TUSDM_UNIT, amount: "3000000" }] } });
    const v2 = registryEntryFromMetadata(agentId(1), chainMeta(1));
    expect(v2.supportedPaymentSources).toEqual([{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: ESCROW, pricing: { pricingType: "Fixed", fixed: [{ asset: PREPROD_TUSDM_UNIT, amount: "1000000" }] } }]);
  });
});

describe("Masumi seller terms vs MPS POST /purchase rules", () => {
  it("passes the signed sellerReturnAddress + paymentForceLayer back verbatim", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    const ret = "addr_test1qr0rnnrhe6tlj5cls2xcunaxvl8kgaa6henck5hjd2fvpw073tfdyz2574tg4rnazrw23t2klnd3ldlx22zdf75y7cnqpcvlyj";
    h.fake.sellerCfg[1] = { extra: { sellerReturnAddress: ret, paymentForceLayer: null } };
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    expect((await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"])).status).toBe("completed");
    expect([...h.fake.purchases.values()][0]!.body).toMatchObject({ sellerReturnAddress: ret, paymentForceLayer: null });
  });

  it("refuses before any money moves: Hydra-forced terms, deadlines MPS would reject, a non-MIP-003 /availability", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    h.fake.sellerCfg[1] = { extra: { paymentForceLayer: "Hydra" } };
    await expect(h.hire(id!, svc)).rejects.toThrow(/settlement layer Hydra/);
    h.fake.sellerCfg[1] = { unlockInMs: 25 * 60_000 }; // submitResult +20 → unlock must be ≥ +35
    await expect(h.hire(id!, svc)).rejects.toThrow(/MPS would refuse these terms: unlockTime/);
    h.fake.sellerCfg[1] = { htmlAvailability: true };
    await expect(h.hire(id!, svc)).rejects.toThrow(/agent unavailable/);
    expect(h.paymentOf(id!)).toHaveLength(0);
  });

  it("accepts the skill's `output` field from /status", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    h.fake.sellerCfg[1] = { useOutput: true, result: "plain output" };
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    const r = await pollUntil(h.market, svc, job.jobId, h.fake, ["completed", "failed"]);
    expect(r).toMatchObject({ status: "completed", result: "plain output", resultHash: mip004ResultHash("plain output", job.reference) });
  });

  it("an escrow lock that never happens by payByTime + grace counts as unused funding and is swept back", async () => {
    h = await setupMasumi();
    const [id] = await h.start([hirer()]);
    const svc = (await h.market.catalog())[0]!.id;
    const { job } = await h.hire(id!, svc);
    await waitFor(() => h!.paymentOf(id!)[0]?.status === "confirmed", 3_000, "funding confirmed");
    await h.market.status(svc, job.jobId); // posts the purchase; the fake never locks it
    expect(h.market.job(job.jobId)!.phase).toBe("purchased");
    expect((await h.market.status(svc, job.jobId)).status).toBe("awaiting_payment"); // still inside payByTime
    const rec = h.market.job(job.jobId)!;
    dbMasumiStore(h.db).set(`masumi:job:${job.jobId}`, JSON.stringify({ ...rec, terms: { ...rec.terms, payByTime: String(Date.now() - 16 * 60_000) } }));
    expect((await h.market.status(svc, job.jobId)).status).toBe("failed");
    expect(h.market.job(job.jobId)!).toMatchObject({ phase: "funding_unused", error: expect.stringMatching(/escrow lock never happened/) });
    await h.market.tick();
    expect(h.fake.transfers[0]!.body).toMatchObject({ toAddress: h.treasury, assets: [{ unit: FAKE_TUSD_UNIT, quantity: "2000000" }] });
  });

  it("mpsTimingError mirrors resolvePurchaseCreationContext", () => {
    const at = 1_000_000_000_000;
    const M = 60_000;
    const ok = { payByTime: String(at + 10 * M), submitResultTime: String(at + 20 * M), unlockTime: String(at + 36 * M), externalDisputeUnlockTime: String(at + 52 * M) };
    expect(mpsTimingError(ok, at)).toBeNull();
    expect(mpsTimingError({ ...ok, payByTime: String(at + 16 * M) }, at)).toMatch(/payByTime must be/);
    expect(mpsTimingError(ok, at + 6 * M)).toMatch(/submitResultTime is less than 15 min/);
    expect(mpsTimingError({ ...ok, unlockTime: String(at + 30 * M) }, at)).toMatch(/unlockTime/);
    expect(mpsTimingError({ ...ok, externalDisputeUnlockTime: String(at + 40 * M) }, at)).toMatch(/externalDisputeUnlockTime/);
  });

  it("input_schema: display-only `none` fields are skipped (live Kodosumi/Sokosumi schemas)", () => {
    // live 2026-10-07: expert-travel-advisor-eve.vercel.app/input_schema
    expect(inputFieldOf({ input_data: [{ id: "request", type: "string", name: "Stay request", validations: [{ validation: "min", value: "1" }] }] })).toBe("request");
    // kodosumi …/uplift/ruth: info (none) + several optional textareas → ambiguous → not hireable from free text
    expect(inputFieldOf({ input_data: [{ id: "info", type: "none", validations: null }, { id: "assets", type: "textarea", validations: [{ validation: "optional", value: "true" }] }, { id: "asset_urls", type: "textarea", validations: [{ validation: "optional", value: "true" }] }] })).toBeNull();
    expect(inputFieldOf({ input_data: [{ id: "info", type: "none", validations: null }, { id: "brief", type: "textarea" }] })).toBe("brief");
    // MIP-003 grouped form
    expect(inputFieldOf({ input_groups: [{ id: "g1", title: "Details", input_data: [{ id: "query", type: "string" }] }] })).toBe("query");
  });
});
