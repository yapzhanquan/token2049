// Engine HTTP API — request bodies and response shapes (single source of truth for the engine
// (packages/engine/src/api.ts), the web app and its fixture engine). Routes: ENGINE_ROUTES in ./index.
// Units: amounts are decimal strings of micro-tUSD (`…Micro`) or lovelace (`…Lovelace`) — bigint-safe
// JSON. Request bodies that a person types use decimal tUSD strings (`…TUSD`, e.g. "1.5").
import type { BulkheadEvent, ContextIn, Decision, Glyph, Handback, Plan, SessionStatus, TaskType, TreeDTO, WalletMode } from "./index";

export type Custody = "custodial" | "self";

/** Every non-2xx response. */
export interface ApiErrorBody {
  error: string;
  /** e.g. "insufficient_funds" (409) — the treasury cannot cover a funding tx. */
  code?: string;
  /** Preprod faucet link, set with code "insufficient_funds". */
  faucetUrl?: string;
}

export const PREPROD_FAUCET_URL = "https://docs.cardano.org/cardano-testnets/tools/faucet/";

// ─────────────── Self-custody signing (spec §2: "Connect wallet" users sign in the browser) ───────────────
/** Returned (HTTP 200) instead of the normal response when the action needs the user's CIP-30 signature.
 * The browser calls `wallet.signTx(unsignedTx, true)` and POSTs the SAME route again with
 * `{ ...originalBody, pendingId, signedTx }` (signedTx = the witness set CIP-30 returns, or a full signed tx). */
export interface NeedsSignatureResponse {
  ok: false;
  needsSignature: true;
  pendingId: string;
  /** Unsigned tx CBOR hex (spends the user's own wallet UTxOs). */
  unsignedTx: string;
  txHash: string;
  /** What is being signed, for the wallet prompt. */
  purpose: string;
  feeLovelace: string;
  /** POSIX ms: after this the pending tx is dropped and the action must be retried. */
  expiresAt: number;
}
export interface SignedBody {
  pendingId?: string;
  /** CIP-30 signTx result: a TransactionWitnessSet CBOR hex, or a full signed tx CBOR hex. */
  signedTx?: string;
}
export type MaybeSigned<T> = T | NeedsSignatureResponse;
export const isNeedsSignature = (x: unknown): x is NeedsSignatureResponse =>
  !!x && typeof x === "object" && (x as { needsSignature?: unknown }).needsSignature === true && typeof (x as { unsignedTx?: unknown }).unsignedTx === "string";

/** A signature the engine is waiting for (also listed on GET /me). */
export interface PendingSignatureDTO {
  pendingId: string;
  purpose: string;
  unsignedTx: string;
  txHash: string;
  feeLovelace: string;
  goalId?: string;
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
}

// ─────────────── Users ───────────────
/** GET /me */
export interface MeDTO {
  userId: string;
  email: string;
  name: string | null;
  custody: Custody;
  treasuryAddress: string;
  network: "preprod";
  /** tusdMicro = CIP-68 (333) tUSD. legacyTusdMicro (deprecated pre-CIP-68 unit) only when > 0. */
  balances: { tusdMicro: string; lovelace: string; legacyTusdMicro?: string };
  /** The tUSD token: CIP-68 (333) unit + CIP-14 fingerprint (asset1…) + its (100) reference NFT. */
  tusdToken?: TusdTokenDTO;
  /** Set when the balance could not be read (provider down / not configured). */
  balanceError?: string;
  /** MYR per 1 tUSD (MYR_PER_TUSD). */
  myrPerTusd: string;
  /** TOPUP_FEE_PCT */
  topupFeePct?: string;
  openDecisions: number;
  /** Self-custody: signatures the engine is waiting for. */
  pendingSignatures?: PendingSignatureDTO[];
  llm?: "anthropic" | "openai" | "mock";
  /** "fake" = offline FakeChain demo (NOT on-chain). */
  chain?: string;
  /** Web fixture engine only. */
  mode?: "fixture";
}

export interface TusdTokenDTO {
  unit: string;
  policyId: string;
  assetNameHex: string;
  standard: "CIP-68 (333)" | "legacy";
  /** CIP-14 asset fingerprint, asset1… */
  fingerprint: string;
  /** CIP-68 (100) reference NFT carrying the metadata datum. */
  referenceUnit?: string;
}

/** POST /users — upsert by email (also switches custody). */
export interface CreateUserBody {
  email: string;
  name: string | null;
  /** Omitted = keep the current custody (new users: "custodial"). Sign-in omits it. */
  custody?: Custody;
  /** Required for custody "self": the CIP-30 wallet's preprod address (its payment key hash becomes the owner key). */
  walletAddress?: string;
}
export interface CreateUserResponse {
  userId: string;
  custody: Custody;
  treasuryAddress: string;
  created: boolean;
}

// ─────────────── Top-ups ───────────────
/** POST /topups */
export interface TopupStartBody {
  amountMYR: string | number;
  simulated?: boolean;
  stripeSessionId?: string;
}
export interface TopupStartResponse {
  topupId: string;
  amountMyr: string;
  feeMyr: string;
  tusdMicro: string;
  simulated?: boolean;
  simulatedNote?: string;
}
/** POST /topups/:id/confirm — Stripe webhook, or the labelled simulated checkout. Idempotent by stripeEventId. */
export type TopupConfirmBody =
  | { stripeEventId: string; stripeSessionId?: string; amountTotal?: number | null; currency?: string | null; simulated?: false }
  | { stripeEventId: `simulated_${string}`; simulated: true };
export interface TopupDTO {
  id: string;
  amountMyr: string;
  feeMyr: string;
  tusdMicro: string;
  simulated: boolean;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash: string | null;
  createdAt: number;
}
export interface TopupConfirmResponse {
  ok: true;
  topup: TopupDTO;
  duplicate?: boolean;
  simulatedNote?: string;
}

// ─────────────── Goals ───────────────
/** GET /goals (newest first) */
export interface GoalSummary {
  id: string;
  goal: string;
  budgetMicro: string;
  deadline: number;
  rules: string;
  status: "planned" | "approved" | "running" | "done" | "cancelled";
  fundingTx: string | null;
  createdAt: number;
  sessions?: number;
  running?: number;
  closed?: number;
}

export interface FundingPreview {
  feeLovelace: string;
  totalTusd: string;
  totalLovelace: string;
  /** Set when the preview could not be built (e.g. empty treasury). */
  error?: string;
}

/** POST /goals */
export interface PlanBody {
  goal: string;
  budgetTUSD: string;
  /** ISO timestamp */
  deadline: string;
  rules: string;
}
export interface PlanResponse {
  goalId: string;
  plan: Plan;
  fundingPreview: FundingPreview;
}

/** POST /goals/:id/approve — body {} (or SignedBody on the second, signed call). */
export interface ApproveOk {
  ok: true;
  fundingTx: string | null;
  sessionIds: string[];
  alreadyApproved?: boolean;
}
export type ApproveResponse = ApproveOk | NeedsSignatureResponse;

// ─────────────── Sessions ───────────────
export interface PayeeDTO {
  id: string;
  label: string;
  address: string;
  /** ADA Handle ("$name") this payee was written as; `address` is its holder when resolved (preprod). */
  handle?: string;
  /** POSIX ms of the handle resolution. */
  resolvedAt?: number;
}

export interface PendingPaymentDTO {
  id: string;
  payee: string;
  payeeLabel?: string;
  amountMicro: string;
  memo: string;
  decisionId?: string;
}

export interface SessionMessageDTO {
  id: string;
  from: "user" | "captain" | "session";
  text: string;
  createdAt: number;
}

/** GET /sessions/:id */
export interface SessionDetailDTO {
  id: string;
  goalId: string;
  parentSessionId: string | null;
  letter: string;
  name: string;
  role: string;
  agentType: string;
  taskType: TaskType;
  definitionOfDone: string;
  goal: string;
  status: SessionStatus;
  tainted: boolean;
  startedAt: number | null;
  endedAt: number | null;
  tokensUsed: number;
  doneAttempts: number;
  /** Why it FAILED / was KILLED / EXPIRED / rejected. */
  endReason?: string | null;
  mandate: {
    budgetMicro: string;
    perPaymentMaxMicro: string;
    approvalThresholdMicro: string;
    allowedPayees: PayeeDTO[];
    expiresAt: number;
  };
  wallet: {
    address: string | null;
    /** "vault" = Bulkhead Session Vault (rules enforced on-chain); "native" = native-script wallet. */
    mode?: WalletMode;
    /** Applied script hash (vault mode: the per-session Session Vault hash). */
    scriptHash?: string | null;
    spentMicro: string;
    budgetMicro: string;
    feesLovelace: string;
    fundingTx?: string | null;
  };
  /** Earlier handbacks passed in — DATA, never instructions. */
  contextIn: ContextIn[];
  /** Session events, oldest first (progress, payments, approvals, messages, transitions…). */
  activity: BulkheadEvent[];
  messages: SessionMessageDTO[];
  pendingPayments: PendingPaymentDTO[];
  decisions: Decision[];
  handback: Handback | null;
  close: {
    refundMicro: string | null;
    closeTx: string | null;
    logSha256: string | null;
    handbackSha256: string | null;
  } | null;
}

export type ControlAction = "pause" | "resume" | "kill" | "extend" | "raise" | "narrow";
/** POST /sessions/:id/:action bodies */
export interface KillBody {
  reason?: string;
}
export interface RaiseBody extends SignedBody {
  addTUSD: string;
  reason?: string;
  /** true = the user approves the resulting decision at once (still recorded in the ledger). */
  confirm?: boolean;
}
export interface ExtendBody extends SignedBody {
  /** POSIX ms (or ISO string), later than the current expiry. */
  newExpiresAt: number | string;
  reason?: string;
  confirm?: boolean;
}
export interface NarrowBody {
  newBudgetTUSD: string;
}
export interface ControlOk {
  ok: true;
  status: SessionStatus;
  /** raise / extend: the decision that was opened (approve it via POST /decisions/:id). */
  decision?: Decision;
}
export type ControlResponse = ControlOk | NeedsSignatureResponse;

/** POST /sessions/pause-all */
export interface PauseAllResponse {
  ok: true;
  paused: number;
  failed: number;
}

/** POST /sessions/:id/messages */
export interface MessageBody {
  text: string;
}
export interface MessageResponse {
  messageId: string;
  /** true when the text looked like a mandate change (event mandate_change_ignored was logged). */
  mandateChangeIgnored?: boolean;
}

/** GET /sessions/:id/peek — SSE, one PeekLine JSON per `data:` line (no `event:` name). */
export interface PeekLine {
  id?: number;
  at: number;
  level: "info" | "warn" | "error";
  kind: string;
  text: string;
}

// ─────────────── Payments + decisions ───────────────
/** POST /payments/:id/approve|reject */
export interface PaymentDecisionResponse {
  ok: true;
  paymentId: string;
  status: string;
  decision?: Decision;
}

/** GET /decisions[?status=open] — without status: all. */
export type DecisionDTO = Decision & { goalId?: string; letter?: string; role?: string };

/** POST /decisions/:id */
export interface DecideBody extends SignedBody {
  status: "approved" | "rejected";
  note?: string;
}
export type DecideResponse = Decision | NeedsSignatureResponse;

/** POST /signatures/:pendingId — complete a pending self-custody signature not tied to a request. */
export interface SignatureBody {
  signedTx: string;
}
export interface SignatureResponse {
  ok: true;
  txHash: string;
}

// ─────────────── Captain ───────────────
/** POST /captain/messages */
export interface CaptainMessageBody {
  text: string;
  goalId?: string | null;
}
export interface CaptainMessageResponse {
  ok: true;
  queued: true;
}

/** GET /captain/log[?goalId=] */
export interface CaptainLogEntry {
  id: number;
  at: number;
  kind: "woken" | "absorbed" | "action" | "report" | "user_message";
  text: string;
  sessionId?: string;
  goalId?: string;
}
export interface CaptainLogDTO {
  woken: number;
  absorbed: number;
  entries: CaptainLogEntry[];
}

// ─────────────── Agent map / spending / logbook ───────────────
/** GET /agent-map[?goalId=] */
export interface AgentCardDTO {
  id: string;
  goalId: string;
  parentId: string | null;
  kind: "session" | "agent_job";
  letter?: string;
  role: string;
  shortGoal: string;
  status: SessionStatus;
  glyph: Glyph;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  tokensUsed: number;
  spentMicro: string;
  budgetMicro: string;
  refundMicro: string | null;
  latest: string | null;
  handbackSummary: string | null;
}
export interface AgentMapDTO {
  captain: {
    name: string;
    model: string;
    contextTokens: number;
    treasuryMicro: string;
    running: number;
    closed: number;
  };
  cards: AgentCardDTO[];
}

/** GET /spending */
export interface SpendingDTO {
  balanceHistory: { at: number; tusdMicro: string }[];
  perSession: {
    sessionId: string;
    goalId: string;
    letter: string;
    role: string;
    status: SessionStatus;
    budgetMicro: string;
    spentMicro: string;
    refundMicro: string | null;
    feesLovelace: string;
  }[];
  topups: TopupDTO[];
  totals: { spentMicro: string; refundMicro: string; feesLovelace: string; topupFeesMyr: string };
}

/** GET /logbook[?goalId=] — closed sessions, newest first. */
export interface LogbookEntryDTO {
  sessionId: string;
  goalId: string;
  goalText: string;
  letter: string;
  role: string;
  taskType: TaskType;
  status: SessionStatus;
  handback: Handback | null;
  spentMicro: string;
  refundMicro: string | null;
  closeTx: string | null;
  logSha256: string | null;
  handbackSha256: string | null;
  endedAt: number | null;
  /** Status the session had when it entered CLOSING (COMPLETED | FAILED | KILLED | EXPIRED). */
  closeStatus?: string | null;
  endReason?: string | null;
}

/** GET /health */
export interface HealthDTO {
  ok: true;
  network: "preprod";
  llm?: string;
  chain?: string;
  simulatedChain?: boolean;
  mode?: "fixture";
  at?: number;
}

export type { TreeDTO, Decision, BulkheadEvent };

// ───────── GET /activity (unified, newest-first activity feed) ─────────
export type ActivityKind =
  | "payment"
  | "funding"
  | "close"
  | "hire"
  | "handback"
  | "decision"
  | "topup"
  | "progress"
  | "captain"
  | "transition"
  | "message"
  | "rejection"
  | "staking";

export interface ActivityRowDTO {
  /** Stable row id, e.g. "ev:123", "pay:<id>", "dec:<id>", "top:<id>", "job:<id>", "stake:<hash>", "chain:<hash>". */
  id: string;
  at: number;
  kind: ActivityKind;
  title: string;
  goalId?: string | null;
  sessionId?: string | null;
  letter?: string | null;
  role?: string | null;
  agentJobId?: string | null;
  externalJobId?: string | null;
  paymentId?: string | null;
  decisionId?: string | null;
  txHash?: string | null;
  address?: string | null;
  amountMicro?: string | null;
  direction: "out" | "in" | null;
  status?: string | null;
  confirmations?: number | null;
  /** Monotonic event id when the row came from the events table (SSE resume / de-dup). */
  eventId?: number | null;
}

/** What `q` resolved to (GET /activity?q=…). */
export interface ActivityMatchDTO {
  type: "session" | "letter" | "agent_job" | "tx" | "decision" | "payment" | "address" | "goal" | "topup" | "text" | "none";
  value: string;
  label?: string;
  /** For a tx hash not found in the DB: a live chain summary (server-side provider). */
  chain?: { found: boolean; blockHeight?: number | null; slot?: number | null; confirmations?: number | null; feeLovelace?: string | null; blockTime?: number | null; error?: string } | null;
}

export interface ActivityDTO {
  rows: ActivityRowDTO[];
  match: ActivityMatchDTO | null;
  /** Pass as `before` to fetch the next (older) page; null at the end. */
  nextBefore: number | null;
}
