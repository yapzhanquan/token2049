import { describe, expect, it } from "vitest";
import { PollingChainWatcher } from "../src/watcher";
import { memoryStores } from "../src/store";
import type { ChainEvent } from "../src/types";
import { FakeProvider, TIP_SLOT } from "./helpers";

function setup(kv = memoryStores().kv, provider = new FakeProvider()) {
  const w = new PollingChainWatcher({ provider, kv, pollMs: 50, log: () => {} });
  const events: ChainEvent[] = [];
  w.on((e) => events.push(e));
  return { w, events, provider, kv };
}

describe("PollingChainWatcher", () => {
  it("emits deposit for new UTxOs (summed per tx) and spend when a known UTxO disappears", async () => {
    const { w, events, provider } = setup();
    provider.add("addr_a", 2_000_000n, { tok: 5n }, "h1", 0);
    provider.add("addr_a", 1_000_000n, {}, "h1", 1);
    w.watchAddress("addr_a");
    await w.tick();
    expect(events).toEqual([
      { type: "deposit", address: "addr_a", txHash: "h1", amount: [{ unit: "lovelace", quantity: "3000000" }, { unit: "tok", quantity: "5" }] },
    ]);
    events.length = 0;
    await w.tick();
    expect(events).toEqual([]); // nothing new
    provider.utxos.set("addr_a", provider.utxos.get("addr_a")!.slice(1));
    await w.tick();
    expect(events).toEqual([{ type: "spend", address: "addr_a", txHash: "h1" }]);
  });

  it("tx_confirmed once, then unwatched; expiry_reached once at the tip slot", async () => {
    const { w, events, provider } = setup();
    let confirmed = false;
    provider.fetchTxConfirmation = async (h: string) => (confirmed && h === "tx1" ? { blockHeight: 5, slot: TIP_SLOT - 1 } : null);
    w.watchTx("tx1");
    w.watchExpiry("s1", TIP_SLOT + 5);
    await w.tick();
    expect(events).toEqual([]);
    confirmed = true;
    provider.tipSlot = TIP_SLOT + 5;
    await w.tick();
    await w.tick();
    expect(events).toEqual([
      { type: "expiry_reached", sessionId: "s1", slot: TIP_SLOT + 5 },
      { type: "tx_confirmed", txHash: "tx1", slot: TIP_SLOT - 1, confirmations: 1 },
    ]);
  });

  it("persists watched items + cursors in kv: a restart does not re-emit, but sees changes made while down", async () => {
    const stores = memoryStores();
    const provider = new FakeProvider();
    provider.add("addr_b", 5_000_000n, {}, "d1", 0);
    const first = setup(stores.kv, provider);
    first.w.watchAddress("addr_b");
    first.w.watchExpiry("s2", TIP_SLOT + 100);
    await first.w.tick();
    expect(first.events).toHaveLength(1);
    // "down": a new deposit arrives
    provider.add("addr_b", 1_000_000n, {}, "d2", 0);
    const second = setup(stores.kv, provider);
    await second.w.tick();
    expect(second.events).toEqual([{ type: "deposit", address: "addr_b", txHash: "d2", amount: [{ unit: "lovelace", quantity: "1000000" }] }]);
    provider.tipSlot = TIP_SLOT + 100;
    await second.w.tick();
    expect(second.events.at(-1)).toEqual({ type: "expiry_reached", sessionId: "s2", slot: TIP_SLOT + 100 });
  });

  it("start()/stop() polls on an interval", async () => {
    const { w, provider } = setup();
    w.watchAddress("addr_c");
    await w.start();
    await new Promise((r) => setTimeout(r, 180));
    await w.stop();
    const calls = provider.fetchUtxosCalls;
    expect(calls).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(provider.fetchUtxosCalls).toBe(calls);
  });

  it("Ogmios block path: deposit, spend by spending tx id, tx_confirmed, expiry", async () => {
    const { w, events } = setup();
    w.watchAddress("addr_o");
    w.setKnownUtxos("addr_o", []);
    w.watchTx("t2");
    w.watchExpiry("s3", 500);
    w.applyBlock({
      id: "b1",
      slot: 400,
      transactions: [{ id: "t1", inputs: [], outputs: [{ address: "addr_o", value: { ada: { lovelace: 7 }, pol: { "6e": 3 } } }] }],
    });
    w.applyBlock({ id: "b2", slot: 500, transactions: [{ id: "t2", inputs: [{ transaction: { id: "t1" }, index: 0 }], outputs: [] }] });
    expect(events).toEqual([
      { type: "deposit", address: "addr_o", txHash: "t1", amount: [{ unit: "lovelace", quantity: "7" }, { unit: "pol6e", quantity: "3" }] },
      { type: "spend", address: "addr_o", txHash: "t2" },
      { type: "tx_confirmed", txHash: "t2", slot: 500, confirmations: 1 },
      { type: "expiry_reached", sessionId: "s3", slot: 500 },
    ]);
  });
});
