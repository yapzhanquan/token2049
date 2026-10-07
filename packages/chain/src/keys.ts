// Key derivation, encryption at rest, and signing.
//
// ─── Derivation (exact) ───────────────────────────────────────────────────────────────────
// MASTER_ROOT = Icarus/CIP-3 BIP32-Ed25519 root from entropy = the 32 raw bytes of MASTER_SECRET:
//     xprv = clamp(PBKDF2-HMAC-SHA512(password = "", salt = MASTER_SECRET bytes, 4096 iters, 96 bytes))
//   (Mesh core-cst `buildBip32PrivateKey(MASTER_SECRET_hex)`). This is the same root a CIP-1852 wallet
//   restores from the 24-word BIP39 mnemonic whose entropy is MASTER_SECRET.
// CIP-1852 paths  m / 1852' / 1815' / account' / role / index   (role 0 = payment, 2 = stake):
//   treasury(user)   payment m/1852'/1815'/<accountIndex>'/0/0   stake m/1852'/1815'/<accountIndex>'/2/0
//                    (accountIndex = users.account_index, must be in [0, 999 999])
//   session key      m/1852'/1815'/1000000'/0/<keyIndex>          (key only; the session address is a script)
//   captain          payment m/1852'/1815'/1000001'/0/0           stake m/1852'/1815'/1000001'/2/0
//   mock agents      payment m/1852'/1815'/1000002'/0/<i>         stake m/1852'/1815'/1000002'/2/0
// OPERATOR = standard Shelley wallet from OPERATOR_MNEMONIC (Icarus root, password ""),
//   payment m/1852'/1815'/0'/0/0, stake m/1852'/1815'/0'/2/0 — the same base address any CIP-1852
//   wallet (Eternl/Lace, Mesh MeshWallet) shows for that mnemonic, so it can be funded from the faucet.
//
// ─── Encryption at rest ───────────────────────────────────────────────────────────────────
// KEK = HKDF-SHA256(ikm = MASTER_SECRET bytes, salt = "" (empty), info = "bulkhead-keys", 32 bytes).
// Each `keys` row stores the 64-byte extended Ed25519 payment private key (kL||kR) as
//   ciphertext = base64( iv[12] | tag[16] | AES-256-GCM(KEK, iv, plaintext, AAD = row id) ).
// Plaintext keys are only materialised inside KeyVault.sign*(), called by TxService.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { KeyStore } from "./types";
import type { KeyRepo, KvStore } from "./store";
import { cst, EmbeddedWallet, ensureCryptoReady } from "./mesh";
import type * as MeshCst from "@meshsdk/core-cst";

type Ed25519PrivateKey = MeshCst.Ed25519PrivateKey;
type Bip32PrivateKey = MeshCst.Bip32PrivateKey;

export const HARDENED = 0x80000000;
export const PURPOSE = 1852;
export const COIN_TYPE = 1815;
export const MAX_USER_ACCOUNT = 999_999;
export const SESSION_ACCOUNT = 1_000_000;
export const CAPTAIN_ACCOUNT = 1_000_001;
export const AGENT_ACCOUNT = 1_000_002;
export const NETWORK_ID = 0; // preprod / testnet addresses only

export function pathString(account: number, role: number, index: number): string {
  return `m/${PURPOSE}'/${COIN_TYPE}'/${account}'/${role}/${index}`;
}

export function parsePath(path: string): { account: number; role: number; index: number } {
  const m = /^m\/1852'\/1815'\/(\d+)'\/(\d+)\/(\d+)$/.exec(path);
  if (!m) throw new Error(`Unsupported derivation path: ${path}`);
  return { account: Number(m[1]), role: Number(m[2]), index: Number(m[3]) };
}

export function parseMasterSecret(hex: string | undefined): Buffer {
  const h = (hex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("MASTER_SECRET must be 32 bytes of hex (64 hex chars). Run `pnpm tsx scripts/gen-env.ts`.");
  return Buffer.from(h, "hex");
}

export function deriveKek(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from("bulkhead-keys"), 32));
}

export function encryptKey(kek: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptKey(kek: Buffer, ciphertext: string, aad: string): Buffer {
  const raw = Buffer.from(ciphertext, "base64");
  const d = createDecipheriv("aes-256-gcm", kek, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export interface DerivedKey {
  path: string;
  paymentKey: Ed25519PrivateKey;
  keyHash: string;
  stakeKeyHash?: string;
  address?: string; // base address (payment + stake), preprod
}

export function baseAddress(paymentKeyHash: string, stakeKeyHash: string): string {
  return cst.serializeAddress({ pubKeyHash: paymentKeyHash, stakeCredentialHash: stakeKeyHash }, NETWORK_ID);
}

export function enterpriseAddress(paymentKeyHash: string): string {
  return cst.serializeAddress({ pubKeyHash: paymentKeyHash }, NETWORK_ID);
}

function keyHashOf(k: Ed25519PrivateKey): string {
  return k.toPublic().hash().hex();
}

/** Root from MASTER_SECRET (sync, no libsodium needed). */
export function masterRoot(master: Buffer): Bip32PrivateKey {
  return cst.buildBip32PrivateKey(master.toString("hex"));
}

/** Root from a BIP39 mnemonic (CIP-3 Icarus, empty password). */
export function mnemonicRoot(mnemonic: string): Bip32PrivateKey {
  const words = mnemonic.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error("OPERATOR_MNEMONIC must be 12–24 words");
  return cst.Bip32PrivateKey.fromHex(cst.Bip32PrivateKeyHex(EmbeddedWallet.mnemonicToPrivateKeyHex(words)));
}

/** Derive payment (+ optional stake) keys. Call `await ensureCryptoReady()` first. */
export function deriveFromRoot(root: Bip32PrivateKey, account: number, index: number, withStake: boolean): DerivedKey {
  if (!Number.isInteger(account) || account < 0 || account >= HARDENED) throw new Error(`bad account ${account}`);
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`bad key index ${index}`);
  const acct = root.derive([HARDENED + PURPOSE, HARDENED + COIN_TYPE, HARDENED + account]);
  const paymentKey = acct.derive([0, index]).toRawKey();
  const keyHash = keyHashOf(paymentKey);
  const out: DerivedKey = { path: pathString(account, 0, index), paymentKey, keyHash };
  if (withStake) {
    out.stakeKeyHash = keyHashOf(acct.derive([2, 0]).toRawKey());
    out.address = baseAddress(keyHash, out.stakeKeyHash);
  }
  return out;
}

/** Ed25519 vkey witness over the tx body hash, merged into the tx's witness set. */
export function signTxWith(txHex: string, key: Ed25519PrivateKey): string {
  const txHash = cst.resolveTxHash(txHex);
  const sig = key.sign(cst.HexBlob(txHash));
  const witness = new cst.VkeyWitness(cst.Ed25519PublicKeyHex(key.toPublic().hex()), cst.Ed25519SignatureHex(sig.hex()));
  return EmbeddedWallet.addWitnessSets(txHex, [witness]);
}

// ─── Mock agent wallets (market) and tUSD policy (env-only helpers) ──────────────────────

/** Mock paid-agent wallet i (0..2), derived from MASTER_SECRET. Address only — nothing secret leaves. */
export async function agentWalletFromSecret(masterHex: string, i: number): Promise<{ address: string; keyHash: string; path: string }> {
  if (!Number.isInteger(i) || i < 0 || i > 99) throw new Error(`agentWallet index out of range: ${i}`);
  await ensureCryptoReady();
  const d = deriveFromRoot(masterRoot(parseMasterSecret(masterHex)), AGENT_ACCOUNT, i, true);
  return { address: d.address!, keyHash: d.keyHash, path: d.path };
}

export async function operatorKeyFromMnemonic(mnemonic: string): Promise<DerivedKey> {
  await ensureCryptoReady();
  return deriveFromRoot(mnemonicRoot(mnemonic), 0, 0, true);
}

// ─── KeyVault: KeyStore implementation + signing (internal to the chain package) ───────────

export interface KeyVaultOptions {
  masterSecret: string;
  operatorMnemonic?: string;
  repo: KeyRepo;
  kv: KvStore;
  now?: () => number;
}

export class KeyVault implements KeyStore {
  private readonly master: Buffer;
  private readonly kek: Buffer;
  private readonly root: Bip32PrivateKey;
  private readonly operatorMnemonic?: string;
  private readonly repo: KeyRepo;
  private readonly kv: KvStore;
  private readonly now: () => number;
  /** Public info cache (no private material). */
  private readonly info = new Map<string, { keyHash: string; address?: string; stakeKeyHash?: string }>();

  constructor(opts: KeyVaultOptions) {
    this.master = parseMasterSecret(opts.masterSecret);
    this.kek = deriveKek(this.master);
    this.root = masterRoot(this.master);
    this.operatorMnemonic = opts.operatorMnemonic?.trim() || undefined;
    this.repo = opts.repo;
    this.kv = opts.kv;
    this.now = opts.now ?? Date.now;
  }

  private store(id: string, purpose: string, d: DerivedKey): void {
    const existing = this.repo.get(id);
    if (existing) {
      if (existing.path !== d.path || existing.keyHash !== d.keyHash)
        throw new Error(`Key ${id} already stored with a different path/key (${existing.path} vs ${d.path})`);
      return;
    }
    const plaintext = Buffer.from(d.paymentKey.hex(), "hex");
    try {
      this.repo.insert({ id, purpose, path: d.path, keyHash: d.keyHash, ciphertext: encryptKey(this.kek, plaintext, id), createdAt: this.now() });
    } finally {
      plaintext.fill(0);
    }
  }

  private claim(kvKey: string, owner: string): void {
    const cur = this.kv.get(kvKey);
    if (cur && cur !== owner) throw new Error(`${kvKey} is already used by ${cur}`);
    if (!cur) this.kv.set(kvKey, owner);
  }

  async treasury(userId: string, accountIndex: number) {
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_USER_ACCOUNT)
      throw new Error(`treasury accountIndex must be an integer in [0, ${MAX_USER_ACCOUNT}]`);
    const keyId = `treasury:${userId}`;
    await ensureCryptoReady();
    const existing = this.repo.get(keyId);
    if (existing && parsePath(existing.path).account !== accountIndex)
      throw new Error(`${keyId} already derived at ${existing.path}, not account ${accountIndex}`);
    this.claim(`keys:treasury-account:${accountIndex}`, userId);
    const d = deriveFromRoot(this.root, accountIndex, 0, true);
    this.store(keyId, "treasury", d);
    this.info.set(keyId, { keyHash: d.keyHash, address: d.address, stakeKeyHash: d.stakeKeyHash });
    return { keyId, address: d.address!, keyHash: d.keyHash, stakeKeyHash: d.stakeKeyHash! };
  }

  async session(sessionId: string, keyIndex: number) {
    const keyId = `session:${sessionId}`;
    await ensureCryptoReady();
    const existing = this.repo.get(keyId);
    if (existing && parsePath(existing.path).index !== keyIndex) throw new Error(`${keyId} already derived at ${existing.path}`);
    this.claim(`keys:session-index:${keyIndex}`, sessionId);
    const d = deriveFromRoot(this.root, SESSION_ACCOUNT, keyIndex, false);
    this.store(keyId, "session", d);
    this.info.set(keyId, { keyHash: d.keyHash });
    return { keyId, keyHash: d.keyHash };
  }

  async captain() {
    const keyId = "captain";
    await ensureCryptoReady();
    const d = deriveFromRoot(this.root, CAPTAIN_ACCOUNT, 0, true);
    this.store(keyId, "captain", d);
    this.info.set(keyId, { keyHash: d.keyHash, address: d.address, stakeKeyHash: d.stakeKeyHash });
    return { keyId, keyHash: d.keyHash, address: d.address! };
  }

  async operator() {
    const keyId = "operator";
    if (!this.operatorMnemonic) throw new Error("OPERATOR_MNEMONIC is not set. Run `pnpm tsx scripts/gen-env.ts` and fund the operator address.");
    const cached = this.info.get(keyId);
    if (cached?.address) return { keyId, keyHash: cached.keyHash, address: cached.address };
    const d = await operatorKeyFromMnemonic(this.operatorMnemonic);
    this.store(keyId, "operator", d);
    this.info.set(keyId, { keyHash: d.keyHash, address: d.address, stakeKeyHash: d.stakeKeyHash });
    return { keyId, keyHash: d.keyHash, address: d.address! };
  }

  /** Public info for a stored key: key hash, and for treasury/captain/operator the base address. */
  async publicInfo(keyId: string): Promise<{ keyHash: string; address?: string; stakeKeyHash?: string }> {
    const c = this.info.get(keyId);
    if (c) return c;
    const row = this.repo.get(keyId);
    if (!row) throw new Error(`Unknown key ${keyId}`);
    if (keyId === "operator") return this.operator();
    await ensureCryptoReady();
    const p = parsePath(row.path);
    const withStake = row.purpose !== "session";
    const d = deriveFromRoot(this.root, p.account, p.index, withStake);
    if (d.keyHash !== row.keyHash) throw new Error(`Key ${keyId}: derived hash does not match stored hash (MASTER_SECRET changed?)`);
    const info = { keyHash: d.keyHash, address: d.address, stakeKeyHash: d.stakeKeyHash };
    this.info.set(keyId, info);
    return info;
  }

  /**
   * Add a witness from the STAKE key (m/1852'/1815'/<acct>'/2/0) of a stored treasury/captain key — needed
   * by stake certificates (delegation, vote delegation, deregistration) and reward withdrawals. The stake key
   * is not stored; it is re-derived from MASTER_SECRET at the stored row's account and never leaves here.
   */
  async signTxWithStakeKey(keyId: string, txHex: string): Promise<string> {
    await ensureCryptoReady();
    const row = this.repo.get(keyId);
    if (!row) throw new Error(`Unknown key ${keyId}`);
    if (row.purpose !== "treasury" && row.purpose !== "captain") throw new Error(`Key ${keyId} has no stake key (purpose ${row.purpose})`);
    const p = parsePath(row.path);
    const acct = this.root.derive([HARDENED + PURPOSE, HARDENED + COIN_TYPE, HARDENED + p.account]);
    if (keyHashOf(acct.derive([0, p.index]).toRawKey()) !== row.keyHash) throw new Error(`Key ${keyId}: derived key does not match stored key hash (MASTER_SECRET changed?)`);
    return signTxWith(txHex, acct.derive([2, 0]).toRawKey());
  }

  /** Sign a tx with a stored key. The only place private key material is decrypted. */
  async signTx(keyId: string, txHex: string): Promise<string> {
    await ensureCryptoReady();
    const row = this.repo.get(keyId);
    if (!row) throw new Error(`Unknown key ${keyId}`);
    const plain = decryptKey(this.kek, row.ciphertext, keyId);
    try {
      const key = cst.Ed25519PrivateKey.fromExtendedBytes(new Uint8Array(plain));
      if (key.toPublic().hash().hex() !== row.keyHash) throw new Error(`Key ${keyId}: decrypted key does not match stored key hash`);
      return signTxWith(txHex, key);
    } finally {
      plain.fill(0);
    }
  }
}
