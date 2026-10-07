// ADA Handle payees ("$name" → current holder address), preprod only.
//
// A handle is a native-asset NFT under the Handle policy. Current handles are CIP-68 user NFTs (label 222):
// asset name = 000de140 ‖ utf8(name). Older handles are plain CIP-25 tokens: asset name = utf8(name).
// Resolution is ON-CHAIN: the holder is whoever's address holds that token now (Blockfrost
// GET /assets/{unit}/addresses, or Koios GET /asset_addresses when no Blockfrost key). The public Handle API
// (preprod.api.handle.me/handles/<name>) is only a fallback when no on-chain source answers, or an optional
// cross-check. Holder changes over time, so callers store { handle, address, resolvedAt } and pin the address.
import type { HandleResolution, HandleResolver } from "./types";
import { fetchWithRetry, HttpError, type RetryOptions } from "./providers/http";

/** Handle minting policy on preprod (same id on mainnet, but Bulkhead refuses mainnet). */
export const HANDLE_POLICY_PREPROD = "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a";
/** CIP-67 label 222 (CIP-68 user NFT) prefix. */
export const CIP68_USER_PREFIX = "000de140";
export const HANDLE_API_PREPROD = "https://preprod.api.handle.me";
export const BLOCKFROST_PREPROD_URL = "https://cardano-preprod.blockfrost.io/api/v0";
export const KOIOS_PREPROD_URL = "https://preprod.koios.rest/api/v1";

export type HandleErrorCode = "invalid" | "not_found" | "ambiguous" | "unavailable" | "wrong_network";

export class HandleError extends Error {
  constructor(
    readonly code: HandleErrorCode,
    readonly handle: string,
    message: string,
  ) {
    super(message);
    this.name = "HandleError";
  }
}

// Handle names: a-z 0-9 - _ . (1..15). Sub-handles "sub@root" are NFTs too. Asset names are ≤ 32 bytes,
// and the CIP-68 prefix takes 4 of them.
const NAME_RE = /^[a-z0-9_.-]{1,15}(@[a-z0-9_.-]{1,15})?$/;

/** True when a payee string is written as an ADA Handle ("$name"). */
export const isHandlePayee = (s: string): boolean => typeof s === "string" && s.trim().startsWith("$");

/** "$Test " → "test"; null when it is not a syntactically valid handle. */
export function parseHandle(input: string): string | null {
  const t = String(input ?? "").trim();
  if (!t.startsWith("$")) return null;
  const name = t.slice(1).toLowerCase();
  if (!NAME_RE.test(name) || Buffer.byteLength(name, "utf8") > 28) return null;
  return name;
}

export function handleUnits(name: string, policyId = HANDLE_POLICY_PREPROD): { cip68: string; legacy: string } {
  const hex = Buffer.from(name, "utf8").toString("hex");
  return { cip68: policyId + CIP68_USER_PREFIX + hex, legacy: policyId + hex };
}

export interface HandleResolverOptions {
  network?: "preprod" | "mainnet";
  blockfrostProjectId?: string;
  blockfrostUrl?: string;
  /** Used for on-chain lookups when no Blockfrost key is set (Koios is keyless). Set to "" to disable. */
  koiosUrl?: string;
  koiosToken?: string;
  /** Public Handle API (fallback / cross-check). Set to "" to disable. */
  handleApiUrl?: string;
  policyId?: string;
  /** Cache successful resolutions this long (default 60 s). */
  cacheMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

type Holders = { source: "blockfrost" | "koios"; cip68: string[]; legacy: string[] };

export function createHandleResolver(opts: HandleResolverOptions = {}): HandleResolver {
  const now = opts.now ?? Date.now;
  const policyId = opts.policyId ?? HANDLE_POLICY_PREPROD;
  const bfKey = opts.blockfrostProjectId?.trim();
  const bfUrl = (opts.blockfrostUrl ?? BLOCKFROST_PREPROD_URL).replace(/\/+$/, "");
  const koiosUrl = (opts.koiosUrl ?? KOIOS_PREPROD_URL).replace(/\/+$/, "");
  const apiUrl = (opts.handleApiUrl ?? HANDLE_API_PREPROD).replace(/\/+$/, "");
  const retry: RetryOptions = { retries: 2, timeoutMs: 15_000, ...opts.retry, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
  const cacheMs = opts.cacheMs ?? 60_000;
  const cache = new Map<string, HandleResolution>();

  async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json", ...headers } }, retry);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  /** Addresses currently holding `unit` with quantity > 0 (deduplicated). */
  async function bfHolders(unit: string): Promise<string[]> {
    const rows = await getJson<Array<{ address: string; quantity: string }>>(`${bfUrl}/assets/${unit}/addresses?count=100`, { project_id: bfKey! });
    return [...new Set((rows ?? []).filter((r) => BigInt(r.quantity || "0") > 0n).map((r) => r.address))];
  }
  async function koiosHolders(unit: string): Promise<string[]> {
    const name = unit.slice(56);
    const rows = await getJson<Array<{ payment_address: string; quantity: string }>>(
      `${koiosUrl}/asset_addresses?_asset_policy=${policyId}&_asset_name=${name}`,
      opts.koiosToken ? { Authorization: `Bearer ${opts.koiosToken}` } : {},
    );
    return [...new Set((rows ?? []).filter((r) => BigInt(r.quantity || "0") > 0n).map((r) => r.payment_address))];
  }

  async function onChain(name: string): Promise<Holders | null> {
    const u = handleUnits(name, policyId);
    if (bfKey) return { source: "blockfrost", cip68: await bfHolders(u.cip68), legacy: await bfHolders(u.legacy) };
    if (koiosUrl) return { source: "koios", cip68: await koiosHolders(u.cip68), legacy: await koiosHolders(u.legacy) };
    return null;
  }

  async function handleApi(name: string): Promise<{ address: string; hex: string } | null | "unavailable"> {
    if (!apiUrl) return "unavailable";
    try {
      const j = await getJson<{ hex?: string; holder?: string; resolved_addresses?: { ada?: string } }>(`${apiUrl}/handles/${encodeURIComponent(name)}`);
      if (!j) return null;
      const address = j.resolved_addresses?.ada ?? j.holder;
      return address ? { address, hex: j.hex ?? "" } : null;
    } catch {
      return "unavailable";
    }
  }

  function checkNetwork(handle: string, address: string): void {
    if (!/^addr_test1[0-9a-z]+$/.test(address)) {
      throw new HandleError("wrong_network", handle, `ADA Handle ${handle} resolves to ${address.slice(0, 12)}…, which is not a preprod (addr_test1) address`);
    }
  }

  return {
    async resolve(input, ropts = {}) {
      const raw = String(input ?? "").trim();
      if (opts.network === "mainnet") throw new HandleError("wrong_network", raw, "ADA Handle payees are supported on preprod only");
      const name = parseHandle(raw);
      if (!name) {
        throw new HandleError("invalid", raw, `"${raw}" is not a valid ADA Handle (expected $name: 1-15 of a-z 0-9 - _ .)`);
      }
      const handle = `$${name}`;
      const hit = cache.get(name);
      if (hit && now() - hit.resolvedAt < cacheMs && !ropts.crossCheck) return hit;
      const units = handleUnits(name, policyId);

      let holders: Holders | null = null;
      let onChainError: string | null = null;
      try {
        holders = await onChain(name);
      } catch (e) {
        onChainError = e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message;
      }

      let res: HandleResolution;
      if (holders) {
        const { cip68, legacy } = holders;
        if (cip68.length > 1) {
          throw new HandleError("ambiguous", handle, `ADA Handle ${handle} is held by ${cip68.length} addresses on preprod; refusing an ambiguous payee`);
        }
        if (legacy.length > 1) {
          throw new HandleError("ambiguous", handle, `legacy ADA Handle ${handle} is held by ${legacy.length} addresses on preprod; refusing an ambiguous payee`);
        }
        if (cip68.length === 1 && legacy.length === 1 && cip68[0] !== legacy[0]) {
          throw new HandleError(
            "ambiguous",
            handle,
            `ADA Handle ${handle} exists both as a CIP-68 token and a legacy CIP-25 token, held by different addresses; refusing an ambiguous payee`,
          );
        }
        const address = cip68[0] ?? legacy[0];
        if (!address) throw new HandleError("not_found", handle, `ADA Handle ${handle} was not found on preprod (no holder of ${handle} under the Handle policy)`);
        checkNetwork(handle, address);
        const standard = cip68[0] ? "cip68" : "cip25";
        res = { handle, address, resolvedAt: now(), unit: standard === "cip68" ? units.cip68 : units.legacy, standard, source: holders.source };
        if (ropts.crossCheck) {
          const api = await handleApi(name);
          res.crossCheck = api === "unavailable" || api === null ? "unavailable" : api.address === address ? "match" : "mismatch";
        }
      } else {
        // No on-chain source answered: fall back to the public Handle API.
        const api = await handleApi(name);
        if (api === null) throw new HandleError("not_found", handle, `ADA Handle ${handle} was not found on preprod`);
        if (api === "unavailable") {
          throw new HandleError("unavailable", handle, `cannot resolve ADA Handle ${handle} right now (${onChainError ?? "no chain data source"}; Handle API unavailable)`);
        }
        checkNetwork(handle, api.address);
        const standard = api.hex.startsWith(CIP68_USER_PREFIX) ? "cip68" : "cip25";
        res = { handle, address: api.address, resolvedAt: now(), unit: standard === "cip68" ? units.cip68 : units.legacy, standard, source: "handle-api" };
      }
      cache.set(name, res);
      return res;
    },
  };
}

/** Resolver from the chain env (Blockfrost when BLOCKFROST_PREPROD_PROJECT_ID is set, else Koios). */
export function handleResolverFromEnv(env: { BLOCKFROST_PREPROD_PROJECT_ID?: string; KOIOS_API_TOKEN?: string } = process.env): HandleResolver {
  return createHandleResolver({ blockfrostProjectId: env.BLOCKFROST_PREPROD_PROJECT_ID, koiosToken: env.KOIOS_API_TOKEN?.trim() || undefined });
}
