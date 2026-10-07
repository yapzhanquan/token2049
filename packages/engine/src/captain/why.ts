// `why` for every captain action: one evidence-based sentence ("B hit 4 consecutive HTTP 404s; redirected it to
// docs.cardano.org"). The model may write its own (tool input `why`); otherwise — and always for the deterministic
// fallback ladder — it is derived here from the wake's events (the evidence) plus what the action did.
import { microToTusd, type BulkheadEvent } from "@bulkhead/shared";
import { sessions as sessionsT, type DB } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import type { SessionRow } from "../contracts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const MAX_WHY = 220;

export function hostOf(s: string): string | null {
  const m = /https?:\/\/[^\s"')<>,;]+/i.exec(s);
  const raw = m ? m[0] : /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i.exec(s)?.[1];
  if (!raw) return null;
  try {
    return new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** "4 consecutive HTTP 404s" / "4 denied tool calls (pay)" / "4 failed tool calls (HTTP 404 ×2, blocked ×2)". */
export function failureSummary(recent: string[]): string {
  const n = recent.length;
  if (!n) return "repeated failures";
  const codes = recent.map((r) => /^HTTP (\d{3})/.exec(r)?.[1] ?? null);
  if (codes.every((c) => c && c === codes[0])) return `${n} consecutive HTTP ${codes[0]}s`;
  if (recent.every((r) => r.startsWith("tool denied"))) {
    const tools = [...new Set(recent.map((r) => /tool denied: (\w+)/.exec(r)?.[1]).filter(Boolean))];
    return `${n} denied tool calls${tools.length ? ` (${tools.join(", ")})` : ""}`;
  }
  if (recent.every((r) => r.startsWith("fetched "))) return `the same page fetched ${n} times`;
  if (recent.every((r) => r.startsWith("stuck:"))) return clip(recent[recent.length - 1], 90);
  const kinds = new Map<string, number>();
  for (const r of recent) {
    const k = /^HTTP \d{3}/.exec(r)?.[0] ?? (r.startsWith("blocked") ? "blocked fetch" : r.startsWith("tool denied") ? "denied tool" : r.startsWith("invalid handback") ? "invalid handback" : "error");
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return `${n} failed tool calls (${[...kinds].map(([k, v]) => `${k} ×${v}`).join(", ")})`;
}

const mins = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** The evidence half: what the wake event says happened (no action). */
export function evidenceOf(e: BulkheadEvent | undefined, L: string): string {
  if (!e) return "";
  const d = e.data ?? {};
  switch (e.type) {
    case "session_looping":
      return `${L} hit ${failureSummary(Array.isArray(d.recent) ? (d.recent as unknown[]).map(String) : [])}`;
    case "session_stalled":
      return `${L} made no progress for ${mins(Number(d.idleMs ?? 0))}`;
    case "handback_submitted":
      return `${L} handed back${typeof d.summary === "string" && d.summary ? ` "${clip(d.summary, 70)}"` : ""}`;
    case "payment_rejected":
      return `${L}'s payment${d.amountTUSD ? ` of ${String(d.amountTUSD)}` : ""} was refused (${String(d.reason ?? "policy")}); no funds moved`;
    case "decision_opened":
      return `${L} needs a decision on ${String(d.kind ?? "a request").replace(/_/g, " ")}`;
    case "decision_closed":
      return `your ${String(d.kind ?? "decision").replace(/_/g, " ")} decision for ${L} was ${String(d.status ?? "closed")}`;
    case "user_message":
      return `you asked: "${clip(String(d.text ?? "").replace(/\s+/g, " "), 80)}"`;
    case "goal_completed":
      return `all ${String(d.total ?? "")} sessions closed and ${String(d.doneMet ?? 0)} met their definition of done${d.timeBoxed ? " (time-boxed)" : ""}`.replace("all  ", "all ");
    case "work_deadline_reached":
      return `${L}'s ${String(d.workSeconds ?? "")} s work time ran out; its partial handback was collected`.replace("'s  s", "'s");
    case "tainted":
      return `${L} read flagged content${hostOf(String(d.url ?? "")) ? ` on ${hostOf(String(d.url))}` : ""} (${clip(String(d.reason ?? "untrusted"), 60)})`;
    case "heartbeat_missed":
      return `${L} missed ${String(d.missed ?? "several")} heartbeats`;
    case "session_transition":
      return `${L} became ${String(d.to ?? "?")}${d.reason ? ` (${clip(String(d.reason), 70)})` : ""}`;
    case "deadline_near":
      return `${L}'s wallet expires in ${mins(Number(d.msLeft ?? 0))}`;
    case "deposit_seen":
    case "topup_confirmed":
      return `a top-up${d.tusd ? ` of ${String(d.tusd)}` : ""} confirmed on-chain`;
    default:
      return e.type.replace(/_/g, " ");
  }
}

/** The action half: what the tool call did, in plain words. */
export function actionPhrase(tool: string, input: Record<string, unknown>, ctx: { db?: DB; row?: SessionRow | null; toLetter?: string }): string {
  const L = ctx.row?.letter ?? (typeof input.sessionId === "string" ? input.sessionId : "it");
  switch (tool) {
    case "message_session": {
      const text = String(input.text ?? "");
      if (/\bwrap up\b/i.test(text)) return `told ${L} to wrap up and hand back what it has`;
      const host = hostOf(text) ?? (ctx.db && ctx.row ? firstScopeHost(ctx.db, ctx.row.id) : null);
      return `redirected ${L}${host ? ` to ${host}` : ""}`;
    }
    case "kill_session":
      return `stopped ${L}; its leftover funds return to your treasury`;
    case "pause_session":
      return `paused ${L} (its spending stops)`;
    case "resume_session":
      return `resumed ${L}`;
    case "pass_handback":
      return `passed ${L}'s handback to ${ctx.toLetter ?? String(input.toSessionId ?? "the next session")}`;
    case "spawn_session":
      return `added session "${clip(String(input.name ?? "new"), 40)}" with ${String(input.budgetTUSD ?? "?")} from the unallocated budget`;
    case "request_user_approval":
      return `asked you to decide on ${String(input.kind ?? "a change").replace(/_/g, " ")} for ${L}`;
    case "report_to_user":
      return "reported to you";
    case "read_status":
      return input.sessionId === "all" ? "checked every session's status" : `checked ${L}'s status`;
    case "plan_task":
      return `planned "${clip(String(input.goal ?? ""), 60)}" for your approval`;
    default:
      return tool.replace(/_/g, " ");
  }
}

function firstScopeHost(db: DB, sessionId: string): string | null {
  try {
    const r = db.select({ j: sessionsT.dataScopeJson }).from(sessionsT).where(eq(sessionsT.id, sessionId)).get();
    const scope = JSON.parse(r?.j || "[]") as unknown[];
    for (const s of scope) {
      const h = hostOf(String(s));
      if (h) return h;
    }
  } catch {
    /* no scope */
  }
  return null;
}

/** Pick the wake event that is about this session (else the trigger). */
export function eventFor(events: BulkheadEvent[], sessionId: string | undefined): BulkheadEvent | undefined {
  return (sessionId ? events.find((e) => e.sessionId === sessionId) : undefined) ?? events[0];
}

/** Evidence + action, one sentence, clipped. */
export function deriveWhy(args: { tool: string; input: Record<string, unknown>; events: BulkheadEvent[]; row?: SessionRow | null; toLetter?: string; db?: DB }): string {
  const { tool, input, events, row } = args;
  const ev = eventFor(events, row?.id);
  const evLetter = !row && ev?.sessionId && args.db ? args.db.select({ l: sessionsT.letter }).from(sessionsT).where(eq(sessionsT.id, ev.sessionId)).get()?.l : undefined;
  const L = row?.letter ?? evLetter ?? (ev?.data?.letter ? String(ev.data.letter) : "the session");
  const evidence = evidenceOf(ev, L);
  const action = actionPhrase(tool, input, { db: args.db, row, toLetter: args.toLetter });
  const s = evidence ? `${capitalize(evidence)}; ${action}` : capitalize(action);
  return clip(s.replace(/\s+/g, " ").trim(), MAX_WHY);
}

/** A model-written why: one sentence, plain text, bounded. Returns null when unusable. */
export function cleanModelWhy(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length < 8) return null;
  return clip(s, MAX_WHY);
}

/** Amount helper for evidence lines. */
export const tusd = (micro: bigint | string) => microToTusd(typeof micro === "bigint" ? micro : BigInt(micro));

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
