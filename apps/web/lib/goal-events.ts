"use client";
// One shared, in-memory event history for the selected goal: a one-shot replay of the goal's events
// (GET /events/stream?goalId=…&after=0, read until it goes idle, then closed — so it never holds a
// browser connection open) merged with the live global SSE stream. The captain feed, Bearings, Ahoy
// and the crew watch all read from it, so the whole Bridge costs zero extra long-lived connections.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { BulkheadEvent } from "@bulkhead/shared";
import { api, ApiError, isTransient, useLive } from "./client";

const MAX_EVENTS = 4000;

export interface GoalEvents {
  goalId: string | null;
  events: BulkheadEvent[];
  /** The history replay finished (events now include everything before the page loaded). */
  replayed: boolean;
}
export const GoalEventsContext = createContext<GoalEvents>({ goalId: null, events: [], replayed: false });
export const useGoalEvents = () => useContext(GoalEventsContext);

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/** Read the SSE replay until the stream has been quiet for `idleMs`, then abort. */
async function replay(goalId: string, signal: AbortSignal): Promise<BulkheadEvent[]> {
  const out: BulkheadEvent[] = [];
  let res: Response;
  try {
    res = await fetch(`/api/engine/events/stream?goalId=${encodeURIComponent(goalId)}&after=0`, { signal, cache: "no-store", headers: { accept: "text/event-stream" } });
  } catch {
    return out;
  }
  if (!res.ok || !res.body) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let first = true;
  const started = Date.now();
  try {
    while (Date.now() - started < 15_000) {
      const r = await Promise.race([reader.read(), sleep(first ? 6_000 : 900)]);
      if (!r || r.done) break;
      first = false;
      buf += dec.decode(r.value, { stream: true });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        let name = "message";
        const data: string[] = [];
        for (const line of b.split(/\r?\n/)) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (name !== "message" || !data.length) continue;
        try {
          const e = JSON.parse(data.join("\n")) as BulkheadEvent;
          if (typeof e.id === "number" && e.type && e.type !== "llm_usage") out.push(e);
        } catch {
          /* skip a malformed line */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return out;
}

/** Keeps the goal's event history; `sessionIds` lets events without a goalId still be attributed. */
export function useGoalEventStore(goalId: string | null, sessionIds: string[]): GoalEvents {
  const { subscribe } = useLive();
  const map = useRef(new Map<number, BulkheadEvent>());
  const [events, setEvents] = useState<BulkheadEvent[]>([]);
  const [replayed, setReplayed] = useState(false);
  const sids = useRef(new Set<string>());
  sids.current = new Set(sessionIds);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      let all = [...map.current.values()].sort((a, b) => a.id - b.id);
      if (all.length > MAX_EVENTS) {
        all = all.slice(-MAX_EVENTS);
        map.current = new Map(all.map((e) => [e.id, e]));
      }
      setEvents(all);
    }, 120);
  };

  // Replay the goal's history whenever the goal changes.
  useEffect(() => {
    map.current = new Map();
    setEvents([]);
    setReplayed(false);
    if (!goalId) return;
    const ac = new AbortController();
    void replay(goalId, ac.signal).then((evs) => {
      if (ac.signal.aborted) return;
      for (const e of evs) map.current.set(e.id, e);
      setReplayed(true);
      flush();
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  // Merge live events.
  useEffect(() => {
    if (!goalId) return;
    return subscribe((e) => {
      if (e.goalId === goalId || (e.sessionId && sids.current.has(e.sessionId))) {
        map.current.set(e.id, e);
        flush();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, subscribe]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { goalId, events, replayed };
}

/**
 * GET an endpoint that may not exist yet (new engine routes). A 404/405/501 marks it missing and stops
 * re-fetching for 60s, so callers fall back to derived data without "failed to fetch" noise. Every
 * error is swallowed: `data` is null and `missing` tells the caller to derive.
 */
export function useOptionalResource<T>(path: string | null): { data: T | null; missing: boolean; reload: () => void } {
  const { version } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [n, setN] = useState(0);
  const missingAt = useRef<Record<string, number>>({});
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(null);
    }
    const m = missingAt.current[path];
    if (m && Date.now() - m < 60_000) {
      setMissing(true);
      return;
    }
    let cancelled = false;
    api<T>(path, { retries: 1 })
      .then((d) => {
        if (cancelled) return;
        delete missingAt.current[path];
        setData(d);
        setMissing(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && [404, 405, 501].includes(e.status)) {
          missingAt.current[path] = Date.now();
          setMissing(true);
          setData(null);
        } else if (!isTransient(e)) {
          setMissing(true);
        }
        // transient (engine restarting): keep the last data quietly
      });
    return () => {
      cancelled = true;
    };
  }, [path, version, n]);
  return { data, missing, reload: () => setN((x) => x + 1) };
}
