// TreasuryQueue (spec §5.1): serialises every tx that spends a given wallet's UTxOs (treasury,
// operator, or a session address). Per-key FIFO mutex + an in-flight ledger:
//  - inputs of submitted-but-unconfirmed txs are excluded from coin selection;
//  - their change outputs back to the same address are offered for chaining (only when the
//    confirmed set is insufficient — callers ask for `withChained`);
//  - an in-flight entry is dropped once the provider shows one of its outputs (confirmed) or
//    the chain tip has passed its TTL slot (the tx can never land).
import type { Utxo } from "./types";

export const refOf = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

interface InFlight {
  txHash: string;
  key: string;
  inputs: Set<string>;
  /** Outputs of this tx paying back to the queue key's address (chainable). */
  outputs: Utxo[];
  ttlSlot: number; // invalidHereafter: once the tip slot is past it, the tx can never land
}

export interface QueueContext {
  /** Filters out inputs reserved by in-flight txs; optionally appends chainable in-flight outputs. */
  available(chainUtxos: Utxo[], opts?: { withChained?: boolean; tipSlot?: number }): Utxo[];
  /** Record a submitted tx (call right after a successful submit, still inside the lock). */
  reserve(txHash: string, inputs: Array<{ txHash: string; outputIndex: number }>, ownOutputs: Utxo[], ttlSlot: number): void;
}

export class TreasuryQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, InFlight>();

  /** Run `fn` exclusively for `key` (FIFO). Different keys run in parallel. */
  run<T>(key: string, fn: (ctx: QueueContext) => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn(this.context(key)));
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  private context(key: string): QueueContext {
    return {
      available: (chainUtxos, opts) => {
        this.prune(key, chainUtxos, opts?.tipSlot);
        const reserved = this.reservedInputs(key);
        const free = chainUtxos.filter((u) => !reserved.has(refOf(u)));
        if (!opts?.withChained) return free;
        const known = new Set(free.map(refOf));
        const chained = this.list(key)
          .flatMap((t) => t.outputs)
          .filter((u) => !reserved.has(refOf(u)) && !known.has(refOf(u)));
        return [...free, ...chained];
      },
      reserve: (txHash, inputs, ownOutputs, ttlSlot) => {
        this.inflight.set(txHash, { txHash, key, inputs: new Set(inputs.map(refOf)), outputs: ownOutputs, ttlSlot });
      },
    };
  }

  private list(key: string): InFlight[] {
    return [...this.inflight.values()].filter((t) => t.key === key);
  }

  private reservedInputs(key: string): Set<string> {
    const s = new Set<string>();
    for (const t of this.list(key)) for (const r of t.inputs) s.add(r);
    return s;
  }

  /** Drop in-flight txs that are visibly confirmed (an output is on chain) or past their TTL. */
  private prune(key: string, chainUtxos: Utxo[], tipSlot?: number): void {
    const onChain = new Set(chainUtxos.map((u) => u.txHash));
    for (const t of this.list(key)) {
      if (onChain.has(t.txHash) || (tipSlot != null && tipSlot > t.ttlSlot)) this.inflight.delete(t.txHash);
    }
  }

  /** External signals (e.g. the watcher saw tx_confirmed, or a submit was rejected). */
  confirm(txHash: string): void {
    this.inflight.delete(txHash);
  }
  release(txHash: string): void {
    this.inflight.delete(txHash);
  }
  pending(key?: string): string[] {
    return [...this.inflight.values()].filter((t) => !key || t.key === key).map((t) => t.txHash);
  }
}
