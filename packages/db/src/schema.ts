// SQLite schema (Drizzle). One file, zero setup: DATABASE_PATH (default ./data/bulkhead.sqlite).
// Amounts are stored as TEXT decimal strings of micro-tUSD / lovelace (bigint-safe).
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  custody: text("custody", { enum: ["custodial", "self"] }).notNull(),
  /** BIP32 account index for custodial treasury derivation. */
  accountIndex: integer("account_index").notNull(),
  treasuryAddress: text("treasury_address").notNull(),
  /** Hex payment key hash of the treasury (owner key in session scripts). */
  ownerKeyHash: text("owner_key_hash").notNull(),
  /** Hex stake credential hash, if any (session addresses delegate to it). */
  stakeKeyHash: text("stake_key_hash"),
  createdAt: integer("created_at").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  goal: text("goal").notNull(),
  budgetMicro: text("budget_micro").notNull(),
  deadline: integer("deadline").notNull(),
  rules: text("rules").notNull().default(""),
  status: text("status", { enum: ["planned", "approved", "running", "done", "cancelled"] }).notNull(),
  planJson: text("plan_json").notNull(),
  /** Orchestrator long-term memory (task notes). Never sent to silos. */
  notes: text("notes").notNull().default(""),
  fundingTx: text("funding_tx"),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id").notNull().references(() => goals.id),
    userId: text("user_id").notNull().references(() => users.id),
    parentSessionId: text("parent_session_id"),
    letter: text("letter").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    agentType: text("agent_type").notNull(),
    taskType: text("task_type", { enum: ["research", "buy_pay", "hire_agent", "monitor"] }).notNull(),
    allowWebFetch: integer("allow_web_fetch", { mode: "boolean" }).notNull().default(false),
    watchJson: text("watch_json"),
    /** Definition-of-done attempts used (max MAX_DONE_ATTEMPTS from @bulkhead/shared). */
    doneAttempts: integer("done_attempts").notNull().default(0),
    goal: text("goal").notNull(),
    status: text("status").notNull(),
    walletMode: text("wallet_mode", { enum: ["native", "vault"] }).notNull().default("native"),
    /** Hash of the applied session script (vault mode: per-session Session Vault script hash). */
    scriptHash: text("script_hash"),
    // Mandate
    budgetMicro: text("budget_micro").notNull(),
    perPaymentMaxMicro: text("per_payment_max_micro").notNull(),
    approvalThresholdMicro: text("approval_threshold_micro").notNull(),
    allowedPayeesJson: text("allowed_payees_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    expirySlot: integer("expiry_slot"),
    dataScopeJson: text("data_scope_json").notNull().default("[]"),
    /** Session ids whose handbacks this session waits for (plan contextFrom), JSON string[]. */
    contextFromJson: text("context_from_json").notNull().default("[]"),
    /** ContextIn[] actually delivered to the silo (handbacks passed in), JSON. */
    contextInJson: text("context_in_json").notNull().default("[]"),
    // Wallet
    keyIndex: integer("key_index").notNull(),
    sessionKeyHash: text("session_key_hash"),
    scriptCbor: text("script_cbor"),
    scriptJson: text("script_json"),
    address: text("address"),
    /** The treasury tx that funded this session (shared by all sessions of one plan). */
    fundingTx: text("funding_tx"),
    fundingConfirmedAt: integer("funding_confirmed_at"),
    // Accounting (micro-tUSD unless noted)
    spentMicro: text("spent_micro").notNull().default("0"),
    refundMicro: text("refund_micro"),
    feesLovelace: text("fees_lovelace").notNull().default("0"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    tainted: integer("tainted", { mode: "boolean" }).notNull().default(false),
    // Close
    handbackJson: text("handback_json"),
    handbackSha256: text("handback_sha256"),
    logSha256: text("log_sha256"),
    closeTx: text("close_tx"),
    closeAttempts: integer("close_attempts").notNull().default(0),
    /** Status the session had when it entered CLOSING (COMPLETED | FAILED | KILLED | EXPIRED | …). */
    closeStatus: text("close_status"),
    /** Human-readable reason for FAILED / KILLED / EXPIRED / rejections (tree "rejected" line). */
    endReason: text("end_reason"),
    lastCheckpoint: text("last_checkpoint"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("sessions_goal").on(t.goalId), index("sessions_status").on(t.status)],
);

/** Every state change, with timestamp and reason (spec §5.2). */
export const transitions = sqliteTable("transitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  from: text("from").notNull(),
  to: text("to").notNull(),
  reason: text("reason").notNull(),
  at: integer("at").notNull(),
});

/** Append-only event log — source of truth for the UI tree and recovery. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    type: text("type").notNull(),
    goalId: text("goal_id"),
    sessionId: text("session_id"),
    dataJson: text("data_json").notNull(),
  },
  (t) => [index("events_goal").on(t.goalId), index("events_session").on(t.sessionId)],
);

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  payee: text("payee").notNull(),
  amountMicro: text("amount_micro").notNull(),
  memo: text("memo").notNull().default(""),
  status: text("status", { enum: ["requested", "awaiting_approval", "approved", "rejected", "submitted", "confirmed", "failed"] }).notNull(),
  rejectionReason: text("rejection_reason"),
  txHash: text("tx_hash"),
  feeLovelace: text("fee_lovelace"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const topups = sqliteTable(
  "topups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    amountMyr: text("amount_myr").notNull(),
    feeMyr: text("fee_myr").notNull(),
    tusdMicro: text("tusd_micro").notNull(),
    stripeSessionId: text("stripe_session_id"),
    stripeEventId: text("stripe_event_id"),
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["pending", "submitted", "confirmed", "failed"] }).notNull(),
    txHash: text("tx_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("topups_stripe_event").on(t.stripeEventId)],
);

/** Decision ledger (spec v2 §4). At most one OPEN row per (sessionId, kind, refKey). */
export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind", { enum: ["payment_approval", "budget_raise", "extend_expiry", "quarantine_release", "widen_mandate"] }).notNull(),
    requestedBy: text("requested_by", { enum: ["captain", "session"] }).notNull(),
    refKey: text("ref_key").notNull(),
    detailsJson: text("details_json").notNull(),
    status: text("status", { enum: ["open", "approved", "rejected", "expired"] }).notNull(),
    /** `${sessionId}:${kind}:${refKey}` while open, NULL once answered: a unique index on it
     * enforces "exactly one open decision per request" (SQLite allows many NULLs). */
    openKey: text("open_key"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("decisions_open_key").on(t.openKey), index("decisions_session").on(t.sessionId)],
);

/** Session conversation (user/captain <-> sub-agent). Messages are DATA, never mandate changes. */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    from: text("from", { enum: ["user", "captain", "session"] }).notNull(),
    text: text("text").notNull(),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_session").on(t.sessionId)],
);

export const agentJobs = sqliteTable("agent_jobs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  serviceId: text("service_id").notNull(),
  externalJobId: text("external_job_id"),
  input: text("input").notNull(),
  priceMicro: text("price_micro").notNull(),
  paymentId: text("payment_id"),
  status: text("status", { enum: ["started", "paid", "running", "completed", "failed"] }).notNull(),
  result: text("result"),
  resultHash: text("result_hash"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Encrypted key material (AES-256-GCM). Only the Signer / TxService read this. */
export const keys = sqliteTable("keys", {
  id: text("id").primaryKey(), // e.g. "treasury:<userId>", "session:<sessionId>", "captain", "operator"
  purpose: text("purpose").notNull(),
  path: text("path").notNull(), // BIP32 derivation path
  keyHash: text("key_hash").notNull(),
  ciphertext: text("ciphertext").notNull(), // base64(iv | tag | ct)
  createdAt: integer("created_at").notNull(),
});

/** Watcher cursors and other small persistent settings. */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
