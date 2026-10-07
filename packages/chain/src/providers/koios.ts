// Koios preprod REST → ChainProvider. Keyless public tier works (rate-limited per IP);
// KOIOS_API_TOKEN (optional) is sent as a Bearer token for the higher tier.
import type { Asset, ChainProvider, Tip, Utxo } from "../types";
import { castProtocol } from "../mesh";
import { fetchWithRetry, hexToBytes, type RetryOptions } from "./http";

export class KoiosProvider implements ChainProvider {
  readonly name = "koios" as const;
  readonly network = "preprod" as const;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly retry: RetryOptions;

  constructor(opts: { token?: string; baseUrl?: string; retry?: RetryOptions } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://preprod.koios.rest/api/v1").replace(/\/+$/, "");
    if (/\/\/api\.koios\.rest/.test(this.baseUrl)) throw new Error("KoiosProvider: refusing the MAINNET endpoint (preprod only)");
    this.headers = { Accept: "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
    this.retry = opts.retry ?? {};
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetchWithRetry(`${this.baseUrl}${path}`, { headers: this.headers }, this.retry);
    if (res.status === 404) throw new Error(`koios: 404 ${path}`);
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      this.retry,
    );
    if (res.status === 404) throw new Error(`koios: 404 ${path}`);
    return (await res.json()) as T;
  }

  async fetchUtxos(address: string): Promise<Utxo[]> {
    const rows = await this.postJson<
      Array<{
        tx_hash: string;
        tx_index: number;
        address: string;
        value: string;
        is_spent?: boolean;
        asset_list?: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null;
      }>
    >(`/address_utxos`, { _addresses: [address], _extended: true });
    return rows
      .filter((r) => !r.is_spent)
      .map((r) => ({
        txHash: r.tx_hash,
        outputIndex: r.tx_index,
        address: r.address,
        amount: [
          { unit: "lovelace", quantity: String(r.value) },
          ...(r.asset_list ?? []).map((a): Asset => ({ unit: a.policy_id + (a.asset_name ?? ""), quantity: String(a.quantity) })),
        ],
      }));
  }

  async fetchTip(): Promise<Tip> {
    const [t] = await this.getJson<Array<{ abs_slot: number; block_time: number; block_height?: number; block_no?: number }>>(`/tip`);
    if (!t) throw new Error("koios: empty tip");
    return { slot: t.abs_slot, time: t.block_time * 1000, height: t.block_height ?? t.block_no ?? 0 };
  }

  async fetchProtocolParameters(): Promise<unknown> {
    const [tip] = await this.getJson<Array<{ epoch_no: number }>>(`/tip`);
    const [d] = await this.getJson<Array<Record<string, unknown>>>(`/epoch_params?_epoch_no=${tip!.epoch_no}`);
    if (!d) throw new Error("koios: no epoch params");
    return castProtocol({
      coinsPerUtxoSize: Number(d.coins_per_utxo_size),
      collateralPercent: d.collateral_percent,
      decentralisation: d.decentralisation,
      epoch: d.epoch_no,
      keyDeposit: d.key_deposit,
      maxBlockExMem: String(d.max_block_ex_mem),
      maxBlockExSteps: String(d.max_block_ex_steps),
      maxBlockHeaderSize: d.max_bh_size,
      maxBlockSize: d.max_block_size,
      maxCollateralInputs: d.max_collateral_inputs,
      maxTxExMem: String(d.max_tx_ex_mem),
      maxTxExSteps: String(d.max_tx_ex_steps),
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

  async submitTx(cborHex: string): Promise<string> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/submittx`,
      { method: "POST", headers: { ...this.headers, "Content-Type": "application/cbor" }, body: hexToBytes(cborHex) },
      this.retry,
    );
    if (res.status === 404) throw new Error("koios: submittx 404");
    return (await res.text()).trim().replace(/^"|"$/g, "");
  }

  async fetchTxConfirmation(txHash: string): Promise<{ blockHeight: number; slot: number } | null> {
    const rows = await this.postJson<Array<{ tx_hash: string; block_height: number | null; absolute_slot: number | null }>>(`/tx_info`, {
      _tx_hashes: [txHash],
      _inputs: false,
      _metadata: false,
      _assets: false,
      _withdrawals: false,
      _certs: false,
      _scripts: false,
      _bytecode: false,
    });
    const r = rows.find((x) => x.tx_hash === txHash);
    if (!r || r.block_height == null || r.absolute_slot == null) return null;
    return { blockHeight: r.block_height, slot: r.absolute_slot };
  }

  async fetchTxMetadata(txHash: string): Promise<Record<string, unknown> | null> {
    const rows = await this.postJson<Array<{ tx_hash: string; metadata: Record<string, unknown> | null }>>(`/tx_metadata`, {
      _tx_hashes: [txHash],
    });
    const r = rows.find((x) => x.tx_hash === txHash);
    return r ? (r.metadata ?? {}) : null;
  }
}
