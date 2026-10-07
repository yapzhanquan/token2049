// pnpm demo:attack-onchain — on-chain attack proof (brief §1.6), PREPROD.
//
// A compromised session tries to pay tUSD to an attacker address, BYPASSING the Signer (no policy check):
// we build the Pay tx directly with the real session key (+ the captain's collateral witness), then
//   1. evaluate it (Blockfrost /utils/txs/evaluate)  → the Session Vault script fails;
//   2. try to submit it anyway                        → the node rejects it before inclusion,
//      so it never reaches a block and NO collateral is lost.
// Then the vault is revoked back to the owner (cleanup). Takes the chain lock itself.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVaultPay, vaultPayTtlSlot, type VaultTxServiceResult } from "@bulkhead/chain";
import { explorerAddress, explorerTx } from "@bulkhead/shared";
import { acquireLock, ada, ATTACKER_ADDRESS, captainCollateral, newTestVault, releaseLock, testTreasury, vaultTestChain, waitConfirmed, writeDeployment, type Step } from "./vault-common";

const TUSD = 1_000_000n;
const ADA = 1_000_000n;

export async function runAttackOnchain(opts: { log?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; steps: Step[]; record?: Record<string, unknown> }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const env = opts.env ?? process.env;
  const steps: Step[] = [];
  const step = (s: Step) => {
    steps.push(s);
    log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}${s.txHash ? `\n    ${explorerTx(s.txHash)}` : ""}`);
    return s.ok;
  };
  for (const k of ["MASTER_SECRET", "OPERATOR_MNEMONIC", "BLOCKFROST_PREPROD_PROJECT_ID"] as const)
    if (!env[k]?.trim()) return { ok: false, steps: [{ name: "env", ok: false, detail: `${k} is not set` }] };

  await acquireLock("demo-attack-onchain.ts", log);
  try {
    const { chain, sessions } = await vaultTestChain(env);
    const treasury = await testTreasury(chain, log, { lovelace: 12n * ADA, tusdMicro: 5n * TUSD });
    const coll = await captainCollateral(chain, log);

    // A funded vault with a real session key; the attacker address is NOT in its payee list.
    const S = await newTestVault(chain, sessions, treasury, { tag: "attack", expiryMs: Date.now() + 3600_000, perTxMaxTusdMicro: 5n * TUSD, adaAllowanceLovelace: 3n * ADA });
    log(`vault ${S.vault.scriptHash} · ${S.vault.address}\n    ${explorerAddress(S.vault.address)}\n    allowed payees: ${S.params.payees.join(", ")}`);
    const fund = await chain.tx.vaultFund({ userId: "vault-test-990002", outputs: [{ address: S.vault.address, tusdMicro: 5n * TUSD, extraLovelace: 3n * ADA }] });
    if (!step({ name: "fund the session vault (5 tUSD)", ok: !!(await waitConfirmed(chain, fund.txHash, log)), detail: `fee ${ada(fund.feeLovelace)}`, txHash: fund.txHash })) return { ok: false, steps };

    // Build the malicious Pay directly (no Signer, no evaluation in the builder: fixed exec units).
    const [pp, costModels, tip, vaultUtxos] = await Promise.all([
      chain.provider.fetchProtocolParameters(),
      chain.provider.fetchCostModels?.(),
      chain.provider.fetchTip(),
      chain.provider.fetchUtxos(S.vault.address),
    ]);
    const collUtxo = await chain.tx.vaultOps().collateral("captain");
    const built = await buildVaultPay({
      vault: S.vault,
      utxos: vaultUtxos,
      collateral: collUtxo.utxo,
      protocolParams: pp as Parameters<typeof buildVaultPay>[0]["protocolParams"],
      costModels,
      exUnits: { mem: 1_500_000, steps: 600_000_000 },
      payee: ATTACKER_ADDRESS,
      tusdMicro: 4n * TUSD,
      memo: "attack: drain to attacker (Signer bypassed)",
      ttlSlot: vaultPayTtlSlot(S.params.expiryMs, tip.slot),
    });
    let signed = await chain.keys.signTx(`session:${S.sessionId}`, built.unsignedTx);
    signed = await chain.keys.signTx("captain", signed);
    step({ name: "malicious Pay built + signed by the REAL session key", ok: true, detail: `tx ${built.txHash}: 4 tUSD → attacker ${ATTACKER_ADDRESS}` });

    let evalErr = "";
    try {
      const r = await chain.provider.evaluateTx!(signed);
      step({ name: "evaluate (Blockfrost)", ok: false, detail: `UNEXPECTED: evaluation succeeded ${JSON.stringify(r)}` });
    } catch (e) {
      evalErr = (e as Error).message;
      step({ name: "evaluate (Blockfrost)", ok: /EvaluationFailure|ScriptFailures|validatorFailed/i.test(evalErr), detail: `script FAILED as expected: ${evalErr.slice(0, 400)}` });
    }
    let submitErr = "";
    try {
      const h = await chain.provider.submitTx(signed);
      step({ name: "submit anyway", ok: false, detail: `UNEXPECTED: node accepted ${h}`, txHash: h });
    } catch (e) {
      submitErr = (e as Error).message;
      step({ name: "submit anyway", ok: true, detail: `node REJECTED it before inclusion (no collateral taken): ${submitErr.slice(0, 400)}` });
    }
    // Nothing moved: the attacker got nothing, the vault still holds its funds, the collateral UTxO is intact.
    await new Promise((r) => setTimeout(r, 20_000));
    const onChain = await chain.provider.fetchTxConfirmation(built.txHash);
    const vaultNow = await chain.tx.balanceOf(S.vault.address);
    const attackerNow = await chain.tx.balanceOf(ATTACKER_ADDRESS);
    const captainUtxos = await chain.provider.fetchUtxos(collUtxo.address);
    const collIntact = captainUtxos.some((u) => u.txHash === collUtxo.utxo.txHash && u.outputIndex === collUtxo.utxo.outputIndex);
    step({
      name: "nothing moved",
      ok: !onChain && vaultNow.tusdMicro === 5n * TUSD && attackerNow.tusdMicro === 0n && collIntact,
      detail: `tx on chain: ${onChain ? "YES" : "no"}; vault still holds ${Number(vaultNow.tusdMicro) / 1e6} tUSD; attacker holds ${Number(attackerNow.tusdMicro) / 1e6} tUSD; captain collateral ${collUtxo.utxo.txHash.slice(0, 12)}…#${collUtxo.utxo.outputIndex} intact: ${collIntact}`,
    });

    // Cleanup: captain revokes the vault back to the owner.
    const rev = (await chain.tx.vaultRevoke({
      sessionId: S.sessionId,
      toAddress: treasury.address,
      metadata674: { session_id: S.sessionId.slice(0, 64), log_sha256: "0".repeat(64), handback_sha256: "0".repeat(64), status: "REVOKED_AFTER_ATTACK" },
    })) as VaultTxServiceResult;
    step({ name: "cleanup: Revoke → owner", ok: !!(await waitConfirmed(chain, rev.txHash, log)), detail: `fee ${ada(rev.feeLovelace)}`, txHash: rev.txHash });

    const record = {
      at: new Date().toISOString(),
      sessionId: S.sessionId,
      appliedScriptHash: S.vault.scriptHash,
      vaultAddress: S.vault.address,
      attacker: ATTACKER_ADDRESS,
      allowedPayees: S.params.payees,
      maliciousTxHash: built.txHash,
      evaluationError: evalErr.slice(0, 2000),
      submissionError: submitErr.slice(0, 2000),
      maliciousTxOnChain: !!onChain,
      txs: { fund: fund.txHash, revoke: rev.txHash, collateral: coll.utxo },
    };
    writeDeployment({ attackDemo: record });
    return { ok: steps.every((s) => s.ok), steps, record };
  } catch (e) {
    step({ name: "error", ok: false, detail: (e as Error).message.slice(0, 1500) });
    return { ok: false, steps };
  } finally {
    releaseLock();
  }
}

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  console.log("Bulkhead on-chain attack proof (PREPROD): a session key tries to pay an attacker, bypassing the Signer.\n");
  runAttackOnchain()
    .then((r) => {
      console.log(r.ok ? "\nATTACK BLOCKED ON-CHAIN by the Session Vault script ✓" : "\nATTACK DEMO FAILED (see steps above)");
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
