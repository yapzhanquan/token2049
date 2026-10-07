// Environment → worker configuration. Secrets are only checked for presence, never printed.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tusdToMicro } from "@bulkhead/shared";
import type { MpsGateConfig } from "./payment-gate";
import type { RunnerConfig } from "./task-runner";
import { ENGINE_USER_EMAIL } from "./worker";

export const PACKAGE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface WorkerConfig {
  coworkerId: string;
  organizationId?: string;
  engineUrl: string;
  engineToken: string;
  engineUserEmail: string;
  stateDir: string;
  pollIntervalMs: number;
  runner: RunnerConfig;
  gate: MpsGateConfig;
  blockfrostProjectId?: string;
}

const num = (env: NodeJS.ProcessEnv, name: string, dflt: number, min = 0) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min}`);
  return n;
};
const tusd = (env: NodeJS.ProcessEnv, name: string, dflt: string) => tusdToMicro((env[name] || dflt).trim());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const coworkerId = (env.SOKOSUMI_COWORKER_ID || env.COWORKER_ID || "").trim();
  if (!coworkerId) throw new Error("SOKOSUMI_COWORKER_ID is required (the registered Coworker id)");
  const engineToken = env.ENGINE_TOKEN ?? "";
  if (!engineToken) throw new Error("ENGINE_TOKEN is required (bulkhead/.env)");
  const stateDir = resolve(env.SOKOSUMI_WORKER_STATE_DIR || join(PACKAGE_DIR, ".local"));
  const sellerAddress = env.MASUMI_SELLER_ADDRESS?.trim();
  if (sellerAddress && !sellerAddress.startsWith("addr_test1")) throw new Error("MASUMI_SELLER_ADDRESS must be a preprod addr_test1 address (preprod only)");
  const feeMicro = tusd(env, "BULKHEAD_FEE_TUSDM", "0.5");
  const maxQuoteMicro = tusd(env, "MAX_QUOTE_TUSDM", "20");
  if (maxQuoteMicro <= feeMicro) throw new Error("MAX_QUOTE_TUSDM must exceed BULKHEAD_FEE_TUSDM");
  const idx = env.MASUMI_PAYMENT_SOURCE_INDEX;
  return {
    coworkerId,
    organizationId: env.SOKOSUMI_ORGANIZATION_ID?.trim() || undefined,
    engineUrl: env.ENGINE_URL || "http://localhost:4000",
    engineToken,
    engineUserEmail: env.SOKOSUMI_ENGINE_USER_EMAIL || ENGINE_USER_EMAIL,
    stateDir,
    pollIntervalMs: num(env, "POLL_INTERVAL_MS", 5000, 1000),
    runner: {
      quote: {
        feeMicro,
        maxQuoteMicro,
        defaultBudgetMicro: tusd(env, "DEFAULT_CREW_BUDGET_TUSDM", "2"),
        defaultDeadlineMs: num(env, "DEFAULT_DEADLINE_MINUTES", 120, 1) * 60_000,
        minDeadlineMs: num(env, "MIN_DEADLINE_MINUTES", 15, 1) * 60_000,
        maxDeadlineMs: num(env, "MAX_DEADLINE_HOURS", 168, 1) * 3_600_000,
      },
      goalRules: env.SOKOSUMI_GOAL_RULES || "Deliver a concise, sourced result. Spend only what the goal needs.",
      payByMs: num(env, "PAY_BY_MINUTES", 5, 1) * 60_000,
      resultMarginMs: num(env, "RESULT_MARGIN_MINUTES", 20, 1) * 60_000,
      askTimeoutMs: num(env, "DECISION_ASK_TIMEOUT_MINUTES", 10, 1) * 60_000,
      commentWindowMs: num(env, "COMMENT_WINDOW_HOURS", 72, 0) * 3_600_000,
    },
    gate: {
      enabled: env.PAID_TASKS_ENABLED === "true",
      mpsUrl: env.MPS_URL || undefined,
      runtimeEnvPath: resolve(env.MPS_RUNTIME_ENV_PATH || join(stateDir, "mps-runtime.env")),
      registrationConfirmed: env.MASUMI_REGISTRATION_CONFIRMED === "true",
      seller: {
        agentIdentifier: env.MASUMI_AGENT_IDENTIFIER?.trim() || undefined,
        supportedPaymentSourceIndex: idx !== undefined && idx !== "" ? Number(idx) : undefined,
        sellerWalletId: env.MASUMI_SELLER_WALLET_ID?.trim() || undefined,
        sellerAddress,
      },
    },
    blockfrostProjectId: env.BLOCKFROST_PREPROD_PROJECT_ID || env.BLOCKFROST_API_KEY_PREPROD || undefined,
  };
}
