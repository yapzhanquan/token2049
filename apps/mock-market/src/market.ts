// Core of the mock agent market: job lifecycle + on-chain payment detection.
//   awaiting_payment ──(UTxO at the agent address with ≥ price tUSD whose tx carries
//                       payment_reference in metadata 674)──▶ running ──(deterministic work)──▶ completed
//   awaiting_payment ──(pay window elapsed)──▶ failed
import { randomBytes, randomUUID } from "node:crypto";
import { microToTusd, tusdToMicro, type AgentCatalogEntry, type JobStatusResponse, type StartJobResponse } from "@bulkhead/shared";
import { AGENTS, findAgent, MAX_INPUT_CHARS, sha256Hex, type AgentDef } from "./agents";
import { metadataHasReference, type ChainReader } from "./chain-reader";
import type { JobRecord, JobStore } from "./store";
import type { AgentWalletSource } from "./wallets";

export class MarketError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

export interface MarketOptions {
  /** Public base URL of this service (catalog `endpoint` = `${baseUrl}/agents/<id>`). */
  baseUrl: string;
  wallets: AgentWalletSource;
  reader: ChainReader;
  store: JobStore;
  /** policyId+assetNameHex of tUSD. Null → payments can never be matched (logged). */
  tusdUnit: string | null;
  payWindowMs?: number;
  workDelayMs?: number;
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type StartJobResult = StartJobResponse & {
  // MIP-003 fields, mapped onto our tUSD direct-payment flow.
  id: string;
  status: JobStatusResponse["status"];
  blockchainIdentifier: string;
  payByTime: number; // unix seconds
  agentIdentifier: string;
  identifierFromPurchaser: string | null;
  input_hash: string;
};

/** MIP-003 /availability body. */
export interface Availability {
  status: "available" | "unavailable";
  type: "masumi-agent";
  message: string;
}

export type StatusResult = JobStatusResponse & {
  agent_id: string;
  amount_tusd: string;
  payment_address: string;
  payment_reference: string;
  input_hash: string;
  error?: string;
};

export class Market {
  private addresses = new Map<string, string | null>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private workTimers = new Set<NodeJS.Timeout>();
  private readonly payWindowMs: number;
  private readonly workDelayMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private o: MarketOptions) {
    this.payWindowMs = o.payWindowMs ?? 60 * 60_000;
    this.workDelayMs = o.workDelayMs ?? 1_500;
    this.pollMs = o.pollMs ?? 10_000;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[market] ${m}`));
  }

  /** Resolve agent payment addresses and resume jobs interrupted by a restart. */
  async init(): Promise<void> {
    for (const a of AGENTS) {
      let addr: string | null = null;
      try {
        addr = await this.o.wallets.address(a.walletIndex);
      } catch (e) {
        this.log(`agent ${a.id}: wallet lookup failed: ${(e as Error).message}`);
      }
      this.addresses.set(a.id, addr);
      if (!addr) this.log(`agent ${a.id}: no payment address (source: ${this.o.wallets.name}) → unavailable`);
    }
    if (!this.o.tusdUnit) this.log("tUSD unit unknown → payments cannot be matched until it is configured");
    for (const j of this.o.store.all()) if (j.status === "running") this.scheduleWork(j.job_id);
  }

  /** Start background polling of the chain for payments. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`tick failed: ${(e as Error).message}`)), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.workTimers) clearTimeout(t);
    this.workTimers.clear();
  }

  private addressOf(a: AgentDef): string | null {
    return this.addresses.get(a.id) ?? null;
  }

  catalog(): AgentCatalogEntry[] {
    return AGENTS.filter((a) => this.addressOf(a)).map((a) => ({
      id: a.id,
      name: a.name,
      skills: a.skills,
      priceTUSD: a.priceTUSD,
      paymentAddress: this.addressOf(a)!,
      endpoint: `${this.o.baseUrl}/agents/${a.id}`,
      source: "mock" as const,
    }));
  }

  agentAvailability(agentId: string): Availability {
    const a = findAgent(agentId);
    if (!a) throw new MarketError(404, `unknown agent: ${agentId}`);
    const ok = !!this.addressOf(a) && !!this.o.tusdUnit;
    return {
      status: ok ? "available" : "unavailable",
      type: "masumi-agent",
      message: ok ? `${a.name} is ready to accept jobs` : `${a.name} has no payment address or tUSD unit configured`,
    };
  }

  availability(): Availability & { agents: (Availability & { id: string })[] } {
    const agents = AGENTS.map((a) => ({ id: a.id, ...this.agentAvailability(a.id) }));
    const n = agents.filter((a) => a.status === "available").length;
    return { status: n > 0 ? "available" : "unavailable", type: "masumi-agent", message: `${n}/${agents.length} agents available`, agents };
  }

  startJob(agentId: unknown, input: unknown, identifierFromPurchaser?: unknown): StartJobResult {
    if (typeof agentId !== "string" || !agentId) throw new MarketError(400, "agent_id is required");
    const agent = findAgent(agentId);
    if (!agent) throw new MarketError(404, `unknown agent: ${agentId}`);
    if (typeof input !== "string" || input.trim().length === 0) throw new MarketError(400, "input must be a non-empty string");
    if (input.length > MAX_INPUT_CHARS) throw new MarketError(400, `input exceeds ${MAX_INPUT_CHARS} characters`);
    const address = this.addressOf(agent);
    if (!address || !this.o.tusdUnit) throw new MarketError(503, `agent ${agentId} is unavailable (no payment address / tUSD unit)`);
    const now = this.now();
    const job: JobRecord = {
      job_id: randomUUID(),
      agent_id: agent.id,
      identifier_from_purchaser: typeof identifierFromPurchaser === "string" ? identifierFromPurchaser.slice(0, 200) : null,
      input,
      input_hash: sha256Hex(input),
      status: "awaiting_payment",
      payment_address: address,
      amount_micro: tusdToMicro(agent.priceTUSD).toString(),
      // ≤ 64 bytes so it fits in one CIP-20 metadata string.
      payment_reference: `bhm-${randomBytes(12).toString("hex")}`,
      created_at: now,
      pay_by: now + this.payWindowMs,
    };
    this.o.store.put(job);
    this.log(`job ${job.job_id} (${agent.id}) awaiting ${agent.priceTUSD} tUSD at ${address} ref ${job.payment_reference}`);
    return {
      job_id: job.job_id,
      payment_address: address,
      amount_tusd: microToTusd(BigInt(job.amount_micro)),
      payment_reference: job.payment_reference,
      id: job.job_id,
      status: job.status,
      blockchainIdentifier: job.payment_reference,
      payByTime: Math.floor(job.pay_by / 1000),
      agentIdentifier: agent.id,
      identifierFromPurchaser: job.identifier_from_purchaser,
      input_hash: job.input_hash,
    };
  }

  status(jobId: string): StatusResult {
    const j = this.o.store.get(jobId);
    if (!j) throw new MarketError(404, `unknown job: ${jobId}`);
    return {
      job_id: j.job_id,
      status: j.status,
      ...(j.payment_tx ? { payment_tx: j.payment_tx } : {}),
      ...(j.result !== undefined ? { result: j.result, result_hash: j.result_hash } : {}),
      agent_id: j.agent_id,
      amount_tusd: microToTusd(BigInt(j.amount_micro)),
      payment_address: j.payment_address,
      payment_reference: j.payment_reference,
      input_hash: j.input_hash,
      ...(j.error ? { error: j.error } : {}),
    };
  }

  /**
   * One poll: for every awaiting job, look for a matching payment on-chain.
   * Returns the ids of jobs that moved to running.
   */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const unit = this.o.tusdUnit;
      const all = this.o.store.all();
      // A UTxO pays for at most one job, ever.
      const used = new Set(all.map((j) => j.payment_output).filter((x): x is string => !!x));
      const now = this.now();
      const waiting: JobRecord[] = [];
      for (const j of all) {
        if (j.status !== "awaiting_payment") continue;
        if (now > j.pay_by) {
          this.o.store.put({ ...j, status: "failed", error: "payment window expired before a matching payment was seen" });
          continue;
        }
        waiting.push(j);
      }
      if (!unit || waiting.length === 0) return [];

      const byAddress = new Map<string, JobRecord[]>();
      for (const j of waiting) byAddress.set(j.payment_address, [...(byAddress.get(j.payment_address) ?? []), j]);
      const metaCache = new Map<string, unknown | null>();
      const paid: string[] = [];

      for (const [address, jobs] of byAddress) {
        let utxos;
        try {
          utxos = await this.o.reader.fetchUtxos(address);
        } catch (e) {
          this.log(`fetchUtxos(${address}) failed: ${(e as Error).message}`);
          continue;
        }
        for (const job of jobs) {
          const need = BigInt(job.amount_micro);
          for (const u of utxos) {
            const outRef = `${u.txHash}#${u.outputIndex}`;
            if (used.has(outRef)) continue;
            const qty = BigInt(u.amount.find((a) => a.unit === unit)?.quantity ?? "0");
            if (qty < need) continue;
            if (!metaCache.has(u.txHash)) {
              try {
                metaCache.set(u.txHash, await this.o.reader.fetchMetadata674(u.txHash));
              } catch (e) {
                this.log(`metadata(${u.txHash}) failed: ${(e as Error).message}`);
                continue; // retry next tick
              }
            }
            if (!metadataHasReference(metaCache.get(u.txHash), job.payment_reference)) continue;
            used.add(outRef);
            this.o.store.put({ ...job, status: "running", payment_tx: u.txHash, payment_output: outRef, paid_at: this.now() });
            this.log(`job ${job.job_id} paid by ${outRef} (${microToTusd(qty)} tUSD) → running`);
            paid.push(job.job_id);
            this.scheduleWork(job.job_id);
            break;
          }
        }
      }
      return paid;
    } finally {
      this.ticking = false;
    }
  }

  private scheduleWork(jobId: string) {
    const t = setTimeout(() => {
      this.workTimers.delete(t);
      this.runWork(jobId);
    }, this.workDelayMs);
    this.workTimers.add(t);
  }

  /** The agent's actual work. Only reachable for jobs whose payment was matched (status running). */
  runWork(jobId: string) {
    const j = this.o.store.get(jobId);
    if (!j || j.status !== "running") return;
    const agent = findAgent(j.agent_id);
    try {
      if (!agent) throw new Error(`agent ${j.agent_id} no longer exists`);
      const result = agent.work(j.input);
      this.o.store.put({ ...j, status: "completed", result, result_hash: sha256Hex(result), completed_at: this.now() });
      this.log(`job ${jobId} completed`);
    } catch (e) {
      this.o.store.put({ ...j, status: "failed", error: (e as Error).message });
    }
  }
}
