// Plan rationale: a short, plain-language "why this plan" stored per goal (planJson.rationale) and exposed in the goal
// DTO. Deterministic from the validated plan (+ the planner model's own one-line summary when it gave one), so it is
// always true to what will actually run: which sessions, why parallel vs dependent, how the budget is split, and
// which guards (on-chain Session Vault / native script, approval thresholds, egress allowlist) apply.
import { microToTusd, settlementTickerFromEnv, tusdToMicro, type AgentCatalogEntry, type Plan, type PlanRationale, type PlanRationaleSession, type WalletMode } from "@bulkhead/shared";

export const LETTER = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

export interface RationaleInput {
  plan: Plan;
  budgetTUSD: string;
  walletMode?: WalletMode;
  /** Catalog id → display name (planJson.payeeLabels). */
  payeeLabels?: Record<string, string>;
  catalog?: AgentCatalogEntry[];
  /** Deterministic adjustments the planner made (parallelizePlan notes). */
  planNotes?: string[];
  /** The planner model's own short summary ("rationale" in its JSON), if any. Treated as text, clipped. */
  modelSummary?: string | null;
  ticker?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hostOf = (s: string) => {
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s;
  }
};
const listJoin = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function walletModeFromEnv(env: NodeJS.ProcessEnv = process.env): WalletMode {
  return env.WALLET_MODE?.trim().toLowerCase() === "native" ? "native" : "vault";
}

export function buildPlanRationale(input: RationaleInput): PlanRationale {
  const { plan } = input;
  const ticker = input.ticker ?? settlementTickerFromEnv(process.env);
  const total = safeMicro(input.budgetTUSD);
  const mode = input.walletMode ?? walletModeFromEnv();
  const label = (p: string) => input.payeeLabels?.[p] ?? input.catalog?.find((a) => a.id === p)?.name ?? (p.startsWith("addr_test1") ? `${p.slice(0, 14)}…` : p);
  const price = (p: string) => input.catalog?.find((a) => a.id === p)?.priceTUSD;

  const sessions: PlanRationaleSession[] = plan.sessions.map((s, i) => {
    const budget = safeMicro(s.budgetTUSD);
    const after = [...new Set([...(s.contextFrom ?? []), ...(s.parent !== undefined ? [s.parent] : [])])].filter((d) => d < i).sort((a, b) => a - b).map(LETTER);
    const goal = clip(s.goal.replace(/\s+/g, " "), 90);
    let why: string;
    switch (s.taskType) {
      case "research": {
        const hosts = [...new Set(s.dataScope.map(hostOf))].slice(0, 3);
        why = `Researches "${goal}"${hosts.length ? ` from ${listJoin(hosts)}` : ""}; it has no pay tool.`;
        break;
      }
      case "hire_agent": {
        const agents = s.allowedPayees.map(label);
        const p = s.allowedPayees.map(price).find(Boolean);
        // "Hire the summariser catalog agent to draft X" → "to draft X"; anything else → `for "<goal>"`.
        const g = s.goal.replace(/\s+/g, " ").trim();
        const m = /^(?:hire|use)\s+(?:the\s+|a\s+|an\s+)?[^,.:;]{0,60}?\b(?:agent|service)\s+(to|for)[:\s]+(.+)$/i.exec(g);
        const task = m ? `${m[1].toLowerCase()} ${clip(m[2], 80)}` : `for "${clip(g, 80)}"`;
        why = `Hires ${agents.length ? listJoin(agents) : "a catalog agent"}${p ? ` (${p} ${ticker})` : ""} ${task} — a paid catalog agent whose skills match, instead of researching it.`;
        break;
      }
      case "buy_pay":
        why = `Pays ${s.allowedPayees.length ? listJoin(s.allowedPayees.map(label)) : "the named payee"} for "${clip(goal, 60)}"; every payment must confirm on-chain.`;
        break;
      case "monitor":
        why = `Watches the chain${s.watch && typeof s.watch.kind === "string" ? ` for a ${s.watch.kind}` : ""} until the condition happens or the deadline passes (read-only).`;
        break;
    }
    return {
      index: i,
      letter: LETTER(i),
      name: s.name,
      taskType: s.taskType,
      why,
      runs: after.length ? "after" : "parallel",
      ...(after.length ? { after } : {}),
      budgetTUSD: microToTusd(budget),
      sharePct: total > 0n ? Number((budget * 100n) / total) : 0,
    };
  });

  // Parallel vs dependent.
  const parallel = sessions.filter((s) => s.runs === "parallel");
  const dependent = sessions.filter((s) => s.runs === "after");
  const depWhy = (s: PlanRationaleSession) => {
    const p = plan.sessions[s.index];
    if (p.taskType === "buy_pay" || p.taskType === "hire_agent") return "it pays based on those findings";
    return "it merges those findings";
  };
  let parallelism: string;
  if (sessions.length === 1) parallelism = "One session does the whole job; there is nothing to split.";
  else if (!dependent.length) parallelism = `All ${sessions.length} sessions start at once: the parts are independent, so nothing waits.`;
  else {
    const starts = parallel.length === sessions.length ? "All" : parallel.length === 1 ? `${parallel[0].letter}` : listJoin(parallel.map((s) => s.letter));
    const waits = dependent.map((s) => `${s.letter} waits for ${listJoin(s.after ?? [])}'s handback because ${depWhy(s)}`);
    parallelism = `${starts} ${parallel.length === 1 ? "starts" : "start"} at once; ${waits.join("; ")}.`;
  }

  // Budget split.
  const allocated = plan.sessions.reduce((s, x) => s + safeMicro(x.budgetTUSD), 0n);
  const reserve = total > allocated ? total - allocated : 0n;
  const budget =
    `${microToTusd(allocated)} of ${microToTusd(total)} ${ticker} allocated (${sessions.map((s) => `${s.letter} ${s.budgetTUSD}`).join(", ")})` +
    (reserve > 0n ? `; ${microToTusd(reserve)} ${ticker} stays unallocated in your treasury for a replacement session if one is needed.` : "; the whole budget is allocated.");

  // Guards that apply (facts about how Bulkhead enforces the mandate).
  const guards: string[] = [];
  guards.push(
    mode === "vault"
      ? "Each session gets its own Bulkhead Session Vault (Aiken, Plutus V3): allowed payees, per-payment max and expiry are checked by the validator on-chain, and it only holds that session's budget."
      : "Each session wallet is a native script that stops spending at its expiry; payee and per-payment limits are enforced by the Signer before anything is signed.",
  );
  const askFirst = plan.sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => (s.taskType === "buy_pay" || s.taskType === "hire_agent") && safeMicro(s.approvalThresholdTUSD) < safeMicro(s.perPaymentMaxTUSD));
  const payers = plan.sessions.filter((s) => s.taskType === "buy_pay" || s.taskType === "hire_agent");
  if (askFirst.length)
    guards.push(`Payments above ${askFirst.map(({ s, i }) => `${s.approvalThresholdTUSD} ${ticker} on ${LETTER(i)}`).join(", ")} wait for your approval.`);
  else if (payers.length) guards.push(`In-policy payments run without clicks; anything above a session's per-payment max or outside its payee list is refused.`);
  if (plan.sessions.some((s) => s.taskType === "research"))
    guards.push("Research sessions can only fetch their listed sources (egress allowlist); flagged content quarantines the session until you decide.");
  guards.push("When a session closes, its leftover funds return to your treasury and the close tx records the handback's SHA-256 in CIP-20 (label 674) metadata.");

  const adjustments = (input.planNotes ?? []).map((n) => n.replace(/^session (\d+)/, (_m, d) => `Session ${LETTER(Number(d))}`));
  const modelSummary = typeof input.modelSummary === "string" ? input.modelSummary.replace(/\s+/g, " ").trim() : "";
  const summary = modelSummary
    ? clip(modelSummary, 300)
    : `${sessions.length} session${sessions.length === 1 ? "" : "s"}: ${parallel.length} start${parallel.length === 1 ? "s" : ""} at once${dependent.length ? `, ${dependent.length} wait${dependent.length === 1 ? "s" : ""} for the findings ${dependent.length === 1 ? "it needs" : "they need"}` : ""}. ` +
      `${microToTusd(allocated)} of ${microToTusd(total)} ${ticker} is allocated, each session capped ${mode === "vault" ? "on-chain by its own vault" : "by its own wallet"}.`;

  return { summary, sessions, parallelism, budget, guards, adjustments, source: modelSummary ? "planner" : "deterministic" };
}

/** The rationale stored on a goal, or (for goals planned before rationales existed) one rebuilt from its plan. */
export function rationaleFromPlanJson(planJson: string, budgetMicro: string, walletMode?: WalletMode): PlanRationale | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(planJson || "{}");
  } catch {
    return undefined;
  }
  if (raw.rationale && typeof raw.rationale === "object" && typeof (raw.rationale as PlanRationale).summary === "string") return raw.rationale as PlanRationale;
  if (!Array.isArray(raw.sessions) || !raw.sessions.length) return undefined;
  try {
    return buildPlanRationale({
      plan: { sessions: (raw.sessions as Plan["sessions"]).map((s) => ({ ...s, contextFrom: s.contextFrom ?? [], dataScope: s.dataScope ?? [], allowedPayees: s.allowedPayees ?? [] })) },
      budgetTUSD: microToTusd(BigInt(budgetMicro)),
      walletMode,
      payeeLabels: (raw.payeeLabels as Record<string, string>) ?? {},
      planNotes: Array.isArray(raw.planNotes) ? (raw.planNotes as string[]) : [],
    });
  } catch {
    return undefined;
  }
}

function safeMicro(v: string): bigint {
  try {
    return tusdToMicro(v);
  } catch {
    return 0n;
  }
}
