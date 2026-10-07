// One-off/ops: move settlement tokens + tADA from one custodial treasury to another (preprod only).
// Usage: tsx scripts/fund-crew-treasury.ts <fromUserId> <toAddress> <tusdm> <extraAda>
import { createChain } from "@bulkhead/chain";
import { explorerTx } from "@bulkhead/shared";

const [fromUserId, toAddress, tusdm, extraAda] = process.argv.slice(2);
if (!fromUserId || !toAddress?.startsWith("addr_test1") || !tusdm) throw new Error("usage: <fromUserId> <addr_test1…> <tusdm> <extraAda>");
const chain = await createChain();
const r = await chain.tx.fundSessions({
  userId: fromUserId,
  outputs: [{ address: toAddress, tusdMicro: BigInt(Math.round(Number(tusdm) * 1e6)), extraLovelace: BigInt(Math.round(Number(extraAda ?? 0) * 1e6)) }],
  metadata: { msg: ["Bulkhead: fund Sokosumi crew treasury"] },
});
console.log("submitted", r.txHash, explorerTx(r.txHash));
process.exit(0);
