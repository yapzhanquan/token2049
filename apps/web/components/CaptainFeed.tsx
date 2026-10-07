"use client";
// The captain feed — the Bridge's primary surface. A conversation, not a log: the captain speaks in
// plain outcomes ("B finished the pricing scan — risk: low — DoD ✓, 3 sources, close tx ↗"), every
// move it makes says why ("→ Redirected B — why: …"), and routine traffic collapses into a single
// "absorbed N routine events" line you can open if you want the detail.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { BulkheadEvent, DecisionDTO, MeDTO } from "@bulkhead/shared";
import { buildFeed, type CaptainReport, type FeedItem } from "@/lib/bridge";
import { api, isTransient, useLive, useResource } from "@/lib/client";
import { useWalletState } from "@/lib/wallet-context";
import { answerDecision } from "@/lib/wallet-decisions";
import { describeEvent } from "@/lib/describe";
import { useGoalEvents } from "@/lib/goal-events";
import { timeOf } from "@/lib/money";
import { EvidenceRow, RiskChip } from "./BridgeBits";

/** Open decisions + who is answering, so an escalation card can be answered in place. */
const DecideCtx = createContext<{ me: MeDTO | null; open: Set<string> | null; reload: () => void }>({ me: null, open: null, reload: () => {} });

const KIND_WORD: Record<string, string> = { session_result: "Session result", goal_result: "Goal result", escalation: "Needs you", incident: "Incident" };
const RISK_EDGE: Record<string, string> = { low: "var(--good)", medium: "var(--warn)", high: "var(--bad)" };

export function CaptainFeed({
  me,
  goalId,
  letterOf,
  rate,
  onSelectSession,
  onActivity,
}: {
  me: MeDTO | null;
  goalId: string | null;
  letterOf: (sid?: string) => string | undefined;
  rate: string;
  onSelectSession: (id: string) => void;
  onActivity: (q: string) => void;
}) {
  const { events, replayed } = useGoalEvents();
  const items = useMemo(() => buildFeed(events, letterOf, rate), [events, letterOf, rate]);
  const hasEscalation = items.some((i) => i.kind === "report" && !!i.report.decisionId);
  const { data: openList, reload } = useResource<DecisionDTO[]>(hasEscalation ? "/decisions?status=open" : null);
  const decideCtx = useMemo(() => ({ me, open: openList ? new Set(openList.filter((d) => d.status === "open").map((d) => d.id)) : null, reload }), [me, openList, reload]);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const stats = useMemo(() => {
    let reports = 0;
    let actions = 0;
    let absorbed = 0;
    for (const i of items) {
      if (i.kind === "report") reports++;
      else if (i.kind === "action") actions++;
      else if (i.kind === "absorbed") absorbed += i.count;
    }
    return { reports, actions, absorbed };
  }, [items]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <DecideCtx.Provider value={decideCtx}>
    <div className="panel flex flex-col min-w-0">
      <div className="px-4 py-3 border-b flex flex-wrap items-center gap-x-3 gap-y-1" style={{ borderColor: "var(--rule)" }}>
        <div className="font-semibold">Captain</div>
        <span className="text-[12px] muted">reports outcomes with risk + evidence · escalates only real decisions · can request, never sign</span>
        <span className="ml-auto text-[11.5px] mono muted tabular-nums">
          {stats.reports} report{stats.reports === 1 ? "" : "s"} · {stats.actions} move{stats.actions === 1 ? "" : "s"} · {stats.absorbed} routine absorbed
        </span>
      </div>
      <div
        ref={boxRef}
        className="px-3 sm:px-4 py-3 flex flex-col gap-2 overflow-auto"
        style={{ maxHeight: "min(68vh, 760px)", minHeight: 220 }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        aria-live="polite"
      >
        {!goalId && <div className="text-[13px] mid">Give the captain a goal. It plans a crew of sessions, watches them, and tells you only what matters.</div>}
        {goalId && !replayed && items.length === 0 && <div className="text-[12.5px] muted">Reading the ship's log…</div>}
        {goalId && replayed && items.length === 0 && <div className="text-[12.5px] mid">Quiet so far. The captain reports here when a session finishes, something goes wrong, or a decision needs you.</div>}
        {items.map((it) => (
          <FeedRow key={`${it.kind}:${it.id}`} it={it} rate={rate} letterOf={letterOf} onSelectSession={onSelectSession} onActivity={onActivity} />
        ))}
      </div>
      <Composer goalId={goalId} />
    </div>
    </DecideCtx.Provider>
  );
}

function FeedRow({ it, rate, letterOf, onSelectSession, onActivity }: { it: FeedItem; rate: string; letterOf: (sid?: string) => string | undefined; onSelectSession: (id: string) => void; onActivity: (q: string) => void }) {
  switch (it.kind) {
    case "report":
      return <ReportCard r={it.report} at={it.at} letterOf={letterOf} onSelectSession={onSelectSession} onActivity={onActivity} />;
    case "action": {
      const a = it.action;
      return (
        <div className="flex items-start gap-2 text-[12.5px] pl-1">
          <span className="mono text-[10.5px] muted pt-[2px] shrink-0">{timeOf(it.at)}</span>
          <div className="min-w-0" style={{ overflowWrap: "anywhere" }}>
            <span className={a.ok ? "good" : "bad"} aria-hidden="true">
              →{" "}
            </span>
            <b>{a.verb}</b>
            {a.target && (
              <>
                {" "}
                {it.sessionId ? (
                  <button type="button" className="good font-semibold" style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => onSelectSession(it.sessionId!)}>
                    {a.target}
                  </button>
                ) : (
                  <b>{a.target}</b>
                )}
              </>
            )}
            {a.why && (
              <span className="mid" title={a.whySource === "auto" ? "Why derived deterministically from the evidence that woke the captain" : a.whySource === "model" ? "Why written by the captain" : undefined}>
                {" "}
                — why: {a.why}
              </span>
            )}
            {a.said && <span className="mid">{a.why ? " · said" : " — said"}: “{a.said.length > 220 ? `${a.said.slice(0, 219)}…` : a.said}”</span>}
            {!a.ok && <span className="bad"> — refused{a.error ? `: ${a.error}` : ""} (the guard held)</span>}
            {a.auto && (
              <span className="tag ml-1" style={{ height: 18, fontSize: 10.5 }} title="Deterministic watchdog ladder (redirect → wrap-up → stop), not an LLM decision">
                auto
              </span>
            )}
          </div>
        </div>
      );
    }
    case "user":
      return (
        <div className="bubble user self-end" style={{ maxWidth: "88%" }}>
          <div className="text-[10.5px] muted mono">you · {timeOf(it.at)}</div>
          <div className="text-[13px] whitespace-pre-wrap">{it.text}</div>
        </div>
      );
    case "signal":
      return (
        <div className="flex items-start gap-2 text-[12.5px] pl-1">
          <span className="mono text-[10.5px] muted pt-[2px] shrink-0">{timeOf(it.at)}</span>
          <span className={`${it.tone} min-w-0`} style={{ overflowWrap: "anywhere" }}>
            {it.tone === "good" ? "✓ " : "! "}
            {it.text}
            {it.sessionId && (
              <button type="button" className="btn btn-sm btn-ghost good" style={{ height: 18, padding: "0 4px" }} onClick={() => onSelectSession(it.sessionId!)}>
                →
              </button>
            )}
          </span>
        </div>
      );
    case "absorbed":
      return <Absorbed events={it.events} count={it.count} rate={rate} letterOf={letterOf} />;
  }
}

function ReportCard({ r, at, letterOf, onSelectSession, onActivity }: { r: CaptainReport; at: number; letterOf: (sid?: string) => string | undefined; onSelectSession: (id: string) => void; onActivity: (q: string) => void }) {
  const letter = letterOf(r.sessionId);
  return (
    <div className="bubble self-start flex flex-col gap-1.5" style={{ maxWidth: "100%", width: "100%", background: "var(--surface)", borderLeft: `3px solid ${r.risk ? RISK_EDGE[r.risk] : "var(--rule)"}` }}>
      <div className="flex flex-wrap items-center gap-2 text-[10.5px] mono muted">
        <span>captain</span>
        <span>·</span>
        <span>{timeOf(at)}</span>
        {r.kind && <span className="eyebrow" style={{ fontSize: 10 }}>{KIND_WORD[r.kind] ?? r.kind}</span>}
        {r.sessionId && (
          <button type="button" className="good" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }} onClick={() => onSelectSession(r.sessionId!)}>
            {letter ? `session ${letter}` : "session"} →
          </button>
        )}
      </div>
      <div className="text-[14px] font-medium whitespace-pre-wrap" style={{ overflowWrap: "anywhere" }}>
        {r.headline}
      </div>
      {(r.risk || r.riskReason) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <RiskChip risk={r.risk} reason={r.riskReason} />
          {r.riskReason && <span className="mid">{r.riskReason}</span>}
        </div>
      )}
      <EvidenceRow evidence={r.evidence} onPick={onActivity} />
      {r.next && (
        <div className="text-[12px] mid">
          <span className="label">Next: </span>
          {r.next}
        </div>
      )}
      {r.recommendation && (
        <div className="text-[12.5px]">
          <span className={`font-semibold ${r.recommendation.action === "approve" ? "good" : r.recommendation.action === "reject" ? "bad" : "warn"}`}>Recommend: {r.recommendation.action}</span>
          {r.recommendation.why && <span className="mid"> — {r.recommendation.why}</span>}
        </div>
      )}
      {r.decisionId && <InlineDecision decisionId={r.decisionId} recommend={r.recommendation?.action} />}
    </div>
  );
}

function InlineDecision({ decisionId, recommend }: { decisionId: string; recommend?: string }) {
  const { me, open, reload } = useContext(DecideCtx);
  const { bump } = useLive();
  const wallet = useWalletState();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<string | null>(null);
  if (res) return <div className="text-[12px] muted">✓ {res} — recorded in the decision ledger.</div>;
  if (!open) return null;
  if (!open.has(decisionId)) return <div className="text-[11.5px] muted">Decision answered.</div>;
  const decide = async (status: "approved" | "rejected") => {
    setBusy(true);
    try {
      await answerDecision({ id: decisionId }, status, { me, wallet });
      setRes(status);
      reload();
      bump();
    } catch (e) {
      setRes(null);
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`btn btn-sm ${recommend === "reject" ? "" : "btn-primary"}`} disabled={busy} onClick={() => void decide("approved")}>
        Approve{me?.custody === "self" ? " (sign)" : ""}
      </button>
      <button type="button" className={`btn btn-sm ${recommend === "reject" ? "btn-danger" : ""}`} disabled={busy} onClick={() => void decide("rejected")}>
        Reject
      </button>
    </div>
  );
}

function Absorbed({ events, count, rate, letterOf }: { events: BulkheadEvent[]; count: number; rate: string; letterOf: (sid?: string) => string | undefined }) {
  const [open, setOpen] = useState(false);
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const top = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`)
    .join(", ");
  return (
    <div className="text-[11.5px] muted pl-1">
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit", textAlign: "left" }} aria-expanded={open}>
        {open ? "▾" : "▸"} absorbed {count} routine event{count === 1 ? "" : "s"}
        {top ? ` (${top})` : ""} — handled without bothering you
      </button>
      {open && (
        <ul className="timeline mt-1" style={{ maxHeight: 260, overflow: "auto" }}>
          {events.slice(-120).map((e) => {
            const d = describeEvent(e, rate);
            return (
              <li key={e.id}>
                <span className="t">{timeOf(e.at)}</span>
                <span className={`dot ${d.tone === "none" ? "" : d.tone}`} />
                <div className="mid" style={{ overflowWrap: "anywhere" }}>
                  {letterOf(e.sessionId) ? <b>{letterOf(e.sessionId)} </b> : null}
                  {d.text}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Composer({ goalId }: { goalId: string | null }) {
  const { bump } = useLive();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/captain/messages", { body: { text: text.trim(), goalId } });
      setText("");
      bump();
    } catch (e) {
      setErr(isTransient(e) ? "The engine is restarting; not sent. Try again in a few seconds." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 sm:px-4 py-3 border-t flex flex-col gap-1" style={{ borderColor: "var(--rule)" }}>
      <div className="flex gap-2">
        <input
          className="input"
          value={text}
          placeholder="Tell the captain… e.g. “Focus B on pricing pages only”"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          maxLength={2000}
          aria-label="Message the captain"
        />
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {err && <div className="text-[12px] bad">{err}</div>}
    </div>
  );
}
