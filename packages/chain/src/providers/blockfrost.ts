// Blockfrost REST (and Blockfrost-compatible REST, e.g. NOWNodes) → ChainProvider.
import type { Asset, ChainProvider, Tip, Utxo } from "../types";
import { castProtocol } from "../mesh";
import { fetchWithRetry, hexToBytes, HttpError, type RetryOptions } from "./http";

export interface BlockfrostCompatOptions {
  name: ChainProvider["name"];
  network: ChainProvider["network"];
  baseUrl: string; // ".../api/v0" (no trailing slash)
  headers: Record<string, string>;
  retry?: RetryOptions;
}

interface BfAmount {
  unit: string;
  quantity: string;
}

export class BlockfrostCompatProvider implements ChainProvider {
  readonly name: ChainProvider["name"];
  readonly network: ChainProvider["network"];
  protected readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly retry: RetryOptions;

  constructor(opts: BlockfrostCompatOptions) {
    this.name = opts.name;
    this.network = opts.network;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = opts.headers;
    this.retry = opts.retry ?? {};
  }

  protected async get<T>(path: string): Promise<T | null> {
    const res = await fetchWithRetry(`${this.baseUrl}${path}`, { headers: this.headers }, this.retry);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  async fetchUtxos(address: string): Promise<Utxo[]> {
    const out: Utxo[] = [];
    for (let page = 1; page < 1000; page++) {
      const rows = await this.get<Array<{ tx_hash: string; output_index: number; amount: BfAmount[]; address?: string }>>(
        `/addresses/${address}/utxos?count=100&page=${page}`,
      );
      if (!rows || rows.length === 0) break;
      for (const r of rows) {
        out.push({
          txHash: r.tx_hash,
          outputIndex: r.output_index,
          address: r.address ?? address,
          amount: r.amount.map((a): Asset => ({ unit: a.unit, quantity: String(a.quantity) })),
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  async fetchTip(): Promise<Tip> {
    const b = await this.get<{ slot: number; time: number; height: number }>(`/blocks/latest`);
    if (!b) throw new Error(`${this.name}: no latest block`);
    return { slot: b.slot, time: b.time * 1000, height: b.height };
  }

  async fetchProtocolParameters(): Promise<unknown> {
    const d = await this.get<Record<string, unknown>>(`/epochs/latest/parameters`);
    if (!d) throw new Error(`${this.name}: no protocol parameters`);
    return castProtocol({
      coinsPerUtxoSize: Number(d.coins_per_utxo_size ?? d.coins_per_utxo_word),
      collateralPercent: d.collateral_percent,
      decentralisation: d.decentralisation_param,
      epoch: d.epoch,
      keyDeposit: d.key_deposit,
      maxBlockExMem: d.max_block_ex_mem,
      maxBlockExSteps: d.max_block_ex_steps,
      maxBlockHeaderSize: d.max_block_header_size,
      maxBlockSize: d.max_block_size,
      maxCollateralInputs: d.max_collateral_inputs,
      maxTxExMem: d.max_tx_ex_mem,
      maxTxExSteps: d.max_tx_ex_steps,
      maxTxSize: d.max_tx_size,
      maxValSize: d.max_val_size,
      minFeeA: d.min_fee_a,
      minFeeB: d.min_fee_b,
      minPoolCost: d.min_pool_cost,
      poolDeposit: d.pool_deposit,
      priceMem: d.price_mem,
      priceStep: d.price_step,
      ...(d.min_fee_ref_script_cost_per_byte != null ? { minFeeRefScriptCostPerByte: Number(d.min_fee_ref_script_cost_per_byte) } : {}),
    });
  }

  /** Live Plutus cost models [V1, V2, V3] from /epochs/latest/parameters (cost_models_raw). */
  async fetchCostModels(): Promise<number[][]> {
    const d = await this.get<{ cost_models_raw?: Record<string, number[]> }>(`/epochs/latest/parameters`);
    const raw = d?.cost_models_raw;
    if (!raw?.PlutusV1 || !raw.PlutusV2 || !raw.PlutusV3) throw new Error(`${this.name}: no cost_models_raw in protocol parameters`);
    return [raw.PlutusV1, raw.PlutusV2, raw.PlutusV3];
  }

  async submitTx(cborHex: string): Promise<string> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/tx/submit`,
      { method: "POST", headers: { ...this.headers, "Content-Type": "application/cbor" }, body: hexToBytes(cborHex) },
      this.retry,
    );
    if (res.status === 404) throw new HttpError(404, await res.text(), `${this.baseUrl}/tx/submit`);
    const txt = (await res.text()).trim();
    return txt.replace(/^"|"$/g, "");
  }

  async fetchTxConfirmation(txHash: string): Promise<{ blockHeight: number; slot: number } | null> {
    const t = await this.get<{ block_height: number; slot: number }>(`/txs/${txHash}`);
    return t ? { blockHeight: t.block_height, slot: t.slot } : null;
  }

  async evaluateTx(cborHex: string): Promise<unknown[]> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/utils/txs/evaluate`,
      { method: "POST", headers: { ...this.headers, "Content-Type": "application/cbor" }, body: cborHex },
      this.retry,
    );
    const j = (await res.json()) as { result?: { EvaluationResult?: Record<string, unknown>; EvaluationFailure?: unknown } };
    if (j?.result?.EvaluationFailure) {
      // The Ogmios-v5 shape often drops the script error details; ask for the v6 shape for a readable reason.
      let detail = "";
      try {
        const r6 = await fetchWithRetry(
          `${this.baseUrl}/utils/txs/evaluate?version=6`,
          { method: "POST", headers: { ...this.headers, "Content-Type": "application/cbor" }, body: cborHex },
          this.retry,
        );
        const j6 = (await r6.json()) as { error?: unknown };
        if (j6?.error) detail = ` · ogmios v6: ${JSON.stringify(j6.error).slice(0, 1500)}`;
      } catch (e) {
        detail = ` · ogmios v6: ${(e as Error).message.slice(0, 1500)}`;
      }
      throw new Error(`evaluateTx failed: ${JSON.stringify(j.result.EvaluationFailure)}${detail}`);
    }
    return Object.entries(j?.result?.EvaluationResult ?? {}).map(([k, v]) => ({ redeemer: k, budget: v }));
  }

  async fetchTxMetadata(txHash: string): Promise<Record<string, unknown> | null> {
    const rows = await this.get<Array<{ label: string; json_metadata: unknown }>>(`/txs/${txHash}/metadata`);
    if (!rows) return null;
    return Object.fromEntries(rows.map((r) => [String(r.label), r.json_metadata]));
  }
}

/** Blockfrost hosted preprod (project_id header). Refuses mainnet project ids. */
export class BlockfrostProvider extends BlockfrostCompatProvider {
  constructor(projectId: string, opts: { baseUrl?: string; retry?: RetryOptions } = {}) {
    if (!projectId) throw new Error("BlockfrostProvider: BLOCKFROST_PREPROD_PROJECT_ID is empty");
    if (/^mainnet/i.test(projectId)) throw new Error("BlockfrostProvider: refusing a MAINNET project id (preprod only)");
    if (!/^preprod/i.test(projectId)) console.warn("[chain] Blockfrost project id does not start with 'preprod' — check it is a PREPROD key");
    super({
      name: "blockfrost",
      network: "preprod",
      baseUrl: opts.baseUrl ?? "https://cardano-preprod.blockfrost.io/api/v0",
      headers: { project_id: projectId },
      retry: opts.retry,
    });
  }
}

/**
 * NOWNodes Cardano — Blockfrost-compatible REST with the `api-key` header.
 * Verified 2026-10-06: NOWNodes lists Cardano as MAINNET ONLY (nownodes.io/nodes/cardano-ada:
 * "testnet": [], networks { testnet: false, mainnet: true }; endpoints ada.nownodes.io,
 * ada-blockfrost.nownodes.io, ada-ogmios.nownodes.io/wss). So this provider is only ever
 * constructed for mainnet dashboard READS (Chain.mainnetProvider). TxService refuses it.
 */
export class NOWNodesProvider extends BlockfrostCompatProvider {
  constructor(apiKey: string, opts: { baseUrl?: string; retry?: RetryOptions } = {}) {
    if (!apiKey) throw new Error("NOWNodesProvider: NOWNODES_API_KEY is empty");
    super({
      name: "nownodes",
      network: "mainnet",
      baseUrl: opts.baseUrl ?? "https://ada-blockfrost.nownodes.io/api/v0",
      headers: { "api-key": apiKey },
      retry: opts.retry,
    });
  }

  override async submitTx(): Promise<string> {
    throw new Error("NOWNodesProvider is mainnet read-only in Bulkhead; transactions are preprod only");
  }
}
