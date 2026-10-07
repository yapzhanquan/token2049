// walletMode "vault" (Bulkhead Session Vault) on the FakeChain: lifecycle, Signer → chain rejection mapping,
// close = Revoke (metadata 674), recover = permissionless Recover after expiry, mandate changes = vault rotation.
// The FakeChain's vault ops mirror the validator rules (payees / per-tx max / ada allowance / expiry / owner).
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { payments, sessions as sessionsT } from "@bulkhead/db";
import { FAKE_FEE_LOVELACE, FAKE_MIN_ADA, FAKE_TUSD_UNIT } from "../fake-chain";
import { adaAllowanceFrom, parseVaultParams, vaultOps, vaultRecoverOf, walletModeFromEnv } from "../../src/vault";
import { PAYEE_1, PAYEE_2, STRANGER, setup, spec, startPlan, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const VAULT = { config: { walletMode: "vault" as const } };
const buyer = (over = {}) =>
  spec({ taskType: "buy_pay", role: "buyer", agentType: "buyer", allowedPayees: [PAYEE_1, PAYEE_2], budgetTUSD: "10", perPaymentMaxTUSD: "5", approvalThresholdTUSD: "4", dataScope: [], ...over });
const dbRow = (x: H, id: string) => x.db.select().from(sessionsT).where(eq(sessionsT.id, id)).get()!;

describe("walletMode vault — config + helpers", () => {
  it("defaults to vault; WALLET_MODE=native switches back to the native-script fallback", async () => {
    expect(walletModeFromEnv({})).toBe("vault");
    expect(walletModeFromEnv({ WALLET_MODE: "vault" })).toBe("vault");
    expect(walletModeFromEnv({ WALLET_MODE: "native" })).toBe("native");
    expect(walletModeFromEnv({ WALLET_MODE: "nonsense" })).toBe("vault");
    h = await setup();
    const { ids } = await startPlan(h, [buyer()]);
    expect(dbRow(h, ids[0]!).walletMode).toBe("native");
    expect(h.chain.txs.some((t) => t.kind === "vaultFund")).toBe(false);
  });

  it("ada_allowance from live protocol params ≈ 3 tADA (fallback 3 tADA)", () => {
    expect(adaAllowanceFrom({ minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: "4310" })).toBe(3_000_000n);
    expect(adaAllowanceFrom(null)).toBe(3_000_000n);
  });
});

describe("walletMode vault — lifecycle on the FakeChain", () => {
  it("apply params → ONE vault funding tx → pay (allowed) → chain rejects over-limit + attacker → kill = Revoke to owner with 674", async () => {
    h = await setup(VAULT);
    const { ids } = await startPlan(h, [buyer(), buyer({ name: "Second" })]);
    const [id, id2] = ids as [string, string];
    const r = dbRow(h, id);
    // Parameters applied per session; owner = user treasury; payees = resolved allowlist; per-tx max = per-payment max.
    expect(r.walletMode).toBe("vault");
    expect(r.scriptHash).toMatch(/^[0-9a-f]{56}$/);
    expect(dbRow(h, id2).scriptHash).not.toBe(r.scriptHash);
    const p = h.chain.vaultAt(r.address!)!;
    expect(p).toBeTruthy();
    expect(p.ownerAddress).toBe(h.treasury);
    expect(p.payees).toEqual([PAYEE_1, PAYEE_2]);
    expect(p.perTxMaxTusdMicro).toBe(5_000_000n);
    expect(p.adaAllowanceLovelace).toBe(3_000_000n);
    expect(p.expiryMs).toBe(r.expiresAt);
    expect(p.tusdPolicyId + p.tusdAssetNameHex).toBe(FAKE_TUSD_UNIT);
    expect(parseVaultParams(r.scriptJson)?.payees).toEqual([PAYEE_1, PAYEE_2]);
    // ONE funding tx (vaultFund) for both vault sessions; exactly the budget in tUSD.
    const funds = h.chain.txs.filter((t) => t.kind === "vaultFund");
    expect(funds).toHaveLength(1);
    expect(funds[0]!.outputs.map((o) => o.address).sort()).toEqual([r.address, dbRow(h, id2).address].sort());
    expect(h.chain.balance(r.address!).tusdMicro).toBe(10_000_000n);
    expect(h.chain.txs.some((t) => t.kind === "fundSessions")).toBe(false);
    expect(h.events("session_funded", id).some((e) => e.data.walletMode === "vault")).toBe(true);

    // 1. allowed payee within limits → vault Pay submitted
    const ok = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 2_000_000n, memo: "ok" });
    expect(ok.kind).toBe("submitted");
    expect(h.chain.txs.at(-1)!.kind).toBe("vaultPay");
    expect(h.chain.balance(PAYEE_1).tusdMicro).toBe(2_000_000n);

    // 2. off-chain policy pre-check still rejects fast (no tx)
    const pre = await h.signer.pay(id, { payee: STRANGER, amountMicro: 1_000_000n, memo: "attack" });
    expect(pre.kind === "rejected" && pre.reason).toBe("payee_not_allowed");
    expect(h.chain.calls.vaultPay).toBe(1);

    // 3. off-chain policy bypassed (simulated Signer bug / tampered DB): the CHAIN is the final authority.
    h.db.update(sessionsT).set({ perPaymentMaxMicro: "50000000", approvalThresholdMicro: "100000000", allowedPayeesJson: JSON.stringify([...JSON.parse(r.allowedPayeesJson), { id: STRANGER, label: "attacker", address: STRANGER }]) }).where(eq(sessionsT.id, id)).run();
    const over = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 6_000_000n, memo: "over" });
    expect(over.kind).toBe("rejected");
    if (over.kind === "rejected") {
      expect(over.reason).toBe("rejected_onchain");
      expect(over.detail).toMatch(/per_tx_max_tusd/);
    }
    const attack = await h.signer.pay(id, { payee: STRANGER, amountMicro: 1_000_000n, memo: "attack" });
    expect(attack.kind === "rejected" && attack.reason).toBe("rejected_onchain");
    expect(h.chain.balance(STRANGER).tusdMicro).toBe(0n);
    const ev = h.events("payment_rejected", id).filter((e) => e.data.reason === "rejected_onchain");
    expect(ev).toHaveLength(2);
    expect(ev[0]!.data.enforcedBy).toBe("Bulkhead Session Vault");
    const rejectedRows = h.db.select().from(payments).where(eq(payments.sessionId, id)).all().filter((x) => x.rejectionReason === "rejected_onchain");
    expect(rejectedRows.every((x) => x.status === "rejected" && !x.txHash)).toBe(true);
    expect(h.sessions.get(id)!.spentMicro).toBe(2_000_000n); // rejected attempts never count
    expect(h.chain.vaultRejections).toHaveLength(2);

    // 4. kill → CLOSING → Revoke (captain) → everything to the owner treasury, metadata 674
    const tBefore = h.chain.balance(h.treasury);
    const inVault = h.chain.balance(r.address!);
    await h.sessions.kill(id, "user", "test kill");
    await h.sessions.whenClosed(id, 5_000);
    const revoke = h.chain.txs.find((t) => t.kind === "vaultRevoke")!;
    expect(revoke).toBeTruthy();
    expect(revoke.outputs).toEqual([{ address: h.treasury, tusdMicro: 8_000_000n, lovelace: inVault.lovelace - FAKE_FEE_LOVELACE }]);
    const m = revoke.metadata!["674"] as Record<string, unknown>;
    const closed = dbRow(h, id);
    expect(m).toEqual({ session_id: id, log_sha256: closed.logSha256, handback_sha256: closed.handbackSha256, status: "KILLED", goal_id: closed.goalId });
    expect(closed.closeTx).toBe(revoke.txHash);
    expect(closed.refundMicro).toBe("8000000");
    expect(h.chain.balance(r.address!)).toEqual({ tusdMicro: 0n, lovelace: 0n });
    expect(h.chain.balance(h.treasury).tusdMicro - tBefore.tusdMicro).toBe(8_000_000n);
    expect(h.chain.txs.some((t) => t.kind === "sweep")).toBe(false);
  });

  it("Signer maps vault build errors to build_failed and validator failures to rejected_onchain", async () => {
    h = await setup(VAULT);
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    h.chain.failNext("vaultPay", 1, "could not build tx: missing utxo");
    const a = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 500_000n, memo: "t" });
    expect(a.kind === "rejected" && a.reason).toBe("build_failed");
    h.chain.failNext("vaultPay", 1, "evaluateTx: script failure: validator returned false (Pay)");
    const b = await h.signer.pay(id, { payee: PAYEE_1, amountMicro: 500_000n, memo: "t" });
    expect(b.kind === "rejected" && b.reason).toBe("rejected_onchain");
    expect(h.db.select().from(payments).where(eq(payments.sessionId, id)).all().find((p) => p.rejectionReason === "rejected_onchain")?.status).toBe("rejected");
    // narrowing cannot "pay home" from a vault: the cap drops, the excess returns at close
    await h.sessions.narrowBudget(id, 6_000_000n);
    expect(h.sessions.get(id)!.budgetMicro).toBe(6_000_000n);
    expect(h.chain.balance(dbRow(h, id).address!).tusdMicro).toBe(10_000_000n);
    await expect(h.signer.returnToTreasury(id, h.treasury, 1n, "x")).rejects.toThrow(/allowlisted payees only/);
  });

  it("extend expiry rotates the vault: Revoke old → fund a new vault with the new expiry", async () => {
    h = await setup(VAULT);
    const { ids } = await startPlan(h, [buyer()]);
    const id = ids[0]!;
    const old = dbRow(h, id);
    const newExp = old.expiresAt + 3_600_000;
    const d = h.decisions.open({ sessionId: id, kind: "extend_expiry", requestedBy: "captain", refKey: "e1", details: { newExpiresAt: newExp } });
    await h.decisions.decide(d.id, "approved", "user");
    const now = dbRow(h, id);
    expect(now.expiresAt).toBe(newExp);
    expect(now.address).not.toBe(old.address);
    expect(now.scriptHash).not.toBe(old.scriptHash);
    expect(h.chain.vaultAt(now.address!)!.expiryMs).toBe(newExp);
    expect(h.chain.balance(old.address!).tusdMicro).toBe(0n);
    expect(h.chain.balance(now.address!).tusdMicro).toBe(10_000_000n);
    expect(((h.chain.txs.find((t) => t.kind === "vaultRevoke")!.metadata!["674"]) as { status: string }).status).toBe("ROTATED");
    expect(now.status).toBe("RUNNING");
    // payments now go through the new vault
    expect((await h.signer.pay(id, { payee: PAYEE_2, amountMicro: 1_000_000n, memo: "after" })).kind).toBe("submitted");
  });

  it("widening payees rotates the vault so the chain enforces the new allowlist", async () => {
    h = await setup(VAULT);
    const { ids } = await startPlan(h, [buyer({ allowedPayees: [PAYEE_1] })]);
    const id = ids[0]!;
    const old = dbRow(h, id);
    const d = h.decisions.open({ sessionId: id, kind: "widen_mandate", requestedBy: "captain", refKey: "w1", details: { addPayees: [PAYEE_2] } });
    await h.decisions.decide(d.id, "approved", "user");
    await waitFor(() => dbRow(h!, id).address !== old.address && dbRow(h!, id).allowedPayeesJson.includes(PAYEE_2), 5_000, "rotation");
    expect(h.chain.vaultAt(dbRow(h, id).address!)!.payees).toEqual([PAYEE_1, PAYEE_2]);
    expect((await h.signer.pay(id, { payee: PAYEE_2, amountMicro: 1_000_000n, memo: "new payee" })).kind).toBe("submitted");
  });

  it("recover: Recover before expiry is refused; after expiry anyone recovers everything to the owner; reconcile closes", async () => {
    let clock = Date.now();
    h = await setup({ config: { walletMode: "vault", now: () => clock } });
    const { ids } = await startPlan(h, [spec({ budgetTUSD: "3" })]);
    const id = ids[0]!;
    const r = dbRow(h, id);
    // no allowlist → the on-chain payee list is just the owner's treasury (the vault client needs ≥ 1 payee)
    expect(h.chain.vaultAt(r.address!)!.payees).toEqual([h.treasury]);
    const recover = vaultRecoverOf(h.chain)!;
    expect(vaultOps(h.chain)).not.toBeNull();
    await expect(recover({ sessionId: id })).rejects.toMatchObject({ name: "NotYetExpiredError" });
    expect(h.chain.txs.some((t) => t.kind === "vaultRecover")).toBe(false);
    // nobody closes the session; time passes the expiry
    clock = r.expiresAt + 60_000;
    h.chain.setNow(clock);
    const inVault = h.chain.balance(r.address!);
    const tBefore = h.chain.balance(h.treasury);
    const meta = { session_id: id, log_sha256: "a".repeat(64), handback_sha256: "none", status: "RECOVERED_BY_OWNER" };
    const res = await recover({ sessionId: id, metadata674: meta });
    const tx = h.chain.txs.find((t) => t.txHash === res.txHash)!;
    expect(tx.kind).toBe("vaultRecover");
    expect(tx.outputs).toEqual([{ address: h.treasury, tusdMicro: 3_000_000n, lovelace: inVault.lovelace - FAKE_FEE_LOVELACE }]);
    expect(tx.metadata!["674"]).toEqual(meta);
    expect(h.chain.balance(h.treasury).tusdMicro - tBefore.tusdMicro).toBe(3_000_000n);
    h.chain.tick();
    // reconcile (as after a restart): EXPIRED → CLOSED with nothing left to revoke (no double sweep)
    await h.sessions.reconcile();
    await h.sessions.whenClosed(id, 5_000);
    const closed = dbRow(h, id);
    expect(closed.closeStatus).toBe("EXPIRED");
    expect(closed.closeTx).toBeNull();
    expect(h.chain.txs.some((t) => t.kind === "vaultRevoke")).toBe(false);
    void FAKE_MIN_ADA;
  });
});
