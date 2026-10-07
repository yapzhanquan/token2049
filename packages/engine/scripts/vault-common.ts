// Shared helpers for the Session Vault preprod scripts (vault-onchain.ts, demo-attack-onchain.ts):
// the chain lock, confirmation wait, a chain with an in-memory session lookup, the dedicated test owner
// treasury (custodial account 990002), test vault creation, and the deployments/preprod.json record.
// Never prints keys or mnemonics.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rawSqlite } from "@bulkhead/db";
import {
  agentWallet,
  applyVaultParams,
  createChain,
  ensureCaptainCollateral,
  sqliteStores,
  timeFromSlot,
  vaultParamsToJson,
  UNAPPLIED_VAULT_HASH,
  VAULT_AIKEN_VERSION,
  VAULT_BLUEPRINT,
  VAULT_SCRIPT_VERSION,
  type AppliedVault,
  type BulkheadChain,
  type SessionWalletInfo,
  type VaultParams,
} from "@bulkhead/chain";

export const VAULT_TEST_ACCOUNT = 990_002;
export const VAULT_TEST_USER = "vault-test-990002";
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCK_DIR = resolve(REPO_ROOT, ".chain-lock");
export const DEPLOYMENTS_JSON = resolve(REPO_ROOT, "deployments/preprod.json");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} tADA`;

export interface Step {
  name: string;
  ok: boolean;
  detail: string;
  txHash?: string;
}

export async function acquireLock(who: string, log: (s: string) => void, maxWaitMs = 40 * 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(resolve(LOCK_DIR, "owner"), `vault agent (${who}) pid ${process.pid} at ${new Date().toISOString()}\n`);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() - t0 > maxWaitMs) throw new Error(`chain lock ${LOCK_DIR} still held after ${Math.round(maxWaitMs / 60000)} min`);
      let age = "";
      try {
        age = ` (held ${Math.round((Date.now() - statSync(LOCK_DIR).mtimeMs) / 1000)} s)`;
      } catch {
        /* released meanwhile */
      }
      log(`chain lock busy${age}; retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

export function releaseLock(): void {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

export async function waitConfirmed(chain: BulkheadChain, txHash: string, log: (s: string) => void, timeoutMs = 360_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await chain.provider.fetchTxConfirmation(txHash).catch(() => null);
    if (c) return c;
    log(`  … waiting for ${txHash.slice(0, 12)}… (${Math.round((Date.now() - t0) / 1000)} s)`);
    await sleep(10_000);
  }
  return null;
}

/** Wait until the provider no longer lists the given UTxOs at `address` (so the next tx sees fresh state). */
export async function waitUtxoGone(chain: BulkheadChain, address: string, txHash: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const us = await chain.provider.fetchUtxos(address).catch(() => []);
    if (!us.some((u) => u.txHash === txHash)) return;
    await sleep(5_000);
  }
}

/** createChain with the real SQLite keys/kv but an in-memory session lookup for the test vaults. */
export async function vaultTestChain(env: NodeJS.ProcessEnv) {
  const sessions = new Map<string, SessionWalletInfo>();
  const db = sqliteStores(rawSqlite());
  const chain = await createChain({ env, stores: { keys: db.keys, kv: db.kv, sessions: (id) => sessions.get(id) ?? db.sessions(id) } });
  return { chain, sessions };
}

/** The dedicated test owner treasury (custodial, account 990002), topped up from the operator when low. */
export async function testTreasury(chain: BulkheadChain, log: (s: string) => void, need: { lovelace: bigint; tusdMicro: bigint }): Promise<{ address: string; keyHash: string; stakeKeyHash: string; fundTx?: string }> {
  const t = await chain.keys.treasury(VAULT_TEST_USER, VAULT_TEST_ACCOUNT);
  const bal = await chain.tx.balanceOf(t.address);
  if (bal.lovelace >= need.lovelace && bal.tusdMicro >= need.tusdMicro) return t;
  const lovelace = need.lovelace + 5_000_000n - (bal.lovelace < need.lovelace ? 0n : need.lovelace);
  const tusd = bal.tusdMicro >= need.tusdMicro ? 0n : need.tusdMicro - bal.tusdMicro + 10_000_000n;
  log(`funding test treasury ${t.address} from the operator: ${ada(lovelace)} + ${Number(tusd) / 1e6} tUSD`);
  const r = await chain.tx.operatorSend({ toAddress: t.address, tusdMicro: tusd, lovelace, reference: "Bulkhead vault test treasury funding" });
  const c = await waitConfirmed(chain, r.txHash, log);
  if (!c) throw new Error(`test treasury funding ${r.txHash} not confirmed in time`);
  return { ...t, fundTx: r.txHash };
}

/** Captain collateral (idempotent). */
export async function captainCollateral(chain: BulkheadChain, log: (s: string) => void): Promise<{ address: string; utxo: string; fundTx?: string }> {
  const c = await ensureCaptainCollateral(chain);
  if (c.existing) return { address: c.address, utxo: `${c.existing.txHash}#${c.existing.outputIndex}` };
  log(`funding the captain's collateral UTxO (10 tADA) from the operator: ${c.funded!.txHash}`);
  const ok = await waitConfirmed(chain, c.funded!.txHash, log);
  if (!ok) throw new Error("captain collateral funding not confirmed in time");
  return { address: c.address, utxo: `${c.funded!.txHash}#?`, fundTx: c.funded!.txHash };
}

/** A fresh session key + applied vault registered in the in-memory session lookup. */
export async function newTestVault(
  chain: BulkheadChain,
  sessions: Map<string, SessionWalletInfo>,
  owner: { address: string },
  opts: { tag: string; expiryMs: number; perTxMaxTusdMicro: bigint; adaAllowanceLovelace: bigint; payees?: string[] },
): Promise<{ sessionId: string; vault: AppliedVault; sessionKeyHash: string; params: VaultParams }> {
  const sessionId = `vault-test-${opts.tag}-${Date.now()}`;
  // Unique session key index per run (claims are recorded in kv; 5,000,000+ is outside the engine's range).
  const keyIndex = 5_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000) + Math.floor(Math.random() * 1000);
  const sk = await chain.keys.session(sessionId, keyIndex);
  const captain = await chain.keys.captain();
  const unit = await chain.tx.tusdUnitAsync();
  const params: VaultParams = {
    ownerAddress: owner.address,
    captainKeyHash: captain.keyHash,
    sessionKeyHash: sk.keyHash,
    expiryMs: opts.expiryMs,
    payees: opts.payees ?? [(await agentWallet(0)).address],
    perTxMaxTusdMicro: opts.perTxMaxTusdMicro,
    adaAllowanceLovelace: opts.adaAllowanceLovelace,
    tusdPolicyId: unit.slice(0, 56),
    tusdAssetNameHex: unit.slice(56),
  };
  const vault = applyVaultParams(params);
  sessions.set(sessionId, {
    sessionId,
    userId: VAULT_TEST_USER,
    address: vault.address,
    scriptCbor: vault.scriptCbor,
    expirySlot: chain.slotFromTime(opts.expiryMs),
    walletMode: "vault",
    scriptJson: JSON.stringify(vaultParamsToJson(params)),
    scriptHash: vault.scriptHash,
  });
  return { sessionId, vault, sessionKeyHash: sk.keyHash, params };
}

/** The demo "attacker" address: enterprise, payment key hash = sha256("bulkhead-demo-attacker")[0..28] (nobody holds the key). */
export const ATTACKER_ADDRESS = "addr_test1vq9mt2fmnradv0khu50s2ckwcw3ptjcfsspf5u9zkaealjgwdxprz";

/** Merge `patch` into deployments/preprod.json (static contract info is refreshed on every write). */
export function writeDeployment(patch: Record<string, unknown>): void {
  mkdirSync(resolve(REPO_ROOT, "deployments"), { recursive: true });
  let cur: Record<string, unknown> = {};
  if (existsSync(DEPLOYMENTS_JSON)) cur = JSON.parse(readFileSync(DEPLOYMENTS_JSON, "utf8"));
  const bp = VAULT_BLUEPRINT;
  const next = {
    ...cur,
    network: "preprod",
    explorer: "https://preprod.cardanoscan.io",
    contract: {
      name: "Bulkhead Session Vault",
      validator: bp.title,
      source: "contracts/validators/session_vault.ak",
      blueprint: "contracts/plutus.json",
      version: VAULT_SCRIPT_VERSION,
      aikenVersion: VAULT_AIKEN_VERSION,
      plutusVersion: bp.preamble.plutusVersion,
      stdlib: "aiken-lang/stdlib v3.0.0",
      unappliedHash: UNAPPLIED_VAULT_HASH,
      unappliedScriptSizeBytes: bp.compiledCode.length / 2,
      parameters: bp.parameters,
      redeemer: bp.redeemer,
      datum: bp.datum,
      definitions: bp.definitions,
    },
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(DEPLOYMENTS_JSON, JSON.stringify(next, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

export const nowPlus = (ms: number) => Date.now() + ms;
export { timeFromSlot };
