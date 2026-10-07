// The chain layer's public contract. The engine depends ONLY on these types, so it can
// be unit-tested with a fake implementation (see packages/engine/test/fake-chain.ts).

export interface Asset {
  unit: string; // "lovelace" or policyId+assetNameHex
  quantity: string;
}

export interface Utxo {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: Asset[];
}

export interface Tip {
  slot: number;
  time: number; // POSIX ms
  height: number;
}

export interface Balance {
  lovelace: bigint;
  tusdMicro: bigint;
  utxoCount: number;
  /** @deprecated pre-CIP-68 tUSD (policyId + "tUSD") still held; set only when > 0. Migrate with migrateLegacyTusd. */
  legacyTusdMicro?: bigint;
}

/** One interface, several implementations (spec §1): NOWNodes, Blockfrost, Koios. */
export interface ChainProvider {
  readonly name: "nownodes" | "blockfrost" | "koios";
  readonly network: "preprod" | "mainnet";
  fetchUtxos(address: string): Promise<Utxo[]>;
  fetchTip(): Promise<Tip>;
  /** Mesh-compatible protocol parameters (read live; never hardcode min-ADA). */
  fetchProtocolParameters(): Promise<unknown>;
  submitTx(cborHex: string): Promise<string>;
  /** Returns null while not yet on chain. Through createChain's FinalityProvider it also returns null until the tx
   * has CONFIRMATIONS blocks on top (depth = tip height − block height + 1) and then carries `confirmations`. */
  fetchTxConfirmation(txHash: string): Promise<{ blockHeight: number; slot: number; confirmations?: number } | null>;
  /** Script execution preview; native-script txs return [] (no redeemers). */
  evaluateTx?(cborHex: string): Promise<unknown[]>;
  /** Transaction metadata as { [label]: json } (e.g. { "674": { msg: [...] } }); null if the tx is unknown. */
  fetchTxMetadata?(txHash: string): Promise<Record<string, unknown> | null>;
  /** Live Plutus cost models [V1, V2, V3] (needed for the script integrity hash of Plutus txs). */
  fetchCostModels?(): Promise<number[][]>;
}

/**
 * Chain events. Finality (CONFIRMATIONS, default 2 via createChain): `tx_confirmed` and `deposit` are emitted only
 * once the tx has N blocks on top; `confirmations` is the depth seen at emission (deposit: present when N > 1).
 * `tx_pending` reports a watched tx that is in a block but not yet N deep; `tx_rolled_back` reports a watched tx
 * that vanished from the chain before reaching N (it stays watched, i.e. pending again).
 */
export type ChainEvent =
  | { type: "deposit"; address: string; txHash: string; amount: Asset[]; confirmations?: number }
  | { type: "spend"; address: string; txHash: string }
  | { type: "tx_confirmed"; txHash: string; slot: number; confirmations?: number }
  | { type: "tx_pending"; txHash: string; slot: number; blockHeight: number; confirmations: number; required: number }
  | { type: "tx_rolled_back"; txHash: string; blockHeight?: number }
  | { type: "expiry_reached"; sessionId: string; slot: number };

/** An ADA Handle ($name) resolved to its current holder (preprod only). */
export interface HandleResolution {
  /** Normalised "$name". */
  handle: string;
  address: string;
  /** POSIX ms of the lookup. */
  resolvedAt: number;
  /** policyId + asset name hex of the handle token that was found. */
  unit: string;
  standard: "cip68" | "cip25";
  source: "blockfrost" | "koios" | "handle-api";
  /** Optional cross-check against the public Handle API. */
  crossCheck?: "match" | "mismatch" | "unavailable";
}
export interface HandleResolver {
  /** Throws HandleError (code invalid | not_found | ambiguous | unavailable | wrong_network) with a user-facing message. */
  resolve(handle: string, opts?: { crossCheck?: boolean }): Promise<HandleResolution>;
}

/** Ogmios chain-sync (if available) or 10 s polling, behind one interface (spec §1). */
export interface ChainWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  watchAddress(address: string): void;
  unwatchAddress(address: string): void;
  watchTx(txHash: string): void;
  watchExpiry(sessionId: string, expirySlot: number): void;
  on(listener: (e: ChainEvent) => void): () => void;
}

/** Native session-wallet script (spec §3.2). */
export interface SessionScriptParams {
  sessionKeyHash: string;
  captainKeyHash: string;
  ownerKeyHash: string;
  expirySlot: number;
  /** Owner's stake credential hash; session address delegates to it when present. */
  ownerStakeKeyHash?: string | null;
}
export interface SessionScript {
  scriptJson: unknown; // Mesh NativeScript object
  scriptCbor: string;
  scriptHash: string;
  address: string;
}

export interface TxResult {
  txHash: string;
  feeLovelace: bigint;
  cborHex: string;
}

export interface FundingOutput {
  address: string;
  tusdMicro: bigint;
  /** Extra lovelace beyond min-ADA (e.g. session fee float). The builder adds min-ADA itself. */
  extraLovelace?: bigint;
}

/** Keys never leave this layer. Callers refer to keys by id only. */
export interface KeyStore {
  /** Custodial treasury for a user (BIP32 account = user's accountIndex). Creates + stores encrypted on first call. */
  treasury(userId: string, accountIndex: number): Promise<{ keyId: string; address: string; keyHash: string; stakeKeyHash: string }>;
  /** A fresh per-session key. */
  session(sessionId: string, keyIndex: number): Promise<{ keyId: string; keyHash: string }>;
  captain(): Promise<{ keyId: string; keyHash: string; address: string }>;
  operator(): Promise<{ keyId: string; keyHash: string; address: string }>;
}

/** An unsigned tx built for a self-custody (CIP-30) wallet; nothing is reserved until submitSigned. */
export interface UnsignedTx {
  unsignedTx: string;
  txHash: string;
  feeLovelace: bigint;
  /** Outputs' lovelace + fee. */
  totalLovelace: bigint;
  totalTusdMicro: bigint;
  /** TTL slot (invalidHereafter): after it the tx can never land. */
  ttlSlot?: number;
}

export interface TxService {
  /** One treasury tx with many outputs (spec §5.3). Goes through TreasuryQueue. */
  fundSessions(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult>;
  /** Preview only — nothing signed. Used for the "Approve & start" funding preview. */
  previewFunding(args: { userId: string; outputs: FundingOutput[] }): Promise<{ feeLovelace: bigint; totalLovelace: bigint; totalTusdMicro: bigint }>;
  /** Pay from a session wallet, signed by the session key (policy checks happen in the Signer before this). */
  sessionPay(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }): Promise<TxResult>;
  /** Spend ALL session UTxOs to the owner treasury; metadata 674 per spec §3.2. */
  sweep(args: {
    sessionId: string;
    signer: "captain" | "owner";
    toAddress: string;
    metadata674: { session_id: string; log_sha256: string; handback_sha256: string; status: string; goal_id?: string };
  }): Promise<TxResult>;
  /** Operator → user treasury (top-up). Mints tUSD if the operator lacks enough. */
  operatorSend(args: { toAddress: string; tusdMicro: bigint; lovelace: bigint; reference: string }): Promise<TxResult>;
  mintTusd(args: { tusdMicro: bigint; toAddress?: string }): Promise<TxResult>;
  balanceOf(address: string): Promise<Balance>;
  tusdUnit(): string;
  /** Self-custody: the same funding tx as fundSessions, built from `fromAddress`'s UTxOs and left UNSIGNED
   * for the browser wallet (CIP-30 signTx(tx, partialSign=true)). */
  buildUnsignedFunding?(args: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx>;
  /** Self-custody: attach the wallet's signature (a witness set, or a full signed tx with the same body),
   * verify it, then submit through TreasuryQueue (keyed by fromAddress). */
  submitSigned?(args: { fromAddress: string; unsignedTx: string; signed: string; requiredKeyHash?: string }): Promise<TxResult>;

  // ── Session Vault (walletMode "vault", docs/VAULT-SPEC.md) ──
  /** Treasury → vault(s): min-ADA + extraLovelace + tUSD per output, each with inline datum Void. */
  vaultFund?(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult>;
  /** Self-custody vault funding: the vaultFund tx (inline datum Void per vault output) built from a CIP-30
   * wallet address's UTxOs and left UNSIGNED; complete it with submitSigned (same as buildUnsignedFunding). */
  buildUnsignedVaultFunding?(args: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx>;
  /** Preview of vaultFund (nothing signed). */
  previewVaultFunding?(args: { userId: string; outputs: FundingOutput[] }): Promise<{ feeLovelace: bigint; totalLovelace: bigint; totalTusdMicro: bigint }>;
  /** Pay redeemer, signed by the session key. Script failure → Error name "VaultScriptError", code "SCRIPT_FAILED". */
  vaultPay?(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }): Promise<TxResult>;
  /** Revoke redeemer, signed by the captain: everything → owner, metadata 674. Empty vault → NothingToSweepError. */
  vaultRevoke?(args: {
    sessionId: string;
    toAddress: string;
    metadata674: { session_id: string; log_sha256: string; handback_sha256: string; status: string; goal_id?: string };
  }): Promise<TxResult>;
  /** Recover redeemer (permissionless after expiry; signerKeyId only provides collateral). Before expiry → NotYetExpiredError. */
  vaultRecover?(args: { sessionId: string; signerKeyId?: string; metadata674?: Record<string, string> }): Promise<TxResult>;
}

export interface Chain {
  provider: ChainProvider;
  /** Mainnet NOWNodes provider for dashboard-only reads, if configured. */
  mainnetProvider?: ChainProvider;
  watcher: ChainWatcher;
  keys: KeyStore;
  tx: TxService;
  buildSessionScript(p: SessionScriptParams): SessionScript;
  slotFromTime(ms: number): number;
  timeFromSlot(slot: number): number;
  /** Payment (+ stake) key hash of a key-based preprod address (self-custody owner key). */
  addressKeyHashes?(address: string): { paymentKeyHash: string; stakeKeyHash: string | null };
  /** CONFIRMATIONS: blocks on top required before a tx counts as confirmed (default 2). */
  confirmations?: number;
  /** ADA Handle ($name) → holder address (preprod). */
  handles?: HandleResolver;
}
