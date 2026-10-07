"use client";
// Browser-side helpers. Everything goes through /api/engine/* (the server adds the engine token).
// Resilience: GETs retry with backoff while the engine restarts (network error / 502 / 503 / 504), the SSE
// stream re-opens with backoff and resumes after the last event id, and useResource keeps the last data
// and reports `reconnecting` instead of a hard "Failed to fetch" error.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isNeedsSignature, type BulkheadEvent, type NeedsSignatureResponse } from "@bulkhead/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** Status codes that mean "the engine (or its proxy) is restarting / briefly unreachable". */
const TRANSIENT = new Set([502, 503, 504]);

/** True for errors that should show "Reconnecting…" and be retried, not a hard error. */
export function isTransient(e: unknown): boolean {
  if (e instanceof ApiError) return TRANSIENT.has(e.status) || e.status === 0;
  return e instanceof TypeError; // fetch() network failure ("Failed to fetch")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON call through the engine proxy. GETs are retried with exponential backoff on network errors and
 * 502/503/504 (engine restarting): 0.4s, 0.8s, 1.6s, 3.2s. POSTs are never retried automatically (they
 * may move money); a network failure surfaces as ApiError(0, "Engine unreachable (reconnecting)").
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; base?: string; retries?: number } = {}): Promise<T> {
  const url = `${init.base ?? "/api/engine"}${path}`;
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const retries = init.retries ?? (method === "GET" ? 4 : 0);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, "Engine unreachable — reconnecting", { cause: (e as Error).message });
    }
    if (TRANSIENT.has(res.status) && attempt < retries) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`, data);
    return data as T;
  }
}

/** POST that may come back with NeedsSignatureResponse (self-custody): sign the unsigned tx in the
 * CIP-30 wallet (signTx(tx, partialSign=true) → witness set) and POST the same route again with
 * { ...body, pendingId, signedTx }. The engine attaches the witnesses, verifies and submits. */
export async function postSigned<T>(path: string, body: Record<string, unknown>, sign: ((unsignedTx: string) => Promise<string>) | null): Promise<Exclude<T, NeedsSignatureResponse>> {
  const first = await api<T | NeedsSignatureResponse>(path, { method: "POST", body });
  if (isNeedsSignature(first)) {
    if (!sign) throw new Error("This step needs your wallet signature. Connect your wallet (self-custody) first.");
    const signedTx = await sign(first.unsignedTx);
    const second = await api<T | NeedsSignatureResponse>(path, { method: "POST", body: { ...body, pendingId: first.pendingId, signedTx } });
    if (isNeedsSignature(second)) throw new Error("The engine is still waiting for a signature; please try again.");
    return second as Exclude<T, NeedsSignatureResponse>;
  }
  return first as Exclude<T, NeedsSignatureResponse>;
}

// ───────── live context: SSE events + a version counter that refetches resources ─────────
export interface Live {
  version: number;
  bump: () => void;
  /** Most recent events (newest last), for toasts / animation. */
  recent: BulkheadEvent[];
  connected: boolean;
  /** The stream dropped and is re-opening (engine restart): show "Reconnecting…", not an error. */
  reconnecting: boolean;
  /** Id of the newest event seen (SSE resume point). */
  lastEventId: number;
}
export const LiveContext = createContext<Live>({ version: 0, bump: () => {}, recent: [], connected: false, reconnecting: false, lastEventId: 0 });
export const useLive = () => useContext(LiveContext);

export function useLiveStream(): Live {
  const [version, setVersion] = useState(0);
  const [recent, setRecent] = useState<BulkheadEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [lastEventId, setLastEventId] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastId = 0;
    let failures = 0;
    let everOpen = false;
    const open = () => {
      // Resume after the last event id: the engine replays everything since (no gaps across restarts).
      es = new EventSource(`/api/engine/events/stream${lastId ? `?after=${lastId}` : ""}`);
      es.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        if (everOpen) bump(); // refetch whatever changed while we were away
        everOpen = true;
        failures = 0;
      };
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as BulkheadEvent;
          if (typeof e.id === "number" && e.id > lastId) {
            lastId = e.id;
            setLastEventId(e.id);
          }
          if (e.type === "llm_usage") return; // routine
          setRecent((r) => [...r.slice(-49), e]);
        } catch {
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(bump, 250);
      };
      es.onerror = () => {
        setConnected(false);
        setReconnecting(true);
        es?.close();
        failures++;
        // 1s, 2s, 4s, 8s, then 15s, with jitter.
        const wait = Math.min(15_000, 1000 * 2 ** Math.min(failures - 1, 4)) + Math.random() * 400;
        if (!closed) retry = setTimeout(open, wait);
      };
    };
    open();
    // Safety net: refetch every 20s even if the stream is quiet.
    const poll = setInterval(bump, 20_000);
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      clearInterval(poll);
    };
  }, [bump]);

  return { version, bump, recent, connected, reconnecting, lastEventId };
}

/**
 * Fetch a JSON resource; refetches whenever the live version changes. Transient failures (engine
 * restarting, network blip) keep the last data, set `reconnecting` and retry by themselves every 3s;
 * `error` is only set for real errors (an engine answer with a message, e.g. 404).
 */
export function useResource<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reconnecting: boolean; reload: () => void } {
  const { version } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [n, setN] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (lastPath.current !== path) {
      setData(null);
      setError(null);
      lastPath.current = path;
    }
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
          setReconnecting(false);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (isTransient(e)) {
          setReconnecting(true);
          retryTimer = setTimeout(() => setN((x) => x + 1), 3000);
        } else {
          setReconnecting(false);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [path, version, n]);

  return { data, error, loading, reconnecting, reload: () => setN((x) => x + 1) };
}

/** Copy text to the clipboard (falls back to a hidden textarea on non-secure origins). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Fixture mode flag + config passed from the server page. */
export interface AppConfig {
  fixture: boolean;
  stripe: boolean;
}
export const ConfigContext = createContext<AppConfig>({ fixture: false, stripe: false });
export const useConfig = () => useContext(ConfigContext);
