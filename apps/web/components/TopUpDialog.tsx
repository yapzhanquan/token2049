"use client";
// Top up RM50: Stripe Checkout (test mode) when configured, else a clearly labelled simulated
// checkout. Both end at the engine's POST /topups/:id/confirm (idempotent by event id), which sends
// REAL preprod settlement asset (tUSDM by default) + ADA from the operator wallet to the treasury.
import { useState } from "react";
import type { MeDTO, TopupStartResponse } from "@bulkhead/shared";
import { api, useConfig } from "@/lib/client";
import { ada, tusd, TICKER } from "@/lib/money";
import { Modal } from "./Modal";

export const ONRAMP_BANNER = "Testnet simulation: in production a licensed on-ramp provider converts fiat directly into your wallet.";

export function TopUpDialog({ me, onClose, onDone }: { me: MeDTO | null; onClose: () => void; onDone: () => void }) {
  const { stripe } = useConfig();
  const [amount, setAmount] = useState(50);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const rate = Number(me?.myrPerTusd ?? "4.70");
  const feePct = Number(me?.topupFeePct ?? "1.5");
  const fee = (amount * feePct) / 100;
  const est = (amount - fee) / rate;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ mode: "stripe" | "simulated"; url?: string; topup: TopupStartResponse }>("/topup", { base: "/api", body: { amountMYR: amount } });
      if (r.mode === "stripe" && r.url) {
        window.location.href = r.url;
        return;
      }
      const c = await api<{ topup?: { status?: string; txHash?: string | null } }>("/topup/simulate", { base: "/api", body: { topupId: r.topup.topupId } });
      setResult(
        `Top-up ${r.topup.topupId}: ${c.topup?.status ?? "submitted"}. ${tusd(r.topup.tusdMicro)} + 2 ADA are on their way to your treasury; the balance updates when the deposit confirms on preprod.`,
      );
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Top up RM${amount}`} subtitle={`Fiat → ${TICKER} on Cardano preprod`} onClose={onClose} width={480}>
      <div className="flex flex-col gap-3">
        <div className="banner banner-warn">
          <span>
            <b>{ONRAMP_BANNER}</b>
          </span>
        </div>
        <div className="flex gap-2">
          {[20, 50, 100].map((v) => (
            <button key={v} type="button" className="btn" aria-pressed={amount === v} style={amount === v ? { borderColor: "var(--good)", color: "var(--good)" } : undefined} onClick={() => setAmount(v)}>
              RM{v}
            </button>
          ))}
        </div>
        <dl className="kv">
          <dt>Amount</dt>
          <dd>RM {amount.toFixed(2)}</dd>
          <dt>Fee ({feePct}%)</dt>
          <dd>RM {fee.toFixed(2)}</dd>
          <dt>Rate</dt>
          <dd>1 {TICKER} = RM {rate.toFixed(2)}</dd>
          <dt>You receive</dt>
          <dd>
            ≈ {est.toFixed(2)} {TICKER} + 2 ADA (for fees / min-UTxO) at <span className="mono">{me ? `${me.treasuryAddress.slice(0, 18)}…` : "your treasury"}</span>
          </dd>
          {me && (
            <>
              <dt>Current</dt>
              <dd>
                {tusd(me.balances.tusdMicro)} · {ada(me.balances.lovelace)}
              </dd>
            </>
          )}
        </dl>
        {stripe ? (
          <button type="button" className="btn btn-primary h-10" disabled={busy} onClick={go}>
            Pay RM{amount} with Stripe (test mode)
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary h-10" disabled={busy} onClick={go}>
              Simulated checkout (testnet) — RM{amount}
            </button>
            <div className="text-[12px] muted">
              Stripe is not configured (no STRIPE_SECRET_KEY), so no card is charged. The engine still runs the real on-ramp step: an operator
              transfer of {TICKER} + ADA on preprod.
            </div>
          </>
        )}
        {stripe && <div className="text-[12px] muted">Test card: 4242 4242 4242 4242, any future date, any CVC.</div>}
        {result && <div className="banner">{result}</div>}
        {err && <div className="banner banner-bad">{err}</div>}
      </div>
    </Modal>
  );
}
