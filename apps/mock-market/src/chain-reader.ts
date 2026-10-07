// The two chain reads the market needs to decide "payment seen on-chain":
//   1. UTxOs at an agent's payment address (tUSD amount),
//   2. the label-674 metadata of the tx that created a UTxO (payment_reference).
// ChainProvider (packages/chain/src/types.ts) has fetchUtxos but no metadata fetch, so the market
// carries a tiny Blockfrost/Koios metadata fetch of its own.
import type { ChainProvider, Utxo } from "@bulkhead/chain";

export interface ChainReader {
  readonly name: string;
  fetchUtxos(address: string): Promise<Utxo[]>;
  /** Label-674 metadata JSON of a tx, or null if none / not yet indexed. */
  fetchMetadata674(txHash: string): Promise<unknown | null>;
}

const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";
const KOIOS_PREPROD = "https://preprod.koios.rest/api/v1";

type FetchFn = typeof fetch;

async function blockfrostGet(path: string, projectId: string, f: FetchFn): Promise<unknown | null> {
  const r = await f(`${BLOCKFROST_PREPROD}${path}`, { headers: { project_id: projectId } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Blockfrost ${path} → HTTP ${r.status}`);
  return r.json();
}

export class BlockfrostMetadata {
  constructor(private projectId: string, private f: FetchFn = fetch) {}
  async fetchMetadata674(txHash: string): Promise<unknown | null> {
    const rows = (await blockfrostGet(`/txs/${txHash}/metadata`, this.projectId, this.f)) as { label: string; json_metadata: unknown }[] | null;
    return rows?.find((r) => String(r.label) === "674")?.json_metadata ?? null;
  }
}

export class KoiosMetadata {
  constructor(private token: string | undefined, private f: FetchFn = fetch) {}
  async fetchMetadata674(txHash: string): Promise<unknown | null> {
    const r = await this.f(`${KOIOS_PREPROD}/tx_metadata`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ _tx_hashes: [txHash] }),
    });
    if (!r.ok) throw new Error(`Koios tx_metadata → HTTP ${r.status}`);
    const rows = (await r.json()) as { tx_hash: string; metadata: Record<string, unknown> | null }[];
    return rows[0]?.metadata?.["674"] ?? null;
  }
}

/** Standalone preprod reader (Blockfrost if a key is set, else public Koios). */
export class HttpChainReader implements ChainReader {
  readonly name: string;
  private meta: { fetchMetadata674(h: string): Promise<unknown | null> };
  constructor(private env: NodeJS.ProcessEnv = process.env, private f: FetchFn = fetch) {
    const bf = env.BLOCKFROST_PREPROD_PROJECT_ID;
    this.name = bf ? "blockfrost-preprod" : "koios-preprod";
    this.meta = bf ? new BlockfrostMetadata(bf, f) : new KoiosMetadata(env.KOIOS_API_TOKEN, f);
  }

  async fetchUtxos(address: string): Promise<Utxo[]> {
    const bf = this.env.BLOCKFROST_PREPROD_PROJECT_ID;
    if (bf) {
      const out: Utxo[] = [];
      for (let page = 1; page <= 20; page++) {
        const rows = (await blockfrostGet(`/addresses/${address}/utxos?count=100&page=${page}`, bf, this.f)) as
          | { tx_hash: string; output_index: number; amount: { unit: string; quantity: string }[] }[]
          | null;
        if (!rows || rows.length === 0) break;
        for (const u of rows) out.push({ txHash: u.tx_hash, outputIndex: u.output_index, address, amount: u.amount });
        if (rows.length < 100) break;
      }
      return out;
    }
    const token = this.env.KOIOS_API_TOKEN;
    const r = await this.f(`${KOIOS_PREPROD}/address_utxos`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ _addresses: [address], _extended: true }),
    });
    if (!r.ok) throw new Error(`Koios address_utxos → HTTP ${r.status}`);
    const rows = (await r.json()) as {
      tx_hash: string;
      tx_index: number;
      value: string;
      asset_list: { policy_id: string; asset_name: string | null; quantity: string }[] | null;
    }[];
    return rows.map((u) => ({
      txHash: u.tx_hash,
      outputIndex: u.tx_index,
      address,
      amount: [
        { unit: "lovelace", quantity: u.value },
        ...(u.asset_list ?? []).map((a) => ({ unit: `${a.policy_id}${a.asset_name ?? ""}`, quantity: a.quantity })),
      ],
    }));
  }

  fetchMetadata674(txHash: string) {
    return this.meta.fetchMetadata674(txHash);
  }
}

/** Use the chain package's ChainProvider for UTxOs, plus a metadata fetcher (ChainProvider has none). */
export function chainReaderFromProvider(
  provider: ChainProvider,
  meta: { fetchMetadata674(txHash: string): Promise<unknown | null> } = new HttpChainReader(),
): ChainReader {
  return {
    name: `${provider.name}+metadata`,
    fetchUtxos: (a) => provider.fetchUtxos(a),
    fetchMetadata674: (h) => meta.fetchMetadata674(h),
  };
}

/**
 * MARKET_TEST_MODE=fake-chain only. An in-memory ledger that tests (or the /__test/payments route)
 * write to. The market's matching logic runs unchanged against it. Never used on preprod.
 */
export class FakeChainReader implements ChainReader {
  readonly name = "fake-chain (TEST MODE — not on-chain)";
  private utxos = new Map<string, Utxo[]>();
  private meta = new Map<string, unknown>();

  addPayment(p: { address: string; txHash: string; amount: { unit: string; quantity: string }[]; metadata674?: unknown }) {
    const list = this.utxos.get(p.address) ?? [];
    list.push({ txHash: p.txHash, outputIndex: list.length, address: p.address, amount: p.amount });
    this.utxos.set(p.address, list);
    if (p.metadata674 !== undefined) this.meta.set(p.txHash, p.metadata674);
  }
  async fetchUtxos(address: string) {
    return [...(this.utxos.get(address) ?? [])];
  }
  async fetchMetadata674(txHash: string) {
    return this.meta.get(txHash) ?? null;
  }
}

/** True if any string inside the 674 metadata (CIP-20 { msg: [...] } or anything else) contains the reference. */
export function metadataHasReference(meta: unknown, reference: string): boolean {
  if (meta == null) return false;
  if (typeof meta === "string") return meta.includes(reference);
  if (Array.isArray(meta)) {
    // CIP-20 splits long strings into ≤64-byte chunks: also check the joined form.
    if (meta.every((m) => typeof m === "string") && meta.join("").includes(reference)) return true;
    return meta.some((m) => metadataHasReference(m, reference));
  }
  if (typeof meta === "object") return Object.values(meta as Record<string, unknown>).some((v) => metadataHasReference(v, reference));
  return false;
}
