"use client";
// Activity tab: one live, newest-first log of everything the captain's crew does — payments, agent hires,
// handbacks, progress, decisions, funding/closes/top-ups, captain actions — from GET /activity. Paste a
// session id, letter, agent job id, tx hash, decision/payment id or address to see that entity's full
// history; every id/hash chip in a row puts its value into the search box (and can be copied).
// Live: re-reads the first page on every SSE event (debounced by the live context) and highlights new rows.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityDTO, ActivityKind, ActivityMatchDTO, ActivityRowDTO } from "@bulkhead/shared";
import { api, isTransient, useLive, useNow } from "@/lib/client";
import { ada, dateTimeOf, myr } from "@/lib/money";
import { IdChip, LiveDot, Reconnecting } from "./IdChip";

type Filter = "all" | "payments" | "agents" | "decisions" | "funding" | "captain";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["payments", "Payments"],
  ["agents", "Agents"],
  ["decisions", "Decisions"],
  ["funding", "Funding & closes"],
  ["captain", "Captain"],
];
const KIND_LABEL: Record<ActivityKind, string> = {
  payment: "Pay",
  funding: "Fund",
  close: "Close",
  hire: "Hire",
  handback: "Handback",
  decision: "Decision",
  topup: "Top-up",
  progress: "Progress",
  captain: "Captain",
  transition: "State",
  message: "Message",
  rejection: "Rejected",
  staking: "Stake",
};
const PAGE = 60;

export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusTone(st: string | null | undefined): string {
  const v = (st ?? "").toLowerCase();
  if (["confirmed", "approved", "completed", "closed", "ok", "paid"].includes(v)) return "tag-good";
  if (["rejected", "failed", "error", "denied", "killed", "expired"].includes(v)) return "tag-bad";
  if (["pending", "open", "awaiting_approval", "requested", "warn", "quarantined", "ignored", "paused", "started"].includes(v)) return "tag-warn";
  if (["running", "funding", "completing", "closing"].includes(v)) return "tag-run";
  return "";
}

export function ActivityLog({ goalId, rate, query, onQuery, onSelectSession }: { goalId: string | null; rate: string; query?: string; onQuery?: (q: string) => void; onSelectSession: (sessionId: string, goalId?: string) => void }) {
  const { version } = useLive();
  const now = useNow(15_000);
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<"goal" | "all">("goal");
  const [input, setInput] = useState(query ?? "");
  const [q, setQ] = useState(query ?? "");
  const [rows, setRows] = useState<ActivityRowDTO[] | null>(null);
  const [older, setOlder] = useState<ActivityRowDTO[]>([]);
  const [match, setMatch] = useState<ActivityMatchDTO | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [retryN, setRetryN] = useState(0);
  const known = useRef<Set<string> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const olderCount = useRef(0);

  // External query (e.g. "Activity" button in a session panel).
  useEffect(() => {
    if (query !== undefined) {
      setInput(query);
      setQ(query);
    }
  }, [query]);

  const params = useCallback(
    (before?: number | null) => {
      const p = new URLSearchParams();
      if (scope === "goal" && goalId && !q) p.set("goalId", goalId);
      if (q && /^[A-Za-z]{1,2}$/.test(q) && goalId) p.set("goalId", goalId); // letters resolve within the goal
      if (q) p.set("q", q);
      if (filter !== "all") p.set("type", filter);
      p.set("limit", String(PAGE));
      if (before) p.set("before", String(before));
      return `/activity?${p.toString()}`;
    },
    [scope, goalId, q, filter],
  );

  // Reset when the view changes.
  useEffect(() => {
    known.current = null;
    setRows(null);
    setOlder([]);
    olderCount.current = 0;
    setNextBefore(null);
    setFresh(new Set());
    setError(null);
  }, [params]);

  // First page: on view change and on every live event (version bump).
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    api<ActivityDTO>(params())
      .then((d) => {
        if (cancelled) return;
        const ids = new Set(d.rows.map((r) => r.id));
        if (known.current) {
          const added = d.rows.filter((r) => !known.current!.has(r.id)).map((r) => r.id);
          if (added.length) setFresh(new Set(added));
        }
        known.current = new Set([...(known.current ?? []), ...ids]);
        setRows(d.rows);
        setMatch(d.match);
        if (!olderCount.current) setNextBefore(d.nextBefore);
        setError(null);
        setReconnecting(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (isTransient(e)) {
          setReconnecting(true);
          retry = setTimeout(() => setRetryN((n) => n + 1), 3000);
        } else setError(e.message);
      });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [params, version, retryN]);

  const loadMore = async () => {
    if (!nextBefore) return;
    try {
      const d = await api<ActivityDTO>(params(nextBefore));
      olderCount.current += d.rows.length;
      setOlder((o) => [...o, ...d.rows]);
      setNextBefore(d.nextBefore);
    } catch (e) {
      if (isTransient(e)) setReconnecting(true);
      else setError((e as Error).message);
    }
  };

  const search = (v: string) => {
    const t = v.trim();
    setInput(t);
    setQ(t);
    onQuery?.(t);
  };
  const pick = (v: string) => {
    search(v);
    inputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const all = (() => {
    const seen = new Set<string>();
    return [...(rows ?? []), ...older].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  })();
  const valid = !input.trim() || /^[A-Za-z0-9_:.$-]{1,140}$/.test(input.trim());

  return (
    <div className="panel flex flex-col">
      <div className="p-3 flex flex-col gap-2.5" style={{ borderBottom: "1px solid var(--rule-soft)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-semibold">Activity log</div>
          <LiveDot />
          <div className="seg ml-auto" role="tablist" aria-label="Scope">
            <button type="button" aria-pressed={scope === "goal"} onClick={() => setScope("goal")} disabled={!goalId}>
              This goal
            </button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              All goals
            </button>
          </div>
        </div>
        <form
          className="act-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) search(input);
          }}
        >
          <input
            ref={inputRef}
            className="input"
            value={input}
            placeholder="Paste a session id, agent job id, tx hash, decision id or address"
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text").trim();
              if (t && /^[A-Za-z0-9_:.$-]{1,140}$/.test(t)) {
                e.preventDefault();
                search(t);
              }
            }}
            aria-label="Search activity by id, hash or address"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-sm" disabled={!valid}>
            Search
          </button>
          {q && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => search("")}>
              Clear
            </button>
          )}
        </form>
        {!valid && <div className="text-[12px] bad">Only ids, letters, 64-hex tx hashes and addr_test1… addresses are searchable.</div>}
        <div className="seg self-start flex-wrap" role="tablist" aria-label="Filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" role="tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        {q && <MatchCard match={match} q={q} onSelectSession={onSelectSession} />}
        {reconnecting && <Reconnecting what="activity" />}
        {error && <div className="banner banner-bad">{error}</div>}
      </div>

      {rows === null && !error ? (
        <div className="p-6 muted text-[13px]">{reconnecting ? "Waiting for the engine…" : "Loading activity…"}</div>
      ) : all.length === 0 ? (
        <div className="p-6 muted text-[13px]">{q ? "Nothing recorded for that id yet." : "No activity yet. Approve a plan and the crew's payments, hires and progress appear here live."}</div>
      ) : (
        <ul className="act-list">
          {all.map((r) => (
            <ActivityItem key={r.id} r={r} rate={rate} now={now} isNew={fresh.has(r.id)} onPick={pick} onSelectSession={onSelectSession} />
          ))}
        </ul>
      )}
      {nextBefore && all.length > 0 && (
        <div className="p-3 text-center" style={{ borderTop: "1px solid var(--rule-soft)" }}>
          <button type="button" className="btn btn-sm" onClick={() => void loadMore()}>
            Load older
          </button>
        </div>
      )}
    </div>
  );
}

function MatchCard({ match, q, onSelectSession }: { match: ActivityMatchDTO | null; q: string; onSelectSession: (id: string) => void }) {
  if (!match) return null;
  const c = match.chain;
  return (
    <div className="act-match flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">{match.type === "none" || match.type === "text" ? "Search" : match.type.replace("_", " ")}</span>
        {match.label && <span className="font-semibold">{match.label}</span>}
        <IdChip value={match.value || q} kind={match.type === "tx" ? "tx" : match.type === "address" ? "addr" : "id"} />
        {(match.type === "session" || match.type === "letter") && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onSelectSession(match.value)}>
            Open in tree →
          </button>
        )}
      </div>
      {c && (
        <div className="text-[12.5px] mid">
          {c.found ? (
            <>
              Not a Bulkhead transaction of yours, but it is on preprod: block {c.blockHeight ?? "?"}
              {c.confirmations ? ` · ${c.confirmations} confirmations` : ""}
              {c.feeLovelace ? ` · fee ${ada(c.feeLovelace)}` : ""}
              {c.blockTime ? ` · ${dateTimeOf(c.blockTime)}` : ""}
            </>
          ) : (
            <>Not found in your activity{c.error ? ` (chain lookup: ${c.error})` : " and not (yet) on preprod"}.</>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityItem({ r, rate, now, isNew, onPick, onSelectSession }: { r: ActivityRowDTO; rate: string; now: number; isNew: boolean; onPick: (v: string) => void; onSelectSession: (id: string, goalId?: string) => void }) {
  const amount = r.amountMicro && r.amountMicro !== "0" ? myr(r.amountMicro, rate) : null;
  const sign = r.direction === "out" ? "−" : r.direction === "in" ? "+" : "";
  return (
    <li className={`act-row${isNew ? " act-new" : ""}`}>
      <span className={`act-kind act-kind-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
      <div className="min-w-0">
        <div className="act-title">{r.title}</div>
        <div className="act-meta">
          {r.sessionId && <IdChip value={r.sessionId} label={r.letter ? `${r.letter}` : "session"} onPick={onPick} title={`Session ${r.letter ?? ""} ${r.role ?? ""} — ${r.sessionId}`} />}
          {r.agentJobId && <IdChip value={r.agentJobId} label="job" onPick={onPick} />}
          {r.externalJobId && r.externalJobId !== r.agentJobId && <IdChip value={r.externalJobId} label="ext" onPick={onPick} />}
          {r.paymentId && <IdChip value={r.paymentId} label="pay" onPick={onPick} />}
          {r.decisionId && <IdChip value={r.decisionId} label="dec" onPick={onPick} />}
          {r.txHash && <IdChip value={r.txHash} kind="tx" label="tx" onPick={onPick} />}
          {r.address && <IdChip value={r.address} kind="addr" label="addr" onPick={onPick} />}
          {r.sessionId && (
            <button type="button" className="btn btn-sm btn-ghost" style={{ height: 20, padding: "0 6px", fontSize: 11 }} onClick={() => onSelectSession(r.sessionId!, r.goalId ?? undefined)}>
              open →
            </button>
          )}
        </div>
      </div>
      <div className="act-right">
        {amount ? (
          <span className={`act-amt ${r.direction === "out" ? "act-amt-out" : r.direction === "in" ? "act-amt-in" : ""}`}>
            {sign}
            {amount}
          </span>
        ) : null}
        {r.status && r.status !== "ok" && <span className={`tag ${statusTone(r.status)}`}>{r.status.replace(/_/g, " ").toUpperCase()}</span>}
        {typeof r.confirmations === "number" && r.confirmations > 0 && (
          <span className="tag tag-good" title="Blocks on top of the transaction (preprod)">
            {r.confirmations} conf
          </span>
        )}
        <span className="act-ago" title={dateTimeOf(r.at)}>
          {timeAgo(r.at, now)}
        </span>
      </div>
    </li>
  );
}
