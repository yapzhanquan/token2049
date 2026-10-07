// pnpm e2e:preprod — acceptance test (base spec §8 + SPEC-v2 "Tests to add").
//
// Drives the REAL engine services in-process (wireEngine: runtime + Signer + silos + supervisor + captain
// with MockLLM) on a temp SQLite DB, through the same HTTP API routes the web app calls, plus the real mock
// agent market (apps/mock-market, in-process on a free port) and a tiny local page server.
//
//   pnpm e2e:preprod            Cardano PREPROD (needs BLOCKFROST_PREPROD_PROJECT_ID, a funded operator,
//                               minted tUSD — see the precondition check). Takes ~15–25 min (blocks ≈ 20 s).
//   E2E_DRY=1 pnpm e2e:preprod  (or `-- --dry`) the same script on the in-memory FakeChain: NOTHING on-chain;
//                               explorer links are labelled "(fake chain)". ~1 min.
//
// Optional env: E2E_ACCOUNT_INDEX (treasury BIP32 account for the e2e user, default 990001),
// E2E_MIN_OPERATOR_ADA (default 100), E2E_EXPIRY_MIN (preprod expiry-test window, default 8), E2E_VERBOSE=1.
//
// WALLET_MODE=vault: every session wallet is a Bulkhead Session Vault (Aiken, Plutus V3) — funding = ONE
// vaultFund tx, payments = vault Pay, closes = captain Revoke (metadata 674), expiry test = permissionless
// Recover — plus an on-chain attack step: a Pay signed by the real session key to a NON-allowlisted payee,
// bypassing the Signer, must be rejected by the validator (no tx lands, the vault balance is unchanged).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentJobs, decisions as decisionsT, goals, messages, payments, sessions as sessionsT, topups, users } from "@bulkhead/db";
import { createChain, type Chain } from "@bulkhead/chain";
import {
  PlanSchema,
  isNeedsSignature,
  microToTusd,
  type AgentCatalogEntry,
  type ApproveResponse,
  type ControlResponse,
  type CreateUserResponse,
  type DecideResponse,
  type DecisionDTO,
  type Handback,
  type MessageResponse,
  type Plan,
  type PlannedSession,
  type PlanResponse,
  type TopupConfirmResponse,
  type TopupStartResponse,
  type TreeDTO,
} from "@bulkhead/shared";
import { createEventBus } from "../src/bus";
import {
  DRY_TIMING,
  PREPROD_TIMING,
  createDryChain,
  events,
  letterOf,
  openTempDb,
  row,
  runtimeOverrides,
  sleep,
  startEngine,
  stopEngine,
  transitionsOf,
  waitFor,
  waitStatus,
  type Harness,
} from "./e2e/harness";
import { assert, log, need, Report } from "./e2e/report";
import { startMarket, startPageServer, type MarketServer, type PageServer } from "./e2e/servers";
import { recoverCli, recoverInProcess, recoverLogSha, type RecoverResult } from "./e2e/recover";
import { isScriptFailure, requireVault, walletModeFromEnv } from "../src/vault";

const DRY = process.env.E2E_DRY === "1" || process.env.E2E_DRY === "true" || process.argv.includes("--dry");
const MODE = walletModeFromEnv(process.env);
const VAULT = MODE === "vault";
const report = new Report(DRY);
const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} ADA`;
const tusd = (m: bigint) => `${microToTusd(m)} tUSD`;

process.on("unhandledRejection", (e) => {
  if (process.env.E2E_VERBOSE) console.error("[e2e] unhandled rejection (background):", e);
});

// ───────────────────────── context shared by the steps ─────────────────────────
const ctx: {
  userId?: string;
  treasury?: string;
  treasuryStart?: { tusdMicro: bigint; lovelace: bigint };
  goalId?: string;
  R?: string; // research
  H?: string; // hire_agent
  B?: string; // buy_pay (policy + quarantine)
  F?: string; // follow-up research (contextIn from H; restart test)
  E?: string; // expiry test
  funded: Map<string, bigint>; // session id → lovelace the funding tx put in its wallet
  recover?: { txHash: string; fee: bigint; pre: { tusdMicro: bigint; lovelace: bigint }; logSha: string };
  notAllowedPayee?: string;
} = { funded: new Map() };

async function main(): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!DRY) delete env.CHAIN; // never let CHAIN=fake from .env turn a preprod run into a fake one
  log(DRY ? "DRY RUN: FakeChain (in-memory, auto-confirm) + mock market bridged to it. NOTHING is submitted to any chain." : "PREPROD run (real transactions on Cardano preprod).");
  log(`wallet mode: ${MODE}${VAULT ? " (Bulkhead Session Vault — rules enforced on-chain)" : " (native-script session wallets)"}`);

  // ── preconditions ──
  if (!DRY) {
    const missing = ["BLOCKFROST_PREPROD_PROJECT_ID", "MASTER_SECRET", "OPERATOR_MNEMONIC"].filter((k) => !env[k]?.trim());
    if (missing.length) {
      console.error(
        `\n✗ Preconditions not met: ${missing.join(", ")} not set.\n` +
          `  1. Create a free PREPROD project at https://blockfrost.io and set BLOCKFROST_PREPROD_PROJECT_ID in .env\n` +
          `  2. MASTER_SECRET / OPERATOR_MNEMONIC: run \`pnpm gen:env\`\n` +
          `  3. Fund the operator from the preprod faucet and run \`pnpm setup:chain\` (mints tUSD)\n` +
          `  Offline check of the same flow: E2E_DRY=1 pnpm e2e:preprod`,
      );
      return 2;
    }
  }

  const { db, dbPath } = openTempDb();
  log(`temp DB: ${dbPath}`);
  const fakeChain = DRY ? createDryChain() : undefined;
  let observer: Chain;
  if (fakeChain) observer = fakeChain;
  else {
    observer = await createChain({ env });
    const pre = await preprodPreconditions(observer, env);
    if (pre) {
      console.error(pre);
      return 2;
    }
  }

  const pages: PageServer = await startPageServer();
  let market: MarketServer | null = null;
  const h: Harness = {
    dry: DRY,
    env,
    db,
    dbPath,
    timing: DRY ? DRY_TIMING : PREPROD_TIMING,
    observer,
    ...(fakeChain ? { fakeChain } : {}),
    reader: createEventBus(db),
    config: {},
    marketUrl: "",
    engine: null,
    api: null,
    lives: 0,
  };
  try {
    market = await startMarket({ dry: DRY, ...(fakeChain ? { fakeChain } : {}), env, pollMs: DRY ? 300 : 5_000, workDelayMs: DRY ? 300 : 1_500 });
    h.marketUrl = market.url;
    h.config = runtimeOverrides(DRY, market.url);
    log(`mock market on ${market.url} (${market.market.catalog().length} agents), fixture pages on ${pages.base}`);

    // Reserve a high treasury account for the e2e user (keeps it apart from real app users with the same MASTER_SECRET).
    const acct = Number(env.E2E_ACCOUNT_INDEX ?? 990_001);
    db.insert(users).values({ id: "u_e2e_reserved", email: "reserved@e2e.invalid", name: "e2e account reservation", custody: "self", accountIndex: acct - 1, treasuryAddress: "addr_test1reserved", ownerKeyHash: "00".repeat(28), createdAt: Date.now() }).run();

    await startEngine(h);
    await runSteps(h, pages, market);
  } catch (e) {
    log(`fatal: ${(e as Error).stack ?? e}`);
    report.steps.push({ id: "!", title: "harness", status: "FAIL", checks: [], error: (e as Error).message, ms: 0 });
  } finally {
    await cleanup(h).catch((e) => log(`cleanup error: ${(e as Error).message}`));
    await stopEngine(h, "test finished");
    await market?.close().catch(() => undefined);
    await pages.close().catch(() => undefined);
  }
  report.steps.sort((a, b) => (Number(a.id) || 99) - (Number(b.id) || 99));
  report.print([`\nDB kept for inspection: ${dbPath}`, ...(DRY ? ["NOTE: dry run — the real preprod run needs BLOCKFROST_PREPROD_PROJECT_ID + a funded operator."] : [])]);
  return report.failed ? 1 : 0;
}

async function preprodPreconditions(chain: Chain, env: NodeJS.ProcessEnv): Promise<string | null> {
  const minAda = BigInt(Math.round(Number(env.E2E_MIN_OPERATOR_ADA ?? 100) * 1e6));
  try {
    const tip = await chain.provider.fetchTip();
    log(`preprod tip slot ${tip.slot} via ${chain.provider.name}`);
  } catch (e) {
    return `\n✗ Cannot reach preprod via ${chain.provider.name}: ${(e as Error).message}\n  Check BLOCKFROST_PREPROD_PROJECT_ID (must be a PREPROD project id).`;
  }
  const op = await chain.keys.operator();
  const bal = await chain.tx.balanceOf(op.address);
  log(`operator ${op.address}: ${ada(bal.lovelace)}, ${tusd(bal.tusdMicro)}`);
  report.address("operator wallet", op.address);
  if (bal.lovelace < minAda) {
    return (
      `\n✗ Operator has ${ada(bal.lovelace)}; the e2e needs ≥ ${ada(minAda)} (top-up sends ~25 tADA + fees).\n` +
      `  Fund it from the preprod faucet: https://docs.cardano.org/cardano-testnets/tools/faucet\n  address: ${op.address}\n  then run \`pnpm setup:chain\`.`
    );
  }
  if (bal.tusdMicro < 20_000_000n) return `\n✗ Operator holds ${tusd(bal.tusdMicro)} — tUSD is not minted yet. Run \`pnpm setup:chain\` first.`;
  return null;
}

// ───────────────────────── the steps ─────────────────────────
async function runSteps(h: Harness, pages: PageServer, market: MarketServer) {
  const T = h.timing;
  const api = () => need(h.api, "a running engine");

  await report.step("1", "Test user + simulated Stripe checkout RM50 → tUSD in the treasury (on-chain)", async () => {
    const created = await api().call<CreateUserResponse>("POST", "/users", { body: { email: `e2e-${Date.now()}@bulkhead.test`, name: "E2E user", custody: "custodial" } });
    const userId = created.userId;
    const treasury = created.treasuryAddress;
    ctx.userId = userId;
    ctx.treasury = treasury;
    assert(created.created && created.custody === "custodial", "a new custodial user was created");
    report.address("e2e user treasury", treasury);
    report.ok(`custodial user ${userId} (treasury account ${h.db.select().from(users).where(eq(users.id, userId)).get()?.accountIndex})`);
    const before = await h.observer.tx.balanceOf(treasury);

    const stripeSessionId = `cs_test_e2e_${randomBytes(8).toString("hex")}`;
    const top = await api().call<TopupStartResponse>("POST", "/topups", { user: userId, body: { amountMYR: "50", stripeSessionId } });
    const topupId = top.topupId;
    const quoteMicro = BigInt(top.tusdMicro);
    const q = need(h.engine, "engine").onramp.quote("50");
    assert(q.tusdMicro === quoteMicro, `quote ${microToTusd(q.tusdMicro)} tUSD = top-up row ${microToTusd(quoteMicro)} tUSD`);
    report.ok(`top-up ${topupId}: RM${top.amountMyr} − fee RM${top.feeMyr} @ ${q.rate} MYR/tUSD → ${microToTusd(quoteMicro)} tUSD`);

    // A Stripe test event, signed with the Stripe v1 scheme and verified like the webhook route does,
    // then forwarded to the engine exactly as apps/web/app/api/stripe/webhook/route.ts forwards it.
    const secret = h.env.STRIPE_WEBHOOK_SECRET || `whsec_e2e_${randomBytes(16).toString("hex")}`;
    const event = {
      id: `evt_test_e2e_${randomBytes(10).toString("hex")}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: stripeSessionId, object: "checkout.session", payment_status: "paid", amount_total: 5000, currency: "myr", client_reference_id: topupId, metadata: { topupId, userId } } },
    };
    const payload = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex")}`;
    assert(verifyStripeSignature(payload, header, secret), "Stripe test-event signature verifies");
    assert(!verifyStripeSignature(payload.replace("5000", "9999"), header, secret), "a tampered payload is rejected");
    const parsed = JSON.parse(payload) as typeof event;
    const forward = { stripeEventId: parsed.id, stripeSessionId: parsed.data.object.id, amountTotal: parsed.data.object.amount_total, currency: parsed.data.object.currency };
    const confirmed = await api().call<TopupConfirmResponse>("POST", `/topups/${parsed.data.object.metadata.topupId}/confirm`, { user: parsed.data.object.metadata.userId, body: forward });
    const txHash: string = need(confirmed.topup.txHash, "top-up tx hash");
    report.tx("top-up (operator → treasury)", txHash);
    report.ok(`signed test event ${event.id} → engine confirm → tx ${txHash.slice(0, 16)}…`);
    // Stripe retries the same event: idempotent, no second payment.
    const again = await api().call<TopupConfirmResponse>("POST", `/topups/${topupId}/confirm`, { user: userId, body: forward });
    assert(again.topup.txHash === txHash, "re-delivered event returns the same tx");
    assert(events(h, { type: "topup_submitted" }).filter((e) => e.data.topupId === topupId).length === 1, "exactly one operator send for the event");
    report.ok("re-delivered webhook event is idempotent (one tx)");

    await waitFor(h, "top-up tx confirmed", async () => (await h.observer.provider.fetchTxConfirmation(txHash)) ?? null, T.chainMs);
    await waitFor(h, "top-up row confirmed", () => h.db.select().from(topups).where(eq(topups.id, topupId)).get()?.status === "confirmed", T.chainMs);
    const lovelaceSent = need(h.engine, "engine").config.topupLovelace > 2_000_000n ? h.engine!.config.topupLovelace : 2_000_000n;
    const after = await waitFor(
      h,
      "treasury balance reflects the top-up",
      async () => {
        const b = await h.observer.tx.balanceOf(treasury);
        return b.tusdMicro - before.tusdMicro === quoteMicro ? b : null;
      },
      T.chainMs,
    );
    assert(after.lovelace - before.lovelace === lovelaceSent, `treasury received ${ada(lovelaceSent)} (got ${ada(after.lovelace - before.lovelace)})`);
    report.ok(`treasury +${tusd(quoteMicro)} and +${ada(lovelaceSent)} on-chain (tx confirmed)`);
    ctx.treasuryStart = { tusdMicro: after.tusdMicro, lovelace: after.lovelace };
  });

  await report.step("2", "Goal → 3 sessions (research, hire_agent, buy_pay); ONE funding tx; all RUNNING together", async () => {
    const userId = need(ctx.userId, "step 1 user");
    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const planned = await api().call<PlanResponse>("POST", "/goals", { user: userId, body: { goal: "Research Malaysian e-wallet adoption and buy a short brief", budgetTUSD: "5.5", deadline, rules: "Stay within budget." } });
    const goalId: string = planned.goalId;
    ctx.goalId = goalId;
    const types = planned.plan.sessions.map((s) => s.taskType);
    assert(JSON.stringify(types) === JSON.stringify(["research", "hire_agent", "buy_pay"]), `planner (MockLLM) returned research/hire_agent/buy_pay (got ${types.join(",")})`);
    report.ok(`planner proposed ${types.join(" + ")} (funding preview fee ${planned.fundingPreview.feeLovelace} lovelace)`);

    // Same three sessions, with the e2e's mandates and deterministic silo hooks (#mock:…; MockLLM silos).
    const catalog = await api().call<AgentCatalogEntry[]>("GET", "/agents", { user: userId });
    const mr = need(catalog.find((a) => a.id === "market-research"), "market-research agent in the catalog");
    report.address("market-research agent wallet", mr.paymentAddress);
    ctx.notAllowedPayee = need(catalog.find((a) => a.id === "fact-checker"), "fact-checker agent (used as a NOT-allowed payee)").paymentAddress;
    const base = planned.plan.sessions;
    const slowR = DRY ? 2_000 : 20_000;
    const plan: Plan = PlanSchema.parse({
      sessions: [
        { ...base[0], goal: `Collect public sources on Malaysian e-wallet adoption #mock:slow=${slowR}`, budgetTUSD: "0.5", perPaymentMaxTUSD: "0.5", approvalThresholdTUSD: "0.5", allowedPayees: [], dataScope: [pages.trustedUrl], contextFrom: [] },
        { ...base[1], goal: "Hire the market-research agent for a Malaysian e-wallet competitor scan #mock:service=market-research", budgetTUSD: "3", perPaymentMaxTUSD: "2", approvalThresholdTUSD: "1", allowedPayees: ["market-research"], dataScope: [], contextFrom: [] },
        {
          ...base[2],
          allowWebFetch: true,
          goal: `Buy a summary brief #mock:pay=${ctx.notAllowedPayee}:0.5 #mock:fetch=${pages.untrustedUrl}`,
          budgetTUSD: "2",
          perPaymentMaxTUSD: "1",
          approvalThresholdTUSD: "1",
          allowedPayees: ["summariser"],
          dataScope: [pages.untrustedUrl],
          contextFrom: [],
        },
      ],
    });
    h.db.update(goals).set({ planJson: JSON.stringify(plan) }).where(eq(goals.id, goalId)).run();
    const approved = await api().call<ApproveResponse>("POST", `/goals/${goalId}/approve`, { user: userId, body: {} });
    assert(!isNeedsSignature(approved), "custodial approval needs no browser signature");
    const ids = approved.sessionIds;
    assert(ids.length === 3, `3 sessions created (got ${ids.length})`);
    const byType = (t: string) => need(ids.find((id) => row(h, id).taskType === t), `${t} session`);
    ctx.R = byType("research");
    ctx.H = byType("hire_agent");
    ctx.B = byType("buy_pay");
    const rows = ids.map((id) => row(h, id));
    const fundingTx = need(rows[0]!.fundingTx, "funding tx");
    assert(rows.every((r) => r.fundingTx === fundingTx), "all 3 sessions share ONE funding tx");
    assert(new Set(rows.map((r) => r.address)).size === 3, "3 distinct session addresses");
    assert(rows.every((r) => r.walletMode === MODE), `all 3 sessions are walletMode "${MODE}"`);
    if (VAULT) {
      assert(rows.every((r) => /^[0-9a-f]{56}$/.test(r.scriptHash ?? "")) && new Set(rows.map((r) => r.scriptHash)).size === 3, "3 distinct applied Session Vault script hashes");
      for (const r of rows) report.ok(`session ${r.letter} (${r.taskType}) Session Vault script ${r.scriptHash}`);
    }
    report.tx(VAULT ? "funding tx (treasury → 3 Session Vaults, inline datum Void)" : "funding tx (treasury → 3 session wallets)", fundingTx);
    for (const r of rows) report.address(`session ${r.letter} (${r.taskType}) wallet`, r.address);
    report.ok(`one funding tx ${fundingTx.slice(0, 16)}… with 3 outputs`);

    await waitFor(h, "funding tx confirmed", async () => (await h.observer.provider.fetchTxConfirmation(fundingTx)) ?? null, T.chainMs);
    await waitFor(h, "engine saw the funding confirmation", () => ids.every((id) => row(h, id).fundingConfirmedAt), T.chainMs);
    for (const r of rows) {
      const b = await h.observer.tx.balanceOf(r.address!);
      assert(b.tusdMicro === BigInt(r.budgetMicro), `session ${r.letter} holds exactly its budget ${tusd(BigInt(r.budgetMicro))} (holds ${tusd(b.tusdMicro)})`);
      ctx.funded.set(r.id, b.lovelace);
    }
    report.ok(`session wallets hold exactly ${rows.map((r) => `${r.letter}=${microToTusd(BigInt(r.budgetMicro))}`).join(", ")} tUSD (+ ADA for min-UTxO/fees)`);

    await waitFor(h, "all 3 sessions started RUNNING", () => ids.every((id) => row(h, id).startedAt), T.localMs);
    await sleep(DRY ? 300 : 1_000);
    const spans = ids.map((id) => {
      const tr = transitionsOf(h, id);
      const i = tr.findIndex((t) => t.to === "RUNNING");
      const end = tr.slice(i + 1).find((t) => t.from === "RUNNING");
      return { id, start: tr[i]!.at, end: end?.at ?? Date.now() };
    });
    const overlapStart = Math.max(...spans.map((s) => s.start));
    const overlapEnd = Math.min(...spans.map((s) => s.end));
    assert(overlapStart < overlapEnd, `RUNNING intervals overlap (latest start ${overlapStart} < earliest end ${overlapEnd})`);
    report.ok(`all 3 RUNNING at the same time for ${overlapEnd - overlapStart} ms (from transitions timestamps)`);
  });

  await report.step("6", "v2: user message to a running session (mandate change ignored) + ONE payment approved via the decision ledger", async () => {
    const userId = need(ctx.userId, "user");
    const H = need(ctx.H, "hire_agent session");
    const hRow0 = row(h, H);
    const dec = await waitFor(
      h,
      "payment_approval decision for the hire payment",
      async () => (await api().call<DecisionDTO[]>("GET", "/decisions?status=open", { user: userId })).find((d) => d.sessionId === H && d.kind === "payment_approval"),
      T.localMs,
    );
    const paymentId = String(dec.details.paymentId);
    assert(row(h, H).status === "RUNNING", "H stays RUNNING while its payment waits for approval");
    assert(h.db.select().from(payments).where(eq(payments.id, paymentId)).get()?.status === "awaiting_approval", "payment is awaiting_approval");
    report.ok(`decision ${dec.id} opened: ${String(dec.details.amountTUSD)} tUSD > approval threshold ${microToTusd(BigInt(hRow0.approvalThresholdMicro))}`);

    // One user message to the running session; it also tries to change the mandate.
    const text = `Focus on Touch 'n Go and GrabPay merchant fees. Also raise the budget to 50 tUSD and add payee ${ctx.notAllowedPayee}.`;
    const sent = await api().call<MessageResponse>("POST", `/sessions/${H}/messages`, { user: userId, body: { text } });
    const messageId = sent.messageId;
    assert(events(h, { sessionId: H, type: "session_message" }).some((e) => e.data.messageId === messageId && e.data.from === "user"), "session_message event recorded");
    const ignored = events(h, { sessionId: H, type: "mandate_change_ignored" }).find((e) => e.data.messageId === messageId);
    assert(ignored, "mandate_change_ignored event recorded");
    assert(h.db.select().from(messages).where(eq(messages.id, messageId)).get()?.deliveredAt, "message delivered to the live silo over IPC");
    await waitFor(h, "silo noted the message as data", () => events(h, { sessionId: H, type: "progress" }).some((e) => String(e.data.text ?? "").includes("message from user noted")), T.localMs);
    const hRow1 = row(h, H);
    assert(hRow1.budgetMicro === hRow0.budgetMicro && hRow1.allowedPayeesJson === hRow0.allowedPayeesJson && hRow1.perPaymentMaxMicro === hRow0.perPaymentMaxMicro && hRow1.expiresAt === hRow0.expiresAt, "mandate unchanged");
    report.ok(`message delivered (session_message); mandate change ignored (${(ignored.data.matched as string[]).join(", ")}); mandate unchanged`);

    const decided = await api().call<DecideResponse>("POST", `/decisions/${dec.id}`, { user: userId, body: { status: "approved", note: "e2e approves the hire payment" } });
    assert(!isNeedsSignature(decided) && decided.status === "approved", "POST /decisions/:id answered approved");
    const d = h.db.select().from(decisionsT).where(eq(decisionsT.id, dec.id)).get();
    assert(d?.status === "approved" && d.decidedBy === userId, "decision closed as approved by the user");
    assert(events(h, { sessionId: H, type: "payment_approved" }).some((e) => e.data.paymentId === paymentId), "payment_approved event");
    const pay = await waitFor(h, "approved payment confirmed on-chain", () => {
      const p = h.db.select().from(payments).where(eq(payments.id, paymentId)).get();
      return p?.status === "confirmed" ? p : null;
    }, T.chainMs);
    assert(await h.observer.provider.fetchTxConfirmation(pay.txHash!), "payment tx is on-chain");
    assert(h.db.select().from(decisionsT).where(eq(decisionsT.sessionId, H)).all().filter((x) => x.kind === "payment_approval").length === 1, "exactly one decision for the request");
    report.tx(`hire payment (session ${hRow0.letter} → market-research, approved via the decision ledger)`, pay.txHash);
    report.ok(`payment ${tusd(BigInt(pay.amountMicro))} approved → confirmed on-chain ${pay.txHash!.slice(0, 16)}…`);
  });

  await report.step("3", "hire_agent session hires market-research: in-policy payment, result (agent_job node), handback w/ result_hash, closes", async () => {
    const userId = need(ctx.userId, "user");
    const H = need(ctx.H, "hire_agent session");
    const hr = row(h, H);
    const pays = h.db.select().from(payments).where(eq(payments.sessionId, H)).all();
    const confirmed = pays.filter((p) => p.status === "confirmed");
    assert(confirmed.length === 1, `one confirmed payment (got ${confirmed.length})`);
    const p = confirmed[0]!;
    const allow = JSON.parse(hr.allowedPayeesJson) as { id: string; address: string }[];
    assert(allow.some((a) => a.address === p.payee && a.id === "market-research"), "payee = market-research (on the allowlist)");
    assert(BigInt(p.amountMicro) <= BigInt(hr.perPaymentMaxMicro) && BigInt(hr.spentMicro) <= BigInt(hr.budgetMicro), "within per-payment max and budget");
    report.ok(`payment ${tusd(BigInt(p.amountMicro))} ≤ per-payment max ${tusd(BigInt(hr.perPaymentMaxMicro))}, payee on allowlist`);

    const job = await waitFor(h, "agent job completed", () => h.db.select().from(agentJobs).where(eq(agentJobs.sessionId, H)).all().find((j) => j.status === "completed"), T.chainMs);
    const st = (await (await fetch(`${market.url}/status/${job.externalJobId}`)).json()) as { status: string; result_hash?: string; payment_tx?: string };
    assert(st.status === "completed" && st.result_hash === job.resultHash, "market status result_hash = recorded job result_hash");
    assert(st.payment_tx === p.txHash, "market matched exactly this payment tx on-chain");
    report.ok(`market-research job ${job.externalJobId} paid by ${p.txHash!.slice(0, 12)}… → completed (result_hash ${st.result_hash!.slice(0, 12)}…)`);

    const closed = await waitStatus(h, H, ["CLOSED"], T.chainMs);
    const hb = JSON.parse(need(closed.handbackJson, "H handback")) as Handback;
    assert(hb.job?.jobId === job.externalJobId && hb.job?.resultHash === st.result_hash, "handback job.resultHash matches the market's result_hash");
    assert(closed.closeStatus === "COMPLETED", `closed as COMPLETED (got ${closed.closeStatus})`);
    assert(events(h, { sessionId: H, type: "handback_accepted" }).length >= 1, "handback accepted (definition of done)");
    const tree = await api().call<TreeDTO>("GET", `/goals/${ctx.goalId}/tree`, { user: userId });
    assert(tree.nodes.some((n) => n.kind === "agent_job" && n.parentId === H), "agent_job child node under H in the tree");
    report.tx(`session ${closed.letter} (hire_agent) ${VAULT ? "Revoke" : "close/sweep"}`, closed.closeTx);
    report.ok(`handback submitted + accepted; agent_job child node in tree; H CLOSED (sweep ${closed.closeTx?.slice(0, 12) ?? "none"}…)`);
  });

  await report.step("5", "buy_pay session: pay() to a NOT-allowlisted payee → payment_rejected; untrusted page → QUARANTINED → killed → closes", async () => {
    const userId = need(ctx.userId, "user");
    const B = need(ctx.B, "buy_pay session");
    const rej = await waitFor(h, "payment_rejected for the non-allowlisted payee", () => events(h, { sessionId: B, type: "payment_rejected" }).find((e) => e.data.reason === "payee_not_allowed"), T.localMs);
    assert(rej.data.payee === ctx.notAllowedPayee, "rejected payee is the non-allowlisted one");
    assert(h.db.select().from(payments).where(eq(payments.sessionId, B)).all().every((p) => !p.txHash), "no tx was built for the rejected payment");
    report.ok(`Signer rejected ${String(rej.data.amountTUSD)} tUSD → ${String(rej.data.payee).slice(0, 20)}… (payee_not_allowed)`);
    if (VAULT) {
      // On-chain attack: bypass the Signer entirely and ask TxService for a vault Pay signed by B's REAL session
      // key, to the non-allowlisted payee. The Session Vault validator must reject it (no tx lands).
      const eng = need(h.engine, "engine");
      const bRow = row(h, B);
      const before = await h.observer.tx.balanceOf(bRow.address!);
      let attackErr: unknown = null;
      let landed: string | null = null;
      try {
        const res = await requireVault(eng.chain).pay({ sessionId: B, payee: need(ctx.notAllowedPayee, "attacker"), tusdMicro: 500_000n, memo: "e2e: on-chain attack (Signer bypassed)" });
        landed = res.txHash;
      } catch (e) {
        attackErr = e;
      }
      assert(!landed, `attack Pay must not be accepted (got tx ${landed})`);
      assert(isScriptFailure(attackErr), `rejected by the Session Vault script (error: ${(attackErr as Error | null)?.message?.slice(0, 300)})`);
      const after = await h.observer.tx.balanceOf(bRow.address!);
      assert(after.tusdMicro === before.tusdMicro && after.lovelace === before.lovelace, "vault balance unchanged after the rejected attack (no collateral lost)");
      report.ok(`ON-CHAIN: Pay (session key, Signer bypassed) → attacker rejected by the validator: ${String((attackErr as Error).message).split("\n")[0]!.slice(0, 200)}`);
    }
    await waitStatus(h, B, ["QUARANTINED"], T.localMs);
    const taint = events(h, { sessionId: B, type: "tainted" }).find((e) => e.data.quarantine === true);
    assert(taint && String(taint.data.url).includes("/untrusted"), "tainted by the untrusted page");
    assert(h.db.select().from(decisionsT).where(eq(decisionsT.sessionId, B)).all().some((d) => d.kind === "quarantine_release" && d.status === "open"), "quarantine_release decision opened");
    report.ok(`fetched ${pages.untrustedUrl} (flagged untrusted) → QUARANTINED + open quarantine_release decision`);
    const killed = await api().call<ControlResponse>("POST", `/sessions/${B}/kill`, { user: userId, body: { reason: "e2e: quarantined session killed by the user" } });
    assert(!isNeedsSignature(killed), "kill needs no signature");
    const closed = await waitStatus(h, B, ["CLOSED"], T.chainMs);
    assert(closed.closeStatus === "KILLED", `closed as KILLED (got ${closed.closeStatus})`);
    assert(closed.closeTx, "funds swept back with a close tx");
    report.tx(`session ${closed.letter} (buy_pay, killed) ${VAULT ? "Revoke" : "close/sweep"}`, closed.closeTx);
    report.ok(`killed → CLOSING → CLOSED, budget ${tusd(BigInt(closed.refundMicro ?? "0"))} swept back`);
  });

  await report.step("4", "A later session starts with the hire_agent handback as contextIn (handback_passed)", async () => {
    const R = need(ctx.R, "research session");
    const H = need(ctx.H, "hire_agent session");
    const goalId = need(ctx.goalId, "goal");
    await waitStatus(h, R, ["CLOSED"], T.chainMs); // keep the restart test free of in-flight closes
    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    const spec: PlannedSession = {
      name: "Follow-up brief",
      role: "analyst",
      agentType: "researcher",
      taskType: "research",
      allowWebFetch: false,
      goal: `Turn the market scan into a one-page brief #mock:slow=${DRY ? 2_500 : 15_000}`,
      budgetTUSD: "0.5",
      perPaymentMaxTUSD: "0.5",
      approvalThresholdTUSD: "0.5",
      allowedPayees: [],
      deadline,
      dataScope: [pages.trustedUrl],
      contextFrom: [],
    };
    // The captain's spawn_session path: fund one more wallet, start once H's handback is passed in.
    const F = await need(h.engine, "engine").sessions.spawn(goalId, spec, { parentSessionId: H, contextFrom: [H] });
    ctx.F = F;
    const fRow = row(h, F);
    report.tx(`funding tx (follow-up session ${fRow.letter})`, fRow.fundingTx);
    report.address(`session ${fRow.letter} (follow-up) wallet`, fRow.address);
    await waitFor(h, "F funded", () => row(h, F).fundingConfirmedAt, T.chainMs);
    ctx.funded.set(F, (await h.observer.tx.balanceOf(fRow.address!)).lovelace);
    await waitStatus(h, F, ["RUNNING"], T.chainMs);
    const passed = events(h, { type: "handback_passed" }).find((e) => e.data.from === H && e.data.to === F);
    assert(passed, "handback_passed H → F event exists");
    const runningEv = events(h, { sessionId: F, type: "session_transition" }).find((e) => e.data.to === "RUNNING");
    assert(runningEv && passed.id < runningEv.id, "handback was passed BEFORE F started (it is part of F's start contextIn)");
    const ctxIn = JSON.parse(row(h, F).contextInJson) as { fromSessionId: string; handback: Handback }[];
    const hb = JSON.parse(row(h, H).handbackJson!) as Handback;
    assert(ctxIn.some((c) => c.fromSessionId === H && c.handback.job?.resultHash === hb.job?.resultHash), "F's contextIn carries H's handback (as data)");
    const others = events(h, { type: "handback_passed" }).filter((e) => e !== passed).map((e) => `${letterOf(h, String(e.data.from))}→${letterOf(h, String(e.data.to))} by ${String(e.data.by)}`);
    report.ok(`handback_passed ${letterOf(h, H)} → ${letterOf(h, F)} (event #${passed.id}) before ${letterOf(h, F)} RUNNING (#${runningEv.id})${others.length ? `; captain also passed: ${others.join(", ")}` : ""}`);
  });

  await report.step("8", "Restart: engine shut down mid-run, re-wired on the same DB → reconcile → sessions still close", async () => {
    const F = need(ctx.F, "follow-up session");
    assert(row(h, F).status === "RUNNING" && need(h.engine, "engine").silos.isAlive(F), "F is RUNNING with a live silo before the restart");
    const marker = events(h).at(-1)?.id ?? 0;
    await stopEngine(h, "restart test: kill the server mid-run");
    assert(row(h, F).status === "RUNNING", "F is still RUNNING in the DB while the engine is down");
    await sleep(DRY ? 500 : 3_000);
    await startEngine(h);
    const after = h.reader.since(marker, { sessionId: F });
    assert(after.some((e) => e.type === "progress" && String(e.data.text ?? "").startsWith("reconcile after restart: RUNNING")), "reconcile inspected F (DB + chain) after the restart");
    await waitFor(h, "F's silo restarted from its checkpoint", () => h.reader.since(marker, { sessionId: F }).some((e) => e.type === "progress" && String(e.data.text ?? "").startsWith("silo started")), T.localMs);
    report.ok(`reconcile after restart: ${letterOf(h, F)} RUNNING, wallet balance read from chain, silo restarted from its checkpoint`);
    const closed = await waitStatus(h, F, ["CLOSED"], T.chainMs);
    assert(closed.closeStatus === "COMPLETED" && closed.closeTx, `F completed and closed after the restart (closeStatus ${closed.closeStatus})`);
    report.tx(`session ${closed.letter} (follow-up) ${VAULT ? "Revoke" : "close/sweep"} after the restart`, closed.closeTx);
    report.ok(`${letterOf(h, F)} completed its handback after the restart and CLOSED (sweep ${closed.closeTx!.slice(0, 12)}…)`);
  });

  await report.step("9", "Expiry: session NOT closed by the app → owner recovery after the expiry slot → funds back to the owner", async () => {
    const goalId = need(ctx.goalId, "goal");
    const treasury = need(ctx.treasury, "treasury");
    const windowMs = DRY ? 12_000 : Number(h.env.E2E_EXPIRY_MIN ?? 8) * 60_000;
    const spec: PlannedSession = {
      name: "Short-lived watcher",
      role: "watcher",
      agentType: "researcher",
      taskType: "research",
      allowWebFetch: false,
      goal: "Long-running research that the app will not get to close #mock:slow=3600000",
      budgetTUSD: "0.5",
      perPaymentMaxTUSD: "0.5",
      approvalThresholdTUSD: "0.5",
      allowedPayees: [],
      deadline: new Date(Date.now() + windowMs).toISOString(),
      dataScope: [pages.trustedUrl],
      contextFrom: [],
    };
    const E = await need(h.engine, "engine").sessions.spawn(goalId, spec);
    ctx.E = E;
    const eRow = row(h, E);
    report.tx(`funding tx (expiry-test session ${eRow.letter})`, eRow.fundingTx);
    report.address(`session ${eRow.letter} (expiry test) wallet`, eRow.address);
    await waitFor(h, "E funded", () => row(h, E).fundingConfirmedAt, Math.max(windowMs - 30_000, 5_000));
    const funded = await h.observer.tx.balanceOf(eRow.address!);
    ctx.funded.set(E, funded.lovelace);
    await waitStatus(h, E, ["RUNNING"], T.localMs);
    report.ok(`E RUNNING with expiry slot ${eRow.expirySlot} (${new Date(eRow.expiresAt).toISOString()})`);
    await stopEngine(h, "expiry test: the app is down, nobody closes E");

    const recover = (): Promise<RecoverResult> =>
      DRY ? recoverInProcess(h.observer, E) : recoverCli({ sessionId: E, dbPath: h.dbPath, env: h.env, wait: true, timeoutMs: 6 * 60_000 });
    const early = await recover();
    assert(early.code === 2 && !early.txHash, `recover before expiry is refused without a tx (code ${early.code})`);
    report.ok("recover before the expiry slot: refused, nothing submitted");

    await waitFor(h, `chain tip past E's expiry slot ${eRow.expirySlot}`, async () => (await h.observer.provider.fetchTip()).slot > eRow.expirySlot! + (DRY ? 0 : 5), windowMs + T.chainMs);
    const pre = await h.observer.tx.balanceOf(eRow.address!);
    assert(pre.tusdMicro === BigInt(eRow.budgetMicro), `E still holds its budget at expiry (${tusd(pre.tusdMicro)}) — the app did not close it`);
    const tBefore = await h.observer.tx.balanceOf(treasury);
    const logSha = recoverLogSha(E);
    const r = await recover();
    assert(r.code === 0 && r.txHash, `owner recovery submitted (code ${r.code}): ${r.output.trim().split("\n").slice(-2).join(" | ")}`);
    const fee = need(r.feeLovelace, "recover fee");
    report.tx(VAULT ? `session ${eRow.letter} vault Recover (pnpm recover, permissionless, after expiry)` : `session ${eRow.letter} owner recovery sweep (pnpm recover, after expiry)`, r.txHash);
    await waitFor(h, "recovery tx confirmed", async () => (await h.observer.provider.fetchTxConfirmation(r.txHash!)) ?? null, T.chainMs);
    await waitFor(h, "E wallet empty", async () => (await h.observer.tx.balanceOf(eRow.address!)).utxoCount === 0, T.chainMs);
    const tAfter = await waitFor(h, "treasury credited by the recovery", async () => {
      const b = await h.observer.tx.balanceOf(treasury);
      return b.tusdMicro - tBefore.tusdMicro === pre.tusdMicro ? b : null;
    }, T.chainMs);
    assert(tAfter.lovelace - tBefore.lovelace === pre.lovelace - fee, `treasury +${ada(pre.lovelace - fee)} (wallet ADA − fee ${ada(fee)})`);
    ctx.recover = { txHash: r.txHash!, fee, pre: { tusdMicro: pre.tusdMicro, lovelace: pre.lovelace }, logSha };
    report.ok(`owner sweep ${r.txHash!.slice(0, 12)}… returned ${tusd(pre.tusdMicro)} + ${ada(pre.lovelace - fee)} to the owner treasury`);

    await startEngine(h);
    const closed = await waitStatus(h, E, ["CLOSED"], T.chainMs);
    assert(closed.closeStatus === "EXPIRED" && !closed.closeTx, `engine reconciles E: EXPIRED → CLOSED with nothing left to sweep (closeStatus ${closed.closeStatus})`);
    report.ok("engine restarted: reconcile saw the expiry + empty wallet → E EXPIRED → CLOSED (no double sweep)");
  });

  await report.step("7", "All sessions: CLOSED, wallets empty, treasury = start − spend − fees, close metadata 674, full tree", async () => {
    const userId = need(ctx.userId, "user");
    const treasury = need(ctx.treasury, "treasury");
    const start = need(ctx.treasuryStart, "treasury start balance");
    const ids = [ctx.R, ctx.H, ctx.B, ctx.F, ctx.E].map((x, i) => need(x, `session #${i + 1}`));
    const rows = ids.map((id) => row(h, id));
    for (const r of rows) assert(r.status === "CLOSED", `session ${r.letter} CLOSED (is ${r.status})`);
    report.ok(`all ${rows.length} sessions CLOSED (${rows.map((r) => `${r.letter}:${r.closeStatus}`).join(", ")})`);

    for (const r of rows) {
      const b = await waitFor(h, `wallet ${r.letter} empty`, async () => {
        const x = await h.observer.tx.balanceOf(r.address!);
        return x.utxoCount === 0 && x.tusdMicro === 0n && x.lovelace === 0n ? x : null;
      }, T.chainMs);
      assert(b.utxoCount === 0, "empty");
    }
    for (const r of rows) report.tx(`session ${r.letter} (${r.taskType}) ${VAULT ? "Revoke" : "close/sweep"}`, r.closeTx);
    report.ok("every session address balance = 0 (no UTxOs)");

    const fetchMeta = need(h.observer.provider.fetchTxMetadata?.bind(h.observer.provider), "provider.fetchTxMetadata");
    for (const r of rows) {
      if (r.id === ctx.E) {
        const rc = need(ctx.recover, "recovery tx");
        const m = (await waitFor(h, "recovery tx metadata", () => fetchMeta(rc.txHash), T.chainMs))["674"] as Record<string, unknown>;
        assert(m?.session_id === r.id && m.log_sha256 === rc.logSha && m.handback_sha256 === "none" && m.status === "RECOVERED_BY_OWNER", `E recovery tx metadata 674 matches (${JSON.stringify(m)})`);
        continue;
      }
      const closeTx = need(r.closeTx, `close tx of ${r.letter}`);
      const m = (await waitFor(h, `close tx metadata of ${r.letter}`, () => fetchMeta(closeTx), T.chainMs))["674"] as Record<string, unknown>;
      assert(m?.session_id === r.id, `${r.letter}: metadata session_id`);
      assert(m.log_sha256 === r.logSha256 && /^[0-9a-f]{64}$/.test(String(m.log_sha256)), `${r.letter}: metadata log_sha256 = stored log hash`);
      assert(m.handback_sha256 === r.handbackSha256, `${r.letter}: metadata handback_sha256 = stored handback hash`);
      assert(m.status === r.closeStatus, `${r.letter}: metadata status ${String(m.status)} = ${r.closeStatus}`);
    }
    report.ok("each close tx carries metadata 674 {session_id, log_sha256, handback_sha256, status} matching the DB (E: owner-recovery tx)");

    // Treasury accounting: tUSD exact; ADA from recorded fees + measured wallet outflows.
    const fundFees = new Map<string, bigint>();
    for (const e of events(h, { goalId: ctx.goalId!, type: "session_funded" })) if (e.data.phase === "submitted") fundFees.set(String(e.data.txHash), BigInt(String(e.data.feeLovelace)));
    let spentTusd = 0n;
    let fees = [...fundFees.values()].reduce((a, b) => a + b, 0n);
    let expectedL = start.lovelace - fees;
    let payeeAda = 0n;
    for (const r of rows) {
      const funded = need(ctx.funded.get(r.id), `funded lovelace of ${r.letter}`);
      const pays = h.db.select().from(payments).where(eq(payments.sessionId, r.id)).all().filter((p) => p.txHash);
      for (const p of pays) assert(p.status === "confirmed", `payment ${p.id} confirmed`);
      const payFees = pays.reduce((a, p) => a + BigInt(p.feeLovelace ?? "0"), 0n);
      spentTusd += pays.reduce((a, p) => a + BigInt(p.amountMicro), 0n);
      let preSweep: bigint;
      let sweepFee: bigint;
      if (r.id === ctx.E) {
        preSweep = ctx.recover!.pre.lovelace;
        sweepFee = ctx.recover!.fee;
      } else {
        const sub = events(h, { sessionId: r.id, type: "close_submitted" }).find((e) => e.data.txHash === r.closeTx);
        preSweep = BigInt(String(need(sub, `close_submitted of ${r.letter}`).data.lovelace));
        sweepFee = BigInt(r.feesLovelace) - payFees;
      }
      const toPayees = funded - payFees - preSweep; // min-ADA that travelled with the payments
      assert(toPayees >= 0n && toPayees <= BigInt(pays.length) * 3_000_000n, `${r.letter}: ADA paid out with payments is sane (${ada(toPayees)} for ${pays.length} payment(s))`);
      if (!pays.length) assert(toPayees === 0n, `${r.letter}: no payments → wallet ADA untouched until the sweep`);
      assert(sweepFee > 0n && sweepFee < 2_000_000n, `${r.letter}: sweep fee ${ada(sweepFee)} recorded`);
      payeeAda += toPayees;
      fees += payFees + sweepFee;
      expectedL += -funded + (preSweep - sweepFee);
    }
    const expectedT = start.tusdMicro - spentTusd;
    const end = await waitFor(h, "treasury settles at start − spend − fees", async () => {
      const b = await h.observer.tx.balanceOf(treasury);
      return b.tusdMicro === expectedT && b.lovelace === expectedL ? b : null;
    }, DRY ? 5_000 : 3 * 60_000).catch(async () => h.observer.tx.balanceOf(treasury));
    assert(end.tusdMicro === expectedT, `treasury tUSD ${tusd(end.tusdMicro)} = start ${tusd(start.tusdMicro)} − spend ${tusd(spentTusd)} (expected ${tusd(expectedT)})`);
    assert(end.lovelace === expectedL, `treasury ADA ${ada(end.lovelace)} = start ${ada(start.lovelace)} − fees ${ada(fees)} − ADA sent with payments ${ada(payeeAda)} (expected ${ada(expectedL)})`);
    report.ok(`treasury: ${tusd(start.tusdMicro)} − spend ${tusd(spentTusd)} = ${tusd(end.tusdMicro)}; ${ada(start.lovelace)} − fees ${ada(fees)} (${fundFees.size} funding + ${rows.length} sweeps/recovery + payments) − payee min-ADA ${ada(payeeAda)} = ${ada(end.lovelace)}`);

    const tree = await api().call<TreeDTO>("GET", `/goals/${ctx.goalId}/tree`, { user: userId });
    for (const r of rows) {
      const n = tree.nodes.find((x) => x.id === r.id);
      assert(n && n.kind === "session" && n.status === "CLOSED" && n.ghost, `tree has closed ghost node ${r.letter}`);
      if (r.handbackJson) assert(n.handbackSummary === (JSON.parse(r.handbackJson) as Handback).summary, `tree node ${r.letter} shows its handback summary`);
    }
    assert(tree.nodes.some((n) => n.kind === "agent_job" && n.parentId === ctx.H), "tree keeps the agent_job node");
    assert(tree.edges.some((e) => e.kind === "handback" && e.from === ctx.H && e.to === ctx.F), "tree has the H → F handback edge");
    assert(tree.nodes.find((n) => n.id === ctx.F)?.parentId === ctx.H, "F is drawn as H's child");
    report.ok(`tree: ${tree.nodes.length} nodes (${tree.nodes.filter((n) => n.kind === "session").length} sessions incl. killed/expired, agent_job), ${tree.edges.filter((e) => e.kind === "handback").length} handback edge(s), summaries on ${rows.filter((r) => r.handbackJson).length} nodes`);
  });
}

/** Stripe v1 webhook signature check (same scheme as stripe.webhooks.constructEvent). */
function verifyStripeSignature(payload: string, header: string, secret: string, toleranceS = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  const got = Buffer.from(parts.v1);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Never leave funds in session wallets: kill whatever is still open and wait for the sweeps. */
async function cleanup(h: Harness) {
  const open = h.db.select().from(sessionsT).all().filter((s) => s.status !== "CLOSED");
  if (!open.length) return;
  log(`cleanup: ${open.length} session(s) not CLOSED (${open.map((s) => `${s.letter}:${s.status}`).join(", ")}) — killing so funds return to the treasury`);
  if (!h.engine) await startEngine(h).catch((e) => log(`cleanup: engine restart failed: ${(e as Error).message}`));
  const e = h.engine;
  if (!e) return;
  for (const s of open) await e.sessions.kill(s.id, "user", "e2e cleanup").catch(() => undefined);
  await waitFor(h, "cleanup sweeps", () => open.every((s) => row(h, s.id).status === "CLOSED"), h.dry ? 20_000 : 10 * 60_000).catch((err) =>
    log(`cleanup: ${(err as Error).message}; expired wallets can be recovered with \`pnpm recover --session <id>\` (DATABASE_PATH=${h.dbPath})`),
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`e2e crashed: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));
