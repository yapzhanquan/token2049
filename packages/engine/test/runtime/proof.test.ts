// Trust receipts: GET /goals/:id/proof + /sessions/:id/proof (FakeChain, in-process Hono) and the close tx's
// CIP-20 674 anchor (session id + goal id + sha256(utf8(handback text))).
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions as sessionsT } from "@bulkhead/db";
import { UNAPPLIED_VAULT_HASH } from "@bulkhead/chain";
import { EMPTY_SHA256, HANDBACK_HASH_RULE, type GoalProofDTO, type SessionProofDTO } from "@bulkhead/shared";
import { createApi } from "../../src/api";
import type { Engine } from "../../src/contracts";
import { PAYEE_1, PAYEE_2, setup, spec, startPlan } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const buyer = () => spec({ taskType: "buy_pay", role: "buyer", agentType: "buyer", allowedPayees: [PAYEE_1, PAYEE_2], budgetTUSD: "10", perPaymentMaxTUSD: "5", approvalThresholdTUSD: "4", dataScope: [] });

function api(x: H) {
  const engine = { db: x.db, chain: x.chain, bus: x.bus, sessions: x.sessions, decisions: x.decisions, market: x.market, signer: x.signer, silos: x.silos, llm: { name: "mock" }, captain: {} } as unknown as Engine;
  const app = createApi({ engine, myrPerTusd: "4.70", chainLabel: "fake", captainInfo: () => ({ name: "c", model: "m", contextTokens: 0, totalTokens: 0 }) });
  return async <T,>(path: string, user = x.userId) => {
    const res = await app.request(path, { headers: { "x-user-id": user } });
    return { status: res.status, body: (await res.json()) as T };
  };
}

describe("trust receipts", () => {
  it("vault session: mandate + exact params + funding/payment/close txs + handback anchored with goal id in the close 674", async () => {
    h = await setup({ config: { walletMode: "vault" } });
    const { goalId, ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    expect((await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 2_000_000n, memo: "ok" })).kind).toBe("submitted");
    // The handback text that gets hashed: exact UTF-8 (non-ASCII + newline on purpose).
    const text = JSON.stringify({ result: "Bought 1 report ✓\nsecond line", summary: "done", sources: [] });
    h.db.update(sessionsT).set({ handbackJson: text }).where(eq(sessionsT.id, id)).run();
    await h.sessions.kill(id, "user", "done for the test");
    await h.sessions.whenClosed(id, 5_000);

    // The close tx anchors session id, goal id and sha256(utf8(handback)) in CIP-20 label 674.
    const revoke = h.chain.txs.find((t) => t.kind === "vaultRevoke")!;
    const m = revoke.metadata!["674"] as Record<string, string>;
    expect(m.session_id).toBe(id);
    expect(m.goal_id).toBe(goalId);
    expect(m.handback_sha256).toBe(sha(text));

    const get = api(h);
    const { status, body } = await get<GoalProofDTO>(`/goals/${goalId}/proof`);
    expect(status).toBe(200);
    expect(body.goalId).toBe(goalId);
    expect(body.sessions).toHaveLength(1);
    const p = body.sessions[0]!;
    const row = h.db.select().from(sessionsT).where(eq(sessionsT.id, id)).get()!;
    expect(p.walletMode).toBe("vault");
    expect(p.vault!.unappliedValidatorHash).toBe(UNAPPLIED_VAULT_HASH);
    expect(p.vault!.appliedScriptHash).toBe(row.scriptHash);
    expect(p.vault!.address).toBe(row.address);
    expect(p.vault!.params.payees).toEqual([PAYEE_1, PAYEE_2]);
    expect(p.vault!.params.perTxMaxTusdMicro).toBe("5000000");
    expect(p.vault!.params.ownerAddress).toBe(h.treasury);
    expect(p.mandate).toMatchObject({ ownerAddress: h.treasury, payees: [PAYEE_1, PAYEE_2], perTxMaxMicro: "5000000", budgetMicro: "10000000" });
    expect(p.mandate!.assetUnit).toBe(p.vault!.params.tusdPolicyId + p.vault!.params.tusdAssetNameHex);
    expect(p.fundings).toEqual([{ kind: "initial", txHash: row.fundingTx, address: row.address, amountMicro: "10000000" }]);
    expect(p.payments).toHaveLength(1);
    expect(p.payments[0]).toMatchObject({ payee: PAYEE_1, amountMicro: "2000000" });
    expect(p.payments[0]!.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.close).toMatchObject({ txHash: revoke.txHash, kind: "revoke", toAddress: h.treasury, refundMicro: "8000000" });
    expect(p.close!.metadata674).toMatchObject({ session_id: id, goal_id: goalId, handback_sha256: sha(text) });
    expect(p.handback).toEqual({ text, sha256: sha(text), rule: HANDBACK_HASH_RULE });
    expect(p.claims.map((c) => c.id)).toEqual(["contract", "vault_address", "funding", "payments", "history", "close", "handback"]);

    const one = await get<SessionProofDTO>(`/sessions/${id}/proof`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(p);
  });

  it("no handback → the anchored hash is sha256(\"\"); other users get 404", async () => {
    h = await setup({ config: { walletMode: "vault" } });
    const { goalId, ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    await h.sessions.kill(id, "user", "t");
    await h.sessions.whenClosed(id, 5_000);
    const get = api(h);
    const p = (await get<SessionProofDTO>(`/sessions/${id}/proof`)).body;
    expect(p.handback.text).toBeNull();
    expect(p.handback.sha256).toBe(EMPTY_SHA256);
    expect((h.chain.txs.find((t) => t.kind === "vaultRevoke")!.metadata!["674"] as Record<string, string>).handback_sha256).toBe(EMPTY_SHA256);
    const { users } = await import("@bulkhead/db");
    h.db.insert(users).values({ id: "intruder", email: "x@example.com", name: "X", custody: "custodial", accountIndex: 9, treasuryAddress: "addr_test1qxyz", ownerKeyHash: "00".repeat(28), createdAt: Date.now() }).run();
    expect((await get(`/goals/${goalId}/proof`, "intruder")).status).toBe(404);
    expect((await get(`/sessions/${id}/proof`, "intruder")).status).toBe(404);
  });

  it("native session: script + engine-enforced mandate, sweep close also carries goal_id", async () => {
    h = await setup();
    const { goalId, ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    await h.sessions.kill(id, "user", "t");
    await h.sessions.whenClosed(id, 5_000);
    const sweep = h.chain.txs.find((t) => t.kind === "sweep")!;
    expect((sweep.metadata![674] as Record<string, string>).goal_id).toBe(goalId);
    const p = (await api(h)<SessionProofDTO>(`/sessions/${id}/proof`)).body;
    expect(p.walletMode).toBe("native");
    expect(p.vault).toBeNull();
    expect(p.native!.address).toBe(h.db.select().from(sessionsT).where(eq(sessionsT.id, id)).get()!.address);
    expect(p.mandate!.payees).toEqual([PAYEE_1, PAYEE_2]);
    expect(p.close!.kind).toBe("sweep");
  });
});
