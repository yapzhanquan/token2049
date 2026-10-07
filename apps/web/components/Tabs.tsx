"use client";
// Spending, Logbook and Decisions tabs (spec §6.6 + v2 §4).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision } from "@bulkhead/shared";
import type { GoalSummary, LogbookEntryDTO, MeDTO, SpendingDTO } from "@bulkhead/shared";
import { api, useLive, useResource } from "@/lib/client";
import { DECISION_WORD } from "@/lib/describe";
import { ada, big, dateTimeOf, myr, pct, tusd } from "@/lib/money";
import { Reconnecting } from "./IdChip";
import { TxLink } from "./Links";
import { decisionText, StatusTag } from "./SessionPanel";
import { useWalletState } from "@/lib/wallet-context";
import { answerDecision, shortHash, type DecisionEvidenceDTO } from "@/lib/wallet-decisions";

// ───────────── Spending ─────────────
export function SpendingTab({ me, onSelect }: { me: MeDTO | null; onSelect: (sessionId: string, goalId: string) => void }) {
  const { data, error, reconnecting } = useResource<SpendingDTO>("/spending");
  const rate = me?.myrPerTusd ?? "4.70";
  if (error && !data) return <div className="banner banner-bad">{error}</div>;
  if (!data) return reconnecting ? <Reconnecting className="p-4" /> : <div className="muted p-4">Loading…</div>;
  const maxBudget = data.perSession.reduce((m, s) => (big(s.budgetMicro) > m ? big(s.budgetMicro) : m), 1n);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Stat label="Treasury now" value={me ? myr(me.balances.tusdMicro, rate) : "…"} sub={me ? `${tusd(me.balances.tusdMicro)} · ${ada(me.balances.lovelace)}` : ""} />
        <Stat label="Spent by sessions" value={myr(data.totals.spentMicro, rate)} sub={tusd(data.totals.spentMicro)} />
        <Stat label="Refunds returned" value={myr(data.totals.refundMicro, rate)} sub="swept back on close" tone="good" />
        <Stat label="Fees" value={ada(data.totals.feesLovelace)} sub={`network · top-up fees RM ${data.totals.topupFeesMyr}`} />
      </div>
      <div className="panel p-4">
        <div className="section-title">Treasury balance over time</div>
        <BalanceChart points={data.balanceHistory} rate={rate} />
      </div>
      <div className="panel p-4 overflow-x-auto">
        <div className="section-title">Spend per session</div>
        <table className="grid">
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th style={{ width: "28%" }}>Spent of budget</th>
              <th className="num">Spent</th>
              <th className="num">Refund</th>
              <th className="num">Fees</th>
            </tr>
          </thead>
          <tbody>
            {data.perSession.map((s) => (
              <tr key={s.sessionId} className="cursor-pointer" onClick={() => onSelect(s.sessionId, s.goalId)}>
                <td>
                  <b>{s.letter}</b> {s.role}
                </td>
                <td>
                  <StatusTag status={s.status} />
                </td>
                <td>
                  <div className="bar" style={{ width: `${Math.max(8, Number((big(s.budgetMicro) * 100n) / maxBudget))}%` }} title={`${pct(s.spentMicro, s.budgetMicro)}% of budget`}>
                    <span style={{ width: `${pct(s.spentMicro, s.budgetMicro)}%` }} />
                  </div>
                </td>
                <td className="num">{myr(s.spentMicro, rate)}</td>
                <td className="num good">{s.refundMicro !== null ? myr(s.refundMicro, rate) : "—"}</td>
                <td className="num muted">{ada(s.feesLovelace)}</td>
              </tr>
            ))}
            {data.perSession.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="panel p-4 overflow-x-auto">
        <div className="section-title">Top-ups</div>
        <table className="grid">
          <thead>
            <tr>
              <th>When</th>
              <th className="num">Paid</th>
              <th className="num">Fee</th>
              <th className="num">Received</th>
              <th>Status</th>
              <th>Deposit tx</th>
            </tr>
          </thead>
          <tbody>
            {data.topups.map((t) => (
              <tr key={t.id}>
                <td>
                  {dateTimeOf(t.createdAt)} {t.simulated && <span className="tag">simulated checkout</span>}
                </td>
                <td className="num">RM {t.amountMyr}</td>
                <td className="num">RM {t.feeMyr}</td>
                <td className="num">{tusd(t.tusdMicro)}</td>
                <td>
                  <span className={`tag ${t.status === "confirmed" ? "tag-good" : t.status === "failed" ? "tag-bad" : "tag-warn"}`}>{t.status}</span>
                </td>
                <td>
                  <TxLink hash={t.txHash} />
                </td>
              </tr>
            ))}
            {data.topups.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No top-ups yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" }) {
  return (
    <div className="panel p-3">
      <div className="label">{label}</div>
      <div className={`text-[20px] font-semibold tabular-nums ${tone === "good" ? "good" : ""}`}>{value}</div>
      {sub && <div className="text-[12px] muted">{sub}</div>}
    </div>
  );
}

/** Single-series step line in the brand violet; hover crosshair + tooltip; table view below. */
function BalanceChart({ points, rate }: { points: { at: number; tusdMicro: string }[]; rate: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 860;
  const H = 220;
  const P = { l: 64, r: 16, t: 12, b: 26 };
  const pts = useMemo(() => [...points].sort((a, b) => a.at - b.at), [points]);
  if (pts.length < 2) return <div className="muted text-[12px]">Not enough history yet.</div>;
  const t0 = pts[0]!.at;
  const t1 = Math.max(pts[pts.length - 1]!.at, t0 + 1);
  const vals = pts.map((p) => Number(big(p.tusdMicro)) / 1e6);
  const vmax = Math.max(...vals, 1) * 1.1;
  const x = (t: number) => P.l + ((t - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / vmax) * (H - P.t - P.b);
  let d = `M${x(pts[0]!.at)} ${y(vals[0]!)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i]!.at)} V${y(vals[i]!)}`;
  const ticks = [0, vmax / 2, vmax];
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const tx = t0 + (((e.clientX - r.left) / r.width) * W - P.l) / (W - P.l - P.r) * (t1 - t0);
    let idx = 0;
    for (let i = 0; i < pts.length; i++) if (pts[i]!.at <= tx) idx = i;
    setHover(idx);
  };
  const h = hover !== null ? pts[hover] : null;
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Treasury balance over time">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--rule-soft)" />
            <text x={P.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-faint)" className="mono">
              RM{(v * Number(rate)).toFixed(0)}
            </text>
          </g>
        ))}
        <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--rule)" />
        <text x={P.l} y={H - 8} fontSize="11" fill="var(--ink-faint)">
          {dateTimeOf(t0)}
        </text>
        <text x={W - P.r} y={H - 8} fontSize="11" fill="var(--ink-faint)" textAnchor="end">
          {dateTimeOf(t1)}
        </text>
        <path d={d} fill="none" stroke="var(--good)" strokeWidth="2" strokeLinejoin="round" />
        {h && hover !== null && (
          <g>
            <line x1={x(h.at)} x2={x(h.at)} y1={P.t} y2={H - P.b} stroke="var(--ink-faint)" strokeDasharray="3 3" />
            <circle cx={x(h.at)} cy={y(vals[hover]!)} r={4.5} fill="var(--good)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(h.at) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}>
          {dateTimeOf(h.at)} · <b>{myr(h.tusdMicro, rate)}</b> ({tusd(h.tusdMicro)})
        </div>
      )}
      <details className="mt-2">
        <summary className="text-[12px] mid cursor-pointer">Table view</summary>
        <table className="grid mt-1">
          <tbody>
            {pts.map((p) => (
              <tr key={p.at}>
                <td>{dateTimeOf(p.at)}</td>
                <td className="num">{myr(p.tusdMicro, rate)}</td>
                <td className="num muted">{tusd(p.tusdMicro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ───────────── Logbook ─────────────
export function LogbookTab({ me, goals, onSelect }: { me: MeDTO | null; goals: GoalSummary[]; onSelect: (sessionId: string, goalId: string) => void }) {
  const { data, error, reconnecting } = useResource<LogbookEntryDTO[]>("/logbook");
  const [goal, setGoal] = useState("all");
  const rate = me?.myrPerTusd ?? "4.70";
  if (error && !data) return <div className="banner banner-bad">{error}</div>;
  if (!data) return reconnecting ? <Reconnecting className="p-4" /> : <div className="muted p-4">Loading…</div>;
  const rows = data.filter((r) => goal === "all" || r.goalId === goal);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="label">Goal</span>
        <select className="input" style={{ width: "auto", maxWidth: 420 }} value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="all">All goals</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.goal}
            </option>
          ))}
        </select>
        <span className="text-[12px] muted ml-auto">{rows.length} closed sessions</span>
      </div>
      {rows.length === 0 && <div className="muted">No closed sessions yet.</div>}
      {rows.map((r) => (
        <div key={r.sessionId} className="panel p-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="font-semibold text-left" onClick={() => onSelect(r.sessionId, r.goalId)}>
              {r.letter} {r.role}
            </button>
            <span className="tag chip-task">{r.taskType}</span>
            <StatusTag status={r.status} />
            <span className="text-[12px] muted">{r.goalText}</span>
            <span className="text-[12px] muted ml-auto">{r.endedAt ? dateTimeOf(r.endedAt) : ""}</span>
          </div>
          {r.handback ? (
            <details>
              <summary className="cursor-pointer">{r.handback.summary}</summary>
              <pre className="mono text-[11.5px] whitespace-pre-wrap mt-2 mb-0">{r.handback.result}</pre>
            </details>
          ) : (
            <div className="muted text-[12.5px]">No handback.</div>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
            <span>
              <span className="label">spent </span>
              {myr(r.spentMicro, rate)}
            </span>
            <span>
              <span className="label">refund </span>
              <span className="good">{r.refundMicro !== null ? myr(r.refundMicro, rate) : "—"}</span>
            </span>
            <span>
              <span className="label">close tx </span>
              <TxLink hash={r.closeTx} />
            </span>
            {r.logSha256 && (
              <span className="mono text-[11px]" title={r.logSha256}>
                <span className="label">log </span>
                {r.logSha256.slice(0, 16)}…
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────── Decisions ─────────────
export function DecisionsTab({ me, onSelect }: { me: MeDTO | null; onSelect: (sessionId: string) => void }) {
  const { data, error, reconnecting, reload } = useResource<Decision[]>("/decisions");
  const { bump } = useLive();
  const wallet = useWalletState();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, DecisionEvidenceDTO>>({});
  const rate = me?.myrPerTusd ?? "4.70";
  // Wallet-signature evidence (self-custody approvals signed with CIP-30 signData, verified by the engine).
  useEffect(() => {
    let live = true;
    api<Record<string, DecisionEvidenceDTO>>("/wallet-auth/evidence", { base: "/api" })
      .then((ev) => {
        if (live) setEvidence(ev ?? {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [data]);
  if (error && !data) return <div className="banner banner-bad">{error}</div>;
  if (!data) return reconnecting ? <Reconnecting className="p-4" /> : <div className="muted p-4">Loading…</div>;
  const sorted = [...data].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.createdAt - a.createdAt);
  const decide = async (d: Decision, status: "approved" | "rejected") => {
    setBusy(d.id);
    setErr(null);
    try {
      await answerDecision(d, status, { me, wallet });
      reload();
      bump();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {err && <div className="banner banner-bad">{err}</div>}
      {sorted.length === 0 && <div className="muted">No decisions yet.</div>}
      {sorted.map((d) => (
        <div key={d.id} className={`panel p-3 flex flex-col gap-1 ${d.status === "open" ? "" : "opacity-70"}`} style={d.status === "open" ? { borderColor: "color-mix(in srgb, var(--warn) 45%, var(--rule))" } : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`tag ${d.status === "open" ? "tag-warn" : d.status === "approved" ? "tag-good" : "tag-bad"}`}>{d.status}</span>
            <b>{DECISION_WORD[d.kind] ?? d.kind}</b>
            <span className="text-[12px] muted">requested by {d.requestedBy} · {dateTimeOf(d.createdAt)}</span>
            <button type="button" className="btn btn-sm ml-auto" onClick={() => onSelect(d.sessionId)}>
              Go to node →
            </button>
          </div>
          <div className="text-[13px]">{decisionText(d, rate)}</div>
          {d.status === "open" ? (
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy === d.id} onClick={() => decide(d, "approved")}>
                {d.kind === "payment_approval" && d.details.amountMicro ? `Approve ${myr(String(d.details.amountMicro), rate)}` : "Approve"}
                {me?.custody === "self" ? " (sign with wallet)" : ""}
              </button>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy === d.id} onClick={() => decide(d, "rejected")}>
                Reject
              </button>
              {me?.custody === "self" && <span className="text-[12px] muted">Your wallet signs the approval message (CIP-30 signData, no fee).</span>}
            </div>
          ) : (
            <div className="text-[12px] muted flex flex-wrap items-center gap-2">
              <span>
                {d.status} {d.decidedBy ? `by ${d.decidedBy}` : ""} {d.decidedAt ? `· ${dateTimeOf(d.decidedAt)}` : ""}
              </span>
              {d.status === "approved" && evidence[d.id] && <WalletSigned ev={evidence[d.id]!} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** "Signed by wallet ✓": this approval carries a CIP-8 COSE_Sign1 from the treasury wallet, verified by the engine. */
function WalletSigned({ ev }: { ev: DecisionEvidenceDTO }) {
  const title = [
    "CIP-30 signData (CIP-8 COSE_Sign1), verified by the engine against the treasury address",
    `key hash: ${ev.keyHash}`,
    `address: ${ev.address}`,
    `signed: ${new Date(ev.signedAt).toISOString()}`,
    "",
    ev.payload,
  ].join("\n");
  return (
    <span className="tag tag-good" title={title}>
      Signed by wallet ✓ <span className="mono">key {shortHash(ev.keyHash)}</span>
    </span>
  );
}
