// Chain finality (CONFIRMATIONS, default 2). Cardano blocks near the tip can still be rolled back (Ouroboros
// settles probabilistically), so a tx counts as confirmed only once N blocks sit on top of the block holding it:
//   depth = tip height − tx block height + 1   (the block holding the tx counts as 1)
// FinalityProvider wraps a ChainProvider so EVERY caller of fetchTxConfirmation (engine waits, reconcile,
// signer, on-ramp, scripts) gets the same rule: null until depth ≥ N. If the tx vanishes (rollback) the
// provider returns null again — callers keep waiting, i.e. the tx is pending again.
import type { ChainProvider, Tip } from "./types";

export const DEFAULT_CONFIRMATIONS = 2;

/** CONFIRMATIONS env → integer 1..100 (default 2; invalid values fall back to the default). */
export function confirmationsFromEnv(env: { CONFIRMATIONS?: string } = process.env as { CONFIRMATIONS?: string }): number {
  const raw = env.CONFIRMATIONS?.trim();
  if (!raw) return DEFAULT_CONFIRMATIONS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_CONFIRMATIONS;
}

/** Blocks on top of (and including) the tx's block. A tx that is in a block is always ≥ 1 deep, even if the
 * tip we read lags behind the tx lookup (two different backend reads). */
export function confirmationDepth(tipHeight: number, blockHeight: number): number {
  return Math.max(1, tipHeight - blockHeight + 1);
}

export interface TxDepth {
  blockHeight: number;
  slot: number;
  confirmations: number;
}

export class FinalityProvider implements ChainProvider {
  readonly name: ChainProvider["name"];
  readonly network: ChainProvider["network"];
  evaluateTx?: ChainProvider["evaluateTx"];
  fetchTxMetadata?: ChainProvider["fetchTxMetadata"];
  fetchCostModels?: ChainProvider["fetchCostModels"];
  private tip: { at: number; tip: Tip } | null = null;
  private readonly tipTtlMs: number;
  private readonly now: () => number;

  constructor(
    readonly inner: ChainProvider,
    readonly confirmations: number,
    opts: { tipTtlMs?: number; now?: () => number } = {},
  ) {
    this.name = inner.name;
    this.network = inner.network;
    this.tipTtlMs = opts.tipTtlMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    if (inner.evaluateTx) this.evaluateTx = inner.evaluateTx.bind(inner);
    if (inner.fetchTxMetadata) this.fetchTxMetadata = inner.fetchTxMetadata.bind(inner);
    if (inner.fetchCostModels) this.fetchCostModels = inner.fetchCostModels.bind(inner);
  }

  fetchUtxos(address: string) {
    return this.inner.fetchUtxos(address);
  }
  async fetchTip(): Promise<Tip> {
    const tip = await this.inner.fetchTip();
    this.tip = { at: this.now(), tip };
    return tip;
  }
  fetchProtocolParameters() {
    return this.inner.fetchProtocolParameters();
  }
  submitTx(cborHex: string) {
    return this.inner.submitTx(cborHex);
  }

  private async tipHeight(): Promise<number> {
    if (this.tip && this.now() - this.tip.at < this.tipTtlMs) return this.tip.tip.height;
    return (await this.fetchTip()).height;
  }

  /** Raw depth (no threshold): null while the tx is not in a block (never seen, or rolled back). */
  async fetchTxDepth(txHash: string): Promise<TxDepth | null> {
    const c = await this.inner.fetchTxConfirmation(txHash);
    if (!c) return null;
    let height = await this.tipHeight();
    // A cached tip older than the tx's block would under-count; refresh once.
    if (height < c.blockHeight) height = (await this.fetchTip()).height;
    return { blockHeight: c.blockHeight, slot: c.slot, confirmations: confirmationDepth(height, c.blockHeight) };
  }

  /** Confirmed = depth ≥ CONFIRMATIONS; otherwise null (pending). */
  async fetchTxConfirmation(txHash: string): Promise<TxDepth | null> {
    const d = await this.fetchTxDepth(txHash);
    return d && d.confirmations >= this.confirmations ? d : null;
  }
}

/** The raw provider under a FinalityProvider (or the provider itself). */
export const rawProvider = (p: ChainProvider): ChainProvider => (p instanceof FinalityProvider ? p.inner : p);
