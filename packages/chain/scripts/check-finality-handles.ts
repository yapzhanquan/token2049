// Read-only preprod check for workstream D (no transactions are built or submitted):
//  1. resolve ADA Handles ($test, $hello by default) on-chain via Blockfrost assets/{unit}/addresses,
//     cross-checked against the public Handle API;
//  2. observe one existing tx's confirmation depth through FinalityProvider and the watcher.
// Usage (from packages/chain): npx tsx --env-file=../../.env scripts/check-finality-handles.ts [txHash] [$handle ...]
import { BlockfrostProvider } from "../src/providers";
import { FinalityProvider, confirmationsFromEnv } from "../src/finality";
import { createHandleResolver, HandleError } from "../src/handle";
import { PollingChainWatcher } from "../src/watcher";
import { memoryStores } from "../src/store";
import type { ChainEvent } from "../src/types";

const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID?.trim();
if (!key) throw new Error("BLOCKFROST_PREPROD_PROJECT_ID is not set");
const args = process.argv.slice(2);
const txHash = args.find((a) => /^[0-9a-f]{64}$/.test(a)) ?? "9d383bd44471517e1b70cd8f2cbeea34d912e3bf7980b7a774859bc1aca50690";
const handles = args.filter((a) => a.startsWith("$"));
if (!handles.length) handles.push("$test", "$hello");

const resolver = createHandleResolver({ blockfrostProjectId: key });
console.log("── ADA Handles (preprod, policy f0ff48bb…, on-chain via Blockfrost) ──");
for (const h of [...handles, "$bulkhead-no-such-handle"]) {
  try {
    const r = await resolver.resolve(h, { crossCheck: true });
    console.log(`${r.handle.padEnd(12)} → ${r.address}`);
    console.log(`${"".padEnd(12)}   ${r.standard} unit ${r.unit} · source ${r.source} · Handle API cross-check: ${r.crossCheck} · resolvedAt ${new Date(r.resolvedAt).toISOString()}`);
  } catch (e) {
    console.log(`${h.padEnd(12)} ✗ ${e instanceof HandleError ? `[${e.code}] ` : ""}${(e as Error).message}`);
  }
}

console.log("\n── Confirmation depth ──");
const raw = new BlockfrostProvider(key);
const need = confirmationsFromEnv();
const fin = new FinalityProvider(raw, need);
const tip = await fin.fetchTip();
const d = await fin.fetchTxDepth(txHash);
console.log(`tip height ${tip.height} slot ${tip.slot}; tx ${txHash}`);
if (!d) console.log("tx not on chain");
else {
  console.log(`tx block height ${d.blockHeight} slot ${d.slot} → depth = ${tip.height} − ${d.blockHeight} + 1 = ${d.confirmations}`);
  console.log(`CONFIRMATIONS=${need}: fetchTxConfirmation → ${JSON.stringify(await fin.fetchTxConfirmation(txHash))}`);
  const strict = new FinalityProvider(raw, d.confirmations + 1000);
  console.log(`CONFIRMATIONS=${d.confirmations + 1000}: fetchTxConfirmation → ${JSON.stringify(await strict.fetchTxConfirmation(txHash))} (pending)`);
  for (const n of [need, d.confirmations + 1000]) {
    const w = new PollingChainWatcher({ provider: raw, kv: memoryStores().kv, log: () => {}, confirmations: n });
    const ev: ChainEvent[] = [];
    w.on((e) => ev.push(e));
    w.watchTx(txHash);
    await w.tick();
    console.log(`watcher (N=${n}) events: ${JSON.stringify(ev)}`);
  }
}
