// Self-custody users get Session Vaults (walletMode "vault"): approve → { needsSignature, unsignedTx } built
// by tx.buildUnsignedVaultFunding from the WALLET's UTxOs (ONE tx for all sessions; owner = wallet address)
// → browser signs (fake CIP-30) → approve again → submitSigned → sessions run → vault Pay (session key) →
// kill = Revoke (captain) back to the WALLET address. Real runtime (wireEngine) + API + FakeChain.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, sessions as sessionsT } from "@bulkhead/db";
import type { ApproveOk, CreateUserResponse, NeedsSignatureResponse, PlanResponse } from "@bulkhead/shared";
import type { FundingOutput, UnsignedTx } from "@bulkhead/chain";
import { createApi } from "../src/api";
import { wireEngine, type WiredEngine } from "../src/wire";
import { canSelfFundVaults } from "../src/vault";
import { MockLLM } from "../src/llm/mock";
import { createFakeChain, fakeAddress, fakeWalletSign, FAKE_FEE_LOVELACE, type FakeChain } from "./fake-chain";
import { freshDb, stubMarket } from "./captain/helpers";

let engine: WiredEngine | null = null;
afterAll(async () => {
  await engine?.shutdown();
  closeDb();
});

/** FakeChain + an unsigned vault-funding builder (refuses non-vault outputs, like the real client). */
function chainWithSelfVault(): { chain: FakeChain; built: Array<{ fromAddress: string; outputs: FundingOutput[] }> } {
  const chain = createFakeChain({ autoConfirmMs: 20, treasuryStart: { tusdMicro: 50_000_000n, lovelace: 50_000_000n } });
  const built: Array<{ fromAddress: string; outputs: FundingOutput[] }> = [];
  const buildUnsignedVaultFunding = async (a: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx> => {
    for (const o of a.outputs) if (!chain.vaultAt(o.address)) throw new Error(`not a Session Vault address: ${o.address}`);
    built.push({ fromAddress: a.fromAddress, outputs: a.outputs });
    return chain.tx.buildUnsignedFunding!(a);
  };
  Object.assign(chain.tx, { buildUnsignedVaultFunding });
  return { chain, built };
}

describe("self-custody Session Vault (CIP-30 signTx)", () => {
  it("canSelfFundVaults needs the vault client + unsigned vault builder + submitSigned", () => {
    expect(canSelfFundVaults(createFakeChain())).toBe(false); // FakeChain alone: no unsigned vault builder → native fallback
    expect(canSelfFundVaults(chainWithSelfVault().chain)).toBe(true);
  });

  it("approve → sign → submit → Pay → Revoke back to the wallet", async () => {
    const db = freshDb();
    const { chain, built } = chainWithSelfVault();
    engine = await wireEngine({ db, chain, llm: new MockLLM(), market: stubMarket, config: { walletMode: "vault", txPollMs: 50, heartbeatMs: 1_000 } });
    await engine.boot();
    const e = engine;
    const app = createApi({ engine: e, onramp: e.onramp, signing: e.signing, token: "t", myrPerTusd: "4.70", captainInfo: e.captainInfo });
    const call = async <T = any>(method: string, path: string, user?: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "x-engine-token": "t", "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    };

    const wallet = fakeAddress("cip30-vault-wallet");
    chain.credit(wallet, 40_000_000n, 80_000_000n);
    const u = await call<CreateUserResponse>("POST", "/users", undefined, { email: "selfvault@example.com", name: "SV", custody: "self", walletAddress: wallet });
    const userId = u.body.userId;
    expect(u.body).toMatchObject({ custody: "self", treasuryAddress: wallet });

    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await call<PlanResponse>("POST", "/goals", userId, { goal: "Research competitors", budgetTUSD: "6", deadline, rules: "" });
    expect(planned.status).toBe(201);
    const goalId = planned.body.goalId;

    // 1st approve: vault sessions created, ONE unsigned vault-funding tx from the wallet, nothing spent yet.
    const first = await call<NeedsSignatureResponse>("POST", `/goals/${goalId}/approve`, userId, {});
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ ok: false, needsSignature: true });
    expect(first.body.purpose).toMatch(/Fund/);
    expect(chain.balance(wallet).tusdMicro).toBe(40_000_000n);
    const rows = db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.walletMode === "vault")).toBe(true);
    for (const r of rows) {
      const p = chain.vaultAt(r.address!)!;
      expect(p.ownerAddress).toBe(wallet); // owner = the wallet's full address
    }
    const fundCalls = built.filter((b) => b.fromAddress === wallet && b.outputs.length === rows.length);
    expect(fundCalls.length).toBeGreaterThan(0);
    const outs = fundCalls.at(-1)!.outputs;
    for (const r of rows) {
      const o = outs.find((x) => x.address === r.address)!;
      expect(o.tusdMicro).toBe(BigInt(r.budgetMicro)); // exactly the budget
      expect(o.extraLovelace! >= chain.vaultAt(r.address!)!.adaAllowanceLovelace).toBe(true); // ada_allowance headroom
    }

    // 2nd approve with the wallet's witness set → submitted from the wallet, vaults funded.
    const signed = await call<ApproveOk>("POST", `/goals/${goalId}/approve`, userId, { pendingId: first.body.pendingId, signedTx: fakeWalletSign(first.body.unsignedTx, wallet) });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.fundingTx).toBe(first.body.txHash);
    const fundTx = chain.txs.find((t) => t.txHash === first.body.txHash)!;
    expect(fundTx.from).toEqual([wallet]);
    expect(fundTx.outputs.map((o) => o.address).sort()).toEqual(rows.map((r) => r.address).sort());
    expect(chain.txs.some((t) => t.kind === "vaultFund")).toBe(false); // nothing from a custodial treasury
    expect(chain.balance(wallet).tusdMicro).toBe(34_000_000n);

    // Pay from a vault session with an allowlisted payee (session key; the fake validator checks the vault rules).
    const withPayee = rows.find((r) => (JSON.parse(r.allowedPayeesJson) as unknown[]).length > 0)!;
    const sid = withPayee.id;
    const payee = (JSON.parse(withPayee.allowedPayeesJson) as Array<{ address: string }>)[0]!.address;
    const until = Date.now() + 20_000;
    while (Date.now() < until && e.sessions.get(sid)?.status !== "RUNNING") await new Promise((r) => setTimeout(r, 50));
    expect(e.sessions.get(sid)?.status).toBe("RUNNING");
    const paid = await e.signer.pay(sid, { payee, amountMicro: 100_000n, memo: "self-custody vault pay" });
    expect(paid.kind, JSON.stringify(paid)).toBe("submitted");
    expect(chain.txs.at(-1)!.kind).toBe("vaultPay");

    // Kill → Revoke (captain) → everything back to the WALLET.
    const inVault = chain.balance(withPayee.address!);
    const before = chain.balance(wallet);
    await e.sessions.kill(sid, "user", "test kill");
    await e.sessions.whenClosed(sid, 5_000);
    const revoke = chain.txs.find((t) => t.kind === "vaultRevoke" && t.from.includes(withPayee.address!))!;
    expect(revoke.outputs).toEqual([{ address: wallet, tusdMicro: inVault.tusdMicro, lovelace: inVault.lovelace - FAKE_FEE_LOVELACE }]);
    expect(chain.balance(wallet).tusdMicro - before.tusdMicro).toBe(inVault.tusdMicro);
    expect((await call("GET", "/me", userId)).body.pendingSignatures).toHaveLength(0);
  }, 60_000);
});
