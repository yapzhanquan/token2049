// pnpm setup:chain — one-time PREPROD chain setup (idempotent; safe to re-run).
//  1. checks the operator balance (clear faucet message if empty);
//  2. tUSD = CIP-68 fungible token: mints, once, the (100) reference NFT (inline-datum metadata {name, ticker,
//     decimals, description}, kept at the operator address) + 1,000,000 tUSD of the (333) user token, in ONE tx;
//  2b. migrates deprecated pre-CIP-68 tUSD (plain "tUSD" asset name) 1:1 to the 333 unit, for the operator and every
//     custodial treasury that still holds some (burn legacy + mint 333, signed by the wallet + operator);
//  3. derives + prints the captain and mock paid-agent wallet addresses (agentWallet(0..2));
//  3b. funds the captain with ONE ADA-only collateral UTxO (10 tADA) for Session Vault txs, if it has none;
//  4. prints explorer links. Never prints keys or mnemonics.
import { createChain, agentWallet, ensureCaptainCollateral, timeFromSlot, NothingToMigrateError } from "@bulkhead/chain";
import { explorerAddress, explorerTx, microToTusd, tusdToMicro } from "@bulkhead/shared";

const FAUCET = "https://docs.cardano.org/cardano-testnets/tools/faucet";
const INITIAL_SUPPLY_MICRO = tusdToMicro("1000000"); // 1,000,000 tUSD (6 decimals)
const KV_MINT = "setup:cip68-tusd-mint-tx"; // (was "setup:initial-tusd-mint-tx" for the deprecated pre-CIP-68 mint)
const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} ADA`;

async function waitConfirmed(chain: Awaited<ReturnType<typeof createChain>>, txHash: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  process.stdout.write("  waiting for confirmation");
  while (Date.now() - t0 < timeoutMs) {
    const c = await chain.provider.fetchTxConfirmation(txHash).catch(() => null);
    if (c) {
      console.log(` ✓ block ${c.blockHeight}, slot ${c.slot} (${new Date(timeFromSlot(c.slot)).toISOString()})`);
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(" still pending (check the explorer link; re-run later).");
  return false;
}

async function main() {
  for (const k of ["MASTER_SECRET", "OPERATOR_MNEMONIC"] as const) {
    if (!process.env[k]?.trim()) throw new Error(`${k} is not set. Run \`pnpm tsx scripts/gen-env.ts\` (gen:env) first.`);
  }
  const chain = await createChain();
  console.log(`Network: PREPROD · provider: ${chain.provider.name}${chain.provider.name === "koios" ? " (keyless/rate-limited; set BLOCKFROST_PREPROD_PROJECT_ID for reliability)" : ""}`);
  const tip = await chain.provider.fetchTip();
  console.log(`Chain tip: slot ${tip.slot}, height ${tip.height}`);

  // 1. Operator balance
  const op = await chain.keys.operator();
  const unit = chain.tx.tusdUnit();
  const bal = await chain.tx.balanceOf(op.address);
  console.log(
    `\nOperator: ${op.address}\n  ${explorerAddress(op.address)}\n  balance: ${ada(bal.lovelace)}, ${microToTusd(bal.tusdMicro)} ${chain.settlement.ticker} (settlement asset; ${bal.utxoCount} UTxOs)`,
  );
  console.log(`Settlement asset: ${chain.settlement.ticker} ${unit} (SETTLEMENT_ASSET / SETTLEMENT_UNIT; default tUSDM)`);
  const token = await chain.tx.tusdTokenInfo();
  console.log(
    `tUSD (CIP-68 fungible, label 333): ${unit}\n  policy id: ${token.policyId} (native script: sig(operator payment key))` +
      `\n  asset name: ${token.assetNameHex} (0014df10 + hex("tUSD"))\n  CIP-14 fingerprint: ${token.fingerprint}` +
      `\n  reference NFT (label 100): ${token.referenceUnit} (${token.referenceFingerprint})`,
  );
  if (bal.lovelace === 0n) {
    console.log(`\n✗ The operator wallet is empty. Fund it with test ADA (Preprod) from the faucet:\n  ${FAUCET}\n  address: ${op.address}\nThen re-run: pnpm setup:chain`);
    process.exitCode = 1;
    return;
  }
  if (bal.lovelace < 10_000_000n) console.log("  ⚠ low ADA: top-ups send 2 ADA each; request more from the faucet soon.");

  // 2. CIP-68 tUSD: (100) reference NFT + (333) supply, once.
  const db = (await import("@bulkhead/db")).rawSqlite();
  const opUtxos = await chain.provider.fetchUtxos(op.address);
  const hasRef = opUtxos.some((u) => u.amount.some((a) => a.unit === token.referenceUnit));
  const pendingMint = db.prepare("SELECT value FROM kv WHERE key = ?").get(KV_MINT) as { value: string } | undefined;
  // Bulkhead's own tUSD held by the operator (independent of the settlement asset).
  const opTusd = opUtxos.reduce((s, u) => s + u.amount.filter((a) => a.unit === token.unit).reduce((x, a) => x + BigInt(a.quantity), 0n), 0n);
  if (hasRef && opTusd > 0n) {
    console.log(`\n✓ CIP-68 tUSD already set up (reference NFT at the operator; operator holds ${microToTusd(opTusd)} tUSD) — skipping mint.`);
  } else if (pendingMint && !(await chain.provider.fetchTxConfirmation(pendingMint.value))) {
    console.log(`\n… The CIP-68 mint was already submitted and is not confirmed yet:\n  ${explorerTx(pendingMint.value)}`);
    await waitConfirmed(chain, pendingMint.value);
  } else {
    const supply = opTusd > 0n ? 0n : INITIAL_SUPPLY_MICRO;
    const parts = [!hasRef ? "(100) reference NFT with the metadata datum → operator" : "", supply ? `${microToTusd(supply)} tUSD (333) → operator` : ""].filter(Boolean);
    console.log(`\nMinting CIP-68 tUSD: ${parts.join(" + ")}`);
    const r = await chain.tx.mintTusdCip68({ supplyMicro: supply, mintReference: !hasRef });
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KV_MINT, r.txHash);
    console.log(`  tx ${r.txHash} (fee ${ada(r.feeLovelace)})\n  ${explorerTx(r.txHash)}`);
    await waitConfirmed(chain, r.txHash);
  }
  console.log(
    "  Note: the reference NFT is kept at the operator address (demo). Production would lock it at a script\n" +
      "  (unspendable for immutable metadata, or an update validator) so ordinary wallet txs cannot move it.",
  );

  // 2b. Deprecated pre-CIP-68 tUSD → 333, 1:1 (operator + custodial treasuries).
  let wallets: string[] = ["operator"];
  try {
    const rows = db
      .prepare("SELECT k.id AS id FROM keys k JOIN users u ON k.id = 'treasury:' || u.id WHERE k.purpose = 'treasury' AND u.custody = 'custodial'")
      .all() as { id: string }[];
    wallets = wallets.concat(rows.map((r) => r.id));
  } catch (e) {
    console.log(`  (could not list custodial treasuries: ${(e as Error).message})`);
  }
  let migrated = 0;
  for (const keyId of wallets) {
    const address = keyId === "operator" ? op.address : (await chain.keys.publicInfo(keyId)).address;
    if (!address) continue;
    const b = await chain.tx.balanceOf(address);
    if (!b.legacyTusdMicro) continue;
    try {
      const r = await chain.tx.migrateLegacyTusd({ keyId });
      migrated++;
      console.log(`  migrated ${microToTusd(r.migratedMicro)} legacy tUSD → CIP-68 (333) for ${keyId}: tx ${r.txHash}\n  ${explorerTx(r.txHash)}`);
      await waitConfirmed(chain, r.txHash);
    } catch (e) {
      if (e instanceof NothingToMigrateError) continue;
      console.log(`  ⚠ migration for ${keyId} failed: ${(e as Error).message}`);
    }
  }
  console.log(migrated ? `✓ legacy tUSD migrated for ${migrated} wallet(s).` : "✓ no deprecated pre-CIP-68 tUSD left to migrate (operator + custodial treasuries).");

  // 3. Captain + mock agent wallets
  const captain = await chain.keys.captain();
  console.log(`\nCaptain (orchestrator) key: ${captain.keyHash}\n  address ${captain.address}\n  ${explorerAddress(captain.address)}`);
  // 3b. Captain collateral for Session Vault (Plutus) txs: ONE ADA-only UTxO (only taken if a script fails on chain).
  const coll = await ensureCaptainCollateral(chain);
  if (coll.existing) console.log(`  ✓ vault collateral UTxO present: ${coll.existing.txHash}#${coll.existing.outputIndex} (${ada(coll.existing.lovelace)})`);
  else if (coll.funded) {
    console.log(`  funding the vault collateral UTxO (10 tADA, operator → captain): tx ${coll.funded.txHash}\n  ${explorerTx(coll.funded.txHash)}`);
    await waitConfirmed(chain, coll.funded.txHash);
  }
  console.log(`\nMock paid-agent wallets (derived from MASTER_SECRET, m/1852'/1815'/1000002'/0/i; market imports agentWallet(i)):`);
  for (let i = 0; i < 3; i++) {
    const a = await agentWallet(i);
    console.log(`  #${i} ${a.address}\n     ${explorerAddress(a.address)}`);
  }
  console.log(`\nSet TUSD_UNIT=${token.unit} in .env (CIP-68 333 unit; a legacy …74555344 value is upgraded automatically).`);
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(`setup:chain failed: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
