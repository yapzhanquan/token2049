import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "@bulkhead/db";
import { FundingError, isBalanceError } from "../../src/sessions";
import { createFakeChain } from "../fake-chain";
import { setup, spec, startPlan, waitFor } from "./helpers";

type H = Awaited<ReturnType<typeof setup>>;
let h: H | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe("startPlan funding: preflight + resumable", () => {
  it("fails with a clear message when the treasury lacks tADA, and resumes without re-creating sessions", async () => {
    h = await setup();
    // drain the treasury's ADA
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, 0n, -bal.lovelace + 1_000_000n);
    const goalId = h.newGoal();
    const plan = { sessions: [spec({ name: "A" }), spec({ name: "B" }), spec({ name: "C" })] };
    const err = await h.sessions.startPlan(goalId, plan).catch((e) => e);
    expect(err).toBeInstanceOf(FundingError);
    expect(String(err.message)).toMatch(/^Your treasury has 1\.00 tADA; this plan needs ≈ [\d.]+ tADA .*preprod faucet/);
    expect(String(err.message)).not.toMatch(/UTxO Balance Insufficient/);
    const rows = h.sessions.list({ goalId });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "AWAITING_APPROVAL")).toBe(true);
    expect(h.chain.calls.fundSessions).toBe(0);

    // a tx-level failure also leaves them resumable
    h.chain.credit(h.treasury, 0n, 500_000_000n);
    h.chain.failNext("fundSessions", 1, "submit failed: mempool full");
    await expect(h.sessions.startPlan(goalId, plan)).rejects.toThrow(/mempool full/);
    expect(h.sessions.list({ goalId }).every((r) => r.status === "AWAITING_APPROVAL")).toBe(true);

    // re-approve: same session ids and keys, ONE funding tx
    const ids = await h.sessions.startPlan(goalId, plan);
    expect(ids).toEqual(rows.map((r) => r.id));
    await waitFor(() => ids.every((id) => h!.sessions.get(id)!.status === "RUNNING"), 5_000, "running");
    expect(h.chain.txs.filter((t) => t.kind === "fundSessions")).toHaveLength(1);
    // approving yet again never double-funds
    await h.sessions.startPlan(goalId, plan);
    expect(h.chain.txs.filter((t) => t.kind === "fundSessions")).toHaveLength(1);
  });
});

describe("funding preflight: precise top-up messages (never the raw Mesh error)", () => {
  it("0 tUSD → 'Your treasury has 0 tUSD; this plan needs N tUSD (≈ RM…)', sessions stay unfunded", async () => {
    h = await setup();
    const bal = h.chain.balance(h.treasury);
    h.chain.credit(h.treasury, -bal.tusdMicro, 0n);
    const goalId = h.newGoal();
    const plan = { sessions: [spec({ name: "A", budgetTUSD: "4" }), spec({ name: "B", budgetTUSD: "4" })] };
    const err = await h.sessions.startPlan(goalId, plan).catch((e) => e);
    expect(err).toBeInstanceOf(FundingError);
    expect(err.code).toBe("insufficient_funds");
    expect(err.message).toBe("Your treasury has 0 tUSD; this plan needs 8 tUSD (≈ RM37.60). Top up first.");
    expect(h.chain.calls.fundSessions).toBe(0);
    expect(h.sessions.list({ goalId }).every((r) => r.status === "AWAITING_APPROVAL")).toBe(true);
  });

  it("a raw coin-selection error from the builder becomes a FundingError", async () => {
    h = await setup();
    const goalId = h.newGoal();
    h.chain.failNext("fundSessions", 1, "UTxO Balance Insufficient");
    const err = await h.sessions.startPlan(goalId, { sessions: [spec({ name: "A" })] }).catch((e) => e);
    expect(err).toBeInstanceOf(FundingError);
    expect(err.message).toMatch(/Your treasury cannot cover this plan: it needs [\d.]+ tUSD \(≈ RM[\d.]+\)/);
    expect(err.message).not.toMatch(/UTxO Balance Insufficient/);
  });

  it("isBalanceError recognises Mesh / CSL balance errors only", () => {
    expect(isBalanceError(new Error("UTxO Balance Insufficient"))).toBe(true);
    expect(isBalanceError(new Error("Insufficient funds for 1000 lovelace"))).toBe(true);
    expect(isBalanceError(new Error("submit failed: mempool full"))).toBe(false);
  });
});

describe("on-ramp (spec §4) — idempotent by stripeEventId", () => {
  it("MYR → tUSD at rate minus fee; one operator send per event; confirmed via watcher", async () => {
    h = await setup({ config: { myrPerTusd: "4.70", topupFeePct: "1.5", topupLovelace: 25_000_000n } });
    const q = h.onramp.quote("50");
    expect(q.feeMyr).toBe("0.75");
    expect(q.tusdMicro).toBe((4925n * 10_000_000n) / 4700n); // 49.25 MYR / 4.70
    const t = h.onramp.start({ userId: h.userId, amountMYR: "50" });
    expect(t.status).toBe("pending");
    const [a, b] = await Promise.all([h.onramp.confirm(t.id, { stripeEventId: "evt_1" }), h.onramp.confirm(t.id, { stripeEventId: "evt_1" })]);
    expect(a.txHash).toBeTruthy();
    expect(b.txHash).toBe(a.txHash);
    await h.onramp.confirm(t.id, { stripeEventId: "evt_1" });
    expect(h.chain.calls.operatorSend).toBe(1);
    const send = h.chain.txs.find((x) => x.kind === "operatorSend")!;
    expect(send.outputs[0]).toMatchObject({ address: h.treasury, tusdMicro: q.tusdMicro, lovelace: 25_000_000n });
    await waitFor(() => h!.onramp.get(t.id)!.status === "confirmed", 3_000, "confirmed");
    expect(h.events("topup_confirmed")).toHaveLength(1);
    // the same event id for another top-up row is ignored
    const t2 = h.onramp.start({ userId: h.userId, amountMYR: "10" });
    const r2 = await h.onramp.confirm(t2.id, { stripeEventId: "evt_1" });
    expect(r2.id).toBe(t.id);
    expect(h.chain.calls.operatorSend).toBe(1);
  });

  it("a failed send can be retried with the same event; never below 2 ADA", async () => {
    h = await setup({ config: { topupLovelace: 1n } });
    const t = h.onramp.start({ userId: h.userId, amountMYR: "20" });
    h.chain.failNext("operatorSend", 1, "operator wallet empty");
    expect((await h.onramp.confirm(t.id, { stripeEventId: "evt_x" })).status).toBe("failed");
    expect((await h.onramp.confirm(t.id, { stripeEventId: "evt_x" })).status).toBe("submitted");
    expect(h.chain.txs.find((x) => x.kind === "operatorSend")!.outputs[0]!.lovelace).toBe(2_000_000n);
  });
});

describe("reconcile on restart (spec §5.2)", () => {
  it("restarts live sessions' silos and resumes closing ones from DB + chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bulkhead-rec-"));
    const dbPath = join(dir, "db.sqlite");
    const chain = createFakeChain({ autoConfirmMs: 15 });
    try {
      h = await setup({ dbPath, chain });
      const { ids } = await startPlan(h, [spec({ name: "A" }), spec({ name: "B" })]);
      const [a, b] = ids as [string, string];
      // simulate a crash mid-run: B was killed (sweep fails) → stays CLOSING
      chain.failNext("sweep", 99, "provider down");
      await h.sessions.kill(b, "user", "x");
      await waitFor(() => h!.events("error", b).some((e) => e.data.kind === "close_failed"), 3_000, "close failed");
      await h.cleanup();
      closeDb();
      chain.failNext("sweep", 0);

      // "restart": new runtime on the same DB + chain
      h = await setup({ dbPath, chain, keepDb: false });
      expect(h.sessions.get(a)!.status).toBe("RUNNING");
      await h.sessions.reconcile();
      expect(h.stub.started).toContain(a); // silo restarted from checkpoint
      await h.sessions.whenClosed(b, 5_000);
      expect(h.chain.balance(h.sessions.get(b)!.address!).tusdMicro).toBe(0n);
    } finally {
      await h?.cleanup();
      h = null;
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
