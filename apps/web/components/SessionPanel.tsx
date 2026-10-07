"use client";
// Session detail panel (spec §6.5 + v2 §2–§4): status + expiry, task type + definition of done,
// MANDATE, WALLET, CONTEXT IN, controls, decisions, MESSAGE BOX, PEEK, LIVE ACTIVITY, mandate
// controls, ON CLOSE.
import { useEffect, useRef, useState } from "react";
import { glyphFor, type Decision } from "@bulkhead/shared";
import type { MeDTO, SessionDetailDTO } from "@bulkhead/shared";
import { api, postSigned, useLive, useNow, useResource } from "@/lib/client";
import { DECISION_WORD, describeEvent, sessionStatusWord } from "@/lib/describe";
import { big, dateTimeOf, duration, myr, pct, shortAddr, timeOf, tokens, tusd, TICKER } from "@/lib/money";
import { GlyphIcon } from "./Glyph";
import { IdChip, Reconnecting } from "./IdChip";
import { AddrLink, TxLink } from "./Links";
import { useWalletSigner, useWalletState } from "@/lib/wallet-context";
import { answerDecision } from "@/lib/wallet-decisions";

const ENDED = ["CLOSED", "KILLED", "FAILED", "EXPIRED", "CLOSING"];

export function SessionPanel({ sessionId, me, onClose, onActivity }: { sessionId: string; me: MeDTO | null; onClose: () => void; onActivity?: (q: string) => void }) {
  const { data: s, error, reconnecting, reload } = useResource<SessionDetailDTO>(`/sessions/${sessionId}`);
  const { bump } = useLive();
  const now = useNow(1000);
  const rate = me?.myrPerTusd ?? "4.70";
  const signer = useWalletSigner();
  const wallet = useWalletState();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  if (error && !s) return <div className="panel p-4 bad">Could not load session: {error}</div>;
  if (!s)
    return (
      <div className="panel p-4 flex flex-col gap-2">
        {reconnecting ? <Reconnecting what="session" /> : <span className="muted">Loading session…</span>}
        <IdChip value={sessionId} label="session" onPick={onActivity} />
      </div>
    );

  const openDecisions = s.decisions.filter((d) => d.status === "open");
  const hasPayment = openDecisions.some((d) => d.kind === "payment_approval") || s.pendingPayments.length > 0;
  const glyph = glyphFor(s.status, hasPayment);
  const ended = ENDED.includes(s.status);
  const left = s.mandate.expiresAt - now;

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: "good", text: ok });
      reload();
      bump();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const control = (action: string, body: Record<string, unknown> = {}, ok?: string) =>
    run(action, () => postSigned(`/sessions/${s.id}/${action}`, body, signer), ok);
  const decide = (d: Decision, status: "approved" | "rejected") =>
    run(`d-${d.id}`, () => answerDecision(d, status, { me, wallet }), `${DECISION_WORD[d.kind] ?? d.kind}: ${status}`);

  return (
    <div className="panel flex flex-col">
      {/* Title */}
      <div className="p-4 flex flex-col gap-2 border-b" style={{ borderColor: "var(--rule)" }}>
        <div className="flex items-start gap-2">
          <span style={{ paddingTop: 3 }}>
            <GlyphIcon kind={glyph} size={18} animate />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[15px]">
              {s.letter} {s.role} — {s.name}
            </div>
            <div className="text-[12px] mid">{s.goal}</div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <IdChip value={s.id} label="session" onPick={onActivity} />
              {onActivity && (
                <button type="button" className="btn btn-sm btn-ghost" style={{ height: 22, fontSize: 11.5 }} onClick={() => onActivity(s.id)}>
                  Activity log →
                </button>
              )}
            </div>
            {reconnecting && <Reconnecting what="session" className="mt-1" />}
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <StatusTag status={s.status} awaiting={hasPayment} />
          <span className="tag chip-task">{s.taskType}</span>
          {s.tainted && <span className="tag tag-warn">tainted input</span>}
          {!ended && <span className={`tag ${left < 15 * 60_000 ? "tag-warn" : ""}`}>{left > 0 ? `expires in ${duration(left)}` : "expired"}</span>}
          <span className="muted">{tokens(s.tokensUsed)}</span>
          {s.startedAt && <span className="muted">· {duration((s.endedAt ?? now) - s.startedAt)} elapsed</span>}
        </div>
        <div className="text-[12px]">
          <span className="label">Definition of done: </span>
          {s.definitionOfDone}
          {s.doneAttempts > 0 && <span className="muted"> · attempt {s.doneAttempts} of 2</span>}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-5">
        {/* Controls */}
        {!ended && (
          <div className="flex flex-wrap gap-2">
            {s.status === "RUNNING" && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => control("pause", {}, "Paused")}>
                Pause
              </button>
            )}
            {s.status === "PAUSED" && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => control("resume", {}, "Resumed")}>
                Resume
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm(`Kill ${s.letter} ${s.role}? It goes to CLOSING and all leftover funds are swept back to your treasury.`))
                  void control("kill", { reason: "killed by user" }, "Killed — sweeping leftovers to treasury");
              }}
            >
              Kill
            </button>
            {s.pendingPayments
              .filter((p) => !openDecisions.some((d) => d.details.paymentId === p.id))
              .map((p) => (
                <span key={p.id} className="flex gap-2">
                  <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run(`p-${p.id}`, () => postSigned(`/payments/${p.id}/approve`, {}, signer), "Payment approved")}>
                    Approve {myr(p.amountMicro, rate)}
                  </button>
                  <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => run(`p-${p.id}`, () => api(`/payments/${p.id}/reject`, { body: {} }), "Payment rejected")}>
                    Reject
                  </button>
                </span>
              ))}
          </div>
        )}

        {/* Open decisions for this session */}
        {openDecisions.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="section-title">Needs your decision</h3>
            {openDecisions.map((d) => (
              <div key={d.id} className="banner banner-warn flex-col">
                <div>
                  <b>{DECISION_WORD[d.kind] ?? d.kind}</b> <span className="muted">· requested by {d.requestedBy}</span>
                </div>
                <div className="text-[12.5px]">{decisionText(d, rate)}</div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => decide(d, "approved")}>
                    {d.kind === "payment_approval" && d.details.amountMicro ? `Approve ${myr(String(d.details.amountMicro), rate)}` : "Approve"}
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => decide(d, "rejected")}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
        {msg && <div className={`banner ${msg.tone === "bad" ? "banner-bad" : ""}`}>{msg.text}</div>}

        {/* Mandate */}
        <section>
          <h3 className="section-title">Mandate</h3>
          <dl className="kv">
            <dt>Budget</dt>
            <dd>
              {myr(s.mandate.budgetMicro, rate)} <span className="muted">({tusd(s.mandate.budgetMicro)})</span>
            </dd>
            <dt>Per-payment max</dt>
            <dd>{myr(s.mandate.perPaymentMaxMicro, rate)}</dd>
            <dt>Ask me above</dt>
            <dd>{myr(s.mandate.approvalThresholdMicro, rate)}</dd>
            <dt>Allowed payees</dt>
            <dd>
              {s.mandate.allowedPayees.length === 0 ? (
                <span className="muted">none (this session cannot pay anyone)</span>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
                  {s.mandate.allowedPayees.map((p) => (
                    <li key={p.id} data-testid={p.handle ? "payee-handle" : undefined}>
                      {p.handle ? (
                        <span
                          className="mono"
                          title={`ADA Handle ${p.handle} → ${p.address}${p.resolvedAt ? ` (resolved on-chain ${dateTimeOf(p.resolvedAt)}; pinned)` : ""}`}
                        >
                          {p.handle}
                        </span>
                      ) : (
                        p.label
                      )}{" "}
                      <span className="mono muted text-[11px]">{shortAddr(p.address, 8)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Expires</dt>
            <dd>{dateTimeOf(s.mandate.expiresAt)}</dd>
          </dl>
          {!ended && <MandateControls s={s} busy={!!busy} control={control} rate={rate} />}
        </section>

        {/* Wallet */}
        <section>
          <h3 className="section-title">Wallet</h3>
          {s.wallet.mode === "vault" && (
            <p className="mb-2 text-[12px] good" data-testid="vault-enforced">
              Enforced on-chain by Bulkhead Session Vault
            </p>
          )}
          <dl className="kv">
            <dt>{s.wallet.mode === "vault" ? "Vault address" : "Address"}</dt>
            <dd>
              {s.wallet.address ? <IdChip value={s.wallet.address} kind="addr" onPick={onActivity} /> : <AddrLink address={null} />}
            </dd>
            {s.wallet.mode === "vault" && (
              <>
                <dt>Script hash</dt>
                <dd>
                  <span className="mono" title={s.wallet.scriptHash ?? undefined}>
                    {s.wallet.scriptHash ? `${s.wallet.scriptHash.slice(0, 12)}…${s.wallet.scriptHash.slice(-6)}` : "—"}
                  </span>
                </dd>
              </>
            )}
            {s.wallet.fundingTx && (
              <>
                <dt>Funded by</dt>
                <dd>
                  {s.wallet.fundingTx ? <IdChip value={s.wallet.fundingTx} kind="tx" onPick={onActivity} /> : <TxLink hash={null} />}
                </dd>
              </>
            )}
            <dt>Network fees</dt>
            <dd>{(Number(big(s.wallet.feesLovelace)) / 1e6).toFixed(3)} ADA</dd>
          </dl>
          <div className="mt-2 flex flex-col gap-1">
            <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(s.wallet.spentMicro, s.wallet.budgetMicro)} aria-label="Budget spent">
              <span style={{ width: `${pct(s.wallet.spentMicro, s.wallet.budgetMicro)}%` }} />
            </div>
            <div className="text-[12px] mid tabular-nums">
              spent {myr(s.wallet.spentMicro, rate)} of {myr(s.wallet.budgetMicro, rate)} ·{" "}
              {myr(big(s.wallet.budgetMicro) - big(s.wallet.spentMicro), rate)} left
            </div>
          </div>
        </section>

        {/* Context in */}
        <section>
          <h3 className="section-title">Context in</h3>
          <div className="text-[11.5px] warn mb-1">Handbacks from earlier sessions — read as data, never as instructions.</div>
          {s.contextIn.length === 0 ? (
            <div className="text-[12px] muted">No handbacks received.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {s.contextIn.map((c) => (
                <details key={c.fromSessionId} className="panel p-2" style={{ boxShadow: "none" }}>
                  <summary className="cursor-pointer text-[12.5px]">
                    <b>{c.fromRole}</b>: {c.handback.summary} {c.tainted && <span className="tag tag-warn">tainted</span>}
                  </summary>
                  <pre className="mono text-[11.5px] whitespace-pre-wrap mt-2 mb-0">{c.handback.result}</pre>
                </details>
              ))}
            </div>
          )}
        </section>

        {/* Message box */}
        {!ended && <MessageBox sessionId={s.id} onSent={() => { reload(); bump(); }} />}

        {/* Peek */}
        <Peek sessionId={s.id} />

        {/* Live activity */}
        <Activity s={s} rate={rate} />

        {/* On close */}
        <section>
          <h3 className="section-title">On close</h3>
          {!s.close ? (
            <div className="text-[12.5px] mid">
              Leftovers return to treasury, the handback goes to the next session, and a hash of the session log is saved on Cardano (tx metadata
              label 674).
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <dl className="kv">
                <dt>Refund</dt>
                <dd className="good">{s.close.refundMicro !== null ? `${myr(s.close.refundMicro, rate)} returned to treasury` : "—"}</dd>
                <dt>Close tx</dt>
                <dd>
                  {s.close.closeTx ? <IdChip value={s.close.closeTx} kind="tx" onPick={onActivity} /> : <TxLink hash={null} />}
                </dd>
                <dt>log_sha256</dt>
                <dd className="mono text-[11px]">{s.close.logSha256 ?? "—"}</dd>
                <dt>handback_sha256</dt>
                <dd className="mono text-[11px]">{s.close.handbackSha256 ?? "—"}</dd>
              </dl>
            </div>
          )}
          {s.handback && (
            <div className="mt-2 panel p-3 flex flex-col gap-2" style={{ boxShadow: "none" }}>
              <div className="text-[12px] label">Full handback (data)</div>
              <div className="font-medium">{s.handback.summary}</div>
              <pre className="mono text-[11.5px] whitespace-pre-wrap m-0">{s.handback.result}</pre>
              {s.handback.sources.length > 0 && (
                <div className="text-[12px]">
                  <span className="label">Sources: </span>
                  {s.handback.sources.map((u) => (
                    <div key={u} className="mono text-[11px] break-all">
                      {u}
                    </div>
                  ))}
                </div>
              )}
              {s.handback.txHashes && s.handback.txHashes.length > 0 && (
                <div className="text-[12px] flex flex-col">
                  <span className="label">Payment txs:</span>
                  {s.handback.txHashes.map((h) => (
                    <TxLink key={h} hash={h} />
                  ))}
                </div>
              )}
              {s.handback.job && (
                <div className="text-[12px]">
                  <span className="label">Job </span>
                  <span className="mono">{s.handback.job.jobId}</span> <span className="label">result hash </span>
                  <span className="mono text-[11px] break-all">{s.handback.job.resultHash}</span>
                </div>
              )}
              {s.handback.flags.length > 0 && <div className="flex gap-1 flex-wrap">{s.handback.flags.map((f) => <span key={f} className="tag tag-warn">{f}</span>)}</div>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function StatusTag({ status, awaiting }: { status: string; awaiting?: boolean }) {
  if (awaiting) return <span className="tag tag-warn">awaiting approval</span>;
  const cls =
    status === "CLOSED" || status === "COMPLETING" ? "tag-good"
    : status === "RUNNING" || status === "FUNDING" ? "tag-run"
    : ["QUARANTINED", "PAUSED", "AWAITING_APPROVAL", "CLOSING"].includes(status) ? "tag-warn"
    : ["FAILED", "KILLED", "EXPIRED"].includes(status) ? "tag-bad"
    : "";
  return <span className={`tag ${cls}`}>{status === "AWAITING_APPROVAL" ? sessionStatusWord(status) : status.toLowerCase().replace(/_/g, " ")}</span>;
}

export function decisionText(d: Decision, rate: string): string {
  const x = d.details as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  switch (d.kind) {
    case "payment_approval":
      return `Pay ${x.amountMicro ? myr(str(x.amountMicro), rate) : "?"} to ${str(x.payeeLabel) || str(x.payee)}${x.memo ? ` (“${str(x.memo)}”)` : ""}. Above the approval threshold.`;
    case "budget_raise":
      return `Raise the budget by ${x.addMicro ? myr(str(x.addMicro), rate) : "?"}${x.newBudgetMicro ? ` to ${myr(str(x.newBudgetMicro), rate)}` : ""}. The extra amount is sent from your treasury to the session wallet.`;
    case "extend_expiry":
      return `Extend expiry to ${x.newExpiresAt ? dateTimeOf(Number(x.newExpiresAt)) : "?"}. A new session wallet with the new expiry is opened and the funds are moved; the old script is never edited.`;
    case "quarantine_release":
      return str(x.reason) || "Release the session from quarantine (same mandate).";
    case "widen_mandate":
      return str(x.reason) || `Widen the mandate: ${JSON.stringify(x)}`;
  }
}

function MandateControls({
  s,
  busy,
  control,
  rate,
}: {
  s: SessionDetailDTO;
  busy: boolean;
  control: (action: string, body?: Record<string, unknown>, ok?: string) => Promise<void>;
  rate: string;
}) {
  const [open, setOpen] = useState(false);
  const [raise, setRaise] = useState("1");
  const [hours, setHours] = useState("2");
  const [narrow, setNarrow] = useState("");
  if (!open)
    return (
      <button type="button" className="btn btn-sm mt-2" onClick={() => setOpen(true)}>
        Change mandate…
      </button>
    );
  return (
    <div className="mt-2 panel p-3 flex flex-col gap-2" style={{ boxShadow: "none" }}>
      <div className="text-[12px] mid">Raising the budget or extending expiry opens a decision you must approve. Narrowing sweeps the excess back right away.</div>
      <div className="flex gap-2 items-center">
        <span className="text-[12px] w-[96px]">Raise by</span>
        <input className="input" style={{ width: 90 }} value={raise} onChange={(e) => setRaise(e.target.value)} inputMode="decimal" aria-label={`Raise budget by ${TICKER}`} />
        <span className="text-[12px] muted">{TICKER} ≈ RM{(Number(raise || 0) * Number(rate)).toFixed(2)}</span>
        <button type="button" className="btn btn-sm ml-auto" disabled={busy || !(Number(raise) > 0)} onClick={() => control("raise", { addTUSD: raise }, "Budget raise requested — approve it in Decisions")}>
          Request
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <span className="text-[12px] w-[96px]">Extend by</span>
        <input className="input" style={{ width: 90 }} value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" aria-label="Extend by hours" />
        <span className="text-[12px] muted">hours</span>
        <button
          type="button"
          className="btn btn-sm ml-auto"
          disabled={busy || !(Number(hours) > 0)}
          onClick={() => control("extend", { newExpiresAt: s.mandate.expiresAt + Math.round(Number(hours) * 3_600_000) }, "Extension requested — approve it in Decisions")}
        >
          Request
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <span className="text-[12px] w-[96px]">Narrow to</span>
        <input className="input" style={{ width: 90 }} value={narrow} placeholder={tusd(s.wallet.spentMicro).replace(" tUSD", "")} onChange={(e) => setNarrow(e.target.value)} inputMode="decimal" aria-label="Narrow budget to tUSD" />
        <span className="text-[12px] muted">{TICKER}</span>
        <button type="button" className="btn btn-sm ml-auto" disabled={busy || !narrow} onClick={() => control("narrow", { newBudgetTUSD: narrow }, "Budget narrowed — excess swept to treasury")}>
          Narrow
        </button>
      </div>
    </div>
  );
}

function MessageBox({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/sessions/${sessionId}/messages`, { body: { text: text.trim() } });
      setText("");
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3 className="section-title">Message this session</h3>
      <textarea
        className="input"
        rows={2}
        value={text}
        maxLength={2000}
        placeholder="e.g. Focus on pricing pages only."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[11.5px] muted flex-1">Messages can redirect work but never change the mandate.</span>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {err && <div className="text-[12px] bad">{err}</div>}
    </section>
  );
}

function Peek({ sessionId }: { sessionId: string }) {
  const [on, setOn] = useState(false);
  const [lines, setLines] = useState<{ at: number; text: string; level?: string }[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!on) return;
    setLines([]);
    const es = new EventSource(`/api/engine/sessions/${sessionId}/peek`);
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data) as { at?: number; text?: string; level?: string; data?: { text?: string }; type?: string };
        const text = d.text ?? d.data?.text ?? (d.type ? d.type : m.data);
        setLines((l) => [...l.slice(-299), { at: d.at ?? Date.now(), text: String(text), level: d.level }]);
      } catch {
        setLines((l) => [...l.slice(-299), { at: Date.now(), text: m.data }]);
      }
    };
    return () => es.close();
  }, [on, sessionId]);
  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [lines]);
  return (
    <section>
      <div className="flex items-center gap-2">
        <h3 className="section-title m-0">Peek</h3>
        <label className="ml-auto inline-flex items-center gap-2 text-[12px] cursor-pointer">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> live read-only stream
        </label>
      </div>
      {on && (
        <div className="peek mt-2" ref={boxRef} aria-live="polite">
          {lines.length === 0 && <div style={{ color: "#8a8f98" }}>waiting for progress / log lines…</div>}
          {lines.map((l, i) => (
            <div key={i} className={l.level === "warn" || l.level === "error" ? "warn" : undefined}>
              <span style={{ color: "#737882" }}>{timeOf(l.at)}</span> {l.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Activity({ s, rate }: { s: SessionDetailDTO; rate: string }) {
  const [all, setAll] = useState(false);
  const events = [...s.activity].reverse();
  const shown = all ? events : events.slice(0, 40);
  return (
    <section>
      <h3 className="section-title">Live activity</h3>
      {events.length === 0 && <div className="text-[12px] muted">Nothing yet.</div>}
      <ul className="timeline">
        {shown.map((e) => {
          const d = describeEvent(e, rate);
          if (e.type === "session_message") {
            const from = String(e.data.from ?? "user");
            return (
              <li key={e.id}>
                <span className="t">{timeOf(e.at)}</span>
                <span className="dot msg" />
                <div className={`bubble ${from === "user" ? "user" : ""}`}>
                  <div className="text-[10.5px] muted mono">{from} → {s.letter} (data)</div>
                  {d.text}
                </div>
              </li>
            );
          }
          return (
            <li key={e.id}>
              <span className="t">{timeOf(e.at)}</span>
              <span className={`dot ${d.tone === "none" ? "" : d.tone}`} />
              <div className={d.tone === "bad" ? "bad" : d.tone === "warn" ? "warn" : undefined}>
                {d.text} {d.tx && <TxLink hash={d.tx} />}
              </div>
            </li>
          );
        })}
      </ul>
      {events.length > 40 && (
        <button type="button" className="btn btn-sm mt-2" onClick={() => setAll((a) => !a)}>
          {all ? "Show recent" : `Show all ${events.length}`}
        </button>
      )}
    </section>
  );
}
