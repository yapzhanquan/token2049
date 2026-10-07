// Task input → Bulkhead order, and the dynamic quote: price = crew budget + Bulkhead fee, capped.
// The input is untrusted DATA: it only supplies the goal text, a budget and a deadline.
import { microToTusd, tusdToMicro } from "@bulkhead/shared";
import type { Order } from "./types";

export interface QuoteConfig {
  feeMicro: bigint; // BULKHEAD_FEE_TUSDM (default 0.5)
  maxQuoteMicro: bigint; // MAX_QUOTE_TUSDM (default 20)
  defaultBudgetMicro: bigint; // DEFAULT_CREW_BUDGET_TUSDM (default 2)
  defaultDeadlineMs: number; // DEFAULT_DEADLINE_MINUTES (default 120)
  minDeadlineMs: number; // MIN_DEADLINE_MINUTES (default 15)
  maxDeadlineMs: number; // MAX_DEADLINE_HOURS (default 168)
}

export const MAX_GOAL_CHARS = 4000;

export interface Quote {
  crewBudgetMicro: bigint;
  feeMicro: bigint;
  quoteMicro: bigint;
  capped: boolean;
}

/** price = crew + fee; when that exceeds the cap the crew budget shrinks to cap − fee. */
export function computeQuote(requestedCrewMicro: bigint, cfg: Pick<QuoteConfig, "feeMicro" | "maxQuoteMicro">): Quote {
  if (requestedCrewMicro <= 0n) throw new Error("Crew budget must be positive");
  const room = cfg.maxQuoteMicro - cfg.feeMicro;
  if (room <= 0n) throw new Error("MAX_QUOTE_TUSDM must exceed BULKHEAD_FEE_TUSDM");
  const capped = requestedCrewMicro > room;
  const crewBudgetMicro = capped ? room : requestedCrewMicro;
  return { crewBudgetMicro, feeMicro: cfg.feeMicro, quoteMicro: crewBudgetMicro + cfg.feeMicro, capped };
}

const AMOUNT = String.raw`(\d{1,9}(?:\.\d{1,6})?)`;
const BUDGET_RE = new RegExp(String.raw`^\s*(?:crew\s+)?budget\s*[:=]?\s*${AMOUNT}\s*(?:t?usdm?|t?usd)?\s*$`, "im");
const INLINE_BUDGET_RE = new RegExp(String.raw`\bbudget(?:\s+of)?\s*[:=]?\s*${AMOUNT}\s*(?:t?usdm|t?usd)\b`, "i");
const DEADLINE_RE = /^\s*deadline\s*[:=]?\s*(.+?)\s*$/im;
const GOAL_RE = /^\s*goal\s*[:=]\s*(.+)$/im;

/** "2026-10-08T12:00Z", "in 90 minutes", "2h", "3 days" → epoch ms (or null if unreadable). */
export function parseDeadline(text: string, now: number): number | null {
  const t = text.trim().replace(/^in\s+/i, "");
  const rel = /^(\d{1,4})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const ms = u.startsWith("m") ? 60_000 : u.startsWith("h") ? 3_600_000 : 86_400_000;
    return now + n * ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse goal / budget / deadline from the authoritative started Task input and quote it. */
export function parseOrder(input: string, cfg: QuoteConfig, now: number, taskName?: string | null): Order {
  const notes: string[] = [];
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("Task input is empty");

  let requested: bigint | null = null;
  const b = BUDGET_RE.exec(text) ?? INLINE_BUDGET_RE.exec(text);
  if (b) requested = tusdToMicro(b[1]);
  if (requested !== null && requested <= 0n) throw new Error("Budget must be positive");

  let deadlineMs: number | null = null;
  const d = DEADLINE_RE.exec(text);
  if (d) {
    deadlineMs = parseDeadline(d[1], now);
    if (deadlineMs === null) notes.push(`Deadline "${d[1].slice(0, 60)}" not understood; default used.`);
  }
  if (deadlineMs === null) deadlineMs = now + cfg.defaultDeadlineMs;
  if (deadlineMs < now + cfg.minDeadlineMs) {
    notes.push(`Deadline raised to the minimum of ${Math.round(cfg.minDeadlineMs / 60_000)} minutes.`);
    deadlineMs = now + cfg.minDeadlineMs;
  }
  if (deadlineMs > now + cfg.maxDeadlineMs) {
    notes.push(`Deadline lowered to the maximum of ${Math.round(cfg.maxDeadlineMs / 3_600_000)} hours.`);
    deadlineMs = now + cfg.maxDeadlineMs;
  }

  const g = GOAL_RE.exec(text);
  let goal = g
    ? g[1].trim()
    : text
        .split("\n")
        .filter((line) => !BUDGET_RE.test(line) && !DEADLINE_RE.test(line))
        .join("\n")
        .trim();
  if (!goal && taskName) goal = taskName.trim();
  if (!goal) throw new Error("Task input has no goal text");
  if (goal.length > MAX_GOAL_CHARS) {
    goal = goal.slice(0, MAX_GOAL_CHARS);
    notes.push(`Goal truncated to ${MAX_GOAL_CHARS} characters.`);
  }

  if (requested === null) notes.push(`No budget given; default crew budget ${microToTusd(cfg.defaultBudgetMicro)} tUSDM used.`);
  const q = computeQuote(requested ?? cfg.defaultBudgetMicro, cfg);
  if (q.capped) notes.push(`Crew budget capped to ${microToTusd(q.crewBudgetMicro)} tUSDM so the quote stays within ${microToTusd(cfg.maxQuoteMicro)} tUSDM.`);
  return {
    goal,
    crewBudgetMicro: q.crewBudgetMicro.toString(),
    feeMicro: q.feeMicro.toString(),
    quoteMicro: q.quoteMicro.toString(),
    requestedBudgetMicro: requested === null ? null : requested.toString(),
    capped: q.capped,
    deadlineMs,
    notes,
  };
}
