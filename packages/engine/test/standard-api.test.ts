// Masumi Standard API (MIP-003) — every endpoint + the background job lifecycle, with a fake engine and
// fake payments. Nothing here touches MPS, the engine, or the chain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inputSchemaHash, mip004InputHash, mip004ResultHash } from "@bulkhead/shared/mip004";
import {
  composeGoalResult,
  confirmedOnChainState,
  createEngineHttpClient,
  createMpsPayments,
  createStandardApi,
  DefiniteError,
  NotSentError,
  fileJobStore,
  memoryJobStore,
  STANDARD_INPUT_SCHEMA,
  type PaymentObservation,
  type PaymentQuote,
  type StandardEngine,
  type StandardPayments,
} from "../src/standard-api";

const NONCE = "aabbccddeeff0011";
const T0 = 1_790_000_000_000;
const MIN = 60_000;

function fakeEngine() {
  const calls: string[] = [];
  let state: Awaited<ReturnType<StandardEngine["goalState"]>> = { state: "running" };
  const e = {
    healthy: true,
    planError: null as Error | null,
    approveError: null as Error | null,
    planArgs: [] as Parameters<StandardEngine["planGoal"]>[0][],
    setState(s: typeof state) {
      state = s;
    },
    calls,
    async health() {
      if (!e.healthy) throw new Error("down");
      return { ok: true };
    },
    async planGoal(a: Parameters<StandardEngine["planGoal"]>[0]) {
      calls.push("plan");
      e.planArgs.push(a);
      if (e.planError) throw e.planError;
      return { goalId: "g_1" };
    },
    async approveGoal(id: string) {
      calls.push(`approve:${id}`);
      if (e.approveError) throw e.approveError;
    },
    async goalState(id: string) {
      calls.push(`state:${id}`);
      return state;
    },
  };
  return e;
}

function fakePayments(now: () => number) {
  const obs: PaymentObservation = { onChainState: null, fundsLockedConfirmed: false, resultSubmittedConfirmed: false, resultHash: null };
  const p = {
    created: [] as Parameters<StandardPayments["createPaymentRequest"]>[0][],
    submitted: [] as { id: string; hash: string }[],
    createError: null as Error | null,
    submitError: null as Error | null,
    obs,
    quoteOverride: {} as Partial<PaymentQuote>,
    async createPaymentRequest(req: Parameters<StandardPayments["createPaymentRequest"]>[0]): Promise<PaymentQuote> {
      p.created.push(req);
      if (p.createError) throw p.createError;
      return {
        blockchainIdentifier: "bc_signed",
        agentIdentifier: "a".repeat(64),
        sellerVKey: "b".repeat(56),
        inputHash: req.inputHash,
        payByTime: req.payByTime.getTime(),
        submitResultTime: req.submitResultTime.getTime(),
        unlockTime: req.unlockTime.getTime(),
        externalDisputeUnlockTime: req.externalDisputeUnlockTime.getTime(),
        paymentSourceType: "Web3CardanoV2",
        supportedPaymentSourceIndex: 0,
        ...p.quoteOverride,
      };
    },
    async getPayment() {
      return { ...p.obs };
    },
    async submitResult(id: string, hash: string) {
      p.submitted.push({ id, hash });
      if (p.submitError) throw p.submitError;
    },
  };
  void now;
  return p;
}

function setup(opts: { free?: boolean } = {}) {
  let t = T0;
  const now = () => t;
  const engine = fakeEngine();
  const payments = fakePayments(now);
  const store = memoryJobStore();
  let n = 0;
  const api = createStandardApi({
    engine,
    payments: opts.free ? null : payments,
    store,
    now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  const post = async (path: string, body: unknown): Promise<Res> =>
    api.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = async (path: string): Promise<Res> => api.app.request(path);
  return { api, engine, payments, store, post, get, advanceClock: (ms: number) => (t += ms), now };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = Omit<Response, "json"> & { json(): Promise<any> };
const startBody = (goal = "Summarise MIP-003", nonce = NONCE) => ({ identifier_from_purchaser: nonce, input_data: { goal } });

describe("GET /availability", () => {
  it("available with type masumi-agent", async () => {
    const { get } = setup();
    const r = await get("/availability");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "available", type: "masumi-agent" });
  });
  it("unavailable when the engine is down", async () => {
    const s = setup();
    s.engine.healthy = false;
    expect(await (await s.get("/availability")).json()).toMatchObject({ status: "unavailable", type: "masumi-agent" });
  });
});

describe("GET /input_schema and /demo", () => {
  it("returns the flat input_data schema", async () => {
    const { get } = setup();
    const body = await (await get("/input_schema")).json();
    expect(body).toEqual(JSON.parse(JSON.stringify(STANDARD_INPUT_SCHEMA)));
    expect(body.input_data[0]).toMatchObject({ id: "goal", type: "string" });
  });
  it("demo returns input + output", async () => {
    const body = await (await setup().get("/demo")).json();
    expect(body.input.goal).toBeTypeOf("string");
    expect(body.output.result).toBeTypeOf("string");
  });
});

describe("POST /start_job validation", () => {
  it.each([
    ["missing nonce", { input_data: { goal: "x" } }],
    ["non-hex nonce", { identifier_from_purchaser: "resume-job-123x", input_data: { goal: "x" } }],
    ["short nonce", { identifier_from_purchaser: "abcdef", input_data: { goal: "x" } }],
    ["missing input", { identifier_from_purchaser: NONCE }],
    ["array input", { identifier_from_purchaser: NONCE, input_data: [{ key: "goal", value: "x" }] }],
    ["empty goal", { identifier_from_purchaser: NONCE, input_data: { goal: "   " } }],
    ["extra field", { identifier_from_purchaser: NONCE, input_data: { goal: "x", other: 1 } }],
    ["goal too long", { identifier_from_purchaser: NONCE, input_data: { goal: "x".repeat(501) } }],
  ])("400 on %s, no payment created", async (_name, body) => {
    const s = setup();
    const r = await s.post("/start_job", body);
    expect(r.status).toBe(400);
    expect(s.payments.created).toHaveLength(0);
  });
  it("400 on invalid JSON, 413 on oversize body", async () => {
    const s = setup();
    expect((await s.post("/start_job", "{nope")).status).toBe(400);
    expect((await s.post("/start_job", { identifier_from_purchaser: NONCE, input_data: { goal: "x".repeat(25_000) } })).status).toBe(413);
  });
});

describe("POST /start_job (paid)", () => {
  it("creates an MPS payment request bound to the MIP-004 input hash and returns MIP-003 terms", async () => {
    const s = setup();
    const r = await s.post("/start_job", startBody());
    expect(r.status).toBe(200);
    const body = await r.json();
    const expectedHash = mip004InputHash({ goal: "Summarise MIP-003" }, NONCE);
    expect(s.payments.created).toHaveLength(1);
    const req = s.payments.created[0]!;
    expect(req.inputHash).toBe(expectedHash);
    expect(req.identifierFromPurchaser).toBe(NONCE);
    // MPS constraints: submitResult ≥ now+15m, submit - payBy ≥ 5m, unlock - submit ≥ 15m, dispute - unlock ≥ 15m
    expect(req.submitResultTime.getTime() - T0).toBeGreaterThanOrEqual(15 * MIN);
    expect(req.submitResultTime.getTime() - req.payByTime.getTime()).toBeGreaterThanOrEqual(5 * MIN);
    expect(req.unlockTime.getTime() - req.submitResultTime.getTime()).toBeGreaterThanOrEqual(15 * MIN);
    expect(req.externalDisputeUnlockTime.getTime() - req.unlockTime.getTime()).toBeGreaterThanOrEqual(15 * MIN);
    expect(body).toMatchObject({
      job_id: body.id,
      status: "awaiting_payment",
      blockchainIdentifier: "bc_signed",
      identifierFromPurchaser: NONCE,
      input_hash: expectedHash,
      agentIdentifier: "a".repeat(64),
      sellerVKey: "b".repeat(56),
      payByTime: req.payByTime.getTime(),
      submitResultTime: req.submitResultTime.getTime(),
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: 0,
    });
    expect(s.engine.calls).toHaveLength(0); // no work before payment
  });

  it("accepts the camelCase identifierFromPurchaser alias", async () => {
    const s = setup();
    const r = await s.post("/start_job", { identifierFromPurchaser: NONCE, input_data: { goal: "x" } });
    expect(r.status).toBe(200);
  });

  it("same nonce + same input replays the saved response; different input → 409", async () => {
    const s = setup();
    const a = await (await s.post("/start_job", startBody())).json();
    const b = await (await s.post("/start_job", startBody())).json();
    expect(b).toEqual(a);
    expect(s.payments.created).toHaveLength(1);
    expect((await s.post("/start_job", startBody("Something else"))).status).toBe(409);
  });

  it("MPS 4xx → job failed, 502", async () => {
    const s = setup();
    s.payments.createError = new DefiniteError("bad", 400);
    const r = await s.post("/start_job", startBody());
    expect(r.status).toBe(502);
    expect(s.store.list()[0]!.phase).toBe("failed");
  });

  it("unknown MPS outcome → needs-inspection, never replayed", async () => {
    const s = setup();
    s.payments.createError = new Error("timeout");
    expect((await s.post("/start_job", startBody())).status).toBe(500);
    expect(s.store.list()[0]!.phase).toBe("needs-inspection");
    s.payments.createError = null;
    expect((await s.post("/start_job", startBody())).status).toBe(409);
    expect(s.payments.created).toHaveLength(1);
  });

  it("quote with a different input hash is not offered to the buyer", async () => {
    const s = setup();
    s.payments.quoteOverride = { inputHash: "f".repeat(64) };
    expect((await s.post("/start_job", startBody())).status).toBe(500);
    expect(s.store.list()[0]!.phase).toBe("needs-inspection");
  });
});

describe("GET /status", () => {
  it("400 without job_id, 404 for unknown / malformed ids", async () => {
    const s = setup();
    expect((await s.get("/status")).status).toBe(400);
    expect((await s.get("/status?job_id=00000000-0000-4000-8000-999999999999")).status).toBe(404);
    expect((await s.get("/status?job_id=../../etc")).status).toBe(404);
  });
  it("awaiting_payment with job_id and input_hash", async () => {
    const s = setup();
    const { job_id, input_hash } = await (await s.post("/start_job", startBody())).json();
    const st = await (await s.get(`/status?job_id=${job_id}`)).json();
    expect(st).toMatchObject({ job_id, status: "awaiting_payment", input_hash, blockchainIdentifier: "bc_signed" });
    expect(st.result).toBeUndefined();
  });
});

describe("paid lifecycle via tick()", () => {
  it("unconfirmed FundsLocked does not start work", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    s.payments.obs.onChainState = "FundsLocked"; // pending tx, not confirmed
    await s.api.tick();
    expect(s.engine.calls).toHaveLength(0);
  });

  it("confirmed lock → goal plan + approve → result → submit MIP-004 hash → confirmed → completed", async () => {
    const s = setup();
    const { job_id } = await (await s.post("/start_job", startBody("Find three preprod faucets"))).json();
    s.payments.obs.onChainState = "FundsLocked";
    s.payments.obs.fundsLockedConfirmed = true;
    await s.api.tick();
    expect(s.engine.calls).toEqual(["plan", "approve:g_1"]);
    expect(s.engine.planArgs[0]!.goal).toBe("Find three preprod faucets");
    expect(Date.parse(s.engine.planArgs[0]!.deadline)).toBeLessThan(s.store.get(job_id)!.payment!.submitResultTime);
    expect((await (await s.get(`/status?job_id=${job_id}`)).json()).status).toBe("running");

    await s.api.tick(); // still running
    expect(s.payments.submitted).toHaveLength(0);

    const result = 'Faucets:\n1. "Cardano" faucet\\docs';
    s.engine.setState({ state: "completed", result });
    await s.api.tick();
    const hash = mip004ResultHash(result, NONCE);
    expect(s.payments.submitted).toEqual([{ id: "bc_signed", hash }]);
    expect((await (await s.get(`/status?job_id=${job_id}`)).json()).status).toBe("running"); // until confirmed

    s.payments.obs.onChainState = "ResultSubmitted";
    s.payments.obs.resultSubmittedConfirmed = true;
    s.payments.obs.resultHash = "0".repeat(64); // wrong hash → not completed
    await s.api.tick();
    expect(s.store.get(job_id)!.phase).toBe("awaiting-result-confirmation");
    s.payments.obs.resultHash = hash;
    await s.api.tick();
    const st = await (await s.get(`/status?job_id=${job_id}`)).json();
    expect(st).toMatchObject({ job_id, status: "completed", result, output_hash: hash, result_hash: hash, input_hash: mip004InputHash({ goal: "Find three preprod faucets" }, NONCE) });
    expect(s.payments.submitted).toHaveLength(1);
  });

  it("lock confirmed too close to the result deadline → failed, no work", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    s.advanceClock(59 * MIN);
    Object.assign(s.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    await s.api.tick();
    expect(s.engine.calls).toHaveLength(0);
    expect(s.store.list()[0]!.phase).toBe("failed");
  });

  it("no payment by payByTime (+grace) → failed", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    s.advanceClock(21 * MIN);
    await s.api.tick();
    expect(s.store.list()[0]).toMatchObject({ phase: "failed", error: "payment not received before payByTime" });
  });

  it("submit-result failure → needs-inspection and is never retried", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    Object.assign(s.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    s.engine.setState({ state: "completed", result: "ok" });
    s.payments.submitError = new Error("timeout");
    await s.api.tick();
    await s.api.tick();
    await s.api.tick();
    expect(s.payments.submitted).toHaveLength(1);
    const job = s.store.list()[0]!;
    expect(job.phase).toBe("needs-inspection");
    const st = await (await s.get(`/status?job_id=${job.id}`)).json();
    expect(st.status).toBe("running");
    expect(st.message).toMatch(/inspection/);
  });

  it("plan rejected (4xx) → failed; unknown plan outcome → needs-inspection, not replayed", async () => {
    const a = setup();
    await a.post("/start_job", startBody());
    Object.assign(a.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    a.engine.planError = new DefiniteError("plan invalid", 400);
    await a.api.tick();
    expect(a.store.list()[0]!.phase).toBe("failed");

    const b = setup();
    await b.post("/start_job", startBody());
    Object.assign(b.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    b.engine.planError = new Error("socket hang up");
    await b.api.tick();
    await b.api.tick();
    expect(b.engine.calls.filter((c) => c === "plan")).toHaveLength(1);
    expect(b.store.list()[0]!.phase).toBe("needs-inspection");
  });

  it("plan not sent (engine user unavailable) stays ready and is retried", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    Object.assign(s.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    s.engine.planError = new NotSentError("engine down");
    await s.api.tick();
    expect(s.store.list()[0]!.phase).toBe("ready");
    s.engine.planError = null;
    await s.api.tick();
    expect(s.store.list()[0]!.phase).toBe("running");
  });

  it("approve network error is retried (idempotent); goal failure → failed", async () => {
    const s = setup();
    await s.post("/start_job", startBody());
    Object.assign(s.payments.obs, { onChainState: "FundsLocked", fundsLockedConfirmed: true });
    s.engine.approveError = new Error("ECONNRESET");
    await s.api.tick();
    expect(s.store.list()[0]!.phase).toBe("goal-planned");
    s.engine.approveError = null;
    await s.api.tick();
    expect(s.engine.calls.filter((c) => c === "plan")).toHaveLength(1);
    expect(s.store.list()[0]!.phase).toBe("running");
    s.engine.setState({ state: "failed", error: "no session produced a result" });
    await s.api.tick();
    const st = await (await s.get(`/status?job_id=${s.store.list()[0]!.id}`)).json();
    expect(st).toMatchObject({ status: "failed", message: "no session produced a result" });
  });
});

describe("free mode", () => {
  it("start_job queues work without payment; tick completes it with hashes", async () => {
    const s = setup({ free: true });
    const body = await (await s.post("/start_job", startBody())).json();
    expect(body).toMatchObject({ status: "running", job_id: body.id, input_hash: mip004InputHash({ goal: "Summarise MIP-003" }, NONCE) });
    s.engine.setState({ state: "completed", result: "done" });
    await s.api.tick();
    await s.api.tick();
    const st = await (await s.get(`/status?job_id=${body.job_id}`)).json();
    expect(st).toMatchObject({ status: "completed", result: "done", output_hash: mip004ResultHash("done", NONCE) });
    expect(s.payments.created).toHaveLength(0);
  });
});

describe("POST /provide_input", () => {
  it("validates body, 404 unknown job, 400 when the job is not awaiting input", async () => {
    const s = setup();
    const { job_id } = await (await s.post("/start_job", startBody())).json();
    const hash = inputSchemaHash(STANDARD_INPUT_SCHEMA);
    expect((await s.post("/provide_input", { input_schema_hash: hash, input_data: {} })).status).toBe(400);
    expect((await s.post("/provide_input", { job_id, input_schema_hash: "xyz", input_data: {} })).status).toBe(400);
    expect((await s.post("/provide_input", { job_id, input_schema_hash: hash })).status).toBe(400);
    expect((await s.post("/provide_input", { job_id: "00000000-0000-4000-8000-999999999999", input_schema_hash: hash, input_data: {} })).status).toBe(404);
    const r = await s.post("/provide_input", { job_id, input_schema_hash: hash, input_data: { goal: "more" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not awaiting input/);
  });
});

describe("fileJobStore", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  it("persists jobs and finds by nonce across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "std-jobs-"));
    dirs.push(dir);
    const a = fileJobStore(dir);
    const job = { id: "00000000-0000-4000-8000-000000000001", nonce: NONCE, input: { goal: "x" }, inputHash: "h", paid: true, phase: "awaiting-payment" as const, createdAt: 1, updatedAt: 1, deadline: 2 };
    a.put(job);
    const b = fileJobStore(dir);
    expect(b.get(job.id)).toEqual(job);
    expect(b.byNonce(NONCE)?.id).toBe(job.id);
    expect(b.get("../x")).toBeUndefined();
    expect(() => a.put({ ...job, id: "../evil" })).toThrow();
  });
});

describe("createMpsPayments (MPS routes, fake fetch)", () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200, headers: { "content-type": "application/json" } });
  const agentIdentifier = "c".repeat(64);
  function client(responder: (url: string, body: Record<string, unknown>) => Response) {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url, headers: init.headers as Record<string, string>, body });
      return responder(url, body);
    }) as unknown as typeof fetch;
    const mps = createMpsPayments({ baseUrl: "http://mps.local/api/v1/", token: "test-token", agentIdentifier, supportedPaymentSourceIndex: 0, paymentSourceType: "Web3CardanoV2", fetch: f });
    return { mps, seen };
  }

  it("POST /payment with the MPS create schema and parses the signed terms", async () => {
    const { mps, seen } = client((_u, b) =>
      ok({ blockchainIdentifier: "bc", agentIdentifier, inputHash: b.inputHash, payByTime: "1790000600000", submitResultTime: "1790003600000", unlockTime: "1790004800000", externalDisputeUnlockTime: "1790006000000", SmartContractWallet: { walletVkey: "d".repeat(56) }, PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2" } }),
    );
    const q = await mps.createPaymentRequest({ inputHash: "e".repeat(64), identifierFromPurchaser: NONCE, payByTime: new Date(T0 + 10 * MIN), submitResultTime: new Date(T0 + 60 * MIN), unlockTime: new Date(T0 + 80 * MIN), externalDisputeUnlockTime: new Date(T0 + 100 * MIN) });
    expect(seen[0]!.url).toBe("http://mps.local/api/v1/payment");
    expect(seen[0]!.headers.token).toBe("test-token");
    expect(seen[0]!.body).toMatchObject({ network: "Preprod", agentIdentifier, inputHash: "e".repeat(64), identifierFromPurchaser: NONCE, supportedPaymentSourceIndex: 0, paymentSourceType: "Web3CardanoV2", submitResultTime: new Date(T0 + 60 * MIN).toISOString() });
    expect(q).toMatchObject({ blockchainIdentifier: "bc", sellerVKey: "d".repeat(56), payByTime: 1790000600000, submitResultTime: 1790003600000 });
  });

  it("rejects a non-Preprod payment source and reports HTTP errors as definite", async () => {
    const a = client(() => ok({ blockchainIdentifier: "bc", payByTime: "1", submitResultTime: "2", unlockTime: "3", externalDisputeUnlockTime: "4", PaymentSource: { network: "Mainnet" } }));
    await expect(a.mps.createPaymentRequest({ inputHash: "e".repeat(64), identifierFromPurchaser: NONCE, payByTime: new Date(), submitResultTime: new Date(), unlockTime: new Date(), externalDisputeUnlockTime: new Date() })).rejects.toThrow(/not Preprod/);
    const b = client(() => new Response(JSON.stringify({ status: "error" }), { status: 400 }));
    await expect(b.mps.submitResult("bc", "a".repeat(64))).rejects.toBeInstanceOf(DefiniteError);
  });

  it("resolve-blockchain-identifier → observation; submit-result sends the 64-hex hash", async () => {
    const { mps, seen } = client((url) =>
      url.endsWith("/resolve-blockchain-identifier")
        ? ok({ onChainState: "FundsLocked", resultHash: "", CurrentTransaction: null, TransactionHistory: [{ status: "Confirmed", newOnChainState: "FundsLocked" }] })
        : ok({ blockchainIdentifier: "bc" }),
    );
    expect(await mps.getPayment("bc")).toEqual({ onChainState: "FundsLocked", fundsLockedConfirmed: true, resultSubmittedConfirmed: false, resultHash: null });
    expect(seen[0]!.body).toMatchObject({ network: "Preprod", blockchainIdentifier: "bc", includeHistory: "true" });
    await mps.submitResult("bc", "a".repeat(64));
    expect(seen[1]!.url).toBe("http://mps.local/api/v1/payment/submit-result");
    expect(seen[1]!.body).toEqual({ network: "Preprod", blockchainIdentifier: "bc", submitResultHash: "a".repeat(64) });
    await expect(mps.submitResult("bc", "a".repeat(128))).rejects.toThrow(/64-char/);
  });

  it("refuses mainnet config and short agent identifiers", () => {
    expect(() => createMpsPayments({ baseUrl: "x", token: "t", agentIdentifier, network: "Mainnet" as "Preprod" })).toThrow(/Preprod/);
    expect(() => createMpsPayments({ baseUrl: "x", token: "t", agentIdentifier: "short" })).toThrow();
  });

  it("confirmedOnChainState needs a Confirmed tx with the expected new state", () => {
    expect(confirmedOnChainState({ CurrentTransaction: { status: "Pending", newOnChainState: "FundsLocked" } }, "FundsLocked")).toBe(false);
    expect(confirmedOnChainState({ CurrentTransaction: { status: "Confirmed", newOnChainState: "Withdrawn" } }, "FundsLocked")).toBe(false);
    expect(confirmedOnChainState({ CurrentTransaction: { status: "Confirmed", newOnChainState: "FundsLocked" } }, "FundsLocked")).toBe(true);
  });
});

describe("createEngineHttpClient (engine routes, fake fetch)", () => {
  it("acts as one dedicated custodial user: POST /users, /goals, approve, then reads handbacks", async () => {
    const seen: { method: string; path: string; headers: Record<string, string> }[] = [];
    let goalStatus = "running";
    const f = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push({ method: init.method!, path, headers: init.headers as Record<string, string> });
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (path === "/users") return j({ userId: "u_std", custody: "custodial", created: true }, 201);
      if (path === "/health") return j({ ok: true });
      if (path === "/goals" && init.method === "POST") return j({ goalId: "g_9", plan: {}, fundingPreview: {} }, 201);
      if (path === "/goals/g_9/approve") return j({ ok: true, fundingTx: "f".repeat(64), sessionIds: ["s_a", "s_b"] });
      if (path === "/goals") return j([{ id: "g_9", status: goalStatus }]);
      if (path === "/goals/g_9/tree") return j({ goalId: "g_9", nodes: [{ id: "g_9", kind: "goal" }, { id: "s_b", kind: "session" }, { id: "s_a", kind: "session" }], edges: [] });
      if (path === "/sessions/s_a") return j({ id: "s_a", letter: "A", name: "Research", handback: { result: "alpha" } });
      if (path === "/sessions/s_b") return j({ id: "s_b", letter: "B", name: "Write", handback: { result: "beta" } });
      return j({ error: "nope" }, 404);
    }) as unknown as typeof fetch;
    const e = createEngineHttpClient({ baseUrl: "http://engine.local/", token: "engine-token", userEmail: "std@bulkhead.local", fetch: f });
    expect(await e.health()).toEqual({ ok: true });
    expect(await e.planGoal({ goal: "g", budgetTUSD: "2", deadline: new Date(T0).toISOString(), rules: "" })).toEqual({ goalId: "g_9" });
    await e.approveGoal("g_9");
    expect(await e.goalState("g_9")).toEqual({ state: "running" });
    goalStatus = "done";
    expect(await e.goalState("g_9")).toEqual({ state: "completed", result: "## A. Research\nalpha\n\n## B. Write\nbeta" });
    expect(seen.filter((s) => s.path === "/users")).toHaveLength(1); // user id cached
    const goalsPost = seen.find((s) => s.path === "/goals" && s.method === "POST")!;
    expect(goalsPost.headers["x-user-id"]).toBe("u_std");
    expect(goalsPost.headers["x-engine-token"]).toBe("engine-token");
    goalStatus = "cancelled";
    expect(await e.goalState("g_9")).toEqual({ state: "failed", error: "goal was cancelled" });
  });

  it("approve that needs a signature (non-custodial user) is a definite failure; HTTP errors are definite", async () => {
    const f = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/users") return new Response(JSON.stringify({ userId: "u", custody: "custodial" }));
      if (path.endsWith("/approve")) return new Response(JSON.stringify({ ok: false, needsSignature: true }));
      return new Response(JSON.stringify({ error: "invalid plan" }), { status: 400 });
    }) as unknown as typeof fetch;
    const e = createEngineHttpClient({ baseUrl: "http://engine.local", userEmail: "x@y.z", fetch: f });
    await expect(e.approveGoal("g")).rejects.toBeInstanceOf(DefiniteError);
    await expect(e.planGoal({ goal: "g", budgetTUSD: "2", deadline: "", rules: "" })).rejects.toBeInstanceOf(DefiniteError);
  });

  it("engine unreachable before POST /goals → NotSentError (retryable)", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const e = createEngineHttpClient({ baseUrl: "http://engine.local", userEmail: "x@y.z", fetch: f });
    await expect(e.planGoal({ goal: "g", budgetTUSD: "2", deadline: "", rules: "" })).rejects.toBeInstanceOf(NotSentError);
  });

  it("composeGoalResult: single handback verbatim; none → failed", () => {
    expect(composeGoalResult([{ id: "s", handback: { result: "only\nline" } }])).toEqual({ state: "completed", result: "only\nline" });
    expect(composeGoalResult([{ id: "s", handback: null }])).toEqual({ state: "failed", error: "no session produced a result" });
  });
});
