// Display helpers shared by server and client. Amounts arrive as decimal strings of micro-tUSD.
import { microToMyr, microToTusd } from "@bulkhead/shared";

export const DEFAULT_MYR_PER_TUSD = "4.70";

export function big(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export function myr(micro: string | bigint | null | undefined, rate = DEFAULT_MYR_PER_TUSD): string {
  return `RM ${microToMyr(big(micro), rate)}`;
}

/** "RM12.34" without the space, for dense labels. */
export function myrShort(micro: string | bigint | null | undefined, rate = DEFAULT_MYR_PER_TUSD): string {
  return `RM${microToMyr(big(micro), rate)}`;
}

export function tusd(micro: string | bigint | null | undefined): string {
  const s = microToTusd(big(micro));
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(2, "0").slice(0, Math.max(2, f.length))} tUSD`;
}

export function ada(lovelace: string | bigint | null | undefined): string {
  const l = big(lovelace);
  const whole = l / 1_000_000n;
  const frac = (l % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac} ADA`;
}

export function pct(part: string | bigint, whole: string | bigint): number {
  const w = big(whole);
  if (w <= 0n) return 0;
  return Math.max(0, Math.min(100, Number((big(part) * 10000n) / w) / 100));
}

export function duration(ms: number): string {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const out = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
  return neg ? `-${out}` : out;
}

export function tokens(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M tok`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k tok`;
  return `${v} tok`;
}

export function shortAddr(a: string | null | undefined, n = 10): string {
  if (!a) return "—";
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-6)}`;
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTimeOf(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
