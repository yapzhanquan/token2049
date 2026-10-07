// TreasuryQueue: concurrent fundings never double-spend (spec §8 unit test).
import { describe, expect, it } from "vitest";
import { TreasuryQueue } from "../src/queue";
import { KeyVault } from "../src/keys";
import { memoryStores } from "../src/store";
import { MeshTxService, parseTx } from "../src/tx";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT } from "./helpers";
import type { Utxo } from "../src/types";

const ADA = 1_000_000n;

async function treasurySetup(utxoCount: number) {
  // The fake provider's UTxO set never changes (as if the chain/indexer lags behind every submit),
  // which is the worst case for double-spends.
  const provider = new FakeProvider();
  provider.submitDelayMs = 5;
  const stores = memoryStores();
  const keys = new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const tx = new MeshTxService({ provider, keys, sessions: stores.sessions });
  const unit = await tx.tusdUnitAsync();
  const t = await keys.treasury("u", 2);
  for (let i = 0; i < utxoCount; i++) provider.add(t.address, 30n * ADA, { [unit]: 20_000_000n });
  const dest = (await keys.captain()).address;
  return { provider, tx, unit, dest };
}

function assertNoInputReused(submitted: string[]) {
  const seen = new Map<string, string>();
  for (const hex of submitted) {
    const p = parseTx(hex);
    for (const i of p.inputs) {
      const ref = `${i.txHash}#${i.outputIndex}`;
      expect(seen.get(ref), `input ${ref} spent by ${seen.get(ref)} and ${p.txHash}`).toBeUndefined();
      seen.set(ref, p.txHash);
    }
  }
}

describe("TreasuryQueue", () => {
  it("N concurrent fundSessions with plenty of UTxOs: all succeed, no input reused", async () => {
    const { provider, tx, dest } = await treasurySetup(10);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => tx.fundSessions({ userId: "u", outputs: [{ address: dest, tusdMicro: BigInt(1_000_000 + i) }] })),
    );
    expect(new Set(results.map((r) => r.txHash)).size).toBe(N);
    expect(provider.submitted).toHaveLength(N);
    assertNoInputReused(provider.submitted);
  });

  it("more fundings than UTxOs: later ones chain on in-flight change, still no input reused", async () => {
    const { provider, tx, dest } = await treasurySetup(2);
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () => tx.fundSessions({ userId: "u", outputs: [{ address: dest, tusdMicro: 2_000_000n }] })),
    );
    expect(results).toHaveLength(N);
    assertNoInputReused(provider.submitted);
    const chainedInputs = provider.submitted.flatMap((h) => parseTx(h).inputs).filter((i) => results.some((r) => r.txHash === i.txHash));
    expect(chainedInputs.length).toBeGreaterThan(0);
  });

  it("serialises per key (FIFO) and runs different keys in parallel", async () => {
    const q = new TreasuryQueue();
    const log: string[] = [];
    const job = (key: string, id: string, ms: number) =>
      q.run(key, async () => {
        log.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${id}`);
      });
    await Promise.all([job("A", "a1", 20), job("A", "a2", 1), job("B", "b1", 5)]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
  });

  it("a failing job does not block the queue", async () => {
    const q = new TreasuryQueue();
    await expect(q.run("A", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run("A", async () => 42)).resolves.toBe(42);
  });

  it("reservations drop on confirmation (output visible) or after the TTL slot", async () => {
    const q = new TreasuryQueue();
    const u: Utxo = { txHash: "aa", outputIndex: 0, address: "x", amount: [] };
    const change: Utxo = { txHash: "t1", outputIndex: 1, address: "x", amount: [] };
    await q.run("x", async (ctx) => ctx.reserve("t1", [u], [change], TIP_SLOT + 10));
    await q.run("x", async (ctx) => {
      expect(ctx.available([u], { tipSlot: TIP_SLOT })).toEqual([]);
      expect(ctx.available([u], { withChained: true, tipSlot: TIP_SLOT })).toEqual([change]);
      // past TTL → the tx can never land → input free again
      expect(ctx.available([u], { tipSlot: TIP_SLOT + 11 })).toEqual([u]);
    });
    await q.run("x", async (ctx) => ctx.reserve("t2", [u], [], TIP_SLOT + 10));
    await q.run("x", async (ctx) => {
      // t2's output shows up on chain → confirmed → dropped
      ctx.available([{ txHash: "t2", outputIndex: 0, address: "x", amount: [] }]);
    });
    expect(q.pending("x")).toEqual([]);
  });
});
