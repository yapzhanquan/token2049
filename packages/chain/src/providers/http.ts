// Small fetch wrapper with retries + exponential backoff on 429 / 5xx / network errors.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface RetryOptions {
  retries?: number; // extra attempts after the first (default 5)
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 15 000
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // per attempt (default 30 000)
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function redactUrl(url: string): string {
  return url.replace(/(token|key|project_id)=[^&]+/gi, "$1=***");
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Returns the Response for 2xx and for 404 (callers decide); throws HttpError otherwise. */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 15_000;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
      if (res.ok || res.status === 404) return res;
      const body = await res.text().catch(() => "");
      const err = new HttpError(res.status, body, url);
      if (!isRetryableStatus(res.status)) throw err;
      lastErr = err;
      const ra = res.headers.get("retry-after");
      if (ra && /^\d+$/.test(ra)) retryAfterMs = Number(ra) * 1000;
    } catch (e) {
      if (e instanceof HttpError && !isRetryableStatus(e.status)) throw e;
      lastErr = e;
    }
    if (attempt < retries) {
      const backoff = Math.min(max, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(max, retryAfterMs ?? backoff));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
