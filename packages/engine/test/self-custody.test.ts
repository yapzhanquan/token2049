// Self-custody signing protocol through the API, on the real runtime (wireEngine) + FakeChain.
// approve → { needsSignature, unsignedTx, pendingId } → browser signs (fake CIP-30) → approve again with
// { pendingId, signedTx } → funding submitted from the user's wallet, sessions run. Then a budget raise
// (decision approval) needs a signature too. FakeChain = nothing on-chain.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, users } from "@bulkhead/db";
import type { ApproveOk, CreateUserResponse, NeedsSignatureResponse, PlanResponse } from "@bulkhead/shared";
import { createApi } from "../src/api";
import { wireEngine, type WiredEngine } from "../src/wire";
import { MockLLM } from "../src/llm/mock";
import { createFakeChain, fakeAddress, fakeWalletKeyHash, fakeWalletSign } from "./fake-chain";
import { freshDb, stubMarket } from "./captain/helpers";

let engine: WiredEngine | null = null;
afterAll(async () => {
  await engine?.shutdown();
  closeDb();
});

describe("self-custody signing (CIP-30 protocol)", () => {
  it("funding and a budget raise wait for the wallet signature; custodial users are unaffected", async () => {
    const db = freshDb();
    const chain = createFakeChain({ autoConfirmMs: 20, treasuryStart: { tusdMicro: 50_000_000n, lovelace: 50_000_000n } });
    engine = await wireEngine({ db, chain, llm: new MockLLM(), market: stubMarket, config: { txPollMs: 50, heartbeatMs: 1_000 } });
    await engine.boot();
    const e = engine;
    const app = createApi({ engine: e, onramp: e.onramp, signing: e.signing, token: "t", myrPerTusd: "4.70", captainInfo: e.captainInfo });
    const call = async <T = any>(method: string, path: string, user?: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "x-engine-token": "t", "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    };

    // A custodial user first, then switch to self-custody with a (fake) CIP-30 wallet address.
    const wallet = fakeAddress("cip30-wallet");
    chain.credit(wallet, 40_000_000n, 60_000_000n);
    const u = await call<CreateUserResponse>("POST", "/users", undefined, { email: "self@example.com", name: "Self", custody: "custodial" });
    const userId = u.body.userId;
    const sw = await call<CreateUserResponse>("POST", "/users", undefined, { email: "self@example.com", name: "Self", custody: "self", walletAddress: wallet });
    expect(sw.body).toMatchObject({ userId, custody: "self", treasuryAddress: wallet, created: false });
    // Sign-in upserts omit custody: they must not switch the user back.
    await call("POST", "/users", undefined, { email: "self@example.com", name: "Self" });
    const me = await call("GET", "/me", userId);
    expect(me.body).toMatchObject({ custody: "self", treasuryAddress: wallet, balances: { tusdMicro: "40000000" }, pendingSignatures: [] });

    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await call<PlanResponse>("POST", "/goals", userId, { goal: "Research competitors", budgetTUSD: "6", deadline, rules: "" });
    expect(planned.status).toBe(201);
    expect(planned.body.fundingPreview.error).toBeUndefined(); // preview built from the wallet's UTxOs
    const goalId = planned.body.goalId;

    // 1st approve: nothing spent yet, the engine asks for a signature.
    const first = await call<NeedsSignatureResponse>("POST", `/goals/${goalId}/approve`, userId, {});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: false, needsSignature: true });
    expect(first.body.unsignedTx).toMatch(/^[0-9a-f]+$/);
    expect(chain.balance(wallet).tusdMicro).toBe(40_000_000n);
    expect((await call("GET", "/me", userId)).body.pendingSignatures).toHaveLength(1);
    // Asking again returns the same pending tx (no second build / double funding).
    const again = await call<NeedsSignatureResponse>("POST", `/goals/${goalId}/approve`, userId, {});
    expect(again.body.pendingId).toBe(first.body.pendingId);

    // A wrong signature is refused and can be retried.
    const bad = await call("POST", `/goals/${goalId}/approve`, userId, { pendingId: first.body.pendingId, signedTx: fakeWalletSign(first.body.unsignedTx, fakeAddress("someone-else")) });
    expect(bad.status).toBe(400);

    // 2nd approve with the CIP-30 witness set: submitted from the wallet, sessions created + funded.
    const signed = await call<ApproveOk>("POST", `/goals/${goalId}/approve`, userId, { pendingId: first.body.pendingId, signedTx: fakeWalletSign(first.body.unsignedTx, wallet) });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.ok).toBe(true);
    expect(signed.body.sessionIds).toHaveLength(3);
    expect(signed.body.fundingTx).toBe(first.body.txHash);
    expect(chain.balance(wallet).tusdMicro).toBe(34_000_000n);
    const fundTx = chain.txs.find((t) => t.txHash === first.body.txHash)!;
    expect(fundTx.from).toEqual([wallet]);
    expect((await call("GET", "/me", userId)).body.pendingSignatures).toHaveLength(0);
    // Session scripts use the wallet's payment key as the owner key.
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.ownerKeyHash).toBe(fakeWalletKeyHash(wallet));

    // Budget raise: the decision approval funds the extra amount from the wallet → signature again.
    const sid = signed.body.sessionIds[0]!;
    const deadlineMs = Date.now() + 20_000;
    while (Date.now() < deadlineMs && !["RUNNING", "CLOSED"].includes(e.sessions.get(sid)?.status ?? "")) await new Promise((r) => setTimeout(r, 50));
    const raise = await call("POST", `/sessions/${sid}/raise`, userId, { addTUSD: "1" });
    expect(raise.body.decision.status).toBe("open");
    if (e.sessions.get(sid)?.status !== "CLOSED") {
      const ask = await call<NeedsSignatureResponse>("POST", `/decisions/${raise.body.decision.id}`, userId, { status: "approved" });
      expect(ask.body.needsSignature).toBe(true);
      const done = await call("POST", `/decisions/${raise.body.decision.id}`, userId, { status: "approved", pendingId: ask.body.pendingId, signedTx: fakeWalletSign(ask.body.unsignedTx, wallet) });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.status).toBe("approved");
      expect(chain.balance(wallet).tusdMicro).toBe(33_000_000n);
    }

    // Custodial users never see needsSignature.
    const c = await call<CreateUserResponse>("POST", "/users", undefined, { email: "cust@example.com", custody: "custodial" });
    const p2 = await call<PlanResponse>("POST", "/goals", c.body.userId, { goal: "Research competitors", budgetTUSD: "3", deadline, rules: "" });
    const a2 = await call<ApproveOk>("POST", `/goals/${p2.body.goalId}/approve`, c.body.userId, {});
    expect(a2.body.ok).toBe(true);
    expect(a2.body.sessionIds).toHaveLength(3);
  }, 60_000);

  it("insufficient funds → 409 with the message and a faucet link", async () => {
    await engine?.shutdown();
    closeDb();
    const db = freshDb();
    const chain = createFakeChain({ autoConfirmMs: 20, treasuryStart: { tusdMicro: 1_000_000n, lovelace: 50_000_000n } });
    engine = await wireEngine({ db, chain, llm: new MockLLM(), market: stubMarket, config: { txPollMs: 50 } });
    await engine.boot();
    const e = engine;
    const app = createApi({ engine: e, onramp: e.onramp, signing: e.signing, myrPerTusd: "4.70", captainInfo: e.captainInfo });
    const req = async (method: string, path: string, user?: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as any };
    };
    const userId = (await req("POST", "/users", undefined, { email: "poor@example.com", custody: "custodial" })).body.userId as string;
    const planned = await req("POST", "/goals", userId, { goal: "Research competitors", budgetTUSD: "6", deadline: new Date(Date.now() + 3600_000).toISOString(), rules: "" });
    const r = await req("POST", `/goals/${planned.body.goalId}/approve`, userId, {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "insufficient_funds" });
    expect(r.body.error).toMatch(/tUSD/);
    expect(r.body.faucetUrl).toMatch(/faucet/);
  }, 30_000);
});
