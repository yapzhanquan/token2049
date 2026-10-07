// Chain finality: CONFIRMATIONS depth (tip height − block height + 1 ≥ N) and rollback safety, with a fake
// provider whose chain we move by hand. Nothing touches the network.
import { describe, expect, it } from "vitest";
import { PollingChainWatcher } from "../src/watcher";
import { FinalityProvider, confirmationDepth, confirmationsFromEnv, rawProvider } from "../src/finality";
import { memoryStores } from "../src/store";
import type { ChainEvent, Tip } from "../src/types";
import { FakeProvider, TIP_SLOT } from "./helpers";
import { timeFromSlot } from "../src/index";

/** A FakeProvider with block heights: txs live in blocks; `height` is the tip; `rollback` removes a tx. */
class ChainSim extends FakeProvider {
  height = 100;
  blocks = new Map<string, { blockHeight: number; slot: number }>();
  tipCalls = 0;
  include(txHash: string, at = this.height) {
    this.blocks.set(txHash, { blockHeight: at, slot: TIP_SLOT + at });
  }
  rollback(txHash: string) {
    this.blocks.delete(txHash);
  }
  override async fetchTip(): Promise<Tip> {
    this.tipCalls++;
    return { slot: TIP_SLOT + this.height, time: timeFromSlot(TIP_SLOT + this.height), height: this.height };
  }
  override async fetchTxConfirmation(txHash: string) {
    return this.blocks.get(txHash) ?? null;
  }
}

function setup(confirmations: number, sim = new ChainSim()) {
  const w = new PollingChainWatcher({ provider: sim, kv: memoryStores().kv, pollMs: 50, log: () => {}, confirmations });
  const events: ChainEvent[] = [];
  w.on((e) => events.push(e));
  return { w, events, sim };
}

describe("finality helpers", () => {
  it("depth = tip − block + 1 (min 1); CONFIRMATIONS env defaults to 2", () => {
    expect(confirmationDepth(100, 100)).toBe(1);
    expect(confirmationDepth(101, 100)).toBe(2);
    expect(confirmationDepth(99, 100)).toBe(1); // tip read lagging behind the tx lookup
    expect(confirmationsFromEnv({})).toBe(2);
    expect(confirmationsFromEnv({ CONFIRMATIONS: "" })).toBe(2);
    expect(confirmationsFromEnv({ CONFIRMATIONS: "5" })).toBe(5);
    expect(confirmationsFromEnv({ CONFIRMATIONS: "0" })).toBe(2);
    expect(confirmationsFromEnv({ CONFIRMATIONS: "abc" })).toBe(2);
    expect(confirmationsFromEnv({ CONFIRMATIONS: "1" })).toBe(1);
  });

  it("FinalityProvider: null until N deep, null again after a rollback, carries confirmations", async () => {
    const sim = new ChainSim();
    let t = 0;
    const p = new FinalityProvider(sim, 3, { tipTtlMs: 0, now: () => t++ });
    expect(rawProvider(p)).toBe(sim);
    expect(p.name).toBe("blockfrost");
    expect(await p.fetchTxConfirmation("a")).toBeNull(); // not on chain
    sim.include("a");
    expect(await p.fetchTxConfirmation("a")).toBeNull(); // depth 1
    expect((await p.fetchTxDepth("a"))?.confirmations).toBe(1);
    sim.height += 1;
    expect(await p.fetchTxConfirmation("a")).toBeNull(); // depth 2
    sim.rollback("a");
    sim.height += 5;
    expect(await p.fetchTxConfirmation("a")).toBeNull(); // vanished → pending again
    sim.include("a"); // re-included at the new tip
    expect(await p.fetchTxConfirmation("a")).toBeNull();
    sim.height += 2;
    expect(await p.fetchTxConfirmation("a")).toEqual({ blockHeight: 106, slot: TIP_SLOT + 106, confirmations: 3 });
  });

  it("FinalityProvider caches the tip briefly but refreshes when the cached tip is older than the tx block", async () => {
    const sim = new ChainSim();
    const p = new FinalityProvider(sim, 2, { tipTtlMs: 60_000, now: () => 0 });
    await p.fetchTip();
    sim.height = 110;
    sim.include("b", 109);
    expect((await p.fetchTxDepth("b"))?.confirmations).toBe(2); // cached height 100 < 109 → refreshed
  });
});

describe("PollingChainWatcher with CONFIRMATIONS", () => {
  it("emits tx_pending per depth, tx_confirmed only at depth ≥ N with confirmations", async () => {
    const { w, events, sim } = setup(3);
    w.watchTx("tx1");
    await w.tick();
    expect(events).toEqual([]); // not in a block
    sim.include("tx1");
    await w.tick();
    sim.height += 1;
    await w.tick();
    await w.tick(); // unchanged depth → no duplicate event
    expect(events).toEqual([
      { type: "tx_pending", txHash: "tx1", slot: TIP_SLOT + 100, blockHeight: 100, confirmations: 1, required: 3 },
      { type: "tx_pending", txHash: "tx1", slot: TIP_SLOT + 100, blockHeight: 100, confirmations: 2, required: 3 },
    ]);
    expect(w.pendingTxs()).toEqual([{ txHash: "tx1", blockHeight: 100, slot: TIP_SLOT + 100, confirmations: 2 }]);
    sim.height += 1;
    await w.tick();
    expect(events.at(-1)).toEqual({ type: "tx_confirmed", txHash: "tx1", slot: TIP_SLOT + 100, confirmations: 3 });
    expect(w.pendingTxs()).toEqual([]);
    events.length = 0;
    sim.height += 10;
    await w.tick();
    expect(events).toEqual([]); // unwatched after confirmation
  });

  it("rollback before N: tx_rolled_back, stays watched (pending), confirms after re-inclusion", async () => {
    const { w, events, sim } = setup(2);
    w.watchTx("tx2");
    sim.include("tx2");
    await w.tick();
    sim.rollback("tx2");
    await w.tick();
    expect(events.map((e) => e.type)).toEqual(["tx_pending", "tx_rolled_back"]);
    expect(events[1]).toEqual({ type: "tx_rolled_back", txHash: "tx2", blockHeight: 100 });
    expect(w.isWatchedTx("tx2")).toBe(true);
    await w.tick();
    expect(events).toHaveLength(2);
    sim.height = 103;
    sim.include("tx2"); // re-included in a later block
    await w.tick();
    expect(events.at(-1)).toMatchObject({ type: "tx_pending", confirmations: 1, blockHeight: 103 });
    sim.height = 104;
    await w.tick();
    expect(events.at(-1)).toEqual({ type: "tx_confirmed", txHash: "tx2", slot: TIP_SLOT + 103, confirmations: 2 });
  });

  it("re-inclusion in a different block between two polls is reported as a rollback", async () => {
    const { w, events, sim } = setup(3);
    w.watchTx("tx3");
    sim.include("tx3");
    await w.tick();
    sim.height = 101;
    sim.include("tx3", 101);
    await w.tick();
    expect(events.map((e) => e.type)).toEqual(["tx_pending", "tx_rolled_back", "tx_pending"]);
    expect(events[2]).toMatchObject({ blockHeight: 101, confirmations: 1 });
  });

  it("pending depth survives a restart (kv), so a rollback after restart is still detected", async () => {
    const kv = memoryStores().kv;
    const sim = new ChainSim();
    const a = new PollingChainWatcher({ provider: sim, kv, log: () => {}, confirmations: 2 });
    a.watchTx("tx4");
    sim.include("tx4");
    await a.tick();
    const b = new PollingChainWatcher({ provider: sim, kv, log: () => {}, confirmations: 2 });
    const ev: ChainEvent[] = [];
    b.on((e) => ev.push(e));
    expect(b.pendingTxs()).toHaveLength(1);
    sim.rollback("tx4");
    await b.tick();
    expect(ev).toEqual([{ type: "tx_rolled_back", txHash: "tx4", blockHeight: 100 }]);
  });

  it("deposits wait for N: UTxO left out of the cursor until deep, then one deposit with confirmations", async () => {
    const { w, events, sim } = setup(2);
    w.watchAddress("addr_d");
    await w.tick(); // seed (empty)
    sim.add("addr_d", 2_000_000n, {}, "dep1", 0);
    sim.include("dep1");
    await w.tick();
    expect(events).toEqual([]); // depth 1
    sim.height += 1;
    await w.tick();
    expect(events).toEqual([{ type: "deposit", address: "addr_d", txHash: "dep1", amount: [{ unit: "lovelace", quantity: "2000000" }], confirmations: 2 }]);
    await w.tick();
    expect(events).toHaveLength(1);
  });

  it("a deposit rolled back before N is never emitted", async () => {
    const { w, events, sim } = setup(2);
    w.watchAddress("addr_r");
    await w.tick();
    sim.add("addr_r", 3_000_000n, {}, "dep2", 0);
    sim.include("dep2");
    await w.tick();
    sim.utxos.set("addr_r", []); // rolled back: the UTxO and the tx are gone
    sim.rollback("dep2");
    sim.height += 5;
    await w.tick();
    expect(events).toEqual([]);
  });

  it("emitExistingOnFirstWatch=false seeds the cursor without depth checks", async () => {
    const sim = new ChainSim();
    sim.add("addr_s", 1_000_000n, {}, "old", 0);
    const w = new PollingChainWatcher({ provider: sim, kv: memoryStores().kv, log: () => {}, confirmations: 2, emitExistingOnFirstWatch: false });
    const ev: ChainEvent[] = [];
    w.on((e) => ev.push(e));
    w.watchAddress("addr_s");
    await w.tick();
    expect(w.knownUtxos("addr_s")).toHaveLength(1);
    expect(ev).toEqual([]);
  });

  it("uses the raw provider under a FinalityProvider (depth is computed by the watcher)", async () => {
    const sim = new ChainSim();
    const w = new PollingChainWatcher({ provider: new FinalityProvider(sim, 5), kv: memoryStores().kv, log: () => {}, confirmations: 2 });
    const ev: ChainEvent[] = [];
    w.on((e) => ev.push(e));
    w.watchTx("tx5");
    sim.include("tx5");
    await w.tick();
    expect(ev).toEqual([{ type: "tx_pending", txHash: "tx5", slot: TIP_SLOT + 100, blockHeight: 100, confirmations: 1, required: 2 }]);
  });
});

describe("Ogmios path with CONFIRMATIONS", () => {
  const blk = (height: number, txs: Array<{ id: string; out?: string; spends?: string }> = []) => ({
    id: `b${height}`,
    slot: 1000 + height,
    height,
    transactions: txs.map((t) => ({
      id: t.id,
      inputs: t.spends ? [{ transaction: { id: t.spends }, index: 0 }] : [],
      outputs: t.out ? [{ address: t.out, value: { ada: { lovelace: 5 } } }] : [],
    })),
  });

  it("holds deposits and tx confirmations until N blocks, then emits with confirmations", () => {
    const { w, events } = setup(2);
    w.watchAddress("addr_o");
    w.setKnownUtxos("addr_o", []);
    w.watchTx("t1");
    w.applyBlock(blk(10, [{ id: "t1", out: "addr_o" }]));
    expect(events).toEqual([{ type: "tx_pending", txHash: "t1", slot: 1010, blockHeight: 10, confirmations: 1, required: 2 }]);
    w.applyBlock(blk(11));
    expect(events.slice(1)).toEqual([
      { type: "tx_confirmed", txHash: "t1", slot: 1010, confirmations: 2 },
      { type: "deposit", address: "addr_o", txHash: "t1", amount: [{ unit: "lovelace", quantity: "5" }], confirmations: 2 },
    ]);
  });

  it("rollBackward before N: tx_rolled_back, held deposit dropped (cursor cleaned), re-inclusion confirms later", () => {
    const { w, events } = setup(3);
    w.watchAddress("addr_o");
    w.setKnownUtxos("addr_o", []);
    w.watchTx("t2");
    w.applyBlock(blk(20, [{ id: "t2", out: "addr_o" }]));
    w.applyBlock(blk(21));
    expect(w.knownUtxos("addr_o")).toEqual([{ ref: "t2#0", txHash: "t2" }]);
    w.rollBackward({ slot: 1019, id: "b19" });
    expect(events.filter((e) => e.type === "tx_rolled_back")).toEqual([{ type: "tx_rolled_back", txHash: "t2", blockHeight: 20 }]);
    expect(w.knownUtxos("addr_o")).toEqual([]);
    expect(w.isWatchedTx("t2")).toBe(true);
    // the fork: t2 lands again at height 20' and gets 3 blocks
    w.applyBlock({ ...blk(20, [{ id: "t2", out: "addr_o" }]), id: "b20x" });
    w.applyBlock(blk(21));
    expect(events.some((e) => e.type === "tx_confirmed" || e.type === "deposit")).toBe(false);
    w.applyBlock(blk(22));
    const tail = events.filter((e) => e.type === "tx_confirmed" || e.type === "deposit");
    expect(tail).toEqual([
      { type: "tx_confirmed", txHash: "t2", slot: 1020, confirmations: 3 },
      { type: "deposit", address: "addr_o", txHash: "t2", amount: [{ unit: "lovelace", quantity: "5" }], confirmations: 3 },
    ]);
  });

  it("a rollback to a point after the tx block keeps it pending", () => {
    const { w, events } = setup(3);
    w.watchTx("t3");
    w.applyBlock(blk(30, [{ id: "t3" }]));
    w.applyBlock(blk(31));
    w.rollBackward({ slot: 1030 });
    expect(events.some((e) => e.type === "tx_rolled_back")).toBe(false);
    w.applyBlock(blk(31));
    w.applyBlock(blk(32));
    expect(events.at(-1)).toEqual({ type: "tx_confirmed", txHash: "t3", slot: 1030, confirmations: 3 });
  });
});
