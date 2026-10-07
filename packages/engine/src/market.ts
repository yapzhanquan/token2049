// Agent market client (spec §5.6). Masumi-style job pattern (MIP-003):
//   GET  {MARKET_URL}/agents                 → AgentCatalogEntry[]  (or { agents: [...] })
//   POST {agent.endpoint}/start_job          → StartJobResponse { job_id, payment_address, amount_tusd, payment_reference }
//   GET  {agent.endpoint}/status?job_id={id}  → JobStatusResponse { status, result?, result_hash? }  (MIP-003)
// The agent starts work only after it sees the payment on-chain (carrying payment_reference in metadata 674).
import { randomUUID } from "node:crypto";
import { microToTusd, tusdToMicro, type AgentCatalogEntry, type JobStatusResponse, type StartJobResponse } from "@bulkhead/shared";
import type { AgentMarket } from "./contracts";

type FetchFn = typeof fetch;

export function createAgentMarket(opts: { baseUrl: string; fetchImpl?: FetchFn; cacheMs?: number; timeoutMs?: number }): AgentMarket & { invalidate(): void } {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let cache: { at: number; list: AgentCatalogEntry[] } | null = null;

  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`market ${init?.method ?? "GET"} ${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const endpointOf = async (serviceId: string) => {
    const list = await market.catalog();
    const entry = list.find((a) => a.id === serviceId);
    if (!entry) throw new Error(`unknown agent service "${serviceId}"`);
    return (entry.endpoint || `${base}/agents/${encodeURIComponent(serviceId)}`).replace(/\/+$/, "");
  };

  const market = {
    invalidate() {
      cache = null;
    },
    async catalog() {
      if (cache && Date.now() - cache.at < (opts.cacheMs ?? 30_000)) return cache.list;
      const body = await call<AgentCatalogEntry[] | { agents: AgentCatalogEntry[] }>(`${base}/agents`);
      const list = Array.isArray(body) ? body : body.agents;
      cache = { at: Date.now(), list };
      return list;
    },
    async startJob(serviceId: string, input: string) {
      const ep = await endpointOf(serviceId);
      const r = await call<StartJobResponse>(`${ep}/start_job`, {
        method: "POST",
        body: JSON.stringify({ identifier_from_purchaser: randomUUID().replace(/-/g, "").slice(0, 26), input_data: { input }, input, service_id: serviceId }),
      });
      if (!r.job_id || !r.payment_address || !r.amount_tusd) throw new Error("market start_job: malformed response");
      return { jobId: r.job_id, paymentAddress: r.payment_address, amountMicro: tusdToMicro(r.amount_tusd), reference: r.payment_reference ?? r.job_id };
    },
    async status(serviceId: string, jobId: string) {
      const ep = await endpointOf(serviceId);
      const r = await call<JobStatusResponse>(`${ep}/status?job_id=${encodeURIComponent(jobId)}`);
      return { status: r.status, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.result_hash !== undefined ? { resultHash: r.result_hash } : {}) };
    },
  };
  return market;
}

/** Sokosumi adapter placeholder (stretch goal, spec §5.6): not configured in this build. */
export class SokosumiMarket implements AgentMarket {
  async catalog(): Promise<AgentCatalogEntry[]> {
    throw new Error("SokosumiMarket: not configured");
  }
  async startJob(): Promise<{ jobId: string; paymentAddress: string; amountMicro: bigint; reference: string }> {
    throw new Error("SokosumiMarket: not configured");
  }
  async status(): Promise<{ status: string; result?: string; resultHash?: string }> {
    throw new Error("SokosumiMarket: not configured");
  }
}

/** The parts of the in-memory FakeChain (packages/engine/test/fake-chain.ts) the dev bridge reads. */
export interface FakeChainLedger {
  txs: { txHash: string; kind: string; confirmed: boolean; args: unknown }[];
}

/**
 * OFFLINE DEMO ONLY (CHAIN=fake). The FakeChain lives inside the engine process, so the separate mock-market
 * process cannot "see" payments on it. This bridge forwards every CONFIRMED FakeChain session payment to the
 * market's test-mode route POST /__test/payments (market started with MARKET_TEST_MODE=fake-chain or
 * CHAIN=fake), carrying the payment_reference, so the market's unchanged matching logic marks the job paid.
 * Nothing here is on-chain. Returns a stop function.
 */
export function bridgeFakeChainToMarket(
  ledger: FakeChainLedger,
  opts: { marketUrl: string; pollMs?: number; fetchImpl?: FetchFn; log?: (msg: string) => void },
): () => void {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(`[engine] ${m}`));
  const url = `${opts.marketUrl.replace(/\/+$/, "")}/__test/payments`;
  const sent = new Set<string>();
  let busy = false;
  let warned = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const t of ledger.txs) {
        if ((t.kind !== "sessionPay" && t.kind !== "vaultPay") || !t.confirmed || sent.has(t.txHash)) continue;
        const a = (t.args ?? {}) as { payee?: string; tusdMicro?: bigint; reference?: string };
        if (!a.payee || typeof a.tusdMicro !== "bigint" || !a.reference) {
          sent.add(t.txHash); // only hire payments (with a payment_reference) matter to the market
          continue;
        }
        let res: Response;
        try {
          res = await f(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: a.payee, amount_tusd: microToTusd(a.tusdMicro), tx_hash: t.txHash, reference: a.reference }),
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          break; // market not up yet: retry next tick
        }
        if (res.ok) {
          sent.add(t.txHash);
          log(`FakeChain → market bridge: payment ${t.txHash.slice(0, 12)}… (ref ${a.reference}) forwarded — OFFLINE DEMO, not on-chain`);
        } else if (res.status === 404) {
          if (!warned) log("FakeChain → market bridge: the market is not in fake-chain test mode (start it with CHAIN=fake or MARKET_TEST_MODE=fake-chain); hired jobs will stay awaiting_payment");
          warned = true;
          break;
        } else break;
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.pollMs ?? 1_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
