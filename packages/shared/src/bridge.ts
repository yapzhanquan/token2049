// Bridge contracts: how the captain earns trust (Firstmate-style communication).
//   - PlanRationale      — why the planner split the goal the way it did (stored per goal, in GoalSummary / PlanResponse)
//   - captain_action.why — one evidence-based sentence on every captain tool call (model-written or deterministic)
//   - CaptainReportData  — structured outcome reports (`captain_report` events that carry `kind`)
//   - BearingsDTO        — GET /bearings: deterministic digest from DB + chain (done / in flight / needs you / money)
//   - AhoyDTO            — GET /ahoy: what happened since the user's last-seen marker + open decisions by impact
// Pure TypeScript; no Node, no Cardano, no DB imports.

// ───────────────────────────── Plan rationale ─────────────────────────────
export interface PlanRationaleSession {
  /** Index in plan.sessions; sessions of a plan get letters A, B, C… in this order. */
  index: number;
  letter: string;
  name: string;
  taskType: "research" | "buy_pay" | "hire_agent" | "monitor";
  /** One plain sentence: why this session exists. */
  why: string;
  /** "parallel" = starts at once; "after" = waits for the handbacks of `after`. */
  runs: "parallel" | "after";
  after?: string[];
  budgetTUSD: string;
  /** Share of the goal budget, 0-100 (integer). */
  sharePct: number;
}

export interface PlanRationale {
  /** 1-2 plain sentences (the planner model's own words when it gave them, else deterministic). */
  summary: string;
  sessions: PlanRationaleSession[];
  /** Why parallel vs dependent, e.g. "A and B start at once; C waits for A's findings because it pays based on them." */
  parallelism: string;
  /** Budget split, e.g. "9 of 10 tUSD allocated (A 1, B 4.5, C 3.5); 1 tUSD stays unallocated in your treasury." */
  budget: string;
  /** Which on-chain / engine guards apply to this plan (one sentence each). */
  guards: string[];
  /** Deterministic adjustments the engine made to the model's plan (e.g. dropped a needless dependency). */
  adjustments: string[];
  source: "planner" | "deterministic";
}

// ───────────────────────────── Captain action why ─────────────────────────────
/** Extra fields every `captain_action` event's data carries (besides tool, input, ok, result|error, userId, auto?). */
export interface CaptainActionWhy {
  /** One evidence-based sentence, e.g. "B hit 4 consecutive HTTP 404s; redirected it to docs.cardano.org". */
  why: string;
  /** "model": the captain LLM wrote it (tool input `why`); "auto": derived deterministically from the wake evidence. */
  whySource: "model" | "auto";
}

// ───────────────────────────── Outcome reports ─────────────────────────────
export const REPORT_KINDS = ["session_result", "goal_result", "escalation", "incident"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const EVIDENCE_KINDS = ["tx", "handback_hash", "source", "dod", "vault"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ReportEvidence {
  label: string;
  kind: EvidenceKind;
  /** tx hash, sha-256, URL, task type (dod) or address (vault). */
  ref: string;
  /** Explorer / source link when there is one (preprod.cardanoscan.io for tx + vault). */
  url?: string;
}

/**
 * `captain_report` event data when `kind` is present (structured outcome report). A `captain_report` WITHOUT `kind`
 * is the captain's free-text chat (report_to_user): `{ text, userId, triggerEventId?, notify, routine? }`.
 */
export interface CaptainReportData {
  kind: ReportKind;
  goalId: string;
  sessionId?: string;
  letter?: string;
  /** Plain outcome, <= 120 chars. */
  headline: string;
  risk: RiskLevel;
  riskReason: string;
  evidence: ReportEvidence[];
  /** What happens next / what the user may want to do. */
  next?: string;
  /** escalation (and quarantine incidents): the open decision this report is about. */
  decisionId?: string;
  /** escalation: the captain's recommendation for that decision. */
  recommendation?: DecisionRecommendation;
  /** true = push to the user (toast / badge); false = record only (shown in /ahoy + logs). */
  notify: boolean;
  /** Who worded the headline: the captain LLM (validated against the facts) or the deterministic template. */
  wording: "llm" | "deterministic";
  /** Rendered one-liner for text-only consumers: "<headline> — risk: <risk> (<riskReason>) — next: <next>". */
  text: string;
  userId: string;
  /** Idempotency key (one report per accepted handback / goal / incident / decision). */
  dedupKey: string;
}

export interface DecisionRecommendation {
  action: "approve" | "reject" | "review";
  /** One evidence-based sentence. */
  why: string;
}

/** Firstmate-style one-liner: outcome first, then risk + reason, then the next step. */
export function renderReportText(r: Pick<CaptainReportData, "headline" | "risk" | "riskReason" | "next">): string {
  return `${r.headline} — risk: ${r.risk} (${r.riskReason})${r.next ? ` — next: ${r.next}` : ""}`.slice(0, 600);
}

export const riskRank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);
export const maxRisk = (...rs: RiskLevel[]): RiskLevel => rs.reduce<RiskLevel>((a, b) => (riskRank(b) > riskRank(a) ? b : a), "low");

// ───────────────────────────── Bearings ─────────────────────────────
export interface BearingsItem {
  /** One scannable line. */
  text: string;
  goalId?: string;
  sessionId?: string;
  letter?: string;
  decisionId?: string;
  risk?: RiskLevel;
  at?: number;
  refs: ReportEvidence[];
  /** needsYou only: what the captain recommends. */
  recommendation?: DecisionRecommendation;
}

export interface BearingsMoney {
  ticker: string;
  /** Decimal amounts in the settlement token (tUSD-style, 6 decimals). */
  budget: string;
  spent: string;
  /** Live on-chain balance of the still-open session wallets / vaults ("chain"), or budget - spent ("db") when the chain could not be read. */
  inVaults: string;
  inVaultsSource: "chain" | "db";
  returned: string;
  /** Number of transactions submitted but not yet confirmed (payments, funding, closes). */
  pendingTx: number;
  pendingTxs: ReportEvidence[];
  /** Treasury autopilot refills touching this user's treasury in the last 24 h (in or out); absent when none. */
  autopilot?: { refills: number; tusd: string; ada: string; pending: number; txs: ReportEvidence[] };
}

/** GET /bearings[?goalId=][&judge=1] */
export interface BearingsDTO {
  generatedAt: number;
  goalId: string | null;
  needsYou: BearingsItem[];
  done: BearingsItem[];
  inFlight: BearingsItem[];
  money: BearingsMoney;
  /** Captain's one-line overall judgement (deterministic unless ?judge=1 and the LLM wording passed validation). */
  overall: { text: string; source: "llm" | "deterministic" };
  /** Empty-state sentences for the three lists (always present). */
  empty: { needsYou: string; done: string; inFlight: string };
}

/** POST /bearings/file { goalId? } */
export interface BearingsFileResponse {
  ok: true;
  /** Absolute path of the dated markdown report (data/reports/bearings-YYYY-MM-DD-<user>[-<goal>].md). */
  path: string;
  file: string;
  bearings: BearingsDTO;
}

// ───────────────────────────── Ahoy ─────────────────────────────
export type AhoyGroupKey = "reports" | "captain" | "money" | "decisions" | "messages" | "routine";

export interface AhoyItem {
  text: string;
  at: number;
  eventIds: number[];
  goalId?: string;
  sessionId?: string;
  risk?: RiskLevel;
  refs: ReportEvidence[];
}

export interface AhoyGroup {
  key: AhoyGroupKey;
  title: string;
  count: number;
  items: AhoyItem[];
}

export interface AhoyDecision {
  decisionId: string;
  goalId: string | null;
  sessionId: string;
  letter: string | null;
  kind: string;
  /** Plain question, e.g. "Approve a 3 tUSD payment from B to Summariser?" */
  question: string;
  amountAtRisk: string;
  deadlineAt: number | null;
  msToDeadline: number | null;
  /** Letters of sessions waiting on this decision (the session itself + dependents not started). */
  blockedSessions: string[];
  impactScore: number;
  /** e.g. "3 tUSD at risk (30% of the goal budget) · B's wallet expires in 40 min · blocks B, C" */
  impactReason: string;
  risk: RiskLevel;
  recommendation: DecisionRecommendation;
  openedAt: number;
}

/** GET /ahoy[?goalId=][&judge=1] */
export interface AhoyDTO {
  generatedAt: number;
  /** Boundary: the user's last-seen marker, else their last message to the captain, else none (bounded window). */
  since: { kind: "marker" | "last_message" | "none"; eventId: number; at: number | null };
  /** Newest event id considered: POST it back to /ahoy/seen to mark everything up to here as seen. */
  latestEventId: number;
  headline: { text: string; source: "llm" | "deterministic" };
  nothingHappened: boolean;
  groups: AhoyGroup[];
  /** Every still-open decision (also ones raised before the boundary), highest impact first. */
  decisions: AhoyDecision[];
  counts: { events: number; reports: number; routine: number };
}

/** POST /ahoy/seen { eventId? } (default: the newest visible event) */
export interface AhoySeenResponse {
  ok: true;
  seenEventId: number;
}

export const BRIDGE_ROUTES = {
  bearings: "GET /bearings", // ?goalId=&judge=1 → BearingsDTO
  bearingsFile: "POST /bearings/file", // { goalId? } → BearingsFileResponse
  ahoy: "GET /ahoy", // ?goalId=&judge=1 → AhoyDTO
  ahoySeen: "POST /ahoy/seen", // { eventId? } → AhoySeenResponse
} as const;
