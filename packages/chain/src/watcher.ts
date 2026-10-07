// ChainWatcher (spec §1/§5.1): Ogmios chain-sync over WebSocket when OGMIOS_URL is set, otherwise
// polling the ChainProvider every `pollMs` (default 10 s). Both feed the same ChainEvent stream.
// Watched items and per-address UTxO cursors are persisted in the `kv` table, so a restart neither
// re-emits old deposits nor misses deposits/spends that happened while the engine was down.
//
// Event semantics:
//  deposit        a new UTxO appeared at a watched address (one event per creating tx, amounts summed).
//  spend          a known UTxO at a watched address disappeared. With Ogmios, txHash = the spending tx;
//                 with polling, txHash = the tx that CREATED the consumed output (polling cannot see the
//                 spender without an extra query) — consumers should treat it as "address was spent".
//  tx_confirmed   a watched tx has `confirmations` (CONFIRMATIONS) blocks on top: depth = tip height - tx block
//                 height + 1 >= N. Carries { slot, confirmations }; the tx is then unwatched.
//  tx_pending     a watched tx is in a block but not yet N deep (emitted when its depth changes).
//  tx_rolled_back a watched tx that was seen in a block vanished before reaching N (rollback). It stays watched:
//                 pending again, confirmed later if it is re-included.
//  expiry_reached the tip slot reached a watched expiry slot; emitted once, then unwatched.
// Finality for deposits: with N > 1 a deposit is emitted only once its creating tx is N deep (polling: the UTxO
// is left out of the cursor until then; Ogmios: held back, dropped on rollback). Spends are emitted
// immediately (an unexpected spend is an alarm; reporting it early is the safe side).
import type { Asset, ChainEvent, ChainProvider, ChainWatcher, Utxo } from "./types";
import type { KvStore } from "./store";
import { refOf } from "./queue";
import { confirmationDepth, rawProvider } from "./finality";

const K_ADDRS = "watcher:addresses";
const K_TXS = "watcher:txs";
const K_EXPIRIES = "watcher:expiries";
const K_UTXOS = (a: string) => `watcher:utxos:${a}`;
const K_OGMIOS_POINT = "watcher:ogmios:point";
const K_PENDING = "watcher:pending";
const K_HELD = "watcher:held-deposits";
const K_TIP_HEIGHT = "watcher:tip-height";

export interface WatcherOptions {
  provider: ChainProvider;
  kv: KvStore;
  pollMs?: number;
  ogmiosUrl?: string;
  /** On the very first sight of an address (no cursor), emit its existing UTxOs as deposits. Default true. */
  emitExistingOnFirstWatch?: boolean;
  /** Blocks on top required before tx_confirmed / deposit (CONFIRMATIONS). Default 1 here; createChain passes
   * confirmationsFromEnv() (default 2). */
  confirmations?: number;
  log?: (msg: string) => void;
}

interface PendingTx {
  blockHeight: number;
  slot: number;
  confirmations: number;
}
/** Ogmios mode: a deposit seen in a block that is not yet N deep. */
interface HeldDeposit {
  address: string;
  txHash: string;
  amount: Asset[];
  refs: string[];
  blockHeight: number;
  slot: number;
}

interface KnownUtxo {
  ref: string;
  txHash: string;
}

export class PollingChainWatcher implements ChainWatcher {
  private readonly provider: ChainProvider;
  private readonly kv: KvStore;
  private readonly pollMs: number;
  private readonly ogmiosUrl?: string;
  private readonly emitExisting: boolean;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<(e: ChainEvent) => void>();
  private readonly addresses: Set<string>;
  private readonly txs: Set<string>;
  private readonly expiries: Map<string, number>;
  private readonly pending: Map<string, PendingTx>;
  private held: HeldDeposit[];
  private tipHeight: number;
  /** Polling: depth of fresh deposit txs, read in immatureTxs and attached to the deposit event. */
  private readonly depthOf = new Map<string, number>();
  readonly confirmations: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking: Promise<void> | null = null;
  private ogmios: OgmiosSync | null = null;

  constructor(opts: WatcherOptions) {
    // Depth is computed here from raw block heights, so never go through a FinalityProvider's threshold.
    this.provider = rawProvider(opts.provider);
    this.confirmations = Math.max(1, Math.floor(opts.confirmations ?? 1));
    this.kv = opts.kv;
    this.pollMs = opts.pollMs ?? 10_000;
    this.ogmiosUrl = opts.ogmiosUrl?.trim() || undefined;
    this.emitExisting = opts.emitExistingOnFirstWatch ?? true;
    this.log = opts.log ?? ((m) => console.log(`[watcher] ${m}`));
    this.addresses = new Set(this.readJson<string[]>(K_ADDRS, []));
    this.txs = new Set(this.readJson<string[]>(K_TXS, []));
    this.expiries = new Map(Object.entries(this.readJson<Record<string, number>>(K_EXPIRIES, {})));
    this.pending = new Map(Object.entries(this.readJson<Record<string, PendingTx>>(K_PENDING, {})));
    this.held = this.readJson<HeldDeposit[]>(K_HELD, []);
    this.tipHeight = Number(this.kv.get(K_TIP_HEIGHT) ?? 0) || 0;
  }

  private readJson<T>(key: string, dflt: T): T {
    const v = this.kv.get(key);
    if (!v) return dflt;
    try {
      return JSON.parse(v) as T;
    } catch {
      return dflt;
    }
  }
  private persist(): void {
    this.kv.set(K_ADDRS, JSON.stringify([...this.addresses]));
    this.kv.set(K_TXS, JSON.stringify([...this.txs]));
    this.kv.set(K_EXPIRIES, JSON.stringify(Object.fromEntries(this.expiries)));
    this.kv.set(K_PENDING, JSON.stringify(Object.fromEntries(this.pending)));
    this.kv.set(K_HELD, JSON.stringify(this.held));
  }

  on(listener: (e: ChainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(e: ChainEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.log(`listener error: ${(err as Error).message}`);
      }
    }
  }

  watchAddress(address: string): void {
    this.addresses.add(address);
    this.persist();
    // In Ogmios mode no poll will seed the cursor, so seed it once from the provider.
    if (this.running && this.ogmios?.connected && this.knownUtxos(address) === null) {
      this.provider
        .fetchUtxos(address)
        .then((u) => this.knownUtxos(address) === null && this.diffAddress(address, u))
        .catch((e) => this.log(`seed ${address.slice(0, 20)}… failed: ${(e as Error).message}`));
    }
  }
  unwatchAddress(address: string): void {
    this.addresses.delete(address);
    this.kv.delete(K_UTXOS(address));
    this.persist();
  }
  watchTx(txHash: string): void {
    this.txs.add(txHash);
    this.persist();
  }
  watchExpiry(sessionId: string, expirySlot: number): void {
    this.expiries.set(sessionId, expirySlot);
    this.persist();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.ogmiosUrl) {
      this.ogmios = new OgmiosSync(this.ogmiosUrl, this, this.kv, this.log);
      this.ogmios.start();
    }
    const loop = async () => {
      if (!this.running) return;
      // With a live Ogmios connection, blocks drive events; polling is only the fallback.
      if (!this.ogmios?.connected) await this.tick().catch((e) => this.log(`poll failed: ${(e as Error).message}`));
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ogmios?.stop();
    this.ogmios = null;
    await this.ticking?.catch(() => undefined);
  }

  /** One polling pass (public for tests and for an on-demand refresh). Never runs concurrently. */
  tick(): Promise<void> {
    if (!this.ticking) this.ticking = this.doTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const tip = await this.provider.fetchTip();
    this.checkExpiries(tip.slot);
    for (const txHash of [...this.txs]) {
      const c = await this.provider.fetchTxConfirmation(txHash);
      this.observeTx(txHash, c ? { blockHeight: c.blockHeight, slot: c.slot, confirmations: confirmationDepth(tip.height, c.blockHeight) } : null);
    }
    for (const address of [...this.addresses]) {
      const utxos = await this.provider.fetchUtxos(address);
      this.diffAddress(address, utxos, await this.immatureTxs(address, utxos, tip.height));
    }
  }

  /** Polling, N > 1: creating txs of NEW UTxOs that are not yet N deep (their UTxOs stay out of the cursor). */
  private async immatureTxs(address: string, utxos: Utxo[], tipHeight: number): Promise<Set<string>> {
    const out = new Set<string>();
    if (this.confirmations <= 1) return out;
    const prev = this.knownUtxos(address);
    if (prev === null && !this.emitExisting) return out; // first sight without emission: just seed the cursor
    const known = new Set((prev ?? []).map((k) => k.ref));
    const fresh = new Set(utxos.filter((u) => !known.has(refOf(u))).map((u) => u.txHash));
    for (const txHash of fresh) {
      const c = await this.provider.fetchTxConfirmation(txHash).catch(() => null);
      const depth = c ? confirmationDepth(tipHeight, c.blockHeight) : 0;
      if (depth < this.confirmations) out.add(txHash);
      else this.depthOf.set(txHash, depth);
    }
    return out;
  }

  /** Polling path: apply one depth reading (null = not in any block) for a watched tx. */
  observeTx(txHash: string, c: PendingTx | null): void {
    if (!this.txs.has(txHash)) return;
    const prev = this.pending.get(txHash);
    if (!c) {
      if (prev) {
        this.pending.delete(txHash);
        this.persist();
        this.emit({ type: "tx_rolled_back", txHash, blockHeight: prev.blockHeight });
      }
      return;
    }
    if (c.confirmations >= this.confirmations) return this.confirmTx(txHash, c.slot, c.confirmations);
    // Rolled back and re-included in another block between two polls.
    if (prev && prev.blockHeight !== c.blockHeight) this.emit({ type: "tx_rolled_back", txHash, blockHeight: prev.blockHeight });
    if (!prev || prev.confirmations !== c.confirmations || prev.blockHeight !== c.blockHeight) {
      this.pending.set(txHash, c);
      this.persist();
      this.emit({ type: "tx_pending", txHash, slot: c.slot, blockHeight: c.blockHeight, confirmations: c.confirmations, required: this.confirmations });
    }
  }

  /** Watched txs seen in a block but not yet final (for UIs / tests). */
  pendingTxs(): Array<{ txHash: string } & PendingTx> {
    return [...this.pending].map(([txHash, p]) => ({ txHash, ...p }));
  }

  // ── shared by polling and Ogmios ───────────────────────────────────────────────────────
  checkExpiries(slot: number): void {
    let changed = false;
    for (const [sessionId, expirySlot] of [...this.expiries]) {
      if (slot >= expirySlot) {
        this.expiries.delete(sessionId);
        changed = true;
        this.emit({ type: "expiry_reached", sessionId, slot });
      }
    }
    if (changed) this.persist();
  }

  isWatchedTx(txHash: string): boolean {
    return this.txs.has(txHash);
  }
  isWatchedAddress(address: string): boolean {
    return this.addresses.has(address);
  }
  watchedAddresses(): string[] {
    return [...this.addresses];
  }

  confirmTx(txHash: string, slot: number, confirmations = this.confirmations): void {
    if (!this.txs.delete(txHash)) return;
    this.pending.delete(txHash);
    this.persist();
    this.emit({ type: "tx_confirmed", txHash, slot, confirmations });
  }

  knownUtxos(address: string): KnownUtxo[] | null {
    return this.readJson<KnownUtxo[] | null>(K_UTXOS(address), null);
  }
  setKnownUtxos(address: string, known: KnownUtxo[]): void {
    this.kv.set(K_UTXOS(address), JSON.stringify(known));
  }

  /** Compare a fresh UTxO set with the stored cursor; emit deposit/spend events. UTxOs created by `immature`
   * txs (not yet N deep) are neither emitted nor added to the cursor, so a later tick sees them as new. */
  diffAddress(address: string, utxos: Utxo[], immature: Set<string> = new Set()): void {
    const prev = this.knownUtxos(address);
    utxos = utxos.filter((u) => !immature.has(u.txHash));
    const now: KnownUtxo[] = utxos.map((u) => ({ ref: refOf(u), txHash: u.txHash }));
    const firstSight = prev === null;
    const prevRefs = new Set((prev ?? []).map((k) => k.ref));
    const nowRefs = new Set(now.map((k) => k.ref));
    this.setKnownUtxos(address, now);
    if (!firstSight || this.emitExisting) {
      const byTx = new Map<string, Asset[]>();
      for (const u of utxos) {
        if (prevRefs.has(refOf(u))) continue;
        byTx.set(u.txHash, addAssets(byTx.get(u.txHash) ?? [], u.amount));
      }
      for (const [txHash, amount] of byTx) {
        const depth = this.depthOf.get(txHash);
        this.depthOf.delete(txHash);
        this.emit({ type: "deposit", address, txHash, amount, ...(this.confirmations > 1 && depth ? { confirmations: depth } : {}) });
      }
    }
    const spentTx = new Set<string>();
    for (const k of prev ?? []) if (!nowRefs.has(k.ref)) spentTx.add(k.txHash);
    for (const txHash of spentTx) this.emit({ type: "spend", address, txHash });
  }

  /** Ogmios path: apply one block's transactions. */
  applyBlock(block: OgmiosBlock): void {
    const height = block.height ?? this.tipHeight + 1;
    this.tipHeight = height;
    this.kv.set(K_TIP_HEIGHT, String(height));
    const watched = this.addresses;
    for (const tx of block.transactions ?? []) {
      // spends of known outputs at watched addresses
      for (const address of watched) {
        const known = this.knownUtxos(address);
        if (!known) continue;
        const spent = new Set((tx.inputs ?? []).map((i) => `${i.transaction.id}#${i.index}`));
        const remaining = known.filter((k) => !spent.has(k.ref));
        if (remaining.length !== known.length) {
          this.setKnownUtxos(address, remaining);
          this.emit({ type: "spend", address, txHash: tx.id });
        }
      }
      // deposits to watched addresses
      const deposits = new Map<string, { amount: Asset[]; known: KnownUtxo[] }>();
      (tx.outputs ?? []).forEach((o, idx) => {
        if (!watched.has(o.address)) return;
        const d = deposits.get(o.address) ?? { amount: [], known: [] };
        d.amount = addAssets(d.amount, ogmiosValueToAssets(o.value));
        d.known.push({ ref: `${tx.id}#${idx}`, txHash: tx.id });
        deposits.set(o.address, d);
      });
      for (const [address, d] of deposits) {
        const known = this.knownUtxos(address) ?? [];
        const refs = new Set(known.map((k) => k.ref));
        const fresh = d.known.filter((k) => !refs.has(k.ref));
        if (fresh.length === 0) continue;
        this.setKnownUtxos(address, [...known, ...fresh]);
        if (this.confirmations <= 1) this.emit({ type: "deposit", address, txHash: tx.id, amount: d.amount });
        else this.held.push({ address, txHash: tx.id, amount: d.amount, refs: fresh.map((k) => k.ref), blockHeight: height, slot: block.slot });
      }
      if (this.txs.has(tx.id)) {
        if (this.confirmations <= 1) this.confirmTx(tx.id, block.slot, 1);
        else this.pending.set(tx.id, { blockHeight: height, slot: block.slot, confirmations: 0 });
      }
    }
    this.promote();
    this.checkExpiries(block.slot);
  }

  /** Ogmios path: emit pending txs / held deposits that reached N at the current tip height. */
  private promote(): void {
    for (const [txHash, p] of [...this.pending]) {
      const depth = confirmationDepth(this.tipHeight, p.blockHeight);
      if (depth >= this.confirmations) this.confirmTx(txHash, p.slot, depth);
      else if (depth !== p.confirmations) {
        this.pending.set(txHash, { ...p, confirmations: depth });
        this.emit({ type: "tx_pending", txHash, slot: p.slot, blockHeight: p.blockHeight, confirmations: depth, required: this.confirmations });
      }
    }
    const keep: HeldDeposit[] = [];
    for (const h of this.held) {
      const depth = confirmationDepth(this.tipHeight, h.blockHeight);
      if (depth >= this.confirmations) this.emit({ type: "deposit", address: h.address, txHash: h.txHash, amount: h.amount, confirmations: depth });
      else keep.push(h);
    }
    this.held = keep;
    this.persist();
  }

  /** Ogmios path: the node rolled back to `point`. Watched txs and held deposits in later blocks become
   * pending again (txs stay watched; held deposits are dropped and their UTxOs removed from the cursor, so a
   * re-inclusion is seen as new). Emitted (final) events are not revisited: N is the finality assumption. */
  rollBackward(point: { slot: number; id?: string } | "origin"): void {
    const slot = point === "origin" ? -1 : point.slot;
    for (const [txHash, p] of [...this.pending]) {
      if (p.slot > slot) {
        this.pending.delete(txHash);
        this.emit({ type: "tx_rolled_back", txHash, blockHeight: p.blockHeight });
      }
    }
    const dropped = this.held.filter((h) => h.slot > slot);
    this.held = this.held.filter((h) => h.slot <= slot);
    for (const h of dropped) {
      const known = this.knownUtxos(h.address);
      if (known) this.setKnownUtxos(h.address, known.filter((k) => !h.refs.includes(k.ref)));
    }
    // The next forward block carries its own height (Ogmios v6), which resets tipHeight.
    this.persist();
  }
}

function addAssets(a: Asset[], b: Asset[]): Asset[] {
  const m = new Map<string, bigint>();
  for (const x of [...a, ...b]) m.set(x.unit, (m.get(x.unit) ?? 0n) + BigInt(x.quantity));
  return [...m].map(([unit, q]) => ({ unit, quantity: q.toString() }));
}

// ── Ogmios v6 chain-sync (JSON-RPC over WebSocket) ───────────────────────────────────────
export interface OgmiosBlock {
  id: string;
  slot: number;
  height?: number;
  transactions?: Array<{
    id: string;
    inputs?: Array<{ transaction: { id: string }; index: number }>;
    outputs?: Array<{ address: string; value: Record<string, Record<string, number | bigint>> }>;
  }>;
}

export function ogmiosValueToAssets(value: Record<string, Record<string, number | bigint>>): Asset[] {
  const out: Asset[] = [];
  for (const [policy, assets] of Object.entries(value ?? {})) {
    for (const [name, q] of Object.entries(assets)) {
      if (policy === "ada" && name === "lovelace") out.push({ unit: "lovelace", quantity: String(q) });
      else if (policy !== "ada") out.push({ unit: policy + name, quantity: String(q) });
    }
  }
  return out;
}

class OgmiosSync {
  connected = false;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly watcher: PollingChainWatcher,
    private readonly kv: KvStore,
    private readonly log: (m: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private send(method: string, params?: unknown): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}), id: this.nextId++ }));
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.log(`ogmios connect failed: ${(e as Error).message}; polling fallback`);
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      const saved = this.kv.get(K_OGMIOS_POINT);
      if (saved) this.send("findIntersection", { points: [JSON.parse(saved)] });
      else this.send("queryNetwork/tip");
    };
    ws.onmessage = (ev) => {
      let msg: { method?: string; result?: any; error?: { message: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.error) {
        this.log(`ogmios error (${msg.method}): ${msg.error.message}`);
        if (msg.method === "findIntersection") {
          this.kv.delete(K_OGMIOS_POINT);
          this.send("queryNetwork/tip");
        }
        return;
      }
      switch (msg.method) {
        case "queryNetwork/tip":
          this.send("findIntersection", { points: [msg.result.slot != null ? { slot: msg.result.slot, id: msg.result.id } : "origin"] });
          break;
        case "findIntersection":
          this.connected = true;
          this.log(`ogmios chain-sync connected at slot ${msg.result?.intersection?.slot ?? "origin"}`);
          // pipeline a few requests
          for (let i = 0; i < 10; i++) this.send("nextBlock");
          break;
        case "nextBlock": {
          const r = msg.result;
          if (r?.direction === "forward" && r.block) {
            const block = r.block as OgmiosBlock;
            if (block.slot != null) {
              this.watcher.applyBlock(block);
              this.kv.set(K_OGMIOS_POINT, JSON.stringify({ slot: block.slot, id: block.id }));
            }
          } else if (r?.direction === "backward" && r.point) {
            this.watcher.rollBackward(r.point);
            if (r.point !== "origin") this.kv.set(K_OGMIOS_POINT, JSON.stringify(r.point));
          }
          this.send("nextBlock");
          break;
        }
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      this.connected = false;
      if (!this.stopped) {
        this.log("ogmios disconnected; polling fallback until reconnect");
        this.retry();
      }
    };
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(60_000, this.backoff * 2);
    setTimeout(() => this.connect(), delay);
  }
}
