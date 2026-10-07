// Server-side engine client. ONLY import from route handlers / server components: it reads
// ENGINE_TOKEN, which must never reach the browser. The browser talks to /api/engine/* (a proxy
// that adds the token + the signed-in user's id) instead.
import type { CreateUserBody, CreateUserResponse } from "@bulkhead/shared";

export function isFixtureMode(): boolean {
  return !process.env.ENGINE_URL || process.env.MOCK_ENGINE === "1";
}

export class EngineError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineCall {
  method: string;
  /** Path + optional query, e.g. "/goals/abc/tree" or "/decisions?status=open". */
  path: string;
  userId?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** Returns the raw Response (JSON or text/event-stream), so the proxy can stream SSE through. */
export async function engineRequest(call: EngineCall): Promise<Response> {
  if (isFixtureMode()) {
    const { handleFixture } = await import("./fixtures");
    return handleFixture(call.method, call.path, call.body, { userId: call.userId, signal: call.signal });
  }
  const base = process.env.ENGINE_URL!.replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
  if (process.env.ENGINE_TOKEN) headers["x-engine-token"] = process.env.ENGINE_TOKEN;
  if (call.userId) headers["x-user-id"] = call.userId;
  let body: string | undefined;
  if (call.body !== undefined && call.method !== "GET" && call.method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(call.body);
  }
  try {
    return await fetch(`${base}${call.path}`, { method: call.method, headers, body, signal: call.signal, cache: "no-store" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return new Response(JSON.stringify({ error: `Engine unreachable at ${base}: ${(e as Error).message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

export async function engineJson<T>(call: EngineCall): Promise<T> {
  const res = await engineRequest(call);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Engine ${call.method} ${call.path} failed (${res.status})`;
    throw new EngineError(res.status, msg);
  }
  return data as T;
}

/** POST /users — upsert by email. Omit `custody` on sign-in so a self-custody user stays self-custody. */
export async function ensureEngineUser(body: CreateUserBody): Promise<{ userId: string; custody: CreateUserResponse["custody"] }> {
  const res = await engineJson<CreateUserResponse>({ method: "POST", path: "/users", body });
  if (!res?.userId) throw new EngineError(502, "Engine POST /users returned no user id");
  return { userId: res.userId, custody: res.custody };
}
