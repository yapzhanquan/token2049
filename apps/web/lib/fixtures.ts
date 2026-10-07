// Fixture engine: serves the engine HTTP API from in-memory sample data, so the UI can be built and
// checked without the engine (ENGINE_URL unset or MOCK_ENGINE=1). NOTHING here is on-chain: the UI
// shows a "Fixture data" banner and renders fixture hashes without explorer links.
// Server-only (imported from lib/engine.ts).
import {
  DEFINITION_OF_DONE,
  glyphFor,
  isActionable,
  microToTusd,
  tusdToMicro,
  type BulkheadEvent,
  type ContextIn,
  type Decision,
  type DecisionKind,
  type EventType,
  type Handback,
  type Plan,
  type PlannedSession,
  type SessionStatus,
  type TaskType,
  type TreeDTO,
  type TreeEdge,
  type TreeNode,
} from "@bulkhead/shared";
import type {
  AgentMapDTO,
  ApproveResponse,
  CaptainLogDTO,
  ControlResponse,
  CreateUserResponse,
  DecisionDTO,
  GoalSummary,
  LogbookEntryDTO,
  MeDTO,
  MessageResponse,
  NeedsSignatureResponse,
  PayeeDTO,
  PaymentDecisionResponse,
  PeekLine,
  PendingPaymentDTO,
  PlanResponse,
  SessionDetailDTO,
  SessionMessageDTO,
  SpendingDTO,
  TopupConfirmResponse,
  TopupStartResponse,
} from "@bulkhead/shared";
import { duration, myrShort } from "./money";
import { fixtureActivity } from "./fixture-activity";

const RATE = process.env.MYR_PER_TUSD ?? "4.70";
const FEE_PCT = process.env.TOPUP_FEE_PCT ?? "1.5";
const MIN = 60_000;
const HOUR = 60 * MIN;

// ───────────── helpers ─────────────
let hexSeed = 7;
function fakeHex(len = 64): string {
  let out = "";
  while (out.length < len) {
    hexSeed = (hexSeed * 1103515245 + 12345) % 2147483648;
    out += hexSeed.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}
function fakeAddr(): string {
  const chars = "023456789acdefghjklmnpqrstuvwxyz";
  let s = "addr_test1w";
  for (let i = 0; i < 52; i++) s += chars[(hexSeed = (hexSeed * 1103515245 + 12345) % 2147483648) % chars.length];
  return s;
}
const id = (p: string) => `${p}_${fakeHex(10)}`;

type Step =
  | { kind: "progress"; text: string }
  | { kind: "pay"; amount: string; payeeId: string; memo: string }
  | { kind: "hire"; serviceId: string; label: string; price: string }
  | { kind: "handback"; handback: Handback };

interface MockSession {
  id: string;
  goalId: string;
  parentSessionId: string | null;
  letter: string;
  name: string;
  role: string;
  agentType: string;
  taskType: TaskType;
  goal: string;
  status: SessionStatus;
  budgetMicro: bigint;
  spentMicro: bigint;
  perPaymentMaxMicro: bigint;
  approvalThresholdMicro: bigint;
  allowedPayees: PayeeDTO[];
  expiresAt: number;
  address: string;
  tainted: boolean;
  tokensUsed: number;
  doneAttempts: number;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  feesLovelace: bigint;
  contextFrom: string[];
  handback: Handback | null;
  refundMicro: bigint | null;
  closeTx: string | null;
  logSha256: string | null;
  handbackSha256: string | null;
  latest: string | null;
  failReason: string | null;
  // simulation
  steps: Step[];
  cursor: number;
  loop: boolean;
  nextAt: number;
  blockedOn: string | null; // payment id awaiting approval
}

interface MockJob {
  id: string;
  sessionId: string;
  label: string;
  status: "started" | "paid" | "running" | "completed" | "failed";
  priceMicro: bigint;
  createdAt: number;
  endedAt: number | null;
}

interface MockGoal {
  id: string;
  goal: string;
  budgetMicro: bigint;
  deadline: number;
  rules: string;
  status: GoalSummary["status"];
  plan: Plan;
  fundingTx: string | null;
  createdAt: number;
}

interface MockPayment extends PendingPaymentDTO {
  sessionId: string;
  status: "awaiting_approval" | "approved" | "rejected" | "confirmed";
}

interface Store {
  user: MeDTO;
  treasuryMicro: bigint;
  lovelace: bigint;
  balanceHistory: { at: number; tusdMicro: string }[];
  goals: MockGoal[];
  sessions: MockSession[];
  jobs: MockJob[];
  events: BulkheadEvent[];
  decisions: Decision[];
  messages: (SessionMessageDTO & { sessionId: string })[];
  payments: MockPayment[];
  topups: SpendingDTO["topups"];
  captain: CaptainLogDTO["entries"];
  woken: number;
  absorbed: number;
  nextEventId: number;
  nextCaptainId: number;
  subscribers: Set<(e: BulkheadEvent) => void>;
  captainContext: number;
}

const PAYEES: Record<string, PayeeDTO> = {
  "agent-summariser": { id: "agent-summariser", label: "Market summariser (mock market)", address: "addr_test1vq8mockmarketsummariser0000000000000000000000000000q" },
  "agent-translator": { id: "agent-translator", label: "Translator (mock market)", address: "addr_test1vq8mockmarkettranslator00000000000000000000000000x" },
  "shop-reports": { id: "shop-reports", label: "ReportShop (data seller)", address: "addr_test1vz4reportshoppayee0000000000000000000000000000000a" },
};

// ───────────── store (globalThis so every route bundle shares one world) ─────────────
const g = globalThis as unknown as { __bulkheadFixture?: Store };
export function store(): Store {
  if (!g.__bulkheadFixture) g.__bulkheadFixture = seed();
  return g.__bulkheadFixture;
}

function emit(s: Store, type: EventType, f: { goalId?: string; sessionId?: string; data?: Record<string, unknown>; at?: number }): BulkheadEvent {
  const e: BulkheadEvent = { id: s.nextEventId++, at: f.at ?? Date.now(), type, goalId: f.goalId, sessionId: f.sessionId, data: f.data ?? {} };
  s.events.push(e);
  if (type !== "captain_woken" && type !== "captain_absorbed" && type !== "captain_action" && type !== "captain_report") {
    const actionable = isActionable(e);
    if (actionable) s.woken++;
    else s.absorbed++;
    if (actionable) {
      s.captain.push({ id: s.nextCaptainId++, at: e.at, kind: "woken", text: `Woken by ${type}${e.data.to ? ` → ${String(e.data.to)}` : ""}`, sessionId: e.sessionId, goalId: e.goalId });
    } else if (type === "progress") {
      s.captain.push({ id: s.nextCaptainId++, at: e.at, kind: "absorbed", text: `Absorbed progress from ${letterOf(s, e.sessionId)}`, sessionId: e.sessionId, goalId: e.goalId });
    }
  }
  for (const fn of s.subscribers) fn(e);
  return e;
}

function letterOf(s: Store, sessionId?: string): string {
  const x = s.sessions.find((y) => y.id === sessionId);
  return x ? `${x.letter} ${x.role}` : "session";
}

function report(s: Store, text: string, goalId?: string, sessionId?: string) {
  s.captain.push({ id: s.nextCaptainId++, at: Date.now(), kind: "report", text, goalId, sessionId });
  emit(s, "captain_report", { goalId, sessionId, data: { text } });
}
function action(s: Store, text: string, goalId?: string, sessionId?: string) {
  s.captain.push({ id: s.nextCaptainId++, at: Date.now(), kind: "action", text, goalId, sessionId });
  emit(s, "captain_action", { goalId, sessionId, data: { text } });
}

function makeSession(p: Partial<MockSession> & Pick<MockSession, "goalId" | "letter" | "name" | "role" | "taskType" | "goal" | "status">): MockSession {
  const now = Date.now();
  return {
    id: id("ses"),
    parentSessionId: null,
    agentType: "generic",
    budgetMicro: tusdToMicro("2"),
    spentMicro: 0n,
    perPaymentMaxMicro: tusdToMicro("2"),
    approvalThresholdMicro: tusdToMicro("1"),
    allowedPayees: [],
    expiresAt: now + 6 * HOUR,
    address: fakeAddr(),
    tainted: false,
    tokensUsed: 0,
    doneAttempts: 0,
    startedAt: now,
    endedAt: null,
    createdAt: now,
    feesLovelace: 0n,
    contextFrom: [],
    handback: null,
    refundMicro: null,
    closeTx: null,
    logSha256: null,
    handbackSha256: null,
    latest: null,
    failReason: null,
    steps: [],
    cursor: 0,
    loop: false,
    nextAt: now + 5000,
    blockedOn: null,
    ...p,
  };
}

// ───────────── seed: one goal, 3 sessions + 1 agent job ─────────────
function seed(): Store {
  const now = Date.now();
  const s: Store = {
    user: {
      userId: "user_fixture",
      email: "demo@bulkhead.local",
      name: "Demo user",
      custody: "custodial",
      treasuryAddress: "addr_test1qrfixturetreasury000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      network: "preprod",
      balances: { tusdMicro: "0", lovelace: "0" },
      myrPerTusd: RATE,
      topupFeePct: FEE_PCT,
      openDecisions: 0,
    },
    treasuryMicro: tusdToMicro("8.2"),
    lovelace: 41_350_000n,
    balanceHistory: [],
    goals: [],
    sessions: [],
    jobs: [],
    events: [],
    decisions: [],
    messages: [],
    payments: [],
    topups: [],
    captain: [],
    woken: 0,
    absorbed: 0,
    nextEventId: 1,
    nextCaptainId: 1,
    subscribers: new Set(),
    captainContext: 18_400,
  };
  const t0 = now - 52 * MIN;
  s.topups.push({ id: "top_fixture1", amountMyr: "50.00", feeMyr: "0.75", tusdMicro: String(tusdToMicro("10.478723")), simulated: true, status: "confirmed", txHash: fakeHex(), createdAt: t0 - 30 * MIN });
  s.topups.push({ id: "top_fixture2", amountMyr: "50.00", feeMyr: "0.75", tusdMicro: String(tusdToMicro("10.478723")), simulated: true, status: "confirmed", txHash: fakeHex(), createdAt: t0 - 20 * MIN });

  const goal: MockGoal = {
    id: "goal_fixture",
    goal: "Research competitors, RM60, due Fri",
    budgetMicro: tusdToMicro("12.76"),
    deadline: now + 3 * 24 * HOUR,
    rules: "Only pay agents from the market catalog. Ask me before any payment over RM5.",
    status: "running",
    plan: { sessions: [] },
    fundingTx: fakeHex(),
    createdAt: t0,
  };
  s.goals.push(goal);
  emit(s, "goal_created", { goalId: goal.id, at: t0, data: { goal: goal.goal } });
  emit(s, "plan_approved", { goalId: goal.id, at: t0 + 30_000, data: { fundingTx: goal.fundingTx } });

  // A — research, closed with a handback
  const a = makeSession({
    goalId: goal.id, letter: "A", name: "Competitor scan", role: "Researcher", agentType: "researcher", taskType: "research",
    goal: "List the 5 closest competitors with pricing pages.", status: "CLOSED",
    budgetMicro: tusdToMicro("1.5"), perPaymentMaxMicro: tusdToMicro("0.5"), approvalThresholdMicro: tusdToMicro("0.5"),
    startedAt: t0 + 60_000, endedAt: t0 + 19 * MIN, createdAt: t0 + 40_000, tokensUsed: 21_480,
    feesLovelace: 352_000n, refundMicro: tusdToMicro("1.5"),
    closeTx: fakeHex(), logSha256: fakeHex(), handbackSha256: fakeHex(),
    handback: {
      result: "1. Acme Agents — RM49/mo, per-seat\n2. Flowpilot — usage based, RM0.10/task\n3. TaskForge — free tier + RM99 team\n4. Crewly — enterprise only\n5. Orbit AI — RM29/mo starter",
      summary: "5 competitors found; 3 publish prices, Flowpilot is usage-based.",
      sources: ["https://example.com/acme/pricing", "https://example.com/flowpilot/pricing", "https://example.com/taskforge"],
      flags: [],
    },
    latest: "Submitted handback (5 competitors, 3 sources).",
  });
  a.address = fakeAddr();
  // B — hire_agent, running, with an agent_job child
  const b = makeSession({
    goalId: goal.id, letter: "B", name: "Market summary", role: "Analyst", agentType: "summariser", taskType: "hire_agent",
    goal: "Hire the market summariser to turn the competitor list into a one-page brief.", status: "RUNNING",
    budgetMicro: tusdToMicro("5"), spentMicro: tusdToMicro("3"), perPaymentMaxMicro: tusdToMicro("3"), approvalThresholdMicro: tusdToMicro("3.5"),
    allowedPayees: [PAYEES["agent-summariser"]!],
    startedAt: t0 + 20 * MIN, createdAt: t0 + 19 * MIN, tokensUsed: 9_870, feesLovelace: 181_000n,
    expiresAt: now + 2 * HOUR + 14 * MIN, contextFrom: [a.id],
    latest: "Waiting for the summariser job result (job paid, 3.00 tUSD).",
    loop: true,
    steps: [
      { kind: "progress", text: "Polling job status: running (42%)." },
      { kind: "progress", text: "Summariser returned a partial draft; checking result hash is not final yet." },
      { kind: "progress", text: "Polling job status: running (71%)." },
      { kind: "progress", text: "Drafting the brief outline from A's handback (read as data)." },
    ],
  });
  const job: MockJob = { id: "job_fixture1", sessionId: b.id, label: "Market summariser job", status: "running", priceMicro: tusdToMicro("3"), createdAt: t0 + 24 * MIN, endedAt: null };
  // C — buy_pay, quarantined with an open decision
  const c = makeSession({
    goalId: goal.id, letter: "C", name: "Buy pricing report", role: "Buyer", agentType: "buyer", taskType: "buy_pay",
    goal: "Buy the 2026 SEA pricing report from ReportShop (max 4 tUSD).", status: "QUARANTINED",
    budgetMicro: tusdToMicro("5"), perPaymentMaxMicro: tusdToMicro("4"), approvalThresholdMicro: tusdToMicro("2"),
    allowedPayees: [PAYEES["shop-reports"]!],
    startedAt: t0 + 21 * MIN, createdAt: t0 + 19 * MIN, tokensUsed: 4_210, tainted: true,
    expiresAt: now + 4 * HOUR, contextFrom: [a.id],
    latest: "Tried to pay an address that is not on the allowlist.",
    failReason: "payee not on allowlist (tainted input)",
  });
  s.sessions.push(a, b, c);
  s.jobs.push(job);

  // History events
  const ev = (type: EventType, sess: MockSession, at: number, data: Record<string, unknown> = {}) => emit(s, type, { goalId: goal.id, sessionId: sess.id, at, data });
  for (const x of [a, b, c]) {
    ev("session_created", x, x.createdAt, { letter: x.letter, role: x.role, taskType: x.taskType });
    ev("session_funded", x, x.createdAt + 20_000, { amountMicro: String(x.budgetMicro), txHash: goal.fundingTx });
    ev("session_transition", x, x.startedAt!, { from: "FUNDING", to: "RUNNING", reason: "funded" });
  }
  ev("progress", a, t0 + 3 * MIN, { text: "Searching for agent-orchestration products in SEA." });
  ev("web_fetch", a, t0 + 5 * MIN, { url: "https://example.com/acme/pricing", bytes: 18231 });
  ev("web_fetch", a, t0 + 7 * MIN, { url: "https://example.com/flowpilot/pricing", bytes: 22410 });
  ev("progress", a, t0 + 12 * MIN, { text: "Found 5 competitors; 3 publish pricing." });
  ev("handback_submitted", a, t0 + 17 * MIN, { summary: a.handback!.summary });
  ev("handback_accepted", a, t0 + 17 * MIN + 5000, { check: DEFINITION_OF_DONE.research });
  ev("session_transition", a, t0 + 17 * MIN + 6000, { from: "RUNNING", to: "COMPLETING", reason: "handback accepted" });
  ev("session_transition", a, t0 + 17 * MIN + 7000, { from: "COMPLETING", to: "CLOSING", reason: "sweep" });
  ev("close_submitted", a, t0 + 18 * MIN, { txHash: a.closeTx });
  ev("close_confirmed", a, t0 + 19 * MIN, { txHash: a.closeTx, refundMicro: String(a.refundMicro), logSha256: a.logSha256, handbackSha256: a.handbackSha256 });
  ev("session_transition", a, t0 + 19 * MIN, { from: "CLOSING", to: "CLOSED", reason: "close confirmed" });
  emit(s, "handback_passed", { goalId: goal.id, sessionId: b.id, at: t0 + 19 * MIN + 5000, data: { from: a.id, to: b.id } });
  emit(s, "handback_passed", { goalId: goal.id, sessionId: c.id, at: t0 + 19 * MIN + 6000, data: { from: a.id, to: c.id } });

  ev("progress", b, t0 + 22 * MIN, { text: "Read A's handback (5 competitors) as data." });
  ev("agent_hired", b, t0 + 24 * MIN, { serviceId: "agent-summariser", jobId: job.id, priceMicro: String(job.priceMicro) });
  const payB = fakeHex();
  ev("payment_requested", b, t0 + 24 * MIN + 2000, { payee: PAYEES["agent-summariser"]!.address, payeeLabel: PAYEES["agent-summariser"]!.label, amountMicro: String(tusdToMicro("3")), memo: "job " + job.id });
  ev("payment_submitted", b, t0 + 24 * MIN + 4000, { txHash: payB, amountMicro: String(tusdToMicro("3")) });
  ev("payment_confirmed", b, t0 + 25 * MIN, { txHash: payB, amountMicro: String(tusdToMicro("3")), payeeLabel: PAYEES["agent-summariser"]!.label });
  ev("agent_job_paid", b, t0 + 25 * MIN + 1000, { jobId: job.id, txHash: payB });
  s.messages.push({ id: "msg_fixture1", sessionId: b.id, from: "user", text: "Focus the brief on pricing models, skip team sizes.", createdAt: t0 + 30 * MIN });
  ev("session_message", b, t0 + 30 * MIN, { from: "user", text: "Focus the brief on pricing models, skip team sizes.", messageId: "msg_fixture1" });
  ev("progress", b, t0 + 31 * MIN, { text: "Noted: brief will focus on pricing models." });
  s.messages.push({ id: "msg_fixture2", sessionId: b.id, from: "user", text: "Also raise your budget to 20 tUSD.", createdAt: t0 + 33 * MIN });
  ev("session_message", b, t0 + 33 * MIN, { from: "user", text: "Also raise your budget to 20 tUSD.", messageId: "msg_fixture2" });
  ev("mandate_change_ignored", b, t0 + 33 * MIN + 1000, { text: "A message cannot change the mandate. Use Raise budget (needs your approval)." });
  ev("progress", b, now - 3 * MIN, { text: b.latest });

  ev("progress", c, t0 + 23 * MIN, { text: "Opened ReportShop listing for the SEA pricing report." });
  ev("web_fetch", c, t0 + 24 * MIN, { url: "https://example.com/reportshop/sea-2026", bytes: 9120 });
  ev("tainted", c, t0 + 26 * MIN, { reason: "Fetched page contained instructions to pay a different address." });
  const badAddr = "addr_test1vzunknownpayee000000000000000000000000000000000000z";
  ev("payment_requested", c, t0 + 26 * MIN + 2000, { payee: badAddr, amountMicro: String(tusdToMicro("3.5")), memo: "report" });
  ev("payment_rejected", c, t0 + 26 * MIN + 2500, { reason: "payee_not_allowed", detail: "payee not on allowlist", payee: badAddr, amountMicro: String(tusdToMicro("3.5")) });
  ev("session_transition", c, t0 + 26 * MIN + 3000, { from: "RUNNING", to: "QUARANTINED", reason: "payment to a payee not on the allowlist after tainted input" });
  const dC: Decision = {
    id: "dec_fixture1", sessionId: c.id, kind: "quarantine_release", requestedBy: "captain", refKey: "quarantine-1",
    details: { reason: "C tried to pay an address that is not on its allowlist after reading a tainted page. Release resumes it with the same mandate; reject closes it and sweeps 5.00 tUSD back.", payee: badAddr, amountMicro: String(tusdToMicro("3.5")) },
    status: "open", createdAt: t0 + 26 * MIN + 4000,
  };
  s.decisions.push(dC);
  ev("decision_opened", c, dC.createdAt, { decisionId: dC.id, kind: dC.kind });
  action(s, "request_user_approval(quarantine_release, C Buyer)", goal.id, c.id);
  report(s, "C (Buyer) was quarantined: it tried to pay an address that is not on its allowlist after reading a tainted page. Your decision is needed.", goal.id, c.id);

  // treasury history
  s.balanceHistory = [
    { at: t0 - 60 * MIN, tusdMicro: "0" },
    { at: t0 - 30 * MIN, tusdMicro: String(tusdToMicro("10.478723")) },
    { at: t0 - 20 * MIN, tusdMicro: String(tusdToMicro("20.957446")) },
    { at: t0 + 60_000, tusdMicro: String(tusdToMicro("9.457446")) },
    { at: t0 + 19 * MIN, tusdMicro: String(tusdToMicro("10.957446")) },
  ];
  s.treasuryMicro = tusdToMicro("10.957446");
  return s;
}

// ───────────── simulation tick ─────────────
const SCRIPTS: Record<TaskType, (p: PlannedSession) => Step[]> = {
  research: (p) => [
    { kind: "progress", text: "Planning search queries." },
    { kind: "progress", text: "Fetched 3 pages (web_fetch)." },
    { kind: "progress", text: "Cross-checking sources." },
    { kind: "handback", handback: { result: `Findings for: ${p.goal}`, summary: `Done: ${p.goal}`.slice(0, 200), sources: ["https://example.com/source-1"], flags: [] } },
  ],
  buy_pay: (p) => [
    { kind: "progress", text: "Checking the seller against the allowlist." },
    { kind: "pay", amount: (Number(p.perPaymentMaxTUSD) || 1).toFixed(2), payeeId: "shop-reports", memo: "purchase" },
    { kind: "progress", text: "Payment confirmed; downloading the item." },
    { kind: "handback", handback: { result: "Purchase complete.", summary: "Bought 1 item; payment confirmed on-chain.", sources: [], flags: [], txHashes: [fakeHex()] } },
  ],
  hire_agent: () => [
    { kind: "progress", text: "Choosing an agent from the catalog." },
    { kind: "hire", serviceId: "agent-summariser", label: "Market summariser job", price: "1" },
    { kind: "progress", text: "Job running at the agent." },
    { kind: "handback", handback: { result: "Agent job result.", summary: "Hired agent completed the job; result hash matches.", sources: [], flags: [], job: { jobId: "job", resultHash: fakeHex() } } },
  ],
  monitor: () => [
    { kind: "progress", text: "Watching the address (read_chain)." },
    { kind: "progress", text: "No deposit yet." },
    { kind: "handback", handback: { result: "Condition met.", summary: "Watched condition happened.", sources: [], flags: [] } },
  ],
};

function closeSession(s: Store, x: MockSession, final: SessionStatus, reason: string) {
  const from = x.status;
  if (final !== "CLOSED") {
    emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from, to: final, reason } });
  } else {
    emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from, to: "COMPLETING", reason } });
  }
  emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from: final === "CLOSED" ? "COMPLETING" : final, to: "CLOSING", reason: "sweep leftovers" } });
  x.refundMicro = x.budgetMicro - x.spentMicro;
  x.closeTx = fakeHex();
  x.logSha256 = fakeHex();
  x.handbackSha256 = x.handback ? fakeHex() : null;
  x.status = final === "CLOSED" ? "CLOSED" : final;
  // ghost: failed/killed keep their status word, but funds are swept (CLOSING → CLOSED in the engine).
  x.endedAt = Date.now();
  x.feesLovelace += 176_000n;
  s.treasuryMicro += x.refundMicro;
  s.balanceHistory.push({ at: Date.now(), tusdMicro: String(s.treasuryMicro) });
  emit(s, "close_confirmed", { goalId: x.goalId, sessionId: x.id, data: { txHash: x.closeTx, refundMicro: String(x.refundMicro), logSha256: x.logSha256, handbackSha256: x.handbackSha256 } });
  if (final === "CLOSED") emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from: "CLOSING", to: "CLOSED", reason: "close confirmed" } });
  for (const d of s.decisions) if (d.sessionId === x.id && d.status === "open") { d.status = "expired"; d.decidedAt = Date.now(); }
}

export function tick(s: Store = store()) {
  const now = Date.now();
  for (const x of s.sessions) {
    if (x.status !== "RUNNING" || x.blockedOn || now < x.nextAt || x.steps.length === 0) continue;
    if (x.cursor >= x.steps.length) {
      if (!x.loop) continue;
      x.cursor = 0;
    }
    const step = x.steps[x.cursor++]!;
    x.nextAt = now + 6000 + Math.floor(Math.random() * 3000);
    x.tokensUsed += 600 + Math.floor(Math.random() * 900);
    s.captainContext += 40;
    if (step.kind === "progress") {
      x.latest = step.text;
      emit(s, "progress", { goalId: x.goalId, sessionId: x.id, data: { text: step.text } });
    } else if (step.kind === "pay") {
      const payee = PAYEES[step.payeeId]!;
      const amt = tusdToMicro(step.amount);
      const pid = id("pay");
      emit(s, "payment_requested", { goalId: x.goalId, sessionId: x.id, data: { paymentId: pid, payee: payee.address, payeeLabel: payee.label, amountMicro: String(amt), memo: step.memo } });
      if (amt > x.approvalThresholdMicro) {
        const d: Decision = { id: id("dec"), sessionId: x.id, kind: "payment_approval", requestedBy: "session", refKey: pid, details: { paymentId: pid, amountMicro: String(amt), payee: payee.address, payeeLabel: payee.label, memo: step.memo }, status: "open", createdAt: now };
        s.decisions.push(d);
        s.payments.push({ id: pid, sessionId: x.id, payee: payee.address, payeeLabel: payee.label, amountMicro: String(amt), memo: step.memo, decisionId: d.id, status: "awaiting_approval" });
        x.blockedOn = pid;
        x.latest = `Waiting for your approval: ${myrShort(amt, RATE)} to ${payee.label}.`;
        emit(s, "payment_approval_needed", { goalId: x.goalId, sessionId: x.id, data: { paymentId: pid, amountMicro: String(amt), payeeLabel: payee.label } });
        emit(s, "decision_opened", { goalId: x.goalId, sessionId: x.id, data: { decisionId: d.id, kind: d.kind } });
      } else {
        confirmPayment(s, x, pid, amt, payee.label);
      }
    } else if (step.kind === "hire") {
      const job: MockJob = { id: id("job"), sessionId: x.id, label: step.label, status: "paid", priceMicro: tusdToMicro(step.price), createdAt: now, endedAt: null };
      s.jobs.push(job);
      emit(s, "agent_hired", { goalId: x.goalId, sessionId: x.id, data: { serviceId: step.serviceId, jobId: job.id } });
      confirmPayment(s, x, id("pay"), job.priceMicro, step.label);
      job.status = "running";
    } else if (step.kind === "handback") {
      x.handback = step.handback;
      emit(s, "handback_submitted", { goalId: x.goalId, sessionId: x.id, data: { summary: step.handback.summary } });
      emit(s, "handback_accepted", { goalId: x.goalId, sessionId: x.id, data: { check: DEFINITION_OF_DONE[x.taskType] } });
      for (const j of s.jobs) if (j.sessionId === x.id && j.status !== "completed") { j.status = "completed"; j.endedAt = now; }
      x.latest = `Handback: ${step.handback.summary}`;
      closeSession(s, x, "CLOSED", "handback accepted");
      report(s, `${x.letter} (${x.role}) finished: ${step.handback.summary}`, x.goalId, x.id);
      const goal = s.goals.find((q) => q.id === x.goalId);
      if (goal && s.sessions.filter((q) => q.goalId === goal.id).every((q) => isEnded(q.status))) goal.status = "done";
    }
  }
}

function confirmPayment(s: Store, x: MockSession, pid: string, amt: bigint, label: string) {
  const tx = fakeHex();
  x.spentMicro += amt;
  x.feesLovelace += 171_000n;
  emit(s, "payment_submitted", { goalId: x.goalId, sessionId: x.id, data: { paymentId: pid, txHash: tx, amountMicro: String(amt) } });
  emit(s, "payment_confirmed", { goalId: x.goalId, sessionId: x.id, data: { paymentId: pid, txHash: tx, amountMicro: String(amt), payeeLabel: label } });
}

const isEnded = (st: SessionStatus) => ["CLOSED", "KILLED", "FAILED", "EXPIRED", "CLOSING"].includes(st);

// ───────────── DTO builders ─────────────
function me(s: Store): MeDTO {
  return {
    ...s.user,
    balances: { tusdMicro: String(s.treasuryMicro), lovelace: String(s.lovelace) },
    openDecisions: s.decisions.filter((d) => d.status === "open").length,
  };
}

function openDecisionsFor(s: Store, sessionId: string) {
  return s.decisions.filter((d) => d.sessionId === sessionId && d.status === "open");
}

function sessionLines(s: Store, x: MockSession, now: number): string[] {
  const left = x.budgetMicro - x.spentMicro;
  if (x.status === "CLOSED") {
    return [x.handback?.summary ?? "Closed.", `spent ${myrShort(x.spentMicro, RATE)} - ${myrShort(x.refundMicro, RATE)} returned`];
  }
  if (["KILLED", "FAILED", "EXPIRED"].includes(x.status)) {
    return [x.failReason ?? `${x.status.toLowerCase()}`, `spent ${myrShort(x.spentMicro, RATE)} - ${myrShort(x.refundMicro ?? 0n, RATE)} returned`];
  }
  if (x.status === "QUARANTINED") return [x.failReason ?? "Quarantined.", "Awaiting your decision"];
  return [x.latest ?? "Starting…", `${myrShort(left, RATE)} of ${myrShort(x.budgetMicro, RATE)} left - ${duration(x.expiresAt - now)} left`];
}

function tree(s: Store, goalId: string): TreeDTO | null {
  const goal = s.goals.find((q) => q.id === goalId);
  if (!goal) return null;
  const now = Date.now();
  const rootId = `goal:${goal.id}`;
  const nodes: TreeNode[] = [
    {
      id: rootId, kind: "goal", parentId: null, label: goal.goal, glyph: goal.status === "planned" ? "planned" : goal.status === "done" ? "closed" : "running", ghost: false,
      lines: [`budget ${myrShort(goal.budgetMicro, RATE)} · due ${new Date(goal.deadline).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`, goal.rules ? `rules: ${goal.rules}` : ""].filter(Boolean),
      budgetMicro: String(goal.budgetMicro),
    },
  ];
  const edges: TreeEdge[] = [];
  if (goal.status === "planned") {
    goal.plan.sessions.forEach((p, i) => {
      const nid = `plan:${goal.id}:${i}`;
      const parent = p.parent !== undefined ? `plan:${goal.id}:${p.parent}` : rootId;
      nodes.push({ id: nid, kind: "session", parentId: parent, letter: String.fromCharCode(65 + i), role: p.role, label: `${String.fromCharCode(65 + i)} ${p.role} - planned`, status: "PLANNED", glyph: "planned", ghost: false, lines: [p.goal, `budget ${myrShort(tusdToMicro(p.budgetTUSD), RATE)}`], budgetMicro: String(tusdToMicro(p.budgetTUSD)), taskType: p.taskType });
      edges.push({ from: parent, to: nid, kind: "parent" });
      for (const c of p.contextFrom) edges.push({ from: `plan:${goal.id}:${c}`, to: nid, kind: "handback" });
    });
    return { goalId, nodes, edges };
  }
  for (const x of s.sessions.filter((q) => q.goalId === goalId)) {
    const open = openDecisionsFor(s, x.id);
    const hasPayment = open.some((d) => d.kind === "payment_approval");
    const parent = x.parentSessionId ?? rootId;
    nodes.push({
      id: x.id, kind: "session", parentId: parent, letter: x.letter, role: x.role,
      label: `${x.letter} ${x.role} - ${hasPayment ? "awaiting approval" : x.status.toLowerCase()}`,
      status: x.status, glyph: glyphFor(x.status, hasPayment), ghost: ["CLOSED", "KILLED", "FAILED", "EXPIRED"].includes(x.status),
      lines: sessionLines(s, x, now), startedAt: x.startedAt ?? undefined, endedAt: x.endedAt ?? undefined, tokensUsed: x.tokensUsed,
      spentMicro: String(x.spentMicro), budgetMicro: String(x.budgetMicro), refundMicro: x.refundMicro === null ? undefined : String(x.refundMicro),
      address: x.address, closeTx: x.closeTx ?? undefined, handbackSummary: x.handback?.summary, taskType: x.taskType, openDecisions: open.length,
    });
    edges.push({ from: parent, to: x.id, kind: "parent" });
    for (const f of x.contextFrom) edges.push({ from: f, to: x.id, kind: "handback" });
    s.jobs.filter((j) => j.sessionId === x.id).forEach((j, i) => {
      const st: SessionStatus = j.status === "completed" ? "CLOSED" : j.status === "failed" ? "FAILED" : "RUNNING";
      nodes.push({
        id: j.id, kind: "agent_job", parentId: x.id, letter: `${x.letter}${i + 1}`, role: "Agent job", label: `${x.letter}${i + 1} ${j.label} - ${j.status}`,
        status: st, glyph: glyphFor(st), ghost: j.status === "completed" || j.status === "failed",
        lines: [j.status === "completed" ? "Result delivered; hash matches." : "Paid; the agent is working.", `paid ${myrShort(j.priceMicro, RATE)}`],
        startedAt: j.createdAt, endedAt: j.endedAt ?? undefined, spentMicro: String(j.priceMicro), taskType: "hire_agent",
      });
      edges.push({ from: x.id, to: j.id, kind: "parent" });
    });
  }
  return { goalId, nodes, edges };
}

function contextInFor(s: Store, x: MockSession): ContextIn[] {
  return x.contextFrom
    .map((fid) => s.sessions.find((q) => q.id === fid))
    .filter((q): q is MockSession => !!q && !!q.handback)
    .map((q) => ({ fromSessionId: q.id, fromRole: `${q.letter} ${q.role}`, tainted: q.tainted, handback: q.handback! }));
}

function sessionDetail(s: Store, sid: string): SessionDetailDTO | null {
  const x = s.sessions.find((q) => q.id === sid);
  if (!x) return null;
  const goal = s.goals.find((q) => q.id === x.goalId);
  return {
    id: x.id, goalId: x.goalId, parentSessionId: x.parentSessionId, letter: x.letter, name: x.name, role: x.role, agentType: x.agentType,
    taskType: x.taskType, definitionOfDone: DEFINITION_OF_DONE[x.taskType], goal: x.goal, status: x.status, tainted: x.tainted,
    startedAt: x.startedAt, endedAt: x.endedAt, tokensUsed: x.tokensUsed, doneAttempts: x.doneAttempts,
    mandate: { budgetMicro: String(x.budgetMicro), perPaymentMaxMicro: String(x.perPaymentMaxMicro), approvalThresholdMicro: String(x.approvalThresholdMicro), allowedPayees: x.allowedPayees, expiresAt: x.expiresAt },
    wallet: { address: x.address, spentMicro: String(x.spentMicro), budgetMicro: String(x.budgetMicro), feesLovelace: String(x.feesLovelace), fundingTx: goal?.fundingTx ?? null },
    contextIn: contextInFor(s, x),
    activity: s.events.filter((e) => e.sessionId === x.id && !e.type.startsWith("captain_") && e.type !== "llm_usage"),
    messages: s.messages.filter((m) => m.sessionId === x.id).map(({ sessionId: _s, ...m }) => m),
    pendingPayments: s.payments.filter((p) => p.sessionId === x.id && p.status === "awaiting_approval").map(({ sessionId: _s, status: _st, ...p }) => p),
    decisions: s.decisions.filter((d) => d.sessionId === x.id),
    handback: x.handback,
    close: x.closeTx ? { refundMicro: x.refundMicro === null ? null : String(x.refundMicro), closeTx: x.closeTx, logSha256: x.logSha256, handbackSha256: x.handbackSha256 } : null,
  };
}

function agentMap(s: Store): AgentMapDTO {
  const cards: AgentMapDTO["cards"] = [];
  for (const x of s.sessions) {
    const open = openDecisionsFor(s, x.id).some((d) => d.kind === "payment_approval");
    cards.push({
      id: x.id, goalId: x.goalId, parentId: x.parentSessionId, kind: "session", letter: x.letter, role: x.role, shortGoal: x.goal,
      status: x.status, glyph: glyphFor(x.status, open), startedAt: x.startedAt, endedAt: x.endedAt, createdAt: x.createdAt, tokensUsed: x.tokensUsed,
      spentMicro: String(x.spentMicro), budgetMicro: String(x.budgetMicro), refundMicro: x.refundMicro === null ? null : String(x.refundMicro),
      latest: x.latest, handbackSummary: x.handback?.summary ?? null,
    });
  }
  for (const j of s.jobs) {
    const st: SessionStatus = j.status === "completed" ? "CLOSED" : j.status === "failed" ? "FAILED" : "RUNNING";
    const parent = s.sessions.find((q) => q.id === j.sessionId);
    cards.push({
      id: j.id, goalId: parent?.goalId ?? "", parentId: j.sessionId, kind: "agent_job", role: "Agent job", shortGoal: j.label, status: st, glyph: glyphFor(st),
      startedAt: j.createdAt, endedAt: j.endedAt, createdAt: j.createdAt, tokensUsed: 0, spentMicro: String(j.priceMicro), budgetMicro: String(j.priceMicro),
      refundMicro: null, latest: j.status === "running" ? "Agent working on the paid job." : null, handbackSummary: j.status === "completed" ? "Result delivered." : null,
    });
  }
  return {
    captain: {
      name: "Captain", model: process.env.ANTHROPIC_API_KEY ? "claude-sonnet-5-5" : "MockLLM (no API key)", contextTokens: s.captainContext,
      treasuryMicro: String(s.treasuryMicro), running: s.sessions.filter((x) => !isEnded(x.status) && x.status !== "PLANNED").length,
      closed: s.sessions.filter((x) => isEnded(x.status)).length,
    },
    cards,
  };
}

function spending(s: Store): SpendingDTO {
  const per = s.sessions.map((x) => ({ sessionId: x.id, goalId: x.goalId, letter: x.letter, role: x.role, status: x.status, budgetMicro: String(x.budgetMicro), spentMicro: String(x.spentMicro), refundMicro: x.refundMicro === null ? null : String(x.refundMicro), feesLovelace: String(x.feesLovelace) }));
  const sum = (f: (x: MockSession) => bigint) => String(s.sessions.reduce((a, x) => a + f(x), 0n));
  return {
    balanceHistory: [...s.balanceHistory, { at: Date.now(), tusdMicro: String(s.treasuryMicro) }],
    perSession: per,
    topups: s.topups,
    totals: {
      spentMicro: sum((x) => x.spentMicro), refundMicro: sum((x) => x.refundMicro ?? 0n), feesLovelace: sum((x) => x.feesLovelace),
      topupFeesMyr: s.topups.filter((t) => t.status === "confirmed").reduce((a, t) => a + Number(t.feeMyr), 0).toFixed(2),
    },
  };
}

function logbook(s: Store): LogbookEntryDTO[] {
  return s.sessions
    .filter((x) => x.closeTx)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .map((x) => ({
      sessionId: x.id, goalId: x.goalId, goalText: s.goals.find((q) => q.id === x.goalId)?.goal ?? "", letter: x.letter, role: x.role, taskType: x.taskType,
      status: x.status, handback: x.handback, spentMicro: String(x.spentMicro), refundMicro: x.refundMicro === null ? null : String(x.refundMicro),
      closeTx: x.closeTx, logSha256: x.logSha256, handbackSha256: x.handbackSha256, endedAt: x.endedAt,
    }));
}

// ───────────── planning (fixture "captain") ─────────────
function planFor(goal: string, budgetTUSD: string, deadline: string): Plan {
  const total = Number(budgetTUSD) || 10;
  const part = (f: number) => (Math.floor(total * f * 100) / 100).toFixed(2);
  return {
    sessions: [
      { name: "Research", role: "Researcher", agentType: "researcher", taskType: "research", allowWebFetch: false, goal: `Research: ${goal}`.slice(0, 500), budgetTUSD: part(0.2), perPaymentMaxTUSD: part(0.1), approvalThresholdTUSD: part(0.1), allowedPayees: [], deadline, dataScope: [], contextFrom: [] },
      { name: "Hire summariser", role: "Analyst", agentType: "summariser", taskType: "hire_agent", allowWebFetch: false, goal: "Hire the market summariser to write a brief from the research.", budgetTUSD: part(0.4), perPaymentMaxTUSD: part(0.3), approvalThresholdTUSD: part(0.35), allowedPayees: ["agent-summariser"], deadline, dataScope: [], contextFrom: [0] },
      { name: "Buy report", role: "Buyer", agentType: "buyer", taskType: "buy_pay", allowWebFetch: false, goal: "Buy one supporting data report from the approved seller.", budgetTUSD: part(0.4), perPaymentMaxTUSD: part(0.3), approvalThresholdTUSD: part(0.15), allowedPayees: ["shop-reports"], deadline, dataScope: [], contextFrom: [0] },
    ],
  };
}

function startPlan(s: Store, goal: MockGoal) {
  goal.status = "running";
  goal.fundingTx = fakeHex();
  const total = goal.plan.sessions.reduce((a, p) => a + tusdToMicro(p.budgetTUSD), 0n);
  s.treasuryMicro -= total;
  s.balanceHistory.push({ at: Date.now(), tusdMicro: String(s.treasuryMicro) });
  emit(s, "plan_approved", { goalId: goal.id, data: { fundingTx: goal.fundingTx } });
  const ids: string[] = [];
  goal.plan.sessions.forEach((p, i) => {
    const x = makeSession({
      goalId: goal.id, letter: String.fromCharCode(65 + i), name: p.name, role: p.role, agentType: p.agentType, taskType: p.taskType, goal: p.goal, status: "RUNNING",
      budgetMicro: tusdToMicro(p.budgetTUSD), perPaymentMaxMicro: tusdToMicro(p.perPaymentMaxTUSD), approvalThresholdMicro: tusdToMicro(p.approvalThresholdTUSD),
      allowedPayees: p.allowedPayees.map((a) => PAYEES[a] ?? { id: a, label: a, address: a }), expiresAt: Date.parse(p.deadline) || Date.now() + 6 * HOUR,
      contextFrom: p.contextFrom.map((c) => ids[c]!).filter(Boolean), steps: SCRIPTS[p.taskType](p), nextAt: Date.now() + 3000 + i * 2500,
    });
    if (p.parent !== undefined) x.parentSessionId = ids[p.parent] ?? null;
    ids.push(x.id);
    s.sessions.push(x);
    emit(s, "session_created", { goalId: goal.id, sessionId: x.id, data: { letter: x.letter, role: x.role, taskType: x.taskType } });
    emit(s, "session_funded", { goalId: goal.id, sessionId: x.id, data: { amountMicro: String(x.budgetMicro), txHash: goal.fundingTx } });
    emit(s, "session_transition", { goalId: goal.id, sessionId: x.id, data: { from: "FUNDING", to: "RUNNING", reason: "funded" } });
  });
  action(s, `spawned ${ids.length} sessions in one funding tx`, goal.id);
  return ids;
}

// ───────────── HTTP surface ─────────────
type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "content-type": "application/json" } });
const err = (status: number, error: string) => json({ error }, status);

function sse(signal: AbortSignal | undefined, start: (send: (data: unknown) => void) => () => void): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      controller.enqueue(enc.encode(`: fixture stream\n\n`));
      const stop = start(send);
      const ping = setInterval(() => {
        tick();
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 2000);
      cleanup = () => {
        clearInterval(ping);
        stop();
      };
      signal?.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}

function decide(s: Store, d: Decision, status: "approved" | "rejected", by: string, note?: string) {
  d.status = status;
  d.decidedBy = by;
  d.decidedAt = Date.now();
  const x = s.sessions.find((q) => q.id === d.sessionId);
  emit(s, "decision_closed", { goalId: x?.goalId, sessionId: d.sessionId, data: { decisionId: d.id, kind: d.kind, status, note } });
  if (!x) return;
  if (d.kind === "payment_approval") {
    const p = s.payments.find((q) => q.id === d.details.paymentId);
    if (p) {
      p.status = status === "approved" ? "confirmed" : "rejected";
      x.blockedOn = null;
      if (status === "approved") {
        emit(s, "payment_approved", { goalId: x.goalId, sessionId: x.id, data: { paymentId: p.id, by } });
        confirmPayment(s, x, p.id, BigInt(p.amountMicro), p.payeeLabel ?? p.payee);
      } else {
        emit(s, "payment_rejected", { goalId: x.goalId, sessionId: x.id, data: { paymentId: p.id, reason: "rejected_by_user", detail: note ?? "rejected by you", amountMicro: p.amountMicro } });
      }
    }
  } else if (d.kind === "quarantine_release") {
    if (status === "approved") {
      emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from: x.status, to: "RUNNING", reason: "quarantine released by user" } });
      x.status = "RUNNING";
      x.failReason = null;
      x.latest = "Released from quarantine; same mandate.";
      x.steps = [{ kind: "progress", text: "Re-checking the seller against the allowlist." }, ...SCRIPTS.buy_pay(planFor("", "5", "").sessions[2]!)];
      x.cursor = 0;
      x.nextAt = Date.now() + 3000;
    } else {
      x.failReason = "quarantine not released; closed by you";
      closeSession(s, x, "KILLED", "quarantine rejected by user");
    }
  } else if (d.kind === "budget_raise" && status === "approved") {
    const add = BigInt(String(d.details.addMicro ?? "0"));
    x.budgetMicro += add;
    s.treasuryMicro -= add;
    emit(s, "session_funded", { goalId: x.goalId, sessionId: x.id, data: { amountMicro: String(add), txHash: fakeHex(), reason: "budget raise" } });
  } else if (d.kind === "extend_expiry" && status === "approved") {
    x.expiresAt = Number(d.details.newExpiresAt ?? x.expiresAt);
    const old = x.address;
    x.address = fakeAddr();
    emit(s, "session_funded", { goalId: x.goalId, sessionId: x.id, data: { reason: "moved to a new wallet with the new expiry", from: old, to: x.address, txHash: fakeHex() } });
  }
}

function openDecision(s: Store, x: MockSession, kind: DecisionKind, refKey: string, details: Json): Decision {
  const existing = s.decisions.find((d) => d.sessionId === x.id && d.kind === kind && d.refKey === refKey && d.status === "open");
  if (existing) return existing;
  const d: Decision = { id: id("dec"), sessionId: x.id, kind, requestedBy: "captain", refKey, details, status: "open", createdAt: Date.now() };
  s.decisions.push(d);
  emit(s, "decision_opened", { goalId: x.goalId, sessionId: x.id, data: { decisionId: d.id, kind } });
  return d;
}

export async function handleFixture(method: string, pathWithQuery: string, body: unknown, ctx: { userId?: string; signal?: AbortSignal }): Promise<Response> {
  const s = store();
  tick(s);
  const url = new URL(pathWithQuery, "http://fixture");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const b = (body ?? {}) as Json;
  const m = (re: RegExp) => p.match(re);
  let r: RegExpMatchArray | null;

  if (method === "GET" && p === "/health") return json({ ok: true, mode: "fixture", network: "preprod" });
  if (method === "GET" && p === "/me") return json({ ...me(s), mode: "fixture" });
  if (method === "POST" && p === "/users") {
    if (b.email) s.user.email = String(b.email);
    if (b.name !== undefined) s.user.name = (b.name as string | null) ?? null;
    if (b.custody === "self" && typeof b.walletAddress === "string") {
      s.user.custody = "self";
      s.user.treasuryAddress = b.walletAddress;
    } else if (b.custody === "custodial") {
      s.user.custody = "custodial";
    }
    const out: CreateUserResponse = { userId: s.user.userId, custody: s.user.custody, treasuryAddress: s.user.treasuryAddress, created: false };
    return json(out);
  }
  if (method === "POST" && p === "/topups") {
    const amountMyr = Number(b.amountMYR ?? 50);
    const fee = (amountMyr * Number(FEE_PCT)) / 100;
    const tusdAmt = ((amountMyr - fee) / Number(RATE)).toFixed(6);
    const t = { id: id("top"), amountMyr: amountMyr.toFixed(2), feeMyr: fee.toFixed(2), tusdMicro: String(tusdToMicro(tusdAmt)), simulated: true, status: "pending" as const, txHash: null, createdAt: Date.now() };
    s.topups.push(t);
    emit(s, "topup_pending", { data: { topupId: t.id, amountMyr: t.amountMyr } });
    const out: TopupStartResponse = { topupId: t.id, amountMyr: t.amountMyr, feeMyr: t.feeMyr, tusdMicro: t.tusdMicro };
    return json(out);
  }
  if (method === "POST" && (r = m(/^\/topups\/([^/]+)\/confirm$/))) {
    const t = s.topups.find((q) => q.id === r![1]);
    if (!t) return err(404, "topup not found");
    if (t.status !== "pending") return json({ ok: true, topup: t, duplicate: true } satisfies TopupConfirmResponse);
    t.status = "confirmed";
    t.txHash = fakeHex();
    s.treasuryMicro += BigInt(t.tusdMicro);
    s.lovelace += 2_000_000n;
    s.balanceHistory.push({ at: Date.now(), tusdMicro: String(s.treasuryMicro) });
    emit(s, "topup_submitted", { data: { topupId: t.id, txHash: t.txHash } });
    emit(s, "topup_confirmed", { data: { topupId: t.id, txHash: t.txHash, tusdMicro: t.tusdMicro } });
    return json({ ok: true, topup: t } satisfies TopupConfirmResponse);
  }
  if (method === "GET" && p === "/goals") {
    const out: GoalSummary[] = [...s.goals].sort((a, c) => c.createdAt - a.createdAt).map((q) => ({ id: q.id, goal: q.goal, budgetMicro: String(q.budgetMicro), deadline: q.deadline, rules: q.rules, status: q.status, fundingTx: q.fundingTx, createdAt: q.createdAt }));
    return json(out);
  }
  if (method === "POST" && p === "/goals") {
    const goalText = String(b.goal ?? "").trim();
    if (!goalText) return err(400, "goal is required");
    const budgetTUSD = String(b.budgetTUSD ?? "10");
    const deadline = String(b.deadline ?? new Date(Date.now() + 24 * HOUR).toISOString());
    const plan = planFor(goalText, budgetTUSD, deadline);
    const goal: MockGoal = { id: id("goal"), goal: goalText, budgetMicro: tusdToMicro(budgetTUSD), deadline: Date.parse(deadline) || Date.now() + 24 * HOUR, rules: String(b.rules ?? ""), status: "planned", plan, fundingTx: null, createdAt: Date.now() };
    s.goals.push(goal);
    emit(s, "goal_created", { goalId: goal.id, data: { goal: goalText } });
    emit(s, "plan_proposed", { goalId: goal.id, data: { sessions: plan.sessions.length } });
    action(s, `plan_task → ${plan.sessions.length} sessions`, goal.id);
    const total = plan.sessions.reduce((a, q) => a + tusdToMicro(q.budgetTUSD), 0n);
    const out: PlanResponse = { goalId: goal.id, plan, fundingPreview: { feeLovelace: "214573", totalTusd: microToTusd(total), totalLovelace: String(BigInt(plan.sessions.length) * 2_000_000n) } };
    return json(out);
  }
  if (method === "POST" && (r = m(/^\/goals\/([^/]+)\/approve$/))) {
    const goal = s.goals.find((q) => q.id === r![1]);
    if (!goal) return err(404, "goal not found");
    if (goal.status !== "planned") return json({ ok: true, fundingTx: goal.fundingTx, sessionIds: s.sessions.filter((x) => x.goalId === goal.id).map((x) => x.id), alreadyApproved: true } satisfies ApproveResponse);
    if (s.user.custody === "self" && !(typeof b.pendingId === "string" && typeof b.signedTx === "string")) {
      const needs: NeedsSignatureResponse = {
        ok: false,
        needsSignature: true,
        pendingId: `sig_fixture_${goal.id}`,
        unsignedTx: "84a400818258200000000000000000000000000000000000000000000000000000000000000000000181a200581d60fixture",
        txHash: fakeHex(),
        purpose: `Fund ${goal.plan.sessions.length} session wallets (fixture — nothing is submitted)`,
        feeLovelace: "214573",
        expiresAt: Date.now() + 15 * MIN,
      };
      return json(needs);
    }
    const ids = startPlan(s, goal);
    return json({ ok: true, fundingTx: goal.fundingTx, sessionIds: ids } satisfies ApproveResponse);
  }
  if (method === "GET" && (r = m(/^\/goals\/([^/]+)\/tree$/))) {
    const t = tree(s, r[1]!);
    return t ? json(t) : err(404, "goal not found");
  }
  if (method === "POST" && p === "/sessions/pause-all") {
    for (const x of s.sessions) if (x.status === "RUNNING") {
      emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from: "RUNNING", to: "PAUSED", reason: "pause all (user)" } });
      x.status = "PAUSED";
    }
    return json({ ok: true, paused: s.sessions.filter((x) => x.status === "PAUSED").length, failed: 0 });
  }
  if (method === "GET" && (r = m(/^\/sessions\/([^/]+)$/))) {
    const d = sessionDetail(s, r[1]!);
    return d ? json(d) : err(404, "session not found");
  }
  if (method === "POST" && (r = m(/^\/sessions\/([^/]+)\/messages$/))) {
    const x = s.sessions.find((q) => q.id === r![1]);
    if (!x) return err(404, "session not found");
    const text = String(b.text ?? "").trim().slice(0, 2000);
    if (!text) return err(400, "text is required");
    const msg = { id: id("msg"), sessionId: x.id, from: "user" as const, text, createdAt: Date.now() };
    s.messages.push(msg);
    emit(s, "session_message", { goalId: x.goalId, sessionId: x.id, data: { from: "user", text, messageId: msg.id } });
    if (/\b(budget|payee|allowlist|expiry|expire|threshold|per.payment|mandate)\b/i.test(text)) {
      emit(s, "mandate_change_ignored", { goalId: x.goalId, sessionId: x.id, data: { text: "A message cannot change the mandate; the request was ignored and logged." } });
    } else if (x.status === "RUNNING") {
      x.steps.splice(x.cursor, 0, { kind: "progress", text: `Acknowledged message: “${text.slice(0, 80)}”` });
      x.nextAt = Date.now() + 1500;
    }
    const out: MessageResponse = { messageId: msg.id, ...(s.events.at(-1)?.type === "mandate_change_ignored" ? { mandateChangeIgnored: true } : {}) };
    return json(out, 201);
  }
  if (method === "GET" && (r = m(/^\/sessions\/([^/]+)\/peek$/))) {
    const sid = r[1]!;
    return sse(ctx.signal, (send) => {
      for (const e of s.events.filter((q) => q.sessionId === sid && (q.type === "progress" || q.type === "web_fetch" || q.type === "tool_denied")).slice(-20)) send(peekLine(e));
      const fn = (e: BulkheadEvent) => {
        if (e.sessionId === sid && !e.type.startsWith("captain_")) send(peekLine(e));
      };
      s.subscribers.add(fn);
      return () => s.subscribers.delete(fn);
    });
  }
  if (method === "POST" && (r = m(/^\/sessions\/([^/]+)\/(pause|resume|kill|extend|raise|narrow)$/))) {
    const x = s.sessions.find((q) => q.id === r![1]);
    if (!x) return err(404, "session not found");
    const act = r[2]!;
    const tr = (to: SessionStatus, reason: string) => {
      emit(s, "session_transition", { goalId: x.goalId, sessionId: x.id, data: { from: x.status, to, reason } });
      x.status = to;
    };
    if (act === "pause") {
      if (x.status !== "RUNNING") return err(409, `cannot pause from ${x.status}`);
      tr("PAUSED", "paused by user");
    } else if (act === "resume") {
      if (x.status !== "PAUSED") return err(409, `cannot resume from ${x.status}`);
      tr("RUNNING", "resumed by user");
      x.nextAt = Date.now() + 2000;
    } else if (act === "kill") {
      if (isEnded(x.status)) return err(409, `already ${x.status}`);
      x.failReason = String(b.reason ?? "killed by you");
      closeSession(s, x, "KILLED", "killed by user");
    } else if (act === "raise") {
      const add = tusdToMicro(String(b.addTUSD ?? "1"));
      const d = openDecision(s, x, "budget_raise", `raise-${add}`, { addMicro: String(add), newBudgetMicro: String(x.budgetMicro + add) });
      return json({ ok: true, status: x.status, decision: d } satisfies ControlResponse);
    } else if (act === "extend") {
      const newExpiresAt = Number(b.newExpiresAt ?? x.expiresAt + HOUR);
      const d = openDecision(s, x, "extend_expiry", `extend-${newExpiresAt}`, { newExpiresAt, oldExpiresAt: x.expiresAt });
      return json({ ok: true, status: x.status, decision: d } satisfies ControlResponse);
    } else if (act === "narrow") {
      const nb = tusdToMicro(String(b.newBudgetTUSD ?? "0"));
      if (nb < x.spentMicro || nb >= x.budgetMicro) return err(400, "new budget must be between spent and the current budget");
      const excess = x.budgetMicro - nb;
      x.budgetMicro = nb;
      s.treasuryMicro += excess;
      emit(s, "close_submitted", { goalId: x.goalId, sessionId: x.id, data: { reason: "narrow: excess swept to treasury", amountMicro: String(excess), txHash: fakeHex() } });
    }
    return json({ ok: true, status: x.status } satisfies ControlResponse);
  }
  if (method === "POST" && (r = m(/^\/payments\/([^/]+)\/(approve|reject)$/))) {
    const pay = s.payments.find((q) => q.id === r![1]);
    const d = pay && s.decisions.find((q) => q.id === pay.decisionId && q.status === "open");
    if (!d) return err(404, "no open approval for that payment");
    decide(s, d, r[2] === "approve" ? "approved" : "rejected", ctx.userId ?? "user");
    return json({ ok: true, paymentId: pay!.id, status: pay!.status, decision: d } satisfies PaymentDecisionResponse);
  }
  if (method === "GET" && p === "/decisions") {
    const st = url.searchParams.get("status");
    const list: DecisionDTO[] = s.decisions
      .filter((d) => !st || d.status === st)
      .sort((a, c) => (a.status === "open" ? 0 : 1) - (c.status === "open" ? 0 : 1) || c.createdAt - a.createdAt)
      .map((d) => {
        const x = s.sessions.find((q) => q.id === d.sessionId);
        return { ...d, ...(x ? { goalId: x.goalId, letter: x.letter, role: x.role } : {}) };
      });
    return json(list);
  }
  if (method === "POST" && (r = m(/^\/decisions\/([^/]+)$/))) {
    const d = s.decisions.find((q) => q.id === r![1]);
    if (!d) return err(404, "decision not found");
    if (d.status !== "open") return json(d);
    const status = b.status === "approved" ? "approved" : "rejected";
    decide(s, d, status, ctx.userId ?? "user", typeof b.note === "string" ? b.note : undefined);
    return json(d);
  }
  if (method === "POST" && p === "/captain/messages") {
    const text = String(b.text ?? "").trim();
    if (!text) return err(400, "text is required");
    const goalId = typeof b.goalId === "string" ? b.goalId : undefined;
    s.captain.push({ id: s.nextCaptainId++, at: Date.now(), kind: "user_message", text, goalId });
    emit(s, "user_message", { goalId, data: { text } });
    const running = s.sessions.filter((x) => x.status === "RUNNING").map((x) => `${x.letter} ${x.role}`);
    const open = s.decisions.filter((d) => d.status === "open").length;
    action(s, "read_status(all)", goalId);
    report(s, `Fixture captain: ${running.length} running (${running.join(", ") || "none"}), ${open} open decision${open === 1 ? "" : "s"}. I can message, pause or kill sessions; mandate changes need your approval.`, goalId);
    return json({ ok: true, queued: true }, 202);
  }
  if (method === "GET" && p === "/captain/log") {
    const out: CaptainLogDTO = { woken: s.woken, absorbed: s.absorbed, entries: s.captain.slice(-200) };
    return json(out);
  }
  if (method === "GET" && p === "/agents") return json(Object.values(PAYEES).map((q) => ({ id: q.id, name: q.label, skills: [], priceTUSD: "1", paymentAddress: q.address, endpoint: "http://localhost:4100", source: "mock" })));
  if (method === "GET" && p === "/agent-map") return json(agentMap(s));
  if (method === "GET" && p === "/spending") return json(spending(s));
  if (method === "GET" && p === "/logbook") return json(logbook(s));
  if (method === "GET" && p === "/activity") return json(fixtureActivity(s.events, url.searchParams));
  if (method === "GET" && p === "/events/stream") {
    const goalId = url.searchParams.get("goalId");
    const after = Number(url.searchParams.get("after") ?? "0") || 0;
    // `after` present (even 0) = replay history (the Bridge replays a goal with ?goalId=…&after=0).
    const replay = url.searchParams.has("after");
    return sse(ctx.signal, (send) => {
      if (replay) for (const e of s.events.filter((q) => q.id > after && (!goalId || !q.goalId || q.goalId === goalId))) send(e);
      const fn = (e: BulkheadEvent) => {
        if (!goalId || !e.goalId || e.goalId === goalId) send(e);
      };
      s.subscribers.add(fn);
      return () => s.subscribers.delete(fn);
    });
  }
  return err(404, `fixture engine: no route for ${method} ${p}`);
}

function peekLine(e: BulkheadEvent): PeekLine {
  const d = e.data;
  const text =
    e.type === "progress" ? String(d.text ?? "")
    : e.type === "web_fetch" ? `web_fetch ${String(d.url ?? "")}`
    : e.type === "session_message" ? `message from ${String(d.from)}: ${String(d.text ?? "")}`
    : e.type === "session_transition" ? `${String(d.from)} → ${String(d.to)} (${String(d.reason ?? "")})`
    : `${e.type}${d.text ? `: ${String(d.text)}` : ""}`;
  return { id: e.id, at: e.at, level: e.type === "tool_denied" || e.type === "payment_rejected" || e.type === "mandate_change_ignored" ? "warn" : "info", kind: e.type, text };
}
