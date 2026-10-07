// Wallet identity routes (workstream A) — CIP-30 signData / CIP-8 COSE_Sign1 proofs, verified here.
//
// Mounted by createApi BEFORE its auth middleware (the sign-in routes have no user yet), so every
// route here checks ENGINE_TOKEN itself; routes that need a user read x-user-id themselves.
//
//   POST /wallet/nonce  {purpose:"login", address}            → { nonce, payload, address, expiresAt }
//                       {purpose:"link", address}  (x-user-id)
//                       {purpose:"decision", decisionId} (x-user-id; signs with the user's treasury address)
//   POST /wallet/login  {address, nonce, signature, key}      → WalletLoginResponse (upserts the engine user,
//                       identity wallet:<stake_test1…|addr_test1…>, custody "self", treasury = the address)
//   POST /wallet/link   {address, nonce, signature, key} (x-user-id) → CreateUserResponse (custody → self)
//   GET  /wallet/evidence (x-user-id)                          → Record<decisionId, DecisionEvidenceDTO>
//
// Approval gate (runs before the existing handlers, then hands over with next()):
//   POST /decisions/:id {status:"approved", walletProof:{nonce,signature,key}}
//   POST /payments/:id/approve {walletProof}
// For a self-custody user whose wallet control was proven (wallet login, signed link, or an earlier signed
// approval) an approval REQUIRES a valid signData proof over the canonical payload
// {decisionId, kind, sessionId, amount, payee, status, nonce, at}; the evidence is stored in kv
// (`wallet:evidence:<decisionId>`). A walletProof sent by any self-custody user is verified and stored.
// The self-custody tx-signing continuation ({pendingId, signedTx}) passes when the evidence exists.
// Custodial users are untouched (click-to-approve).
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { eq, max } from "drizzle-orm";
import { sessions as sessionsT, users, type DB } from "@bulkhead/db";
import { addressKeyHashes, type Chain } from "@bulkhead/chain";
import type { CreateUserResponse, Decision } from "@bulkhead/shared";
import type { DecisionLedger } from "./contracts";
import { toJsonSafe } from "./captain/tools";
import { WalletAuth, WalletAuthError, decisionFields, walletEmail, type DecisionEvidence, type WalletProof } from "./wallet-auth";

export interface WalletApiDeps {
  db: DB;
  chain: Chain;
  decisions: Pick<DecisionLedger, "list">;
  /** ENGINE_TOKEN (same as createApi). */
  token?: string;
  /** Inject (tests). */
  auth?: WalletAuth;
}

export interface WalletLoginResponse {
  userId: string;
  identity: string;
  email: string;
  name: string;
  custody: "custodial" | "self";
  treasuryAddress: string;
  created: boolean;
  keyHash: string;
}

export type DecisionEvidenceDTO = Pick<DecisionEvidence, "decisionId" | "address" | "keyHash" | "payload" | "signature" | "key" | "signedAt">;

const httpError = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const asHttp = (e: unknown) => (e instanceof WalletAuthError ? httpError(e.status, e.message, e.code) : e);

export function createWalletRoutes(deps: WalletApiDeps) {
  const { db, chain, decisions } = deps;
  const auth = deps.auth ?? new WalletAuth({ db });
  const app = new Hono();
  const json = (c: Context, v: unknown, status = 200) => c.json(toJsonSafe(v) as object, status as 200);

  const tokenOk = (c: Context) => {
    if (!deps.token) return true;
    const got = Buffer.from(c.req.header("x-engine-token") ?? "");
    const want = Buffer.from(deps.token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const requireToken = (c: Context) => {
    if (!tokenOk(c)) throw httpError(401, "unauthorized");
  };
  const userById = (id: string | undefined | null) => (id ? db.select().from(users).where(eq(users.id, id)).get() : undefined);
  const requireUser = (c: Context) => {
    const u = userById(c.req.header("x-user-id"));
    if (!u) throw httpError(401, "x-user-id required");
    return u;
  };
  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const keyHashesOf = (address: string) => {
    try {
      return (chain.addressKeyHashes ?? addressKeyHashes)(address);
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
  };
  const watch = (address: string) => {
    try {
      chain.watcher.watchAddress(address);
    } catch {
      /* watcher optional */
    }
  };
  const proofOf = (b: Record<string, unknown>): Partial<WalletProof> => ({ nonce: b.nonce as string, signature: b.signature as string, key: b.key as string });
  const ownsSession = (userId: string, sessionId: string) => db.select({ u: sessionsT.userId }).from(sessionsT).where(eq(sessionsT.id, sessionId)).get()?.u === userId;
  const findDecision = (id: string): Decision | undefined => decisions.list({}).find((d) => d.id === id);

  // ── nonce ──
  app.post("/wallet/nonce", async (c) => {
    requireToken(c);
    const b = await readBody(c);
    const purpose = b.purpose;
    try {
      if (purpose === "login") return json(c, auth.issue({ purpose, address: String(b.address ?? "") }));
      const u = requireUser(c);
      if (purpose === "link") return json(c, auth.issue({ purpose, address: String(b.address ?? ""), userId: u.id }));
      if (purpose === "decision") {
        if (u.custody !== "self") throw httpError(400, "Only self-custody approvals are signed with the wallet");
        const d = findDecision(String(b.decisionId ?? ""));
        if (!d || !ownsSession(u.id, d.sessionId)) throw httpError(404, "decision not found");
        if (d.status !== "open") throw httpError(409, `decision is ${d.status}`);
        return json(c, auth.issue({ purpose, address: u.treasuryAddress, userId: u.id, decision: decisionFields(d) }));
      }
      throw httpError(400, "purpose must be login | link | decision");
    } catch (e) {
      throw asHttp(e);
    }
  });

  // ── sign in with a wallet ──
  app.post("/wallet/login", async (c) => {
    requireToken(c);
    const b = await readBody(c);
    let v;
    try {
      v = await auth.verify({ purpose: "login", address: String(b.address ?? ""), proof: proofOf(b) });
    } catch (e) {
      throw asHttp(e);
    }
    const email = walletEmail(v.identity);
    const shortId = (v.stakeAddress ?? v.address).slice(-8);
    const name = `Wallet …${shortId}`;
    let u = db.select().from(users).where(eq(users.email, email)).get();
    let created = false;
    if (!u) {
      const id = `u_${randomUUID()}`;
      const accountIndex = (db.select({ m: max(users.accountIndex) }).from(users).get()?.m ?? -1) + 1;
      const h = keyHashesOf(v.address);
      db.insert(users)
        .values({ id, email, name, custody: "self", accountIndex, treasuryAddress: v.address, ownerKeyHash: h.paymentKeyHash, stakeKeyHash: h.stakeKeyHash, createdAt: Date.now() })
        .run();
      watch(v.address);
      u = db.select().from(users).where(eq(users.id, id)).get()!;
      created = true;
    }
    auth.setIdentity(v.identity, u.id);
    if (u.custody === "self" && u.treasuryAddress === v.address) auth.markLinked(u.id, v.address, v.keyHash);
    const out: WalletLoginResponse = { userId: u.id, identity: v.identity, email, name: u.name ?? name, custody: u.custody, treasuryAddress: u.treasuryAddress, created, keyHash: v.keyHash };
    return json(c, out, created ? 201 : 200);
  });

  // ── link a wallet as the self-custody treasury (requires the same proof) ──
  app.post("/wallet/link", async (c) => {
    requireToken(c);
    const u = requireUser(c);
    const b = await readBody(c);
    let v;
    try {
      v = await auth.verify({ purpose: "link", address: String(b.address ?? ""), proof: proofOf(b), userId: u.id });
    } catch (e) {
      throw asHttp(e);
    }
    const h = keyHashesOf(v.address);
    db.update(users).set({ custody: "self", treasuryAddress: v.address, ownerKeyHash: h.paymentKeyHash, stakeKeyHash: h.stakeKeyHash }).where(eq(users.id, u.id)).run();
    if (u.treasuryAddress !== v.address) watch(v.address);
    auth.markLinked(u.id, v.address, v.keyHash);
    const out: CreateUserResponse = { userId: u.id, custody: "self", treasuryAddress: v.address, created: false };
    return json(c, { ...out, keyHash: v.keyHash });
  });

  // ── evidence for the Decisions list ──
  app.get("/wallet/evidence", (c) => {
    requireToken(c);
    const u = requireUser(c);
    const sids = new Set(db.select({ id: sessionsT.id }).from(sessionsT).where(eq(sessionsT.userId, u.id)).all().map((s) => s.id));
    const out: Record<string, DecisionEvidenceDTO> = {};
    for (const d of decisions.list({})) {
      if (!sids.has(d.sessionId)) continue;
      const ev = auth.evidence(d.id);
      if (ev && ev.userId === u.id) out[d.id] = { decisionId: ev.decisionId, address: ev.address, keyHash: ev.keyHash, payload: ev.payload, signature: ev.signature, key: ev.key, signedAt: ev.signedAt };
    }
    return json(c, out);
  });

  // ── approval gate (then the existing handlers run via next()) ──
  const gate = async (c: Context, next: Next, decisionOf: (body: Record<string, unknown>) => Decision | undefined | "skip") => {
    if (!tokenOk(c)) return next(); // the main auth middleware answers 401
    const u = userById(c.req.header("x-user-id"));
    if (!u || u.custody !== "self") return next(); // unknown → main auth; custodial → unchanged
    const b = await readBody(c); // Hono caches the body: the main handler can read it again
    const d = decisionOf(b);
    if (d === "skip" || !d || !ownsSession(u.id, d.sessionId)) return next();
    const link = auth.linked(u.id);
    const enforced = !!link && link.address === u.treasuryAddress;
    const continuation = typeof b.pendingId === "string" && typeof b.signedTx === "string";
    if (continuation) {
      // Second leg of a self-custody approval (the funding tx was signed): the message proof came first.
      if (enforced && d.status === "open" && !auth.evidence(d.id)) throw httpError(403, "Sign the approval with your wallet first", "wallet_signature_required");
      return next();
    }
    if (d.status !== "open") return next(); // already answered: the handler is idempotent
    const proof = b.walletProof as Partial<WalletProof> | undefined;
    if (!proof) {
      if (enforced) throw httpError(403, "Self-custody approval: sign it with your wallet (CIP-30 signData)", "wallet_signature_required");
      return next();
    }
    let v;
    try {
      v = await auth.verify({ purpose: "decision", address: u.treasuryAddress, proof, userId: u.id, decisionId: d.id, expect: decisionFields(d) });
    } catch (e) {
      throw asHttp(e);
    }
    auth.storeEvidence({ decisionId: d.id, userId: u.id, address: v.address, keyHash: v.keyHash, payload: v.payload, nonce: v.nonce, signature: v.signature, key: v.key, signedAt: v.verifiedAt });
    auth.markLinked(u.id, v.address, v.keyHash);
    return next();
  };

  app.post("/decisions/:id", (c, next) =>
    gate(c, next, (b) => {
      // Rejections stay click-only; approvals (and their tx continuation) are gated.
      if (b.status !== "approved" && typeof b.pendingId !== "string") return "skip";
      return findDecision(c.req.param("id"));
    }),
  );
  app.post("/payments/:id/approve", (c, next) =>
    gate(c, next, () => {
      const pid = c.req.param("id");
      return decisions.list({ status: "open" }).find((x) => x.kind === "payment_approval" && (x.refKey === pid || x.details.paymentId === pid));
    }),
  );

  return app;
}
