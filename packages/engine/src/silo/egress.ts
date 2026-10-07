// web_fetch on behalf of a silo (spec §5.5): the ORCHESTRATOR fetches, never the silo.
// Egress allowlist = the session's dataScope hosts; private / loopback / link-local IPs are blocked;
// responses are size-limited; content flagged untrusted (URL pattern, trust header, injection text) is reported.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressOptions {
  dataScope: string[];
  maxBytes: number;
  timeoutMs: number;
  allowPrivateHosts: string[];
  untrustedUrlPatterns: RegExp[];
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  maxRedirects?: number;
}

export type EgressResult =
  | { kind: "blocked"; reason: string; suspicious: boolean }
  | { kind: "ok"; url: string; status: number; contentType: string; bytes: number; truncated: boolean; text: string; untrusted: string | null };

/** dataScope entries may be URLs ("https://example.com/x"), hosts ("example.com") or wildcards ("*.example.com"). */
export function scopeHosts(dataScope: string[]): string[] {
  const out: string[] = [];
  for (const raw of dataScope) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    try {
      out.push(new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s.replace(/^\*\./, "")}`).hostname);
    } catch {
      /* not a host */
    }
  }
  return [...new Set(out)];
}

export function hostInScope(host: string, dataScope: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return scopeHosts(dataScope).some((s) => h === s || h.endsWith(`.${s}`));
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]!);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true; // not an IP → treat as unsafe
}

const INJECTION = [/ignore (all |any )?(previous|prior|above) instructions/i, /disregard (the )?(system|previous) prompt/i, /you are now (a|an|the)\b/i, /send (all |the )?(funds|money|tusd|ada)\b/i, /reveal (your )?(system prompt|keys?|mnemonic|secret)/i];

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function checkHost(url: URL, o: EgressOptions): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (o.allowPrivateHosts.includes(host)) return null;
  if (isIP(host)) return isPrivateIp(host) ? `private address ${host} blocked` : null;
  const lookup: LookupFn = o.lookup ?? ((h) => dnsLookup(h, { all: true, verbatim: true }));
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch {
    return `could not resolve ${host}`;
  }
  if (!addrs.length) return `could not resolve ${host}`;
  const bad = addrs.find((a) => isPrivateIp(a.address));
  return bad ? `${host} resolves to private address ${bad.address}` : null;
}

export async function egressFetch(rawUrl: string, o: EgressOptions): Promise<EgressResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "blocked", reason: "malformed URL", suspicious: false };
  }
  const f = o.fetchImpl ?? fetch;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "blocked", reason: `protocol ${url.protocol} not allowed`, suspicious: false };
    if (url.username || url.password) return { kind: "blocked", reason: "credentials in URL not allowed", suspicious: true };
    if (!hostInScope(url.hostname, o.dataScope)) return { kind: "blocked", reason: `${url.hostname} is not in the session's dataScope`, suspicious: true };
    const hostProblem = await checkHost(url, o);
    // Still blocked either way. Only a private target the agent named itself (an IP literal or
    // localhost) is suspicious enough to quarantine; a public hostname that the local network's DNS
    // resolves privately (DNS filters, captive portals) or fails to resolve is an environment
    // problem, so the agent just gets an error and moves on.
    if (hostProblem) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const named = isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
      return { kind: "blocked", reason: hostProblem, suspicious: named };
    }
    let res: Response;
    try {
      res = await f(url, { redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs), headers: { "user-agent": "bulkhead-egress/0.1", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    } catch (e) {
      return { kind: "blocked", reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}`, suspicious: false };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue; // every hop is re-checked against the allowlist and private-IP rules
    }
    // Size-limited read.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > o.maxBytes) {
          chunks.push(value.subarray(0, o.maxBytes - bytes));
          bytes = o.maxBytes;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        bytes += value.byteLength;
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    const contentType = res.headers.get("content-type") ?? "";
    const text = (/html/i.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body).slice(0, 20_000);
    const trustHeader = (res.headers.get("x-bulkhead-trust") ?? res.headers.get("x-content-trust") ?? "").toLowerCase();
    let untrusted: string | null = null;
    if (o.untrustedUrlPatterns.some((p) => p.test(url.href))) untrusted = "URL is flagged untrusted";
    else if (trustHeader === "untrusted") untrusted = "page is flagged untrusted by its trust header";
    else if (INJECTION.some((p) => p.test(text))) untrusted = "page contains instruction-like text (possible prompt injection)";
    return { kind: "ok", url: url.href, status: res.status, contentType, bytes, truncated, text, untrusted };
  }
  return { kind: "blocked", reason: "too many redirects", suspicious: false };
}
