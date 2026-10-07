// Self-custody (CIP-30 wallet as treasury) with 0 tUSD: approve answers 409 insufficient_funds with the precise
// "Your treasury has 0 tUSD; this plan needs …" message BEFORE any unsigned tx is built (no signature request,
// never the raw Mesh "UTxO Balance Insufficient"); sessions stay unfunded and approving again after a deposit
// proceeds to the wallet signature. FakeChain = nothing on-chain.
import { afterAll, describe, expect, it } from "vitest";
import type { CreateUserResponse, PlanResponse } from "@bulkhead/shared";
import { closeDb } from "@bulkhead/db";
import { createApi } from "../src/api";
import { wireEngine, type WiredEngine } from "../src/wire";
import { MockLLM } from "../src/llm/mock";
import { createFakeChain, fakeAddress } from "./fake-chain";
import { freshDb, stubMarket } from "./captain/helpers";

let engine: WiredEngine | null = null;
afterAll(async () => {
  await engine?.shutdown();
  closeDb();
});

describe("self-custody funding preflight", () => {
  it("0 tUSD in the wallet → 409 with a top-up message, no signature request; after a deposit → needsSignature", async () => {
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
    const wallet = fakeAddress("eternl-wallet");
    chain.credit(wallet, 0n, 139_000_000n); // 139 tADA, 0 tUSD (the reported case)
    const u = await call<CreateUserResponse>("POST", "/users", undefined, { email: "eternl@example.com", custody: "self", walletAddress: wallet });
    const userId = u.body.userId;
    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await call<PlanResponse>("POST", "/goals", userId, { goal: "Research competitors", budgetTUSD: "8", deadline, rules: "" });
    expect(planned.status).toBe(201);
    const goalId = planned.body.goalId;

    const r = await call<{ error: string; code: string; faucetUrl: string }>("POST", `/goals/${goalId}/approve`, userId, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("insufficient_funds");
    expect(r.body.error).toMatch(/^Your treasury has 0 tUSD; this plan needs [\d.]+ tUSD \(≈ RM[\d.]+\)\. Top up first\. Shortfall: [\d.]+ tUSD \(asset [0-9a-f]+\) — send it to treasury addr_test1[0-9a-z]+\.$/);
    expect(r.body.error).not.toMatch(/UTxO Balance Insufficient/);
    expect((await call("GET", "/me", userId)).body.pendingSignatures).toHaveLength(0);
    const sessions = e.sessions.list({ goalId });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.status === "AWAITING_APPROVAL")).toBe(true);

    // Deposit tUSD into the wallet → approving again reaches the wallet signature step.
    chain.credit(wallet, 20_000_000n, 0n);
    const again = await call("POST", `/goals/${goalId}/approve`, userId, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: false, needsSignature: true });
  });
});
