// Where each mock agent's preprod payment address comes from.
// Preferred: @bulkhead/chain's `agentWallet(i)` (derived from MASTER_SECRET by the chain package).
// Fallback: MARKET_AGENT_ADDRESS_0..2 env vars.
// The market only ever needs the ADDRESS — it never holds or sees agent keys.

export interface AgentWalletSource {
  readonly name: string;
  /** Payment address of agent wallet i, or null if unknown. */
  address(index: number): Promise<string | null>;
}

/** Preprod only: refuse anything that is not a testnet address. */
export function assertPreprodAddress(addr: string): string {
  if (!/^addr_test1[0-9a-z]+$/.test(addr)) throw new Error(`Refusing non-preprod agent address: ${addr.slice(0, 12)}…`);
  return addr;
}

export class EnvAgentWalletSource implements AgentWalletSource {
  readonly name = "env:MARKET_AGENT_ADDRESS_i";
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async address(index: number): Promise<string | null> {
    const v = this.env[`MARKET_AGENT_ADDRESS_${index}`]?.trim();
    return v ? assertPreprodAddress(v) : null;
  }
}

export class StaticAgentWalletSource implements AgentWalletSource {
  readonly name = "static";
  constructor(private addrs: string[]) {}
  async address(index: number): Promise<string | null> {
    return this.addrs[index] ?? null;
  }
}

type AgentWalletFn = (i: number) => unknown;

/** Wraps @bulkhead/chain's agentWallet(i) (sync or async; returns an address string or { address }). */
export class ChainAgentWalletSource implements AgentWalletSource {
  readonly name = "@bulkhead/chain agentWallet(i)";
  constructor(private fn: AgentWalletFn) {}
  async address(index: number): Promise<string | null> {
    const r = await this.fn(index);
    const addr = typeof r === "string" ? r : r && typeof r === "object" && "address" in r ? String((r as { address: unknown }).address) : null;
    return addr ? assertPreprodAddress(addr) : null;
  }
}

/** Tries each source in order; first non-null address wins. */
export class FallbackAgentWalletSource implements AgentWalletSource {
  constructor(private sources: AgentWalletSource[]) {}
  get name() {
    return this.sources.map((s) => s.name).join(" → ");
  }
  async address(index: number): Promise<string | null> {
    for (const s of this.sources) {
      try {
        const a = await s.address(index);
        if (a) return a;
      } catch (e) {
        console.warn(`[market] agent wallet source ${s.name} failed for #${index}: ${(e as Error).message}`);
      }
    }
    return null;
  }
}

/** Default wiring: chain helper if the chain package exports it, then env vars. */
export async function defaultAgentWalletSource(): Promise<AgentWalletSource> {
  const sources: AgentWalletSource[] = [];
  try {
    const chain = (await import("@bulkhead/chain")) as Record<string, unknown>;
    if (typeof chain.agentWallet === "function") sources.push(new ChainAgentWalletSource(chain.agentWallet as AgentWalletFn));
  } catch (e) {
    console.warn(`[market] could not load @bulkhead/chain: ${(e as Error).message}`);
  }
  sources.push(new EnvAgentWalletSource());
  return new FallbackAgentWalletSource(sources);
}
