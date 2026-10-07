"use client";
// A goal the captain planned from chat (plan_task) waits in status "planned" until the user approves
// it. The New-goal composer only covers plans made there, so this bar gives every planned goal the
// same "Approve & start" (self-custody: the connected wallet signs the funding tx).
// It also stays up for an approved-but-UNFUNDED goal (the funding tx was never submitted, e.g. the
// treasury lacked tUSD): the engine answers 409 insufficient_funds with a precise message, the bar
// offers "Top up RM50", and re-enables Approve once the top-up has confirmed on preprod.
import { useEffect, useRef, useState } from "react";
import type { GoalSummary, MeDTO } from "@bulkhead/shared";
import { ApiError, postSigned, useResource } from "@/lib/client";
import { useWalletSigner } from "@/lib/wallet-context";
import { myr, tusd } from "@/lib/money";
import { UNFUNDED_GOAL_TEXT } from "@/lib/describe";
import { TopUpDialog } from "./TopUpDialog";

/** Max time to wait for a top-up deposit before re-enabling Approve anyway. */
const TOPUP_WAIT_MS = 4 * 60_000;

export function PlannedGoalBar({ goal, rate, onStarted }: { goal: GoalSummary; rate: string; onStarted: () => void }) {
  const signer = useWalletSigner();
  const { data: me, reload: reloadMe } = useResource<MeDTO>("/me");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [faucet, setFaucet] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const [topup, setTopup] = useState(false);
  /** Set while a top-up is on its way: Approve stays disabled until the treasury balance grows. */
  const [waiting, setWaiting] = useState<{ since: number; tusdMicro: bigint; lovelace: bigint } | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const budget = BigInt(goal.budgetMicro);
  const unfunded = goal.status !== "planned";

  // Poll the treasury balance while waiting for the top-up deposit to confirm.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => reloadMe(), 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  useEffect(() => {
    if (!waiting || !me) return;
    const grew = BigInt(me.balances.tusdMicro) > waiting.tusdMicro || BigInt(me.balances.lovelace) > waiting.lovelace;
    if (grew || Date.now() - waiting.since > TOPUP_WAIT_MS) {
      setWaiting(null);
      setErr(null);
      setShort(false);
    }
  }, [me, waiting]);

  const approve = async () => {
    setBusy(true);
    setErr(null);
    setFaucet(null);
    setShort(false);
    try {
      await postSigned(`/goals/${goal.id}/approve`, {}, signer);
      onStarted();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; faucetUrl?: string; error?: string } | undefined) : undefined;
      const insufficient = body?.code === "insufficient_funds";
      setErr(insufficient && body?.error ? body.error : (e as Error).message);
      setShort(insufficient);
      setFaucet(insufficient ? (body?.faucetUrl ?? null) : null);
    } finally {
      setBusy(false);
    }
  };

  const onTopupDone = () => {
    const cur = meRef.current;
    setWaiting({ since: Date.now(), tusdMicro: BigInt(cur?.balances.tusdMicro ?? "0"), lovelace: BigInt(cur?.balances.lovelace ?? "0") });
    reloadMe();
  };

  return (
    <div className="panel p-3 flex flex-col gap-2" style={{ borderColor: "var(--violet, #4B3A9E)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="section-title">{unfunded ? UNFUNDED_GOAL_TEXT : "Plan ready — nothing is funded until you approve"}</div>
          <div className="truncate">
            <b>{goal.goal}</b> · budget {myr(budget, rate)} ({tusd(budget)}) · due {new Date(goal.deadline).toLocaleString()}
            {goal.sessions ? ` · ${goal.sessions} session(s)` : ""}
          </div>
        </div>
        <button type="button" className="btn btn-primary h-10 px-5" disabled={busy || !!waiting} onClick={approve}>
          {busy ? "Starting…" : waiting ? "Waiting for top-up…" : `Approve & start (${myr(budget, rate)})`}
        </button>
      </div>
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
          {short && (
            <button type="button" className="btn btn-sm" onClick={() => setTopup(true)}>
              Top up RM50
            </button>
          )}
        </div>
      )}
      {topup && <TopUpDialog me={me} onClose={() => setTopup(false)} onDone={onTopupDone} />}
    </div>
  );
}
