// Local types for the worker. Engine DTOs come from @bulkhead/shared (type-only imports).

/** A Task row from `sokosumi --preprod tasks list --coworker-id ID --json` (`.tasks[]`). */
export interface SokoTask {
  id: string;
  status: string | null; // DRAFT | READY | RUNNING | COMPLETED | …
  coworkerId: string | null;
  name?: string | null;
  description?: string | null;
  organizationId?: string | null;
  updatedAt?: string | null;
}

/** `runtime start` result: the authoritative started Task input. */
export interface StartedTask {
  id: string;
  name: string | null;
  description: string | null;
  status: string;
}

/** A Core Task event (GET /v1/tasks/{id}/events). Only the fields the worker reads. */
export interface SokoEvent {
  id: string;
  createdAt?: string;
  status?: string | null;
  comment?: string | null;
  actor?: { type?: string; id?: string } | null;
}

/** Core GET /v1/tasks/{id}/receipt `data`. */
export interface CoreReceipt {
  settled?: boolean;
  txHash?: string | null;
  blockchainIdentifier?: string | null;
  [k: string]: unknown;
}

/** What a Task asks for, after parsing and quoting. Amounts are micro units (6 decimals) as strings. */
export interface Order {
  goal: string;
  /** Crew budget = Bulkhead treasury float for the goal (tUSD, 1:1 with tUSDM). */
  crewBudgetMicro: string;
  feeMicro: string;
  /** Price quoted to the Task = crew budget + fee (≤ MAX_QUOTE_TUSDM). */
  quoteMicro: string;
  requestedBudgetMicro: string | null;
  capped: boolean;
  deadlineMs: number;
  notes: string[];
}

export type Phase =
  | "starting" // runtime start pending (uncertain on restart)
  | "started" // authoritative input saved
  | "goal-pending" // POST /goals pending
  | "goal-created"
  | "approve-pending" // POST /goals/:id/approve pending
  | "running" // crew running; decisions handled; waits for all sessions CLOSED
  | "result-saved" // exact result bytes saved + hashed
  | "complete-pending" // completion write pending (uncertain on restart)
  | "completed"
  | "failed"; // needs a human; nothing is retried automatically

export type PaymentStage =
  | "terms-pending"
  | "terms-saved"
  | "purchase-pending"
  | "awaiting-escrow"
  | "escrow-confirmed"
  | "submit-pending"
  | "awaiting-result"
  | "complete-ready"
  | "awaiting-withdrawal"
  | "settled";

export interface PaidState {
  stage: PaymentStage;
  nonce: string;
  request?: Record<string, unknown>;
  /** When the terms request was sent (terms-pending inspection waits a grace period after this). */
  requestedAt?: number;
  /** Signed MPS payment terms, saved verbatim before validation. */
  payment?: MpsPayment;
  payload?: Record<string, unknown>;
  paymentEventId?: string;
  observed?: MpsPayment;
  resultHash?: string;
  completionEventId?: string;
  settlement?: SettlementEvidence;
}

export type DecisionState = "approve-pending" | "reject-pending" | "approved" | "rejected" | "ask-pending" | "asked" | "uncertain";
export interface DecisionRecord {
  state: DecisionState;
  kind: string;
  reason: string;
  amountMicro?: string;
  askedAt?: number;
}

export type CommentState = "action-pending" | "reply-pending" | "posted" | "ignored";
export interface CommentRecord {
  state: CommentState;
  intent: string;
  reply?: string;
}

export interface Ledger {
  /** Treasury float: sum of session budgets funded by Bulkhead's treasury. */
  floatMicro: string;
  spentMicro: string;
  refundMicro: string;
  feesLovelace: string;
  /** float − refunds: what the treasury is out after the crew closed. */
  treasuryNetOutMicro: string;
  quoteMicro: string;
  feeMicro: string;
  /** Paid Tasks: net seller receipt measured by the settlement check (null until verified). */
  reimbursementAtomic: string | null;
  settlementTx: string | null;
  /** reimbursement − treasuryNetOut (null until verified). */
  marginMicro: string | null;
  /**
   * Float ↔ reimbursement bridge entry, written once the settlement check verifies the seller's net
   * receipt. Accounting only: the tUSDM stays in the MPS-managed Selling wallet (moved only through
   * MPS-supported endpoints, never by extracting its keys); the entry credits it against the float.
   */
  reimbursementEntry?: {
    kind: "float-reimbursement";
    unit: string;
    atomic: string;
    settlementTx: string;
    sellerAddress: string;
    treasuryNetOutMicro: string;
    marginMicro: string;
    onChainTransferToTreasury: false;
    recordedAt: number;
  };
}

export interface TaskJournal {
  version: 1;
  taskId: string;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  mode?: "paid" | "execution";
  /** When `runtime start` was last attempted (runner clock). */
  startAttemptAt?: number;
  input?: string;
  taskName?: string | null;
  order?: Order;
  orderError?: string;
  payment?: PaidState;
  goalId?: string;
  fundingTx?: string | null;
  sessionIds?: string[];
  /** Extra auto-approval allowance granted by the Task owner via "approve <n> tUSDM" comments. */
  allowanceExtraMicro: string;
  decisions: Record<string, DecisionRecord>;
  comments: Record<string, CommentRecord>;
  result?: { sha256: string; hashRule: string; byteLength: number; savedAt: number };
  completion?: { eventId?: string | null; at: number; via: "cli" | "core-event" };
  ledger?: Ledger;
  /** Last error (truncated, secret-free) and when. */
  lastError?: { at: number; message: string };
  failedReason?: string;
}

export interface WorkerState {
  engineUserId?: string;
  engineUserEmail?: string;
}

// ─────────── MPS (Masumi Payment Service) payment shape, only the fields used ───────────
export interface MpsTx {
  status?: string; // Pending | Confirmed | FailedViaTimeout | RolledBack
  newOnChainState?: string | null;
  previousOnChainState?: string | null;
  txHash?: string | null;
}
export interface MpsPayment {
  blockchainIdentifier: string;
  agentIdentifier?: string | null;
  onChainState?: string | null;
  resultHash?: string | null;
  inputHash?: string | null;
  payByTime?: string | null;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  sellerReturnAddress?: string | null;
  forceLayer?: string | null;
  RequestedFunds: { amount: string; unit: string }[];
  PaymentSource?: { network?: string; paymentSourceType?: string; smartContractAddress?: string; policyId?: string | null } | null;
  SmartContractWallet?: { id?: string; walletVkey?: string; walletAddress?: string } | null;
  CurrentTransaction?: MpsTx | null;
  TransactionHistory?: MpsTx[] | null;
  [k: string]: unknown;
}

export interface SettlementEvidence {
  verified: boolean;
  reason?: string;
  txHash?: string;
  netAtomicUnits?: string;
  method?: string;
  checkedAt: number;
}
