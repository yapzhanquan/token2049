"use client";
// Goal composer + plan preview (spec §5.9): goal, budget (MYR or tUSD), deadline, rules →
// POST /goals → preview tree of planned (dashed) sessions + total cost + funding tx preview →
// one "Approve & start" click (self-custody: the wallet signs the funding tx).
import { useEffect, useMemo, useState } from "react";
import { tusdToMicro } from "@bulkhead/shared";
import type { MeDTO, PlanResponse } from "@bulkhead/shared";
import { api, ApiError, postSigned, useConfig, useResource } from "@/lib/client";
import { ada, myr, tusd, TICKER } from "@/lib/money";
import { planToTree } from "@/lib/tree-layout";
import { Modal } from "./Modal";
import { PlanRationale, rationaleOf, stepsFromPlan } from "./PlanRationale";
import { TopUpDialog } from "./TopUpDialog";
import { TreeCanvas } from "./TreeCanvas";
import { TreeList } from "./TreeList";
import { useWalletSigner } from "@/lib/wallet-context";

/** Default OUTER deadline (advanced field): 30 minutes from now (rounded up to 5 min). The crew itself is
 * time-boxed by the engine's work time (WORK_DEADLINE_SECONDS, shown as "Work time"). */
function defaultDeadline(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function GoalComposer({ me: meProp, onClose, onStarted }: { me: MeDTO | null; onClose: () => void; onStarted: (goalId: string) => void }) {
  const { fixture } = useConfig();
  // Own /me read so the treasury balance can be polled while a top-up confirms.
  const { data: meLive, reload: reloadMe } = useResource<MeDTO>("/me");
  const me = meLive ?? meProp;
  const rate = me?.myrPerTusd ?? "4.70";
  /** WORK_DEADLINE_SECONDS from the engine (/me); 60 s when the engine does not say. */
  const workSecs = me?.workDeadlineSeconds ?? 60;
  const signer = useWalletSigner();
  const [goal, setGoal] = useState("");
  const [unit, setUnit] = useState<"MYR" | "tUSD">("MYR");
  const [amount, setAmount] = useState("60");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [rules, setRules] = useState("Only pay agents from the market catalog. Ask me before any payment over RM5.");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [faucet, setFaucet] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [topup, setTopup] = useState(false);
  /** A top-up is on its way: Approve stays disabled until the treasury balance grows (or 4 min pass). */
  const [waiting, setWaiting] = useState<{ since: number; tusdMicro: bigint; lovelace: bigint } | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => reloadMe(), 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  useEffect(() => {
    if (!waiting || !me) return;
    if (BigInt(me.balances.tusdMicro) > waiting.tusdMicro || BigInt(me.balances.lovelace) > waiting.lovelace || Date.now() - waiting.since > 4 * 60_000) {
      setWaiting(null);
      setErr(null);
      setInsufficient(false);
    }
  }, [me, waiting]);
  const onTopupDone = () => {
    setWaiting({ since: Date.now(), tusdMicro: BigInt(me?.balances.tusdMicro ?? "0"), lovelace: BigInt(me?.balances.lovelace ?? "0") });
    reloadMe();
  };

  const budgetTUSD = useMemo(() => {
    const v = Number(amount);
    if (!(v > 0)) return "";
    return unit === "tUSD" ? v.toFixed(6).replace(/\.?0+$/, "") : (v / Number(rate)).toFixed(6).replace(/\.?0+$/, "");
  }, [amount, unit, rate]);

  const propose = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<PlanResponse>("/goals", { body: { goal: goal.trim(), budgetTUSD, deadline: new Date(deadline).toISOString(), rules: rules.trim() } });
      setPlan(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    setInsufficient(false);
    try {
      setFaucet(null);
      await postSigned(`/goals/${plan.goalId}/approve`, {}, signer);
      onStarted(plan.goalId);
    } catch (e) {
      // 409 insufficient_funds: the engine's precise "Your treasury has … ; this plan needs …" + Top up + faucet link.
      const body = e instanceof ApiError ? (e.body as { code?: string; faucetUrl?: string; error?: string } | undefined) : undefined;
      const short = body?.code === "insufficient_funds";
      setErr(short && body?.error ? body.error : (e as Error).message);
      setInsufficient(short);
      setFaucet(short ? (body?.faucetUrl ?? null) : null);
    } finally {
      setBusy(false);
    }
  };

  const total = plan ? plan.plan.sessions.reduce((a, s) => a + tusdToMicro(s.budgetTUSD), 0n) : 0n;
  const treasury = BigInt(me?.balances.tusdMicro ?? "0");
  const short = plan ? total > treasury : false;
  const tree = plan ? planToTree(plan.goalId, goal, plan.plan, (t) => myr(tusdToMicro(t), rate)) : null;

  return (
    <>
    <Modal title={plan ? "Plan preview" : "New goal"} subtitle={plan ? "Nothing is funded until you approve." : "The captain plans parallel sessions, each with its own wallet and mandate."} onClose={onClose} width={1100}>
      {!plan ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void propose();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="label">Goal</span>
            <textarea className="input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Research competitors and buy one pricing report" maxLength={500} required />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <span className="label">Budget</span>
              <div className="flex gap-2">
                <input className="input" style={{ width: 110 }} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
                <div className="seg">
                  {(["MYR", "tUSD"] as const).map((u) => (
                    <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)}>
                      {u === "tUSD" ? TICKER : u}
                    </button>
                  ))}
                </div>
              </div>
              <span className="text-[11.5px] muted">{budgetTUSD ? `= ${budgetTUSD} ${TICKER} ≈ ${myr(tusdToMicro(budgetTUSD), rate)}` : ""}</span>
            </label>
            <div className="flex flex-col gap-1">
              <span className="label">Work time</span>
              <div className="input flex items-center" style={{ width: 150 }} aria-readonly="true" title="Each session works this long after its wallet is funded, then hands back what it has.">
                <b className="tabular-nums">{workSecs > 0 ? `${workSecs} s` : "no limit"}</b>
              </div>
              <span className="text-[11.5px] muted">per session, from funding · partial results at the limit</span>
            </div>
          </div>
          <details className="text-[12.5px]">
            <summary className="cursor-pointer mid">Advanced: outer deadline</summary>
            <label className="flex flex-col gap-1 mt-2">
              <span className="label">Deadline (outer bound)</span>
              <input className="input" style={{ maxWidth: 260 }} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} required />
              <span className="text-[11.5px] muted">The crew is time-boxed by the work time; wallet expiry is set by the engine (work + funding / close confirmation windows).</span>
            </label>
          </details>
          <label className="flex flex-col gap-1">
            <span className="label">Rules</span>
            <textarea className="input" rows={2} value={rules} onChange={(e) => setRules(e.target.value)} maxLength={1000} />
          </label>
          {me && (
            <div className="text-[12px] mid">
              Treasury: {myr(me.balances.tusdMicro, rate)} ({tusd(me.balances.tusdMicro)}) · {me.custody === "self" ? "Self-custody: your wallet signs the funding tx." : "Custodial on testnet."}
            </div>
          )}
          {err && (
            <div className="banner banner-bad">
              {err}
              {faucet && (
                <>
                  {" "}
                  Top up, or get test ADA from the{" "}
                  <a href={faucet} target="_blank" rel="noreferrer">
                    preprod faucet
                  </a>
                  .
                </>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={busy || !goal.trim() || !budgetTUSD}>
              {busy ? "Planning…" : "Plan it"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="panel only-wide" style={{ height: 380, boxShadow: "none" }}>
            {tree && <TreeCanvas tree={tree} selected={selected} onSelect={setSelected} showLegend={false} />}
          </div>
          <div className="only-narrow">{tree && <TreeList tree={tree} selected={selected} onSelect={setSelected} />}</div>
          <table className="grid">
            <thead>
              <tr>
                <th></th>
                <th>Session</th>
                <th>Task</th>
                <th className="num">Budget</th>
                <th className="num">Max / payment</th>
                <th className="num">Ask me above</th>
                <th>Payees</th>
              </tr>
            </thead>
            <tbody>
              {plan.plan.sessions.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{String.fromCharCode(65 + i)}</td>
                  <td>
                    <b>{s.role}</b> <span className="muted">· {s.name}</span>
                    <div className="text-[12px] mid">{s.goal}</div>
                    {s.contextFrom.length > 0 && <div className="text-[11.5px] good">receives handback from {s.contextFrom.map((c) => String.fromCharCode(65 + c)).join(", ")} (data)</div>}
                  </td>
                  <td>
                    <span className="tag chip-task">{s.taskType}</span>
                  </td>
                  <td className="num">{myr(tusdToMicro(s.budgetTUSD), rate)}</td>
                  <td className="num">{myr(tusdToMicro(s.perPaymentMaxTUSD), rate)}</td>
                  <td className="num">{myr(tusdToMicro(s.approvalThresholdTUSD), rate)}</td>
                  <td className="text-[12px]">{s.allowedPayees.length ? s.allowedPayees.join(", ") : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="panel p-3" style={{ boxShadow: "none", borderColor: "color-mix(in srgb, var(--good) 30%, var(--rule))" }}>
            <PlanRationale rationale={rationaleOf(plan, plan.plan)} steps={stepsFromPlan(plan.plan)} rate={rate} />
          </div>
          <div className="panel p-3 flex flex-col gap-1" style={{ boxShadow: "none" }}>
            <div className="section-title">Funding transaction preview</div>
            <dl className="kv">
              <dt>Total budget</dt>
              <dd>
                <b>{myr(total, rate)}</b> ({tusd(total)}){" "}
                {short && (
                  <>
                    <span className="bad">
                      · Your treasury has {tusd(treasury)}; this plan needs {tusd(total)} (≈ {myr(total, rate)}). Top up first.
                    </span>{" "}
                    {!waiting && (
                      <button type="button" className="btn btn-sm" onClick={() => setTopup(true)}>
                        Top up RM50
                      </button>
                    )}
                  </>
                )}
              </dd>
              {plan.fundingPreview.error && (
                <>
                  <dt>Preview</dt>
                  <dd className="muted">Exact fee unavailable right now; the treasury balance is checked again when you approve.</dd>
                </>
              )}
              <dt>Min-ADA carried</dt>
              <dd>{ada(plan.fundingPreview.totalLovelace)}</dd>
              <dt>Network fee</dt>
              <dd>{ada(plan.fundingPreview.feeLovelace)} (estimate)</dd>
              <dt>Outputs</dt>
              <dd>
                One transaction from your treasury to {plan.plan.sessions.length} session wallets (native-script addresses). Each wallet holds exactly its budget, so the cap is
                enforced on-chain.
              </dd>
              <dt>Signed by</dt>
              <dd>{me?.custody === "self" ? "your wallet (CIP-30) — you will be asked to sign" : "the server-held treasury key (custodial on testnet)"}</dd>
            </dl>
          </div>
          {fixture && <div className="banner banner-warn">Fixture mode: approving starts simulated sessions; nothing is submitted on-chain.</div>}
          {waiting && (
            <div className="banner" aria-live="polite">
              Top-up submitted — waiting for the deposit to confirm on preprod (usually under a minute). Approve re-enables when your treasury balance updates.
            </div>
          )}
          {err && !waiting && (
            <div className="banner banner-bad flex flex-wrap items-center gap-2" role="alert">
              <span className="min-w-0 flex-1">
                {err}
                {faucet && (
                  <>
                    {" "}
                    For tADA, use the{" "}
                    <a href={faucet} target="_blank" rel="noreferrer">
                      preprod faucet
                    </a>
                    .
                  </>
                )}
              </span>
              {insufficient && (
                <button type="button" className="btn btn-sm" onClick={() => setTopup(true)}>
                  Top up RM50
                </button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary h-10 px-5" disabled={busy || short || !!waiting} onClick={approve}>
              {busy ? "Starting…" : waiting ? "Waiting for top-up…" : `Approve & start (${myr(total, rate)})`}
            </button>
            <button type="button" className="btn h-10" disabled={busy} onClick={() => setPlan(null)}>
              Edit goal
            </button>
          </div>
        </div>
      )}
    </Modal>
    {topup && <TopUpDialog me={me} onClose={() => setTopup(false)} onDone={onTopupDone} />}
    </>
  );
}
