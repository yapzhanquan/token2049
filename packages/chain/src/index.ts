// Public entry of @bulkhead/chain.
import type { Chain, ChainProvider, HandleResolver } from "./types";
import { createMainnetProvider, createProvider } from "./providers";
import { KeyVault, agentWalletFromSecret, operatorKeyFromMnemonic } from "./keys";
import { buildSessionScript, tusdPolicy, normalizeTusdUnit, TUSD_ASSET_NAME_HEX, TUSD_REF_ASSET_NAME_HEX, LEGACY_TUSD_ASSET_NAME_HEX } from "./script";
import { assetFingerprint } from "./cip68";
import { MeshTxService, addressKeyHashes } from "./tx";
import { TreasuryQueue } from "./queue";
import { PollingChainWatcher } from "./watcher";
import { FinalityProvider, confirmationsFromEnv } from "./finality";
import { handleResolverFromEnv } from "./handle";
import { sqliteStores, type ChainStores } from "./store";
import { SLOT_CONFIG_NETWORK, slotToBeginUnixTime, unixTimeToEnclosingSlot, ensureCryptoReady } from "./mesh";

export * from "./types";
export { createProvider, createMainnetProvider, BlockfrostProvider, KoiosProvider, NOWNodesProvider, BlockfrostCompatProvider, HttpError } from "./providers";
export {
  buildSessionScript,
  sessionNativeScript,
  tusdPolicy,
  normalizeTusdUnit,
  TUSD_ASSET_NAME,
  TUSD_ASSET_NAME_HEX,
  TUSD_CONTENT_HEX,
  TUSD_REF_ASSET_NAME_HEX,
  LEGACY_TUSD_ASSET_NAME_HEX,
  TUSD_METADATA,
} from "./script";
export * from "./cip68";
export { TreasuryQueue } from "./queue";
export { PollingChainWatcher } from "./watcher";
export { FinalityProvider, confirmationsFromEnv, confirmationDepth, rawProvider, DEFAULT_CONFIRMATIONS, type TxDepth } from "./finality";
export { createHandleResolver, handleResolverFromEnv, parseHandle, isHandlePayee, handleUnits, HandleError, HANDLE_POLICY_PREPROD, CIP68_USER_PREFIX, type HandleErrorCode, type HandleResolverOptions } from "./handle";
export * from "./staking";
export * from "./vault";
export { MeshTxService, NothingToMigrateError, withoutUnit, type TusdTokenInfo, NothingToSweepError, NotYetExpiredError, SessionExpiredError, cip20, chunkUtf8, parseTx, attachSignature, vkeyWitnesses, addressKeyHashes } from "./tx";
export {
  KeyVault,
  SESSION_ACCOUNT,
  CAPTAIN_ACCOUNT,
  AGENT_ACCOUNT,
  MAX_USER_ACCOUNT,
  pathString,
} from "./keys";
export { memoryStores, sqliteStores, type ChainStores, type KeyRepo, type KvStore, type SessionLookup, type SessionWalletInfo } from "./store";

export interface ChainEnv {
  MASTER_SECRET?: string;
  OPERATOR_MNEMONIC?: string;
  BLOCKFROST_PREPROD_PROJECT_ID?: string;
  KOIOS_API_TOKEN?: string;
  NOWNODES_API_KEY?: string;
  OGMIOS_URL?: string;
  TUSD_UNIT?: string;
  /** Blocks on top before a tx counts as confirmed (default 2). */
  CONFIRMATIONS?: string;
}

export interface ChainConfig {
  env?: ChainEnv;
  /** Override the preprod provider (tests). Default: createProvider(env). */
  provider?: ChainProvider;
  mainnetProvider?: ChainProvider | null;
  /** Default: the shared SQLite DB (`keys`, `kv`, `sessions` tables) via @bulkhead/db. */
  stores?: ChainStores;
  pollMs?: number;
  ttlSlots?: number;
  evaluateBeforeSubmit?: boolean;
  log?: (msg: string) => void;
  /** Override CONFIRMATIONS (default: env CONFIRMATIONS, else 2). */
  confirmations?: number;
  /** ADA Handle resolver (default: from env; null disables). */
  handles?: HandleResolver | null;
}

export interface BulkheadChain extends Chain {
  keys: KeyVault;
  tx: MeshTxService;
  watcher: PollingChainWatcher;
  queue: TreasuryQueue;
}

export const slotFromTime = (ms: number): number => unixTimeToEnclosingSlot(ms, SLOT_CONFIG_NETWORK.preprod);
export const timeFromSlot = (slot: number): number => slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK.preprod);

/**
 * Wire the chain layer. Async because key derivation needs libsodium ready and tx.tusdUnit()
 * (sync in the contract) needs the operator policy resolved up front (when OPERATOR_MNEMONIC is set).
 */
export async function createChain(config: ChainConfig = {}): Promise<BulkheadChain> {
  const env = config.env ?? (process.env as ChainEnv);
  await ensureCryptoReady();
  const baseProvider = config.provider ?? createProvider(env);
  if (baseProvider.network !== "preprod") throw new Error("createChain: the transacting provider must be preprod");
  // Finality: every fetchTxConfirmation through chain.provider requires CONFIRMATIONS blocks on top.
  const confirmations = config.confirmations ?? confirmationsFromEnv(env);
  const provider = new FinalityProvider(baseProvider, confirmations);
  const handles = config.handles === null ? undefined : (config.handles ?? handleResolverFromEnv(env));
  const mainnetProvider = config.mainnetProvider === null ? undefined : (config.mainnetProvider ?? createMainnetProvider(env));
  const stores = config.stores ?? sqliteStores((await import("@bulkhead/db")).rawSqlite());
  const keys = new KeyVault({ masterSecret: env.MASTER_SECRET ?? "", operatorMnemonic: env.OPERATOR_MNEMONIC, repo: stores.keys, kv: stores.kv });
  const queue = new TreasuryQueue();
  const tx = new MeshTxService({
    provider,
    keys,
    sessions: stores.sessions,
    queue,
    ttlSlots: config.ttlSlots,
    evaluateBeforeSubmit: config.evaluateBeforeSubmit,
  });
  if (env.OPERATOR_MNEMONIC?.trim()) await tx.tusdUnitAsync();
  const watcher = new PollingChainWatcher({ provider: baseProvider, kv: stores.kv, pollMs: config.pollMs, ogmiosUrl: env.OGMIOS_URL, log: config.log, confirmations });
  watcher.on((e) => {
    if (e.type === "tx_confirmed") queue.confirm(e.txHash);
  });
  return { provider, mainnetProvider, watcher, keys, tx, queue, buildSessionScript, slotFromTime, timeFromSlot, addressKeyHashes, confirmations, handles };
}

/**
 * tUSD unit = policyId (native script sig(operator payment key)) + CIP-68 (333) asset name 0014df10 + hex("tUSD").
 * Env-only (no provider): TUSD_UNIT if set, else derived from OPERATOR_MNEMONIC. A legacy TUSD_UNIT
 * (policyId + "74555344", pre-CIP-68) is upgraded to the 333 unit of the same policy.
 */
export async function tusdUnit(env: ChainEnv = process.env as ChainEnv): Promise<string> {
  if (env.TUSD_UNIT?.trim()) return normalizeTusdUnit(env.TUSD_UNIT);
  if (!env.OPERATOR_MNEMONIC?.trim()) throw new Error("tusdUnit: OPERATOR_MNEMONIC (or TUSD_UNIT) is not set");
  const op = await operatorKeyFromMnemonic(env.OPERATOR_MNEMONIC);
  return tusdPolicy(op.keyHash).policyId + TUSD_ASSET_NAME_HEX;
}

/** Mock paid-agent wallet i (0..2 for the market) — derived from MASTER_SECRET, account 1000002', index i. */
export async function agentWallet(i: number, env: ChainEnv = process.env as ChainEnv): Promise<{ address: string; keyHash: string; path: string }> {
  return agentWalletFromSecret(env.MASTER_SECRET ?? "", i);
}

/** Operator public info from env (address + key hash), for scripts. Never returns key material. */
export async function operatorInfo(env: ChainEnv = process.env as ChainEnv): Promise<{
  address: string;
  keyHash: string;
  policyId: string;
  /** CIP-68 (333) fungible tUSD unit. */
  tusdUnit: string;
  /** CIP-14 fingerprint of tusdUnit. */
  tusdFingerprint: string;
  /** CIP-68 (100) reference NFT unit (metadata datum; held at `address`). */
  tusdReferenceUnit: string;
  /** @deprecated pre-CIP-68 unit; only for reading / migrating old balances. */
  legacyTusdUnit: string;
}> {
  if (!env.OPERATOR_MNEMONIC?.trim()) throw new Error("OPERATOR_MNEMONIC is not set");
  const op = await operatorKeyFromMnemonic(env.OPERATOR_MNEMONIC);
  const { policyId } = tusdPolicy(op.keyHash);
  return {
    address: op.address!,
    keyHash: op.keyHash,
    policyId,
    tusdUnit: policyId + TUSD_ASSET_NAME_HEX,
    tusdFingerprint: assetFingerprint(policyId, TUSD_ASSET_NAME_HEX),
    tusdReferenceUnit: policyId + TUSD_REF_ASSET_NAME_HEX,
    legacyTusdUnit: policyId + LEGACY_TUSD_ASSET_NAME_HEX,
  };
}
