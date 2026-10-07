// pnpm recover --session <id> [--to addr_test1…] [--wait]
//
// Owner recovery after expiry (spec §3.2): spends ALL UTxOs of the session's native-script address
// through the `all[ sig(owner), after(expirySlot) ]` branch — signed by the user's treasury (owner)
// key, invalidBefore = expirySlot — and sends everything to the owner treasury, with metadata 674.
// Works while the engine is down. Fails clearly (no tx) before the expiry slot is reached.
// It does not change session state in the DB; the engine's reconcile step sees the empty wallet.
//
// walletMode "vault" (Bulkhead Session Vault): uses the validator's permissionless `Recover` redeemer —
// validity lower bound > expiry, every output to the owner address, NO signature needed (the captain wallet
// only provides collateral). Same metadata 674, status "RECOVERED_BY_OWNER".
import { createHash } from "node:crypto";
import { createChain, NotYetExpiredError, NothingToSweepError } from "@bulkhead/chain";
import { explorerAddress, explorerTx, microToTusd } from "@bulkhead/shared";
import { vaultRecoverOf } from "../src/vault";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const sessionId = arg("session");
  if (!sessionId) throw new Error("usage: pnpm recover --session <id> [--to addr_test1…] [--wait]");
  const chain = await createChain();
  const db = (await import("@bulkhead/db")).rawSqlite();
  const s = db
    .prepare(
      "SELECT s.id, s.user_id, s.status, s.address, s.expiry_slot, s.wallet_mode, s.script_hash, s.log_sha256, s.handback_sha256, u.treasury_address FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    )
    .get(sessionId) as
    | { id: string; user_id: string; status: string; address: string | null; expiry_slot: number | null; wallet_mode: string | null; script_hash: string | null; log_sha256: string | null; handback_sha256: string | null; treasury_address: string }
    | undefined;
  if (!s) throw new Error(`Session ${sessionId} not found in ${process.env.DATABASE_PATH ?? "the default DB"}`);
  if (!s.address || s.expiry_slot == null) throw new Error(`Session ${sessionId} has no wallet yet (status ${s.status}) — nothing to recover`);
  const vault = s.wallet_mode === "vault";
  const to = arg("to") ?? s.treasury_address;
  if (vault && to !== s.treasury_address) throw new Error("vault mode: Recover always pays the vault owner's address (--to is not allowed)");

  const tip = await chain.provider.fetchTip();
  const expiryAt = new Date(chain.timeFromSlot(s.expiry_slot));
  console.log(`Session ${s.id} (${s.status})\n  ${vault ? `Session Vault (script ${s.script_hash ?? "?"})` : "wallet"} ${s.address}\n  ${explorerAddress(s.address)}`);
  console.log(`  expiry slot ${s.expiry_slot} (${expiryAt.toISOString()}), chain tip slot ${tip.slot}`);
  // Native: after(expirySlot) → tip ≥ expirySlot. Vault: Recover needs lower bound > expiry → tip > expirySlot.
  if (vault ? tip.slot <= s.expiry_slot : tip.slot < s.expiry_slot) {
    const mins = Math.ceil((expiryAt.getTime() - Date.now()) / 60_000);
    console.error(`\n✗ Not expired yet: the ${vault ? "vault's Recover redeemer" : "owner branch of the session script"} only validates after slot ${s.expiry_slot} (~${mins} min, ${expiryAt.toISOString()}). Nothing submitted.`);
    process.exitCode = 2;
    return;
  }
  const bal = await chain.tx.balanceOf(s.address);
  console.log(`  holds ${(Number(bal.lovelace) / 1e6).toFixed(6)} ADA, ${microToTusd(bal.tusdMicro)} tUSD in ${bal.utxoCount} UTxO(s)`);

  // Log hash: the engine's stored value, else SHA-256 over this session's event rows (ordered by id).
  let logSha = s.log_sha256;
  if (!logSha) {
    const rows = db.prepare("SELECT id, at, type, data_json FROM events WHERE session_id = ? ORDER BY id").all(sessionId);
    logSha = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  try {
    const metadata674 = { session_id: s.id, log_sha256: logSha, handback_sha256: s.handback_sha256 ?? "none", status: "RECOVERED_BY_OWNER" };
    let r;
    if (vault) {
      const recover = vaultRecoverOf(chain);
      if (!recover) throw new Error("this @bulkhead/chain build has no tx.vaultRecover (Session Vault client missing)");
      r = await recover({ sessionId: s.id, metadata674 });
    } else r = await chain.tx.sweep({ sessionId: s.id, signer: "owner", toAddress: to, metadata674 });
    console.log(`\n✓ ${vault ? "Vault Recover (permissionless, after expiry)" : "Owner sweep"} submitted → ${to}\n  tx ${r.txHash} (fee ${(Number(r.feeLovelace) / 1e6).toFixed(6)} ADA)\n  ${explorerTx(r.txHash)}`);
    if (process.argv.includes("--wait")) {
      for (let i = 0; i < 24; i++) {
        const c = await chain.provider.fetchTxConfirmation(r.txHash).catch(() => null);
        if (c) {
          console.log(`  confirmed in block ${c.blockHeight} (slot ${c.slot})`);
          return;
        }
        await new Promise((res) => setTimeout(res, 10_000));
      }
      console.log("  not confirmed after 4 min — check the explorer link.");
    }
  } catch (e) {
    if (e instanceof NothingToSweepError || (e as { code?: string }).code === "NOTHING_TO_SWEEP") {
      console.log("\nNothing to recover: the session wallet is already empty.");
      return;
    }
    if (e instanceof NotYetExpiredError || (e as { name?: string }).name === "NotYetExpiredError") {
      console.error(`\n✗ ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

main()
  .catch((e) => {
    console.error(`recover failed: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
