// Session Vault integration run on PREPROD (brief §4, vault part). Takes the chain lock itself.
//   0. test owner treasury (custodial account 990002, topped up from the operator) + captain collateral UTxO
//   1. fund two vaults in ONE treasury tx (A: long expiry; B: expiry in ~5 min), inline datum Void
//   2. A: Pay an allowed payee (mock agent #0) → confirmed
//   3. A: Pay over the per-tx tUSD limit → rejected by the script (Blockfrost evaluation)
//   4. A: Pay to an attacker address → rejected by the script
//   5. A: Revoke (captain) → everything back to the owner, metadata 674 present
//   6. B: after expiry, Recover by a RANDOM in-memory key (it only provides collateral; not persisted, not logged)
// Run: pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/vault-onchain.ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  agentWallet,
  buildVaultRecover,
  parseTx,
  createThrowawayKey,
  providerEvaluator,
  vaultRecoverFromSlot,
  type VaultTxServiceResult,
} from "@bulkhead/chain";
import { explorerAddress, explorerTx } from "@bulkhead/shared";
import {
  acquireLock,
  ada,
  ATTACKER_ADDRESS,
  captainCollateral,
  newTestVault,
  releaseLock,
  sleep,
  testTreasury,
  vaultTestChain,
  waitConfirmed,
  writeDeployment,
  type Step,
} from "./vault-common";

const TUSD = 1_000_000n;
const ADA = 1_000_000n;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function runVaultOnchain(opts: { log?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; steps: Step[]; record?: Record<string, unknown> }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const env = opts.env ?? process.env;
  const steps: Step[] = [];
  const step = (s: Step) => {
    steps.push(s);
    log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}${s.txHash ? `\n    ${explorerTx(s.txHash)}` : ""}`);
    return s.ok;
  };
  for (const k of ["MASTER_SECRET", "OPERATOR_MNEMONIC"] as const) if (!env[k]?.trim()) return { ok: false, steps: [{ name: "env", ok: false, detail: `${k} is not set` }] };
  if (!env.BLOCKFROST_PREPROD_PROJECT_ID?.trim()) return { ok: false, steps: [{ name: "env", ok: false, detail: "BLOCKFROST_PREPROD_PROJECT_ID is not set (vault txs need Blockfrost evaluate + cost models)" }] };

  await acquireLock("vault-onchain.ts", log);
  const record: Record<string, unknown> = { startedAt: new Date().toISOString() };
  try {
    const { chain, sessions } = await vaultTestChain(env);
    if (chain.provider.network !== "preprod") throw new Error("preprod only");
    log(`Network: PREPROD · provider ${chain.provider.name}`);

    const unit = await chain.tx.tusdUnitAsync();
    /** Outputs of a tx: how many, how many to `owner`, tUSD to `owner`. */
    const tusdTo = (hex: string, owner: string) => {
      const outs = parseTx(hex).outputs;
      const mine = outs.filter((o) => o.address === owner);
      return { outputs: outs.length, toOwner: mine.length, tusd: mine.reduce((s, o) => s + BigInt(o.amount.find((a) => a.unit === unit)?.quantity ?? "0"), 0n) };
    };
    /** Poll (provider indexing lags block confirmation) until the vault address holds no UTxO. */
    const emptied = async (address: string) => {
      let n = -1;
      for (let i = 0; i < 12; i++) {
        n = (await chain.provider.fetchUtxos(address)).length;
        if (n === 0) break;
        await sleep(5_000);
      }
      return n;
    };

    // 0. test owner treasury + captain collateral
    const treasury = await testTreasury(chain, log, { lovelace: 25n * ADA, tusdMicro: 20n * TUSD });
    step({ name: "test owner treasury", ok: true, detail: `custodial account 990002 → ${treasury.address}${treasury.fundTx ? " (funded by the operator)" : ""}`, txHash: treasury.fundTx });
    const coll = await captainCollateral(chain, log);
    step({ name: "captain collateral UTxO", ok: true, detail: `${coll.address} · ${coll.utxo}`, txHash: coll.fundTx });
    const payee = (await agentWallet(0)).address;

    // 1. two vaults, one funding tx
    const A = await newTestVault(chain, sessions, treasury, { tag: "A", expiryMs: Date.now() + 2 * 3600_000, perTxMaxTusdMicro: 5n * TUSD, adaAllowanceLovelace: 3n * ADA, payees: [payee] });
    const B = await newTestVault(chain, sessions, treasury, { tag: "B", expiryMs: Date.now() + 5 * 60_000, perTxMaxTusdMicro: 5n * TUSD, adaAllowanceLovelace: 3n * ADA, payees: [payee] });
    for (const [n, v] of [["A", A], ["B", B]] as const)
      log(`vault ${n}: script ${v.vault.scriptHash} (${v.vault.scriptSizeBytes} bytes) · ${v.vault.address}\n    ${explorerAddress(v.vault.address)} · expiry ${new Date(v.params.expiryMs).toISOString()}`);
    const fund = await chain.tx.vaultFund!({
      userId: "vault-test-990002",
      outputs: [
        { address: A.vault.address, tusdMicro: 10n * TUSD, extraLovelace: 6n * ADA },
        { address: B.vault.address, tusdMicro: 3n * TUSD, extraLovelace: 2n * ADA },
      ],
      metadata: { msg: ["Bulkhead vault integration test: fund 2 vaults"] },
    });
    const fundC = await waitConfirmed(chain, fund.txHash, log);
    if (!step({ name: "fund vaults A + B (one treasury tx, inline datum Void)", ok: !!fundC, detail: `A 10 tUSD + 6 tADA headroom, B 3 tUSD + 2 tADA; fee ${ada(fund.feeLovelace)}`, txHash: fund.txHash })) return { ok: false, steps };

    // 2. Pay an allowed payee
    const pay = (await chain.tx.vaultPay!({ sessionId: A.sessionId, payee, tusdMicro: 2n * TUSD, memo: "vault test: allowed payee", reference: "vault-onchain" })) as VaultTxServiceResult;
    const payC = await waitConfirmed(chain, pay.txHash, log);
    step({
      name: "A: Pay allowed payee 2 tUSD (session key)",
      ok: !!payC,
      detail: `fee ${ada(pay.feeLovelace)}; exec units measured ${JSON.stringify(pay.measured)} declared ${JSON.stringify(pay.exUnits)}; tx ${pay.txSizeBytes} bytes`,
      txHash: pay.txHash,
    });
    if (!payC) return { ok: false, steps };

    // 3 + 4. rejected by the script
    const rejected: Record<string, string> = {};
    for (const [name, payeeAddr, amount] of [
      ["A: Pay over the per-tx limit (6 tUSD > 5)", payee, 6n * TUSD],
      ["A: Pay to the attacker address", ATTACKER_ADDRESS, 1n * TUSD],
    ] as const) {
      try {
        const r = await chain.tx.vaultPay!({ sessionId: A.sessionId, payee: payeeAddr, tusdMicro: amount, memo: "must fail" });
        step({ name, ok: false, detail: "UNEXPECTED: accepted", txHash: r.txHash });
      } catch (e) {
        const err = e as Error & { code?: string };
        rejected[name] = err.message.slice(0, 600);
        step({ name, ok: err.name === "VaultScriptError" && err.code === "SCRIPT_FAILED", detail: `rejected by the script (${err.name}/${err.code}): ${err.message.slice(0, 220)}` });
      }
    }

    // 5. Revoke A → owner, metadata 674
    const revokeMeta = { session_id: A.sessionId.slice(0, 64), log_sha256: sha(`log:${A.sessionId}`), handback_sha256: sha(`handback:${A.sessionId}`), status: "REVOKED" };
    const revoke = (await chain.tx.vaultRevoke!({ sessionId: A.sessionId, toAddress: treasury.address, metadata674: revokeMeta })) as VaultTxServiceResult;
    const revC = await waitConfirmed(chain, revoke.txHash, log);
    let meta: Record<string, unknown> | null = null;
    for (let i = 0; i < 6 && revC && !meta?.["674"]; i++) {
      meta = (await chain.provider.fetchTxMetadata?.(revoke.txHash)) ?? null;
      if (!meta?.["674"]) await sleep(5_000);
    }
    const m674 = meta?.["674"] as Record<string, unknown> | undefined;
    const leftA = await emptied(A.vault.address);
    const revOut = tusdTo(revoke.cborHex, treasury.address);
    step({
      name: "A: Revoke (captain) → all to owner, metadata 674",
      ok: !!revC && leftA === 0 && m674?.log_sha256 === revokeMeta.log_sha256 && m674?.status === "REVOKED" && revOut.outputs === revOut.toOwner && revOut.tusd === 8n * TUSD,
      detail: `vault now holds ${leftA} UTxOs; tx outputs ${revOut.outputs}, all to the owner: ${revOut.outputs === revOut.toOwner} (+${Number(revOut.tusd) / 1e6} tUSD); 674 = ${JSON.stringify(m674 ?? null).slice(0, 200)}; exec units ${JSON.stringify(revoke.measured)}; fee ${ada(revoke.feeLovelace)}`,
      txHash: revoke.txHash,
    });

    // 6. Recover B after expiry by a random throwaway key (collateral provider only)
    const rnd = await createThrowawayKey();
    log(`random recoverer: key hash ${rnd.keyHash} (in-memory only) · ${rnd.address}`);
    const seed = await chain.tx.operatorSend({ toAddress: rnd.address, tusdMicro: 0n, lovelace: 6n * ADA, reference: "Bulkhead vault test: collateral for a random recoverer" });
    const seedC = await waitConfirmed(chain, seed.txHash, log);
    step({ name: "B: give the random key 6 tADA (its collateral)", ok: !!seedC, detail: `operator → ${rnd.address}`, txHash: seed.txHash });
    const fromSlot = vaultRecoverFromSlot(B.params.expiryMs);
    for (;;) {
      const tip = await chain.provider.fetchTip();
      if (tip.slot >= fromSlot) break;
      log(`  … waiting for expiry: tip slot ${tip.slot} < first Recover slot ${fromSlot} (~${fromSlot - tip.slot} s)`);
      await sleep(Math.min(30_000, Math.max(5_000, (fromSlot - tip.slot) * 1000)));
    }
    const pp = (await chain.provider.fetchProtocolParameters()) as Parameters<typeof buildVaultRecover>[0]["protocolParams"];
    const costModels = await chain.provider.fetchCostModels?.();
    const rndUtxos = await chain.provider.fetchUtxos(rnd.address);
    const bUtxos = await chain.provider.fetchUtxos(B.vault.address);
    const tipNow = await chain.provider.fetchTip();
    const built = await buildVaultRecover({
      vault: B.vault,
      utxos: bUtxos,
      collateral: rndUtxos[0]!,
      protocolParams: pp,
      costModels,
      evaluate: providerEvaluator((hex) => chain.provider.evaluateTx!(hex)),
      ownerAddress: treasury.address,
      validFromSlot: fromSlot,
      ttlSlot: tipNow.slot + 900,
      metadata674: { session_id: B.sessionId.slice(0, 64), status: "RECOVERED" },
    });
    const recoverHash = await chain.provider.submitTx(rnd.sign(built.unsignedTx));
    const recC = await waitConfirmed(chain, recoverHash || built.txHash, log);
    const leftB = await emptied(B.vault.address);
    const recOut = tusdTo(built.unsignedTx, treasury.address);
    step({
      name: "B: Recover after expiry by a random key (no owner/captain signature)",
      ok: !!recC && leftB === 0 && recOut.outputs === recOut.toOwner && recOut.tusd === 3n * TUSD,
      detail: `invalidBefore slot ${fromSlot} (> expiry ${new Date(B.params.expiryMs).toISOString()}); witnesses: random key only; vault now holds ${leftB} UTxOs; all ${recOut.outputs} outputs to the owner: ${recOut.outputs === recOut.toOwner} (+${Number(recOut.tusd) / 1e6} tUSD); exec units ${JSON.stringify(built.measured)}; fee ${ada(built.feeLovelace)}`,
      txHash: built.txHash,
    });
    // return the random key's tADA to the operator (the key is then discarded)
    let sweepBack: string | null = null;
    try {
      await sleep(5_000);
      sweepBack = await rnd.sweepAll(chain.provider, (await chain.keys.operator()).address, pp);
      if (sweepBack) await waitConfirmed(chain, sweepBack, log, 180_000);
      step({ name: "B: return the random key's tADA to the operator", ok: !!sweepBack, detail: "key discarded (never persisted)", txHash: sweepBack ?? undefined });
    } catch (e) {
      step({ name: "B: return the random key's tADA to the operator", ok: true, detail: `skipped (${(e as Error).message.slice(0, 120)}); ≤ 6 tADA left at a throwaway address` });
    }

    Object.assign(record, {
      finishedAt: new Date().toISOString(),
      testOwnerTreasury: { account: 990002, address: treasury.address, stakeKeyHash: treasury.stakeKeyHash },
      captainCollateral: coll,
      sessions: [
        {
          vault: "A",
          sessionId: A.sessionId,
          appliedScriptHash: A.vault.scriptHash,
          vaultAddress: A.vault.address,
          scriptSizeBytes: A.vault.scriptSizeBytes,
          expiry: new Date(A.params.expiryMs).toISOString(),
          payees: A.params.payees,
          perTxMaxTusdMicro: A.params.perTxMaxTusdMicro.toString(),
          adaAllowanceLovelace: A.params.adaAllowanceLovelace.toString(),
          txs: { fund: fund.txHash, pay: pay.txHash, revoke: revoke.txHash },
          exUnits: { pay: pay.measured, revoke: revoke.measured },
          fees: { pay: pay.feeLovelace.toString(), revoke: revoke.feeLovelace.toString() },
          rejected,
        },
        {
          vault: "B",
          sessionId: B.sessionId,
          appliedScriptHash: B.vault.scriptHash,
          vaultAddress: B.vault.address,
          scriptSizeBytes: B.vault.scriptSizeBytes,
          expiry: new Date(B.params.expiryMs).toISOString(),
          txs: { fund: fund.txHash, recover: built.txHash, randomKeyCollateral: seed.txHash, randomKeySweepBack: sweepBack },
          exUnits: { recover: built.measured },
          fees: { recover: built.feeLovelace.toString() },
        },
      ],
    });
    writeDeployment({ vaultIntegrationRun: record });
    log(`deployments/preprod.json updated (${resolve(fileURLToPath(new URL("../../../deployments/preprod.json", import.meta.url)))})`);
    return { ok: steps.every((s) => s.ok), steps, record };
  } catch (e) {
    step({ name: "error", ok: false, detail: (e as Error).message.slice(0, 1500) });
    return { ok: false, steps, record };
  } finally {
    releaseLock();
  }
}

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  runVaultOnchain()
    .then((r) => {
      console.log(r.ok ? "\nVAULT ON-CHAIN: OK" : "\nVAULT ON-CHAIN: FAILED");
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
