// Wallet identity (CIP-30 signData / CIP-8 COSE_Sign1): nonce lifecycle + real signature verification.
// Signatures are produced in-test by a Mesh 1.9.1 MeshWallet built from a throwaway mnemonic
// (MeshWallet.brew(), in memory only, never printed or persisted). Nothing touches the chain.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, users } from "@bulkhead/db";
import type { ApproveOk, CreateUserResponse, NeedsSignatureResponse, PlanResponse } from "@bulkhead/shared";
import { WalletAuth, WalletAuthError, assertPreprodPaymentAddress, canonicalJson, walletIdentity, type WalletProof } from "../src/wallet-auth";
import { createApi } from "../src/api";
import { wireEngine, type WiredEngine } from "../src/wire";
import { MockLLM } from "../src/llm/mock";
import { createFakeChain, fakeWalletSign } from "./fake-chain";
import { freshDb, stubMarket } from "./captain/helpers";

// MeshWallet loaded like packages/chain/src/mesh.ts (CJS, from @meshsdk/core's location).
interface TestWallet {
  init(): Promise<void>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  signData(payload: string, address?: string): Promise<{ signature: string; key: string }>;
}
const local = createRequire(import.meta.url);
const meshReq = createRequire(createRequire(local.resolve("@bulkhead/chain")).resolve("@meshsdk/core"));
const { MeshWallet } = meshReq("@meshsdk/wallet") as {
  MeshWallet: { new (o: { networkId: 0 | 1; key: { type: "mnemonic"; words: string[] } }): TestWallet; brew(privateKey?: boolean, strength?: number): string[] | string };
};

async function throwawayWallet(networkId: 0 | 1 = 0) {
  const w = new MeshWallet({ networkId, key: { type: "mnemonic", words: MeshWallet.brew() as string[] } });
  await w.init();
  return { w, address: await w.getChangeAddress() };
}
const sign = async (w: TestWallet, payload: string, address: string) => w.signData(payload, address);
const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof WalletAuthError ? e.code : `other:${(e as Error).message}`;
  }
};

let alice: { w: TestWallet; address: string };
let mallory: { w: TestWallet; address: string };
beforeAll(async () => {
  alice = await throwawayWallet();
  mallory = await throwawayWallet();
}, 60_000);

let engine: WiredEngine | null = null;
afterAll(async () => {
  await engine?.shutdown();
  closeDb();
});

describe("wallet nonce lifecycle + COSE verification", () => {
  it("addresses: preprod only, identity from the stake credential", async () => {
    expect(alice.address).toMatch(/^addr_test1/);
    expect(assertPreprodPaymentAddress(alice.address)).toBe(alice.address);
    const main = await throwawayWallet(1);
    expect(main.address).toMatch(/^addr1/);
    expect(() => assertPreprodPaymentAddress(main.address)).toThrow(/Mainnet address refused/);
    expect(() => assertPreprodPaymentAddress("stake1uxyz")).toThrow(/Mainnet/);
    expect(() => assertPreprodPaymentAddress("addr_test1notreallyanaddressatallxxxxxxxx")).toThrow(/valid Cardano address/);
    const id = walletIdentity(alice.address);
    expect(id.stakeAddress).toBe((await alice.w.getRewardAddresses())[0]);
    expect(id.identity).toBe(`wallet:${id.stakeAddress}`);
    expect(canonicalJson({ b: 1, a: { d: null, c: "x" } })).toBe('{"a":{"c":"x","d":null},"b":1}');
  });

  it("valid signature verifies once; replay, expiry, wrong address, forged key and mainnet are refused", async () => {
    const db = freshDb();
    let t = 1_000_000;
    const auth = new WalletAuth({ db, now: () => t, ttlMs: 60_000 });

    // Happy path: real CIP-8 COSE_Sign1 from the MeshWallet.
    const n1 = auth.issue({ purpose: "login", address: alice.address });
    expect(n1.payload).toContain(n1.nonce);
    expect(n1.payload).toContain(alice.address);
    const s1 = await sign(alice.w, n1.payload, alice.address);
    const v = await auth.verify({ purpose: "login", address: alice.address, proof: { nonce: n1.nonce, ...s1 } });
    expect(v.identity).toBe(walletIdentity(alice.address).identity);
    expect(v.keyHash).toMatch(/^[0-9a-f]{56}$/);
    // Single use: the same proof again is refused.
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: { nonce: n1.nonce, ...s1 } }))).toBe("nonce_used");

    // Expiry.
    const n2 = auth.issue({ purpose: "login", address: alice.address });
    const s2 = await sign(alice.w, n2.payload, alice.address);
    t += 61_000;
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: { nonce: n2.nonce, ...s2 } }))).toBe("nonce_expired");
    // ...and burnt even though it failed.
    expect(auth.peek(n2.nonce)?.used).toBe(true);

    // Wrong address: nonce issued for alice, presented for mallory (with mallory's own valid signature).
    const n3 = auth.issue({ purpose: "login", address: alice.address });
    const s3m = await sign(mallory.w, n3.payload, mallory.address);
    expect(await errCode(auth.verify({ purpose: "login", address: mallory.address, proof: { nonce: n3.nonce, ...s3m } }))).toBe("wrong_address");

    // Mallory signs alice's message with her key, claims alice's address → checkSignature fails.
    const n4 = auth.issue({ purpose: "login", address: alice.address });
    const s4m = await sign(mallory.w, n4.payload, mallory.address);
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: { nonce: n4.nonce, ...s4m } }))).toBe("bad_signature");

    // Alice signs a different message (e.g. an old nonce) → payload mismatch.
    const n5 = auth.issue({ purpose: "login", address: alice.address });
    const s5 = await sign(alice.w, n1.payload, alice.address);
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: { nonce: n5.nonce, ...s5 } }))).toBe("bad_signature");

    // Purpose binding: a login signature cannot be used to link.
    const n6 = auth.issue({ purpose: "login", address: alice.address });
    const s6 = await sign(alice.w, n6.payload, alice.address);
    expect(await errCode(auth.verify({ purpose: "link", address: alice.address, userId: "u_x", proof: { nonce: n6.nonce, ...s6 } }))).toBe("wrong_purpose");

    // Unknown nonce, missing proof, mainnet address at issue + verify.
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: { nonce: "0".repeat(32), ...s1 } }))).toBe("unknown_nonce");
    expect(await errCode(auth.verify({ purpose: "login", address: alice.address, proof: null }))).toBe("proof_required");
    const main = await throwawayWallet(1);
    expect(await errCode(Promise.resolve().then(() => auth.issue({ purpose: "login", address: main.address })))).toBe("mainnet_refused");
    expect(await errCode(auth.verify({ purpose: "login", address: main.address, proof: { nonce: n1.nonce, ...s1 } }))).toBe("mainnet_refused");

    // Expired / used nonces are purged on the next issue.
    t += 120_000;
    auth.issue({ purpose: "login", address: alice.address });
    expect(auth.peek(n1.nonce)).toBeNull();
    expect(auth.peek(n2.nonce)).toBeNull();
  }, 60_000);
});

describe("wallet routes: sign-in, link, signed decision approvals", () => {
  it("login upserts a self-custody user; link needs a proof; self-custody approvals need a signature and keep evidence", async () => {
    const db = freshDb();
    const chain = createFakeChain({ autoConfirmMs: 20, treasuryStart: { tusdMicro: 50_000_000n, lovelace: 50_000_000n } });
    engine = await wireEngine({ db, chain, llm: new MockLLM(), market: stubMarket, config: { txPollMs: 50, heartbeatMs: 1_000 } });
    await engine.boot();
    const e = engine;
    const app = createApi({ engine: e, onramp: e.onramp, signing: e.signing, token: "t", myrPerTusd: "4.70", captainInfo: e.captainInfo });
    const call = async <T = any>(method: string, path: string, user?: string, body?: unknown, token = "t") => {
      const res = await app.request(path, { method, headers: { "x-engine-token": token, "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    };
    const proofFor = async (w: TestWallet, address: string, n: { nonce: string; payload: string }): Promise<WalletProof> => ({ nonce: n.nonce, ...(await sign(w, n.payload, address)) });

    // Engine token is enforced on the pre-auth wallet routes.
    expect((await call("POST", "/wallet/nonce", undefined, { purpose: "login", address: alice.address }, "wrong")).status).toBe(401);

    // ── Sign in with Cardano wallet ──
    const n = await call("POST", "/wallet/nonce", undefined, { purpose: "login", address: alice.address });
    expect(n.status).toBe(200);
    const login = await call("POST", "/wallet/login", undefined, { address: alice.address, ...(await proofFor(alice.w, alice.address, n.body)) });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const stake = (await alice.w.getRewardAddresses())[0];
    expect(login.body).toMatchObject({ identity: `wallet:${stake}`, custody: "self", treasuryAddress: alice.address, created: true });
    const aliceId = login.body.userId as string;
    // Replay of the same login proof is refused; a fresh login finds the same user.
    expect((await call("POST", "/wallet/login", undefined, { address: alice.address, ...(await proofFor(alice.w, alice.address, n.body)) })).status).toBe(401);
    const n2 = await call("POST", "/wallet/nonce", undefined, { purpose: "login", address: alice.address });
    const again = await call("POST", "/wallet/login", undefined, { address: alice.address, ...(await proofFor(alice.w, alice.address, n2.body)) });
    expect(again.body).toMatchObject({ userId: aliceId, created: false });
    // The normal sign-in upsert (by email) keeps self custody.
    await call("POST", "/users", undefined, { email: login.body.email, name: login.body.name });
    expect((await call("GET", "/me", aliceId)).body).toMatchObject({ custody: "self", treasuryAddress: alice.address });
    // Mainnet address refused at nonce time.
    const main = await throwawayWallet(1);
    expect((await call("POST", "/wallet/nonce", undefined, { purpose: "login", address: main.address })).body).toMatchObject({ code: "mainnet_refused" });

    // ── Linking a wallet as treasury requires the proof ──
    const cu = await call<CreateUserResponse>("POST", "/users", undefined, { email: "linker@example.com", custody: "custodial" });
    const linkerId = cu.body.userId;
    expect((await call("POST", "/wallet/link", linkerId, { address: mallory.address })).status).toBe(400);
    const ln = await call("POST", "/wallet/nonce", linkerId, { purpose: "link", address: mallory.address });
    // Alice can't link her address with a nonce issued to the linker for mallory's address.
    const forged = await call("POST", "/wallet/link", linkerId, { address: alice.address, ...(await proofFor(alice.w, alice.address, ln.body)) });
    expect(forged.status).toBe(401);
    const ln2 = await call("POST", "/wallet/nonce", linkerId, { purpose: "link", address: mallory.address });
    const linked = await call("POST", "/wallet/link", linkerId, { address: mallory.address, ...(await proofFor(mallory.w, mallory.address, ln2.body)) });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(db.select().from(users).where(eq(users.id, linkerId)).get()).toMatchObject({ custody: "self", treasuryAddress: mallory.address });

    // ── Decision approvals by a self-custody user (alice) ──
    chain.credit(alice.address, 40_000_000n, 60_000_000n);
    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await call<PlanResponse>("POST", "/goals", aliceId, { goal: "Research competitors", budgetTUSD: "6", deadline, rules: "" });
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    const first = await call<NeedsSignatureResponse>("POST", `/goals/${planned.body.goalId}/approve`, aliceId, {});
    expect(first.body.needsSignature).toBe(true);
    const funded = await call<ApproveOk>("POST", `/goals/${planned.body.goalId}/approve`, aliceId, { pendingId: first.body.pendingId, signedTx: fakeWalletSign(first.body.unsignedTx, alice.address) });
    expect(funded.body.ok, JSON.stringify(funded.body)).toBe(true);
    const sid = funded.body.sessionIds[0]!;
    const s = e.sessions.get(sid)!;
    const dec = e.decisions.open({ sessionId: sid, kind: "extend_expiry", requestedBy: "session", refKey: "wallet-test", details: { newExpiresAt: s.expiresAt + 3_600_000 } });

    // Unsigned click-approve is refused for a wallet-proven self-custody user.
    const unsigned = await call("POST", `/decisions/${dec.id}`, aliceId, { status: "approved" });
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe("wallet_signature_required");
    // Nonce for the decision: canonical payload over the decision fields.
    const dn = await call("POST", "/wallet/nonce", aliceId, { purpose: "decision", decisionId: dec.id });
    expect(dn.status, JSON.stringify(dn.body)).toBe(200);
    expect(dn.body.address).toBe(alice.address);
    const signedObj = JSON.parse(String(dn.body.payload).split("\n")[1]);
    expect(Object.keys(signedObj)).toEqual(["amount", "at", "decisionId", "kind", "nonce", "payee", "sessionId", "status"]);
    expect(signedObj).toMatchObject({ decisionId: dec.id, kind: "extend_expiry", sessionId: sid, status: "approved", nonce: dn.body.nonce });
    // Mallory's signature over alice's approval payload is refused.
    const bad = await call("POST", `/decisions/${dec.id}`, aliceId, { status: "approved", walletProof: await proofFor(mallory.w, mallory.address, dn.body) });
    expect(bad.status).toBe(401);
    // The good one (fresh nonce) approves the decision and stores the evidence.
    const dn2 = await call("POST", "/wallet/nonce", aliceId, { purpose: "decision", decisionId: dec.id });
    const ok = await call("POST", `/decisions/${dec.id}`, aliceId, { status: "approved", walletProof: await proofFor(alice.w, alice.address, dn2.body) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(e.decisions.list({}).find((d) => d.id === dec.id)!.status).toBe("approved");
    const ev = await call("GET", "/wallet/evidence", aliceId);
    expect(ev.body[dec.id]).toMatchObject({ decisionId: dec.id, address: alice.address, payload: dn2.body.payload });
    expect(ev.body[dec.id].keyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(ev.body[dec.id].signature).toMatch(/^[0-9a-f]+$/);
    // Other users don't see it.
    expect((await call("GET", "/wallet/evidence", linkerId)).body[dec.id]).toBeUndefined();

    // Custodial users are unchanged: click-approve works without any wallet.
    const cust = await call<CreateUserResponse>("POST", "/users", undefined, { email: "cust@example.com", custody: "custodial" });
    const p2 = await call<PlanResponse>("POST", "/goals", cust.body.userId, { goal: "Research competitors", budgetTUSD: "3", deadline, rules: "" });
    const a2 = await call<ApproveOk>("POST", `/goals/${p2.body.goalId}/approve`, cust.body.userId, {});
    expect(a2.body.ok).toBe(true);
    const cs = a2.body.sessionIds[0]!;
    const cdec = e.decisions.open({ sessionId: cs, kind: "extend_expiry", requestedBy: "session", refKey: "wallet-test-c", details: { newExpiresAt: e.sessions.get(cs)!.expiresAt + 3_600_000 } });
    const cok = await call("POST", `/decisions/${cdec.id}`, cust.body.userId, { status: "approved" });
    expect(cok.status, JSON.stringify(cok.body)).toBe(200);
    expect(cok.body.status).toBe("approved");
    // Custodial users can't ask for a decision nonce.
    expect((await call("POST", "/wallet/nonce", cust.body.userId, { purpose: "decision", decisionId: cdec.id })).status).toBe(400);
  }, 90_000);
});
