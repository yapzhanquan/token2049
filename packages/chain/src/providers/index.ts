import type { ChainProvider } from "../types";
import { BlockfrostProvider, NOWNodesProvider } from "./blockfrost";
import { KoiosProvider } from "./koios";
import type { RetryOptions } from "./http";

export { BlockfrostCompatProvider, BlockfrostProvider, NOWNodesProvider } from "./blockfrost";
export { KoiosProvider } from "./koios";
export { fetchWithRetry, HttpError, type RetryOptions } from "./http";

export interface ProviderEnv {
  BLOCKFROST_PREPROD_PROJECT_ID?: string;
  KOIOS_API_TOKEN?: string;
  NOWNODES_API_KEY?: string;
}

/**
 * Preprod provider: Blockfrost when BLOCKFROST_PREPROD_PROJECT_ID is set, else Koios (keyless,
 * KOIOS_API_TOKEN optional). NOWNodes is never returned here: it serves Cardano mainnet only.
 */
export function createProvider(env: ProviderEnv = process.env, retry?: RetryOptions): ChainProvider {
  const bf = env.BLOCKFROST_PREPROD_PROJECT_ID?.trim();
  if (bf) return new BlockfrostProvider(bf, { retry });
  return new KoiosProvider({ token: env.KOIOS_API_TOKEN?.trim() || undefined, retry });
}

/** Mainnet NOWNodes provider for dashboard-only reads (undefined without NOWNODES_API_KEY). */
export function createMainnetProvider(env: ProviderEnv = process.env, retry?: RetryOptions): ChainProvider | undefined {
  const k = env.NOWNODES_API_KEY?.trim();
  return k ? new NOWNodesProvider(k, { retry }) : undefined;
}
