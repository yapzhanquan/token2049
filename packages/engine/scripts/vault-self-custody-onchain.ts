// Self-custody Session Vault on PREPROD (workstream B). Takes the chain lock itself.
//   0. captain collateral UTxO; a throwaway in-memory "browser wallet" (random payment + stake key, BASE address;
//      never persisted, never logged) funded from the operator with a small amount of tADA + tUSD
//   1. vault owned by the wallet's FULL address (payment + stake credential) → vault address = script + wallet stake
//   2. UNSIGNED vault funding built from the wallet's UTxOs (tx.buildUnsignedVaultFunding: inline datum Void,
//      exactly the budget tUSD + min-ADA + ada_allowance headroom) → the wallet signs like CIP-30
//      signTx(tx, true) (witness set only) → tx.submitSigned (attach + verify + submit)
//   3. Pay (session key; captain collateral) to an allowed payee
//   4. Revoke (captain) → everything back to the WALLET address, metadata 674
//   5. leftovers: the wallet sweeps everything back to the operator
// Run: pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/vault-self-custody-onchain.ts
import { createHash } from "node:crypto";
import { addressCredentials, agentWallet, createThrowawayWallet, parseTx, txOutputInfo } from "@bulkhead/chain";
import { explorerTx } from "@bulkhead/shared";
import { acquireLock, ada, captainCollateral, newTestVault, releaseLock, sleep, vaultTestChain, waitConfirmed, writeDeployment, type Step } from "./vault-common";

const TUSD = 1_000_000n;
const ADA = 1_000_000n;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  const log = (s: string) => console.log(s);
  const env = process.env;
  const steps: Step[] = [];
  const step = (s: Step) => {
    steps.push(s);
    log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}${s.txHash ? `\n    ${explorerTx(s.txHash)}` : ""}`);
    if (!s.ok) throw new Error(`step failed: ${s.name}`);
  };
  for (const k of ["MASTER_SECRET", "OPERATOR_MNEMONIC", "BLOCKFROST_PREPROD_PROJECT_ID"] as const) if (!env[k]?.trim()) throw new Error(`${k} is not set`);

  await acquireLock("vault-self-custody-onchain.ts (workstream B)", log);
  const record: Record<string, unknown> = { startedAt: new Date().toISOString() };
  let wallet: Awaited<ReturnType<typeof createThrowawayWallet>> | null = null;
  let chainRef: Awaited<ReturnType<typeof vaultTestChain>>["chain"] | null = null;
  try {
    const { chain, sessions } = await vaultTestChain(env);
    chainRef = chain;
    if (chain.provider.network !== "preprod") throw new Error("preprod only");
    log(`Network: PREPROD · provider ${chain.provider.name}`);
    const unit = await chain.tx.tusdUnitAsync();
    log(`tUSD unit: ${unit}`);

    // 0. collateral + throwaway browser wallet
    const coll = await captainCollateral(chain, log);
    wallet = await createThrowawayWallet();
    const d = addressCredentials(wallet.address);
    if (d.payment.type !== "key" || !d.stake) throw new Error("throwaway wallet must be a base address");
    const w = wallet;
    const seed = await chain.tx.operatorSend({ toAddress: wallet.address, tusdMicro: 2n * TUSD, lovelace: 12n * ADA, reference: "Bulkhead self-custody vault test wallet (throwaway)" });
    step({ name: "operator → throwaway wallet (12 tADA + 2 tUSD)", ok: !!(await waitConfirmed(chain, seed.txHash, log)), detail: `wallet ${wallet.address}`, txHash: seed.txHash });
    for (let i = 0; i < 12 && (await chain.provider.fetchUtxos(wallet.address)).length === 0; i++) await sleep(5_000);

    // 1. vault owned by the wallet's full address
    const payee = (await agentWallet(0)).address;
    const v = await newTestVault(chain, sessions, { address: wallet.address }, { tag: "selfcustody", expiryMs: Date.now() + 2 * 3600_000, perTxMaxTusdMicro: 1n * TUSD, adaAllowanceLovelace: 3n * ADA, payees: [payee] });
    const vd = addressCredentials(v.vault.address);
    step({ name: "vault owner = wallet full address", ok: vd.payment.type === "script" && vd.payment.hash === v.vault.scriptHash && vd.stake?.hash === w.stakeKeyHash, detail: `vault ${v.vault.address} (script ${v.vault.scriptHash}, stake = wallet stake key)` });

    // 2. unsigned funding → wallet witness set → submitSigned
    const u = await chain.tx.buildUnsignedVaultFunding({ fromAddress: wallet.address, outputs: [{ address: v.vault.address, tusdMicro: 2n * TUSD, extraLovelace: 3n * ADA }], metadata: { 674: { msg: ["bulkhead: fund session vaults (self-custody)", v.sessionId.slice(0, 60)] } } });
    const info = txOutputInfo(u.unsignedTx, v.vault.address);
    const unsignedWitnesses = info.vkeyWitnesses;
    const datum = info.inlineDatumCbor;
    const vaultLovelace = info.lovelace ?? 0n;
    log(`  unsigned funding ${u.txHash}: fee ${ada(u.feeLovelace)}, vkey witnesses ${unsignedWitnesses}, vault output datum ${datum}, ${ada(vaultLovelace)}`);
    const ws = wallet.signTx(u.unsignedTx); // CIP-30 signTx(tx, true): witness set only
    const funded = await chain.tx.submitSigned({ fromAddress: wallet.address, unsignedTx: u.unsignedTx, signed: ws, requiredKeyHash: wallet.paymentKeyHash });
    const fundOk = funded.txHash === u.txHash && unsignedWitnesses === 0 && datum === "d87980" && !!(await waitConfirmed(chain, funded.txHash, log));
    step({ name: "unsigned vault funding signed by the wallet (witness set) + submitSigned", ok: fundOk, detail: `inputs from the wallet only, inline datum Void, 2 tUSD + ${ada(vaultLovelace)}`, txHash: funded.txHash });
    record.fund = { txHash: funded.txHash, feeLovelace: funded.feeLovelace.toString(), vaultLovelace: vaultLovelace.toString() };
    for (let i = 0; i < 12 && !(await chain.provider.fetchUtxos(v.vault.address)).some((x) => x.txHash === funded.txHash); i++) await sleep(5_000);

    // 3. Pay
    const pay = await chain.tx.vaultPay({ sessionId: v.sessionId, payee, tusdMicro: 500_000n, memo: "Bulkhead self-custody vault pay", reference: "selfcustody-1" });
    step({ name: "Pay 0.5 tUSD to the allowed payee (session key)", ok: !!(await waitConfirmed(chain, pay.txHash, log)), detail: `fee ${ada(pay.feeLovelace)}, exUnits mem ${pay.exUnits[0]?.mem} steps ${pay.exUnits[0]?.steps}`, txHash: pay.txHash });
    record.pay = { txHash: pay.txHash, feeLovelace: pay.feeLovelace.toString(), exUnits: pay.exUnits };
    for (let i = 0; i < 12 && !(await chain.provider.fetchUtxos(v.vault.address)).some((x) => x.txHash === pay.txHash); i++) await sleep(5_000);

    // 4. Revoke → wallet
    const metadata674 = { session_id: v.sessionId.slice(0, 64), log_sha256: sha(`log:${v.sessionId}`), handback_sha256: sha(""), status: "CLOSED" };
    const rv = await chain.tx.vaultRevoke({ sessionId: v.sessionId, toAddress: wallet.address, metadata674 });
    const outs = parseTx(rv.cborHex).outputs;
    const back = outs.filter((o) => o.address === w.address).reduce((s, o) => s + BigInt(o.amount.find((a) => a.unit === unit)?.quantity ?? "0"), 0n);
    step({ name: "Revoke (captain) → everything back to the WALLET", ok: outs.length === 1 && back === 1_500_000n && !!(await waitConfirmed(chain, rv.txHash, log)), detail: `1 output → wallet, ${Number(back) / 1e6} tUSD + ${ada(BigInt(outs[0]!.amount.find((a) => a.unit === "lovelace")!.quantity))}`, txHash: rv.txHash });
    record.revoke = { txHash: rv.txHash, feeLovelace: rv.feeLovelace.toString() };
    record.wallet = wallet.address;
    record.vault = { address: v.vault.address, scriptHash: v.vault.scriptHash };
    record.collateral = coll.utxo;
  } finally {
    // 5. leftovers back to the operator (also on failure), then release the lock
    try {
      if (wallet && chainRef) {
        const c = chainRef;
        for (let i = 0; i < 12; i++) {
          const us = await c.provider.fetchUtxos(wallet.address);
          if (us.length && (!record.revoke || us.some((x) => x.txHash === (record.revoke as { txHash: string }).txHash))) break;
          await sleep(5_000);
        }
        const op = await c.keys.operator();
        const h = await wallet.sweepAll(c.provider, op.address, (await c.provider.fetchProtocolParameters()) as Parameters<typeof wallet.sweepAll>[2]);
        if (h) {
          const ok = await waitConfirmed(c, h, log);
          steps.push({ name: "leftovers → operator", ok: !!ok, detail: "throwaway wallet swept back to the operator", txHash: h });
          log(`${ok ? "✓" : "✗"} leftovers → operator\n    ${explorerTx(h)}`);
          record.returnLeftovers = h;
        }
      }
    } catch (e) {
      log(`! could not return leftovers: ${(e as Error).message}`);
    }
    releaseLock();
  }
  writeDeployment({ selfCustodyVaultRun: { ...record, finishedAt: new Date().toISOString(), steps } });
  log("done.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
