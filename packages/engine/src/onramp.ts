// Top-up simulator (spec §4). The ONLY simulated step in Bulkhead: fiat → crypto. A (test) Stripe payment
// makes the operator wallet send REAL preprod tUSD + 2 ADA to the user's treasury; the watcher confirms it.
// Idempotent by stripeEventId: topups row pending → submitted → confirmed; retries never double-pay.
import { eq } from "drizzle-orm";
import { topups, users, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { microToTusd } from "@bulkhead/shared";
import type { EventBus } from "./contracts";
import { newId, type RuntimeConfig } from "./sessions-store";

/** Spec section 4 floor: every top-up carries at least 2 ADA. The actual amount is TOPUP_ADA (default 25). */
export const TOPUP_LOVELACE_FLOOR = 2_000_000n;
export const SIMULATION_LABEL = "Testnet simulation: in production a licensed on-ramp provider converts fiat directly into your wallet.";

type TopupRow = typeof topups.$inferSelect;

export interface OnRamp {
  /** Quote: MYR → tUSD at MYR_PER_TUSD minus TOPUP_FEE_PCT. */
  quote(amountMYR: string): { amountMyr: string; feeMyr: string; netMyr: string; tusdMicro: bigint; tusd: string; rate: string; feePct: string };
  /** Create a pending top-up (POST /topups). */
  start(args: { userId: string; amountMYR: string; stripeSessionId?: string; simulated?: boolean }): TopupRow;
  /** Payment confirmed (Stripe webhook or simulated checkout). Idempotent by stripeEventId. */
  confirm(topupId: string, args: { stripeEventId: string }): Promise<TopupRow>;
  get(topupId: string): TopupRow | null;
  /** Re-attach confirmation watching for submitted top-ups (boot). */
  resume(): void;
  stop(): void;
}

/** "50" / "50.5" / "50.25" MYR → sen (hundredths). */
function toSen(myr: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(myr.trim());
  if (!m) throw new Error(`bad MYR amount: ${myr}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}
const senToMyr = (sen: bigint) => `${sen / 100n}.${(sen % 100n).toString().padStart(2, "0")}`;

export function createOnRamp(deps: { db: DB; bus: EventBus; chain: Chain; config: Pick<RuntimeConfig, "now" | "myrPerTusd" | "topupFeePct"> & Partial<Pick<RuntimeConfig, "topupLovelace">> }): OnRamp {
  const { db, bus, chain, config } = deps;
  const now = () => config.now();
  const topupLovelace = config.topupLovelace && config.topupLovelace > TOPUP_LOVELACE_FLOOR ? config.topupLovelace : TOPUP_LOVELACE_FLOOR;
  const inflight = new Map<string, Promise<TopupRow>>();
  const get = (id: string) => db.select().from(topups).where(eq(topups.id, id)).get() ?? null;
  const set = (id: string, patch: Partial<TopupRow>) => db.update(topups).set({ ...patch, updatedAt: now() }).where(eq(topups.id, id)).run();
  const watching = new Set<string>();

  const markConfirmed = (txHash: string) => {
    const t = db.select().from(topups).where(eq(topups.txHash, txHash)).get();
    if (!t || t.status !== "submitted") return;
    set(t.id, { status: "confirmed" });
    watching.delete(txHash);
    bus.emit("topup_confirmed", { data: { topupId: t.id, userId: t.userId, txHash, tusdMicro: t.tusdMicro, tusd: microToTusd(BigInt(t.tusdMicro)), amountMyr: t.amountMyr, simulated: t.simulated } });
  };
  const off = chain.watcher.on((e) => {
    if (e.type === "tx_confirmed" && watching.has(e.txHash)) markConfirmed(e.txHash);
    if (e.type === "deposit") {
      const t = db.select().from(topups).where(eq(topups.txHash, e.txHash)).get();
      if (t) {
        bus.emit("deposit_seen", { data: { address: e.address, txHash: e.txHash, amount: e.amount, topupId: t.id, userId: t.userId } });
        markConfirmed(e.txHash);
      }
    }
  });
  const watch = (txHash: string, address: string) => {
    watching.add(txHash);
    chain.watcher.watchAddress(address);
    chain.watcher.watchTx(txHash);
  };

  const ramp: OnRamp = {
    quote(amountMYR) {
      const sen = toSen(amountMYR);
      if (sen <= 0n) throw new Error("amount must be > 0");
      const feeBp = BigInt(Math.round(Number(config.topupFeePct) * 100)); // basis points
      const feeSen = (sen * feeBp + 5_000n) / 10_000n;
      const netSen = sen - feeSen;
      const rateMilli = BigInt(Math.round(Number(config.myrPerTusd) * 1000));
      // net MYR / rate = tUSD  →  micro = netSen/100 / (rateMilli/1000) * 1e6 = netSen * 10_000_000 / rateMilli
      const tusdMicro = (netSen * 10_000_000n) / rateMilli;
      return { amountMyr: senToMyr(sen), feeMyr: senToMyr(feeSen), netMyr: senToMyr(netSen), tusdMicro, tusd: microToTusd(tusdMicro), rate: config.myrPerTusd, feePct: config.topupFeePct };
    },
    start({ userId, amountMYR, stripeSessionId, simulated }) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw new Error(`user ${userId} not found`);
      const q = ramp.quote(amountMYR);
      const id = newId("top");
      const t = now();
      db.insert(topups)
        .values({ id, userId, amountMyr: q.amountMyr, feeMyr: q.feeMyr, tusdMicro: q.tusdMicro.toString(), stripeSessionId: stripeSessionId ?? null, simulated: simulated ?? !stripeSessionId, status: "pending", createdAt: t, updatedAt: t })
        .run();
      bus.emit("topup_pending", { data: { topupId: id, userId, amountMyr: q.amountMyr, feeMyr: q.feeMyr, tusd: q.tusd, simulated: simulated ?? !stripeSessionId, label: SIMULATION_LABEL } });
      return get(id)!;
    },
    get,
    async confirm(topupId, { stripeEventId }) {
      // Same Stripe event processed before (possibly for this very row) → return that row, never pay twice.
      const seen = db.select().from(topups).where(eq(topups.stripeEventId, stripeEventId)).get();
      if (seen && seen.id !== topupId) return seen;
      const running = inflight.get(topupId);
      if (running) return running;
      const p = (async () => {
        const row = get(topupId);
        if (!row) throw new Error(`top-up ${topupId} not found`);
        if (row.stripeEventId && row.stripeEventId !== stripeEventId) return row; // already settled by another event
        if (row.status === "submitted" || row.status === "confirmed") return row;
        // Claim the row atomically: pending|failed → submitted (with the event id).
        const claimed = db
          .update(topups)
          .set({ status: "submitted", stripeEventId, updatedAt: now() })
          .where(eq(topups.id, topupId))
          .run();
        if (claimed.changes === 0) return get(topupId)!;
        const user = db.select().from(users).where(eq(users.id, row.userId)).get()!;
        try {
          const res = await chain.tx.operatorSend({ toAddress: user.treasuryAddress, tusdMicro: BigInt(row.tusdMicro), lovelace: topupLovelace, reference: topupId });
          set(topupId, { txHash: res.txHash });
          bus.emit("topup_submitted", { data: { topupId, userId: row.userId, txHash: res.txHash, lovelace: topupLovelace.toString(), tusdMicro: row.tusdMicro, tusd: microToTusd(BigInt(row.tusdMicro)), address: user.treasuryAddress, simulated: row.simulated } });
          watch(res.txHash, user.treasuryAddress);
        } catch (e) {
          // Nothing was submitted: safe to retry with the same event id (status failed → submitted again).
          set(topupId, { status: "failed" });
          bus.emit("error", { data: { kind: "topup_failed", topupId, error: e instanceof Error ? e.message : String(e) } });
        }
        return get(topupId)!;
      })().finally(() => inflight.delete(topupId));
      inflight.set(topupId, p);
      return p;
    },
    resume() {
      for (const t of db.select().from(topups).where(eq(topups.status, "submitted")).all()) {
        if (!t.txHash) continue;
        const u = db.select().from(users).where(eq(users.id, t.userId)).get();
        if (u) watch(t.txHash, u.treasuryAddress);
        void chain.provider.fetchTxConfirmation(t.txHash).then((c) => c && markConfirmed(t.txHash!), () => undefined);
      }
    },
    stop() {
      off();
    },
  };
  return ramp;
}
