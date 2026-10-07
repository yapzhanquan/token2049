// Wallet identity: CIP-30 signData / CIP-8 COSE_Sign1 proofs (workstream A).
//
// The server issues a one-time nonce bound to { purpose, address, user?, decision? } and the exact
// message the wallet must sign. The browser signs it with CIP-30 signData (Mesh wallet.signData);
// the engine verifies the COSE_Sign1 with Mesh 1.9.1 `checkSignature(data, { key, signature }, address)`
// (it checks the signing key belongs to the address), additionally checks the COSE protected
// "address" header equals the claimed address (CIP-30 requires the wallet to set it), and burns the
// nonce. Nonces live in the `kv` table (key `wallet:nonce:<hex>`, JSON) with an expiry; they are
// single use (consumed before the signature is checked, so a failed attempt cannot be retried).
//
// Preprod only: mainnet addresses (addr1… / stake1…) are refused before anything is issued or checked.
//
// Mesh is loaded the same way packages/chain/src/mesh.ts does (CJS require from @meshsdk/core's
// location): `import "@meshsdk/core"` crashes in this workspace, and the engine has no direct Mesh dep.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { kv, type DB } from "@bulkhead/db";

// ── Mesh core-cst (runtime via require; minimal local types — the engine has no @meshsdk type dep) ──
interface CoseSign1Like {
  getAddress(): Buffer;
  getPayload(): Buffer | null;
}
interface MeshCstSubset {
  checkSignature(data: string, sig: { key: string; signature: string }, address?: string): Promise<boolean>;
  CoseSign1: { fromCbor(cbor: string): CoseSign1Like };
  getPublicKeyFromCoseKey(cbor: string): Buffer;
  Ed25519PublicKey: { fromBytes(b: Uint8Array): { hash(): { hex(): string } } };
  Address: { fromBech32(a: string): { toBytes(): string; getNetworkId(): number } };
  resolveRewardAddress(bech32: string): string;
}
let cstCache: MeshCstSubset | null = null;
/** @meshsdk/core-cst 1.9.1, resolved exactly like packages/chain/src/mesh.ts (one shared instance). */
export function meshCst(): MeshCstSubset {
  if (!cstCache) {
    const local = createRequire(import.meta.url);
    const chainReq = createRequire(local.resolve("@bulkhead/chain"));
    const meshReq = createRequire(chainReq.resolve("@meshsdk/core"));
    cstCache = meshReq("@meshsdk/core-cst") as MeshCstSubset;
  }
  return cstCache;
}

export type WalletProofPurpose = "login" | "link" | "decision";
export const WALLET_PROOF_PURPOSES: readonly WalletProofPurpose[] = ["login", "link", "decision"];
export const NONCE_TTL_MS = 5 * 60_000;
const NONCE_PREFIX = "wallet:nonce:";
const EVIDENCE_PREFIX = "wallet:evidence:";
const LINK_PREFIX = "wallet:link:";
const IDENTITY_PREFIX = "wallet:identity:";

export interface NonceRecord {
  nonce: string;
  purpose: WalletProofPurpose;
  address: string;
  userId: string | null;
  decisionId: string | null;
  /** The exact UTF-8 message the wallet signs. */
  payload: string;
  /** Decision approvals: the canonical fields inside the payload (re-checked at verify time). */
  fields?: DecisionPayloadFields;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
}

export interface WalletProof {
  nonce: string;
  /** COSE_Sign1, hex CBOR (CIP-30 DataSignature.signature). */
  signature: string;
  /** COSE_Key, hex CBOR (CIP-30 DataSignature.key). */
  key: string;
}

export interface VerifiedProof {
  purpose: WalletProofPurpose;
  address: string;
  /** blake2b-224 of the signing public key (= the payment key hash for a payment-address signature). */
  keyHash: string;
  identity: string;
  stakeAddress: string | null;
  nonce: string;
  payload: string;
  signature: string;
  key: string;
  verifiedAt: number;
}

/** Stored with a decision: the evidence that the user's wallet signed the approval. */
export interface DecisionEvidence {
  decisionId: string;
  userId: string;
  address: string;
  keyHash: string;
  payload: string;
  nonce: string;
  signature: string;
  key: string;
  signedAt: number;
}

export interface DecisionPayloadFields {
  decisionId: string;
  kind: string;
  sessionId: string;
  amount: string | null;
  payee: string | null;
  status: "approved";
}

export class WalletAuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Refuse anything that is not a key-hash preprod payment address (addr_test1…). */
export function assertPreprodPaymentAddress(address: unknown): string {
  const a = typeof address === "string" ? address.trim() : "";
  if (/^(addr1|stake1)/.test(a)) throw new WalletAuthError(400, "mainnet_refused", "Mainnet address refused: Bulkhead runs on Cardano preprod only. Switch your wallet to preprod.");
  if (!/^addr_test1[0-9a-z]{20,}$/.test(a)) throw new WalletAuthError(400, "bad_address", "A preprod payment address (addr_test1…) is required");
  let net: number;
  try {
    net = meshCst().Address.fromBech32(a).getNetworkId();
  } catch (e) {
    throw new WalletAuthError(400, "bad_address", `Not a valid Cardano address: ${(e as Error).message}`);
  }
  if (net !== 0) throw new WalletAuthError(400, "mainnet_refused", "Address is not a testnet address");
  return a;
}

/** `wallet:<stake_test1…>` for a base address, `wallet:<addr_test1…>` for an enterprise address. */
export function walletIdentity(address: string): { identity: string; stakeAddress: string | null } {
  let stakeAddress: string | null = null;
  try {
    const s = meshCst().resolveRewardAddress(address);
    stakeAddress = s.startsWith("stake_test1") ? s : null;
  } catch {
    stakeAddress = null;
  }
  return { identity: `wallet:${stakeAddress ?? address}`, stakeAddress };
}

/** JSON with sorted keys, no whitespace: the canonical form signed for decision approvals. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function loginMessage(o: { purpose: "login" | "link"; address: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  const title = o.purpose === "login" ? "Sign in to Bulkhead (Cardano preprod)" : "Link this wallet as my Bulkhead treasury (Cardano preprod, self-custody)";
  return [
    title,
    `Address: ${o.address}`,
    `Nonce: ${o.nonce}`,
    `Issued: ${new Date(o.issuedAt).toISOString()}`,
    `Expires: ${new Date(o.expiresAt).toISOString()}`,
    "This is a message signature (CIP-8). It is not a transaction and costs no fees.",
  ].join("\n");
}

export function decisionMessage(fields: DecisionPayloadFields, nonce: string, at: number): string {
  return ["Bulkhead (Cardano preprod): approve a decision", canonicalJson({ ...fields, nonce, at })].join("\n");
}

/** amount / payee as they appear in the signed payload, derived from the decision details. */
export function decisionFields(d: { id: string; kind: string; sessionId: string; details: Record<string, unknown> }): DecisionPayloadFields {
  const det = d.details ?? {};
  const amount = det.amountMicro ?? det.addMicro ?? null;
  const payee = det.payee ?? null;
  return {
    decisionId: d.id,
    kind: d.kind,
    sessionId: d.sessionId,
    amount: amount === null || amount === undefined ? null : String(amount),
    payee: payee === null || payee === undefined ? null : String(payee),
    status: "approved",
  };
}

export class WalletAuth {
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(private readonly deps: { db: DB; now?: () => number; ttlMs?: number }) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? NONCE_TTL_MS;
  }

  private kvGet<T>(key: string): T | null {
    const r = this.deps.db.select().from(kv).where(eq(kv.key, key)).get();
    if (!r) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }
  private kvSet(key: string, value: unknown) {
    const v = JSON.stringify(value);
    this.deps.db.insert(kv).values({ key, value: v }).onConflictDoUpdate({ target: kv.key, set: { value: v } }).run();
  }

  /** Delete expired / used nonces (cheap; called on every issue). */
  purge(): number {
    const rows = this.deps.db.select().from(kv).where(like(kv.key, `${NONCE_PREFIX}%`)).all();
    const t = this.now();
    let n = 0;
    for (const r of rows) {
      let rec: NonceRecord | null = null;
      try {
        rec = JSON.parse(r.value) as NonceRecord;
      } catch {
        rec = null;
      }
      if (!rec || rec.used || rec.expiresAt < t) {
        this.deps.db.delete(kv).where(eq(kv.key, r.key)).run();
        n++;
      }
    }
    return n;
  }

  /** Issue a one-time nonce + the message to sign. Login/link messages are built here; decisions pass their fields. */
  issue(o: { purpose: WalletProofPurpose; address: string; userId?: string | null; decision?: DecisionPayloadFields }): { nonce: string; payload: string; address: string; expiresAt: number } {
    const address = assertPreprodPaymentAddress(o.address);
    if (!WALLET_PROOF_PURPOSES.includes(o.purpose)) throw new WalletAuthError(400, "bad_purpose", "purpose must be login | link | decision");
    if (o.purpose !== "login" && !o.userId) throw new WalletAuthError(401, "user_required", "Sign in first");
    if (o.purpose === "decision" && !o.decision) throw new WalletAuthError(400, "decision_required", "decisionId required");
    this.purge();
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    const payload = o.purpose === "decision" ? decisionMessage(o.decision!, nonce, issuedAt) : loginMessage({ purpose: o.purpose, address, nonce, issuedAt, expiresAt });
    const rec: NonceRecord = {
      nonce,
      purpose: o.purpose,
      address,
      userId: o.userId ?? null,
      decisionId: o.decision?.decisionId ?? null,
      payload,
      ...(o.decision ? { fields: o.decision } : {}),
      issuedAt,
      expiresAt,
      used: false,
    };
    this.kvSet(NONCE_PREFIX + nonce, rec);
    return { nonce, payload, address, expiresAt };
  }

  /** Read a nonce record without consuming it (tests / diagnostics). */
  peek(nonce: string): NonceRecord | null {
    return /^[0-9a-f]{32}$/.test(nonce) ? this.kvGet<NonceRecord>(NONCE_PREFIX + nonce) : null;
  }

  /**
   * Consume the nonce (single use, even when the signature turns out invalid) and verify the
   * COSE_Sign1 over the stored message against `address`. Throws WalletAuthError on any failure.
   * `expect` lets the caller re-check the decision's current fields still match what was signed.
   */
  async verify(o: {
    purpose: WalletProofPurpose;
    address: string;
    proof: Partial<WalletProof> | null | undefined;
    userId?: string | null;
    decisionId?: string;
    expect?: DecisionPayloadFields;
  }): Promise<VerifiedProof> {
    const address = assertPreprodPaymentAddress(o.address);
    const p = o.proof ?? {};
    if (typeof p.nonce !== "string" || typeof p.signature !== "string" || typeof p.key !== "string" || !p.signature || !p.key) {
      throw new WalletAuthError(400, "proof_required", "A wallet signature is required: { nonce, signature, key } from CIP-30 signData");
    }
    if (!/^[0-9a-f]+$/i.test(p.signature) || !/^[0-9a-f]+$/i.test(p.key) || p.signature.length > 8_000 || p.key.length > 1_000) {
      throw new WalletAuthError(400, "bad_signature", "signature and key must be hex CBOR");
    }
    // Consume first (synchronous read-modify-write: no await in between → no double use).
    const rec = this.peek(p.nonce);
    if (!rec) throw new WalletAuthError(401, "unknown_nonce", "Unknown or expired sign-in request; start again");
    if (rec.used) throw new WalletAuthError(401, "nonce_used", "This signature request was already used; start again");
    this.kvSet(NONCE_PREFIX + rec.nonce, { ...rec, used: true });
    if (rec.expiresAt < this.now()) throw new WalletAuthError(401, "nonce_expired", "The signature request expired; start again");
    if (rec.purpose !== o.purpose) throw new WalletAuthError(401, "wrong_purpose", "This signature was requested for something else");
    if (rec.address !== address) throw new WalletAuthError(401, "wrong_address", "The signature request was issued for a different address");
    if ((rec.userId ?? null) !== (o.userId ?? null) && o.purpose !== "login") throw new WalletAuthError(401, "wrong_user", "The signature request belongs to a different user");
    if (o.purpose === "decision") {
      if (rec.decisionId !== o.decisionId) throw new WalletAuthError(401, "wrong_decision", "The signature is for a different decision");
      if (o.expect && canonicalJson(o.expect) !== canonicalJson(rec.fields ?? null)) {
        throw new WalletAuthError(409, "decision_changed", "The decision changed after it was signed; sign again");
      }
    }

    const cst = meshCst();
    let ok = false;
    try {
      ok = await cst.checkSignature(rec.payload, { key: p.key, signature: p.signature }, address);
    } catch {
      ok = false;
    }
    if (!ok) throw new WalletAuthError(401, "bad_signature", "Wallet signature does not verify for this address and message");
    // CIP-30: the protected "address" header must be the signing address.
    let headerAddr = "";
    try {
      headerAddr = cst.CoseSign1.fromCbor(p.signature).getAddress().toString("hex");
    } catch {
      headerAddr = "";
    }
    if (headerAddr.toLowerCase() !== cst.Address.fromBech32(address).toBytes().toLowerCase()) {
      throw new WalletAuthError(401, "bad_signature", "COSE address header does not match the claimed address");
    }
    const keyHash = cst.Ed25519PublicKey.fromBytes(cst.getPublicKeyFromCoseKey(p.key)).hash().hex();
    const { identity, stakeAddress } = walletIdentity(address);
    return { purpose: o.purpose, address, keyHash, identity, stakeAddress, nonce: rec.nonce, payload: rec.payload, signature: p.signature, key: p.key, verifiedAt: this.now() };
  }

  // ── evidence + links ──
  storeEvidence(ev: DecisionEvidence) {
    this.kvSet(EVIDENCE_PREFIX + ev.decisionId, ev);
  }
  evidence(decisionId: string): DecisionEvidence | null {
    return this.kvGet<DecisionEvidence>(EVIDENCE_PREFIX + decisionId);
  }
  /** Record that `userId` proved control of `address` (wallet login, link, or a signed approval). */
  markLinked(userId: string, address: string, keyHash: string) {
    this.kvSet(LINK_PREFIX + userId, { address, keyHash, at: this.now() });
  }
  linked(userId: string): { address: string; keyHash: string; at: number } | null {
    return this.kvGet(LINK_PREFIX + userId);
  }
  setIdentity(identity: string, userId: string) {
    this.kvSet(IDENTITY_PREFIX + identity, { userId, at: this.now() });
  }
  identityUser(identity: string): string | null {
    return this.kvGet<{ userId: string }>(IDENTITY_PREFIX + identity)?.userId ?? null;
  }
}

/** The engine user email used for a wallet identity (users.email is the upsert key everywhere). */
export function walletEmail(identity: string): string {
  return `${identity.replace(/^wallet:/, "")}@wallet.bulkhead.local`;
}
