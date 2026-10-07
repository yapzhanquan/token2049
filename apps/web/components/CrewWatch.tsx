"use client";
// Crew watch: every session of the goal side by side, each streaming its own work live — so you can
// see the crew working in parallel, each inside its own wallet + mandate. Lines come from the shared
// goal event history (no extra connections); "raw" opens the session's read-only peek stream
// (GET /sessions/:id/peek) for up to 2 sessions at once (browsers cap open connections per host).
import { useEffect, useMemo, useRef, useState } from "react";
import type { BulkheadEvent, TreeDTO, TreeNode } from "@bulkhead/shared";
import { describeEvent, sessionStatusWord } from "@/lib/describe";
import { useGoalEvents } from "@/lib/goal-events";
import { myr, pct, timeOf } from "@/lib/money";
import { GlyphIcon } from "./Glyph";
import { IdChip } from "./IdChip";

const RAW_MAX = 2;
const ENDED = new Set(["CLOSED", "KILLED", "FAILED", "EXPIRED"]);
/** Event types worth a line in a session's watch column. */
const WATCH = new Set([
  "progress",
  "web_fetch",
  "session_message",
  "tool_denied",
  "mandate_change_ignored",
  "payment_requested",
  "payment_approval_needed",
  "payment_confirmed",
  "payment_rejected",
  "agent_hired",
  "agent_job_paid",
  "agent_job_result",
  "handback_submitted",
  "handback_accepted",
  "handback_rejected",
  "session_transition",
  "session_funded",
  "close_confirmed",
  "session_looping",
  "session_stalled",
  "work_deadline_reached",
  "captain_action",
  "tainted",
  "error",
]);

export function CrewWatch({ tree, rate, onSelectSession, onActivity }: { tree: TreeDTO | null | undefined; rate: string; onSelectSession: (id: string) => void; onActivity: (q: string) => void }) {
  const { events, replayed } = useGoalEvents();
  const [raw, setRaw] = useState<string[]>([]);
  const [showEnded, setShowEnded] = useState(false);
  const sessions = useMemo(() => (tree?.nodes ?? []).filter((n) => n.kind === "session" && n.glyph !== "planned" && !n.id.startsWith("plan:")), [tree]);
  const bySession = useMemo(() => {
    const m = new Map<string, BulkheadEvent[]>();
    for (const e of events) {
      if (!e.sessionId || !WATCH.has(e.type)) continue;
      const a = m.get(e.sessionId) ?? [];
      a.push(e);
      m.set(e.sessionId, a);
    }
    return m;
  }, [events]);
  const live = sessions.filter((n) => !(n.status && ENDED.has(n.status)));
  const ended = sessions.filter((n) => n.status && ENDED.has(n.status));
  const shown = showEnded ? [...live, ...ended] : live.length ? live : ended;
  const toggleRaw = (id: string) => setRaw((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id].slice(-RAW_MAX)));

  if (!tree) return <div className="panel p-6 muted">Loading the crew…</div>;
  if (sessions.length === 0) return <div className="panel p-6 mid">No crew yet. Approve the plan and the sessions appear here, each streaming its work live.</div>;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-semibold">Crew</span>
        <span className="mid">
          {live.length} working in parallel{ended.length ? ` · ${ended.length} finished` : ""} — each in its own vault, under its own mandate
        </span>
        {ended.length > 0 && live.length > 0 && (
          <label className="ml-auto inline-flex items-center gap-1.5 cursor-pointer text-[12px]">
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> show finished
          </label>
        )}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))" }}>
        {shown.map((n) => (
          <CrewColumn key={n.id} n={n} events={bySession.get(n.id) ?? []} replayed={replayed} rate={rate} raw={raw.includes(n.id)} onRaw={() => toggleRaw(n.id)} onOpen={() => onSelectSession(n.id)} onActivity={onActivity} />
        ))}
      </div>
    </div>
  );
}

/** Statuses in which the crew is still inside its work time. */
const WORKING = new Set(["RUNNING", "PAUSED", "QUARANTINED"]);

/** Live work-time countdown (WORK_DEADLINE_SECONDS from RUNNING); the engine sends workDeadlineAt on the tree node. */
function WorkCountdown({ n }: { n: TreeNode }) {
  const [now, setNow] = useState(() => Date.now());
  const active = !!n.workDeadlineAt && !!n.status && WORKING.has(n.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  if (!n.workDeadlineAt || !n.status) return null;
  if (!active) return n.status === "COMPLETING" ? <div className="text-[11.5px] mid tabular-nums">work time: handed back</div> : null;
  const left = Math.max(0, Math.ceil((n.workDeadlineAt - now) / 1000));
  const total = n.startedAt ? Math.max(1, Math.round((n.workDeadlineAt - n.startedAt) / 1000)) : 60;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="flex items-center gap-2 text-[11.5px] tabular-nums" aria-live="off">
      <span className={left <= 15 ? "bad" : "mid"}>{left > 0 ? `work time ${mm}:${ss} left` : "time up — handing back"}</span>
      <div className="bar flex-1" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left} aria-label="Work time left">
        <span style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
    </div>
  );
}

function CrewColumn({ n, events, replayed, rate, raw, onRaw, onOpen, onActivity }: { n: TreeNode; events: BulkheadEvent[]; replayed: boolean; rate: string; raw: boolean; onRaw: () => void; onOpen: () => void; onActivity: (q: string) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = events.slice(-60);
  const [rawLines, setRawLines] = useState<{ at: number; text: string; level?: string }[]>([]);
  useEffect(() => {
    if (!raw) return;
    setRawLines([]);
    const es = new EventSource(`/api/engine/sessions/${n.id}/peek`);
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data) as { at?: number; text?: string; level?: string };
        setRawLines((l) => [...l.slice(-199), { at: d.at ?? Date.now(), text: String(d.text ?? m.data), level: d.level }]);
      } catch {
        setRawLines((l) => [...l.slice(-199), { at: Date.now(), text: m.data }]);
      }
    };
    return () => es.close();
  }, [raw, n.id]);
  const count = raw ? rawLines.length : lines.length;
  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [count]);
  const ended = n.status && ENDED.has(n.status);
  const budget = n.budgetMicro ?? "0";
  const spent = n.spentMicro ?? "0";
  return (
    <div className={`panel p-3 flex flex-col gap-2 min-w-0 ${ended ? "opacity-75" : ""}`}>
      <div className="flex items-center gap-2 min-w-0">
        <GlyphIcon kind={n.glyph} size={16} animate />
        <button type="button" className="font-semibold text-[13.5px] truncate text-left" style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={onOpen} title="Open session">
          {n.letter} {n.role ?? n.label}
        </button>
        <span className="tag ml-auto shrink-0" style={{ fontSize: 11 }}>
          {sessionStatusWord(n.status, n.glyph)}
        </span>
      </div>
      {!ended && <WorkCountdown n={n} />}
      <div className="flex flex-wrap items-center gap-1.5">
        {n.taskType && <span className="tag chip-task">{n.taskType}</span>}
        <IdChip value={n.id} label="id" onPick={onActivity} />
      </div>
      <div className="flex flex-col gap-1">
        <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(spent, budget)} aria-label="Budget spent">
          <span style={{ width: `${pct(spent, budget)}%` }} />
        </div>
        <div className="text-[11.5px] mid tabular-nums">
          {myr(spent, rate)} of {myr(budget, rate)}
          {n.refundMicro ? ` · ${myr(n.refundMicro, rate)} returned` : ""}
        </div>
      </div>
      <div className="peek" ref={boxRef} style={{ height: 200, maxHeight: 200 }} aria-live="off">
        {raw ? (
          <>
            {rawLines.length === 0 && <div style={{ color: "#8a8f98" }}>raw peek: waiting for log lines…</div>}
            {rawLines.map((l, i) => (
              <div key={i} className={l.level === "warn" || l.level === "error" ? "warn" : undefined}>
                <span style={{ color: "#737882" }}>{timeOf(l.at)}</span> {l.text}
              </div>
            ))}
          </>
        ) : (
          <>
            {lines.length === 0 && <div style={{ color: "#8a8f98" }}>{replayed ? "waiting for work…" : "loading…"}</div>}
            {lines.map((e) => {
              const d = describeEvent(e, rate);
              return (
                <div key={e.id} className={d.tone === "bad" || d.tone === "warn" ? "warn" : undefined} style={d.tone === "good" ? { color: "#b9aef0" } : undefined}>
                  <span style={{ color: "#737882" }}>{timeOf(e.at)}</span> {d.text}
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          Open
        </button>
        {!ended && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRaw} title="Read-only raw peek stream from the session sandbox (max 2 at once)">
            {raw ? "events view" : "raw peek"}
          </button>
        )}
      </div>
    </div>
  );
}
