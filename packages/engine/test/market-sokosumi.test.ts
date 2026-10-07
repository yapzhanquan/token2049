// MARKET=sokosumi: hire Sokosumi agents with CREDITS billed only to the configured organization.
// OFFLINE: an in-process fake Sokosumi API behind fetchImpl (shapes from the live /v1/openapi.json + the
// installed Sokosumi CLI's api/services + api/models). Nothing here touches the live API.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentJobs, payments, sessions as sessionsT } from "@bulkhead/db";
import { sha256Hex } from "@bulkhead/shared/mip004";
import { checkDone } from "../src/done";
import { dbMasumiStore } from "../src/market-masumi";
import {
  SOKOSUMI_CREDITS_PAYEE_PREFIX,
  createCompositeMarket,
  createSokosumiMarket,
  dbSokosumiMandate,
  mapSokosumiInput,
  maxCreditsFor,
  sokosumiConfigFromEnv,
  type SokosumiConfig,
  type SokosumiMandate,
  type SokosumiMarket,
} from "../src/market-sokosumi";
import { createFakeMarket, setup, spec, waitFor } from "./runtime/helpers";

const API = "https://api.preprod.sokosumi.test";
const KEY = "soko-test-key-SECRET";
const SLUG = "token2049-origins-hackathon-2026-test";
const ORG = "org-hackathon";
const OTHER = "org-bulkhead";
const AGENT = "cmmdca97d000304icco9htf5n"; // "Expose: Advanced Web Research" (1 credit)
const PRICEY = "cmnh66qhb000604i2jgdenpb6"; // "Statista Research" (100 credits)
const RESULT = "# Cardano stablecoin settlement\n\nB2B suppliers can settle in USDM on Cardano…\n";

/** Live input schema of "Expose: Advanced Web Research" (GET /v1/agents/{id}/input-schema, 2026-10-07). */
const LIVE_SCHEMA = {
  input_data: [
    { id: "info", type: "none", name: "Information", data: { description: "# Advanced Web Research Agent" } },
    { id: "research_question", type: "textarea", name: "Research Question", data: { placeholder: "Example: …" }, validations: null },
    { id: "additional_context", type: "textarea", name: "Additional Context (Optional)", data: { placeholder: "…" }, validations: [{ validation: "optional", value: "true" }] },
  ],
};

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function createFakeSokosumi(opts: { org?: number; personal?: number; other?: number; chargeTo?: "org" | "personal"; jobOrg?: string | null; pollsUntilDone?: number; resultInLinksOnly?: boolean } = {}) {
  const state = { org: opts.org ?? 58_950, personal: opts.personal ?? 3_250, other: opts.other ?? 250 };
  const calls: Call[] = [];
  const jobs = new Map<string, { agentId: string; credits: number; polls: number; body: Record<string, unknown> }>();
  const agents = [
    { id: AGENT, name: "Expose: Advanced Web Research", credits: 1, summary: "Web research with citations", categories: [{ name: "Research" }], kind: "agent" },
    { id: PRICEY, name: "Statista Research", credits: 100, summary: "Statista", categories: [], kind: "agent" },
    { id: "x402-1", name: "Patrick OpenAPI", kind: "x402" }, // no credits → not listed
    { id: "free-1", name: "devint", credits: 0, kind: "agent" }, // free dev agent → not listed
  ];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, headers, body });
    if (headers.authorization !== `Bearer ${KEY}`) return json({ error: "Unauthorized" }, 401);
    const p = url.pathname;
    if (method === "GET" && p === "/v1/agents") return json({ data: agents, meta: { pagination: { nextCursor: null } } });
    let m = /^\/v1\/agents\/([^/]+)\/input-schema$/.exec(p);
    if (method === "GET" && m) return json({ data: LIVE_SCHEMA });
    if (method === "GET" && p === "/v1/users/me/organizations") return json({ data: [{ id: OTHER, slug: "bulkhead-x" }, { id: ORG, slug: SLUG }] });
    m = /^\/v1\/users\/me\/organizations\/([^/]+)\/credits$/.exec(p);
    if (method === "GET" && m) return json({ data: { scope: "organization", spendable: m[1] === ORG ? state.org : state.other } });
    if (method === "GET" && p === "/v1/users/me/credits") {
      // Active context: the slug header switches it; without it → the personal wallet.
      return headers["x-organization-slug"] ? json({ data: { scope: "organization", spendable: state.org } }) : json({ data: { scope: "personal", spendable: state.personal } });
    }
    m = /^\/v1\/agents\/([^/]+)\/jobs$/.exec(p);
    if (method === "POST" && m) {
      const a = agents.find((x) => x.id === m![1])!;
      if ((body as { maxCredits?: number }).maxCredits! < a.credits!) return json({ error: "BadRequest", message: "maxCredits below price" }, 400);
      if (state.org < a.credits!) return json({ error: "PaymentRequired", message: "Insufficient credits" }, 402);
      const id = `job_${++n}`;
      jobs.set(id, { agentId: a.id, credits: a.credits!, polls: 0, body: body as Record<string, unknown> });
      if ((opts.chargeTo ?? "org") === "org") state.org -= a.credits!;
      else state.personal -= a.credits!;
      return json({ data: { id, status: "started", agentId: a.id, credits: a.credits, organizationId: opts.jobOrg === undefined ? ORG : opts.jobOrg } }, 201);
    }
    m = /^\/v1\/jobs\/([^/]+)(\/(links|files|events))?$/.exec(p);
    if (method === "GET" && m) {
      const j = jobs.get(m[1]!);
      if (!j) return json({ error: "NotFound" }, 404);
      if (m[3] === "links") return json({ data: opts.resultInLinksOnly ? [{ title: "Report", url: "https://example.test/report" }] : [] });
      if (m[3]) return json({ data: [] });
      j.polls++;
      const done = j.polls > (opts.pollsUntilDone ?? 1);
      return json({ data: { id: m[1], status: done ? "completed" : "processing", credits: j.credits, organizationId: ORG, result: done && !opts.resultInLinksOnly ? RESULT : null, resultHash: done ? "masumi-onchain-hash" : null } });
    }
    return json({ error: "NotFound", path: p }, 404);
  };
  return { fetchImpl, calls, state, jobs };
}

const cfg = (over: Partial<SokosumiConfig> = {}): SokosumiConfig => ({ apiUrl: API, apiKey: KEY, organizationSlug: SLUG, organizationId: ORG, creditsPerTusd: 100, maxCreditsPerHire: 10, ...over });
const memStore = () => {
  const m = new Map<string, string>();
  return { m, store: { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), list: (pre: string) => [...m].filter(([k]) => k.startsWith(pre)).map(([key, value]) => ({ key, value })) } };
};
const mandate = (over: Partial<SokosumiMandate> = {}): SokosumiMandate => ({ status: "RUNNING", budgetMicro: 1_000_000n, spentMicro: 0n, creditSpentMicro: 0n, perPaymentMaxMicro: 1_000_000n, ...over });

function standalone(fakeOpts: Parameters<typeof createFakeSokosumi>[0] = {}, m: SokosumiMandate | null = mandate(), cfgOver: Partial<SokosumiConfig> = {}) {
  const fake = createFakeSokosumi(fakeOpts);
  const { m: kv, store } = memStore();
  const events: { type: string; sessionId: string | null; data: Record<string, unknown> }[] = [];
  const market = createSokosumiMarket(cfg(cfgOver), { fetchImpl: fake.fetchImpl, store, mandate: () => m, emit: (type, sessionId, data) => void events.push({ type, sessionId, data }), log: () => undefined });
  return { fake, kv, market, events };
}

async function pollDone(market: SokosumiMarket, serviceId: string, jobId: string) {
  for (let i = 0; i < 20; i++) {
    const r = await market.status(serviceId, jobId);
    if (r.status !== "running") return r;
  }
  throw new Error("never finished");
}

describe("Sokosumi market: organization-only billing", () => {
  it("every request carries X-Organization-Slug (except the no-slug personal control read); the key never leaks", async () => {
    const { fake, market, events, kv } = standalone();
    const list = await market.catalog();
    expect(list.map((a) => a.id)).toEqual([`sokosumi:${AGENT}`, `sokosumi:${PRICEY}`]); // x402 + free agents skipped
    expect(list[0]).toMatchObject({ source: "sokosumi", billing: "credits", credits: 1, priceTUSD: "0.01", paymentAddress: "" });
    const job = await market.startJob(`sokosumi:${AGENT}`, "Cardano stablecoin settlement for B2B supplier payments", { sessionId: "ses_1" });
    expect(job.billing).toMatchObject({ kind: "credits", credits: 1, maxCredits: 10, organizationSlug: SLUG, payee: `${SOKOSUMI_CREDITS_PAYEE_PREFIX}${SLUG}` });
    expect(job.amountMicro).toBe(10_000n);
    await pollDone(market, `sokosumi:${AGENT}`, job.jobId);
    expect(fake.calls.length).toBeGreaterThan(8);
    for (const c of fake.calls) {
      const personalRead = c.method === "GET" && c.path === "/v1/users/me/credits";
      if (personalRead) expect(c.headers["x-organization-slug"]).toBeUndefined();
      else expect(c.headers["x-organization-slug"], `${c.method} ${c.path}`).toBe(SLUG);
    }
    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.headers["x-organization-slug"]).toBe(SLUG);
    expect(post.body).toMatchObject({ inputSchema: LIVE_SCHEMA, inputData: { research_question: "Cardano stablecoin settlement for B2B supplier payments" }, maxCredits: 10 });
    expect((post.body as { inputData: Record<string, unknown> }).inputData).not.toHaveProperty("additional_context");
    // Org paid, personal unchanged; deltas recorded; no secret anywhere.
    const rec = market.job(job.jobId)!;
    expect(rec).toMatchObject({ status: "completed", orgDelta: -1, personalDelta: 0, otherDeltas: { [OTHER]: 0 }, jobOrganizationId: ORG, resultHash: sha256Hex(RESULT), sokosumiResultHash: "masumi-onchain-hash" });
    expect(fake.state).toMatchObject({ org: 58_949, personal: 3_250 });
    expect(JSON.stringify([...kv.values()]) + JSON.stringify(events)).not.toContain(KEY);
    expect(events.filter((e) => e.data.kind === "sokosumi_credits").map((e) => e.data.phase)).toEqual(["afterHire", "afterResult"]);
    expect(market.disabled()).toBeNull();
  });

  it("refuses to start without the organization slug / id or the key; mainnet is refused", () => {
    const deps = { store: memStore().store, mandate: () => null };
    expect(() => createSokosumiMarket(cfg({ organizationSlug: "" }), deps)).toThrow(/SOKOSUMI_HIRE_ORGANIZATION_SLUG/);
    expect(() => createSokosumiMarket(cfg({ organizationSlug: "bad slug!" }), deps)).toThrow(/letters, numbers/);
    expect(() => createSokosumiMarket(cfg({ organizationId: " " }), deps)).toThrow(/SOKOSUMI_HIRE_ORGANIZATION_ID/);
    expect(() => createSokosumiMarket(cfg({ apiKey: "" }), deps)).toThrow(/SOKOSUMI_API_KEY/);
    expect(() => createSokosumiMarket(cfg({ apiUrl: "https://api.sokosumi.com" }), deps)).toThrow(/mainnet/);
    const env = { SOKOSUMI_API_KEY: KEY, SOKOSUMI_HIRE_ORGANIZATION_SLUG: SLUG, SOKOSUMI_HIRE_ORGANIZATION_ID: ORG } as NodeJS.ProcessEnv;
    expect(() => sokosumiConfigFromEnv({ ...env, SOKOSUMI_HIRE_ORGANIZATION_SLUG: "" })).toThrow(/refused/);
    expect(() => sokosumiConfigFromEnv({ ...env, SOKOSUMI_HIRE_ORGANIZATION_ID: undefined })).toThrow(/refused/);
    expect(sokosumiConfigFromEnv(env)).toMatchObject({ apiUrl: "https://api.preprod.sokosumi.com", creditsPerTusd: 100, maxCreditsPerHire: 10, organizationSlug: SLUG });
    expect(sokosumiConfigFromEnv({ ...env, SOKOSUMI_CREDITS_PER_TUSDM: "50" }).creditsPerTusd).toBe(50);
    expect(() => sokosumiConfigFromEnv({ ...env, SOKOSUMI_CREDITS_PER_TUSDM: "-1" })).toThrow();
  });

  it("personal credits decrease → incident event, market disabled (persisted), no further hires", async () => {
    const { fake, market, events, kv } = standalone({ chargeTo: "personal" });
    await expect(market.startJob(`sokosumi:${AGENT}`, "research X", { sessionId: "ses_1" })).rejects.toThrow(/disabled/);
    const inc = events.find((e) => e.data.kind === "sokosumi_incident")!;
    expect(inc.type).toBe("error");
    expect(inc.data).toMatchObject({ incident: true, personalBefore: 3_250, personalAfter: 3_249 });
    expect(market.disabled()).toMatch(/personal Sokosumi credits decreased by 1/);
    expect(await market.catalog()).toEqual([]);
    const posts = fake.calls.filter((c) => c.method === "POST").length;
    await expect(market.startJob(`sokosumi:${AGENT}`, "again", { sessionId: "ses_1" })).rejects.toThrow(/disabled/);
    expect(fake.calls.filter((c) => c.method === "POST").length).toBe(posts);
    // Persisted: a new market instance on the same store stays disabled.
    const again = createSokosumiMarket(cfg(), { fetchImpl: fake.fetchImpl, store: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v), list: () => [] }, mandate: () => mandate() });
    expect(again.disabled()).toBeTruthy();
  });

  it("a job created outside the configured organization → incident + disabled", async () => {
    const { market, events } = standalone({ jobOrg: null });
    await expect(market.startJob(`sokosumi:${AGENT}`, "research X", { sessionId: "ses_1" })).rejects.toThrow(/not billed to organization/);
    expect(events.some((e) => e.data.kind === "sokosumi_incident")).toBe(true);
    expect(market.disabled()).toMatch(/non-organization/);
  });

  it("mandate cap: maxCredits from the remaining budget × rate and the per-payment max; pricier agents refused before any request", async () => {
    expect(maxCreditsFor(mandate({ budgetMicro: 50_000n, perPaymentMaxMicro: 1_000_000n }), 100, 10).maxCredits).toBe(5);
    expect(maxCreditsFor(mandate({ budgetMicro: 1_000_000n, perPaymentMaxMicro: 20_000n }), 100, 10).maxCredits).toBe(2);
    expect(maxCreditsFor(mandate({ budgetMicro: 1_000_000n, spentMicro: 600_000n, creditSpentMicro: 395_000n }), 100, 10).maxCredits).toBe(0);
    expect(maxCreditsFor(mandate({ budgetMicro: 100_000_000n, perPaymentMaxMicro: 100_000_000n }), 100, 10).maxCredits).toBe(10); // ceiling

    const a = standalone({}, mandate({ perPaymentMaxMicro: 20_000n }));
    const j = await a.market.startJob(`sokosumi:${AGENT}`, "q", { sessionId: "ses_1" });
    expect(a.fake.calls.find((c) => c.method === "POST")!.body).toMatchObject({ maxCredits: 2 });
    expect(j.billing!.maxCredits).toBe(2);

    const b = standalone({}, mandate({ budgetMicro: 100_000_000n, perPaymentMaxMicro: 100_000_000n }));
    await expect(b.market.startJob(`sokosumi:${PRICEY}`, "q", { sessionId: "ses_1" })).rejects.toThrow(/100 credits > mandate cap 10/);
    const c = standalone({}, mandate({ budgetMicro: 5_000n })); // 0.005 tUSD → 0 credits
    await expect(c.market.startJob(`sokosumi:${AGENT}`, "q", { sessionId: "ses_1" })).rejects.toThrow(/mandate cap 0/);
    const d = standalone({}, null);
    await expect(d.market.startJob(`sokosumi:${AGENT}`, "q")).rejects.toThrow(/session mandate/);
    for (const x of [b, c, d]) expect(x.fake.calls.filter((k) => k.method === "POST" || /credits/.test(k.path))).toHaveLength(0);
    // Not enough org credits → refused before the POST.
    const e = standalone({ org: 0 });
    await expect(e.market.startJob(`sokosumi:${AGENT}`, "q", { sessionId: "ses_1" })).rejects.toThrow(/0 spendable credits/);
    expect(e.fake.calls.filter((k) => k.method === "POST")).toHaveLength(0);
  });

  it("input schema mapping: free text → primary field; JSON → fields by id; missing required fields are named", () => {
    expect(mapSokosumiInput(LIVE_SCHEMA, "What drives EV adoption?").inputData).toEqual({ research_question: "What drives EV adoption?" });
    expect(mapSokosumiInput(LIVE_SCHEMA, JSON.stringify({ research_question: "Q", additional_context: "C" })).inputData).toEqual({ research_question: "Q", additional_context: "C" });
    const two = { input_data: [{ id: "company", type: "string", name: "Company" }, { id: "website", type: "url", name: "Website" }, { id: "depth", type: "option", name: "Depth", data: { values: ["quick", "deep"], default: "quick" } }, { id: "token", type: "hidden", name: "t", data: { value: "abc" } }] };
    expect(mapSokosumiInput(two, JSON.stringify({ company: "IOG", website: "https://iog.io" })).inputData).toEqual({ company: "IOG", website: "https://iog.io", depth: "quick", token: "abc" });
    expect(() => mapSokosumiInput(two, "IOG")).toThrow(/website \(url, required\)/);
    expect(() => mapSokosumiInput(LIVE_SCHEMA, JSON.stringify({ research_question: { nested: 1 } }))).toThrow(/must be a string/);
    expect(() => mapSokosumiInput(LIVE_SCHEMA, "  ")).toThrow(/empty/);
  });

  it("a completed job without a result string uses its links; resultHash = sha256(raw UTF-8 text)", async () => {
    const { market } = standalone({ resultInLinksOnly: true });
    const job = await market.startJob(`sokosumi:${AGENT}`, "q", { sessionId: "ses_1" });
    const r = await pollDone(market, `sokosumi:${AGENT}`, job.jobId);
    expect(r).toEqual({ status: "completed", result: "Report: https://example.test/report", resultHash: sha256Hex("Report: https://example.test/report") });
  });

  it("composite: the catalog shows mock + sokosumi with source labels and routes by id", async () => {
    const { market } = standalone();
    const mock = createFakeMarket({ txs: [] } as never);
    const comp = createCompositeMarket([{ name: "mock", market: mock }, { name: "sokosumi", market }]);
    const list = await comp.catalog();
    expect(list.map((a) => `${a.source}:${a.id}`)).toEqual(["mock:market-research", `sokosumi:sokosumi:${AGENT}`, `sokosumi:sokosumi:${PRICEY}`]);
    const j = await comp.startJob(`sokosumi:${AGENT}`, "q", { sessionId: "ses_1" });
    expect(j.billing?.kind).toBe("credits");
    expect((await comp.startJob("market-research", "q")).billing).toBeUndefined();
    expect(await comp.resolvePayeeAlias!(`sokosumi:${AGENT}`, { ownerAddress: "addr_test1qowner" })).toMatchObject({ id: `sokosumi:${AGENT}`, address: "addr_test1qowner" });
  });
});

describe("definition of done accepts a Sokosumi credit job", () => {
  const hb = (jobId: string, resultHash: string) => ({ summary: "hired", result: "r", sources: [], flags: [], job: { jobId, resultHash } });
  const base = { taskType: "hire_agent" as const, payments: [], deadline: Date.now() + 60_000, startedAt: Date.now(), now: Date.now() };
  const h64 = sha256Hex(RESULT);
  it("credits job: needs the recorded credit charge + a matching 64-hex result hash; no tx hash", () => {
    expect(checkDone({ ...base, handback: hb("job_1", h64), jobs: [{ externalJobId: "job_1", status: "completed", resultHash: h64, paymentConfirmed: true, billing: "credits" }] })).toEqual({ ok: true });
    expect(checkDone({ ...base, handback: hb("job_1", h64), jobs: [{ externalJobId: "job_1", status: "completed", resultHash: h64, paymentConfirmed: false, billing: "credits" }] })).toMatchObject({ ok: false, reason: /credit charge/ });
    expect(checkDone({ ...base, handback: hb("job_1", "00"), jobs: [{ externalJobId: "job_1", status: "completed", resultHash: h64, paymentConfirmed: true, billing: "credits" }] })).toMatchObject({ ok: false, reason: /result_hash/ });
    expect(checkDone({ ...base, handback: hb("job_1", h64), jobs: [{ externalJobId: "job_1", status: "completed", resultHash: h64, paymentConfirmed: false }] })).toMatchObject({ ok: false, reason: /on-chain/ });
  });
});

describe("hire_agent session end-to-end with Sokosumi credits (real silo, FakeChain)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });
  it("hires with org credits, records an off-chain credit payment row, DoD accepts jobId + resultHash, session CLOSED/COMPLETED", async () => {
    const fake = createFakeSokosumi();
    let soko: SokosumiMarket | null = null;
    const h = await setup({
      realSilos: true,
      market: (db, chain, bus) => {
        soko = createSokosumiMarket(cfg(), { fetchImpl: fake.fetchImpl, store: dbMasumiStore(db), mandate: dbSokosumiMandate(db), emit: (type, sessionId, data) => void bus.emit(type, { ...(sessionId ? { sessionId } : {}), data }), log: () => undefined });
        return createCompositeMarket([{ name: "mock", market: createFakeMarket(chain) }, { name: "sokosumi", market: soko }]);
      },
    });
    cleanup = h.cleanup;
    const goalId = h.newGoal();
    const [id] = await h.sessions.startPlan(goalId, { sessions: [spec({ taskType: "hire_agent", role: "hirer", goal: "Cardano stablecoin settlement for B2B supplier payments", allowedPayees: [`sokosumi:${AGENT}`], budgetTUSD: "1", perPaymentMaxTUSD: "0.5", approvalThresholdTUSD: "0.4", dataScope: [] })] });
    await h.sessions.whenClosed(id!, 40_000);
    const row = h.db.select().from(sessionsT).where(eq(sessionsT.id, id!)).get()!;
    expect(row.closeStatus).toBe("COMPLETED");
    // Allowlist entry: the agent id, pinned to the owner's own treasury (credits never go on-chain).
    expect(JSON.parse(row.allowedPayeesJson)[0]).toMatchObject({ id: `sokosumi:${AGENT}`, address: h.treasury });
    const pay = h.db.select().from(payments).where(eq(payments.sessionId, id!)).all();
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ payee: `${SOKOSUMI_CREDITS_PAYEE_PREFIX}${SLUG}`, txHash: null, status: "confirmed", amountMicro: "10000" });
    expect(pay[0]!.memo).toMatch(/credits:1 .*off-chain/);
    const job = h.db.select().from(agentJobs).where(eq(agentJobs.sessionId, id!)).get()!;
    expect(job).toMatchObject({ status: "completed", paymentId: pay[0]!.id, resultHash: sha256Hex(RESULT) });
    expect(h.events("agent_job_paid", id)[0]!.data).toMatchObject({ kind: "credits", txHash: null, credits: 1, organizationSlug: SLUG });
    expect(h.events("handback_accepted", id)).toHaveLength(1);
    // No on-chain hire payment; session spent nothing on-chain.
    expect(h.events("payment_submitted", id)).toHaveLength(0);
    // Credit hires inside the mandate caps are autonomous: no approval / decision is ever opened for them.
    expect(h.events("decision_opened")).toHaveLength(0);
    expect(h.events("payment_approval_needed")).toHaveLength(0);
    expect(row.spentMicro).toBe("0");
    expect(fake.state).toMatchObject({ org: 58_949, personal: 3_250 });
    expect(soko!.disabled()).toBeNull();
    // POST carried the slug and the mandate cap (min(1, 0.5) tUSD × 100 = 50 → ceiling 10).
    expect(fake.calls.find((c) => c.method === "POST")).toMatchObject({ headers: { "x-organization-slug": SLUG }, body: { maxCredits: 10 } });
    await waitFor(() => true);
  }, 60_000);
});
