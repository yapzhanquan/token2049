// Staking routes (Hono sub-router), mounted by createApi after its auth middleware, so `userId` is the
// acting user (x-user-id) and every route is scoped to that user's treasury.
//   GET  /staking                         → StakingStatusDTO
//   POST /staking/setup {poolId?, drepId?} → StakingActionResponse | NeedsSignatureResponse (self-custody)
//   POST /staking/stop  {confirm: true}    → StakingActionResponse | NeedsSignatureResponse (self-custody)
// Self-custody: the first POST answers needsSignature; the browser signs (CIP-30, partialSign) and POSTs the
// same route again with { pendingId, signedTx } (same contract as the other signable routes).
import { Hono, type Context } from "hono";
import {
  StakingSetupBodySchema,
  StakingStopBodySchema,
  type NeedsSignatureResponse,
  type PendingSignatureDTO,
  type StakingActionResponse,
} from "@bulkhead/shared";
import type { DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import type { SigningBroker } from "./self-custody";
import { EngineStaking } from "./staking";
import { toJsonSafe } from "./captain/tools";

type Vars = { Variables: { userId: string } };

export interface StakingApiDeps {
  db: DB;
  chain: Chain;
  signing?: SigningBroker;
  env?: NodeJS.ProcessEnv;
  /** Inject (tests). */
  staking?: EngineStaking;
}

const needsSig = (p: PendingSignatureDTO): NeedsSignatureResponse => ({
  ok: false,
  needsSignature: true,
  pendingId: p.pendingId,
  unsignedTx: p.unsignedTx,
  txHash: p.txHash,
  purpose: p.purpose,
  feeLovelace: p.feeLovelace,
  expiresAt: p.expiresAt,
});

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function createStakingRoutes(deps: StakingApiDeps) {
  const staking = deps.staking ?? new EngineStaking({ db: deps.db, chain: deps.chain, signing: deps.signing, env: deps.env, log: (m) => console.log(m) });
  const { signing } = deps;
  const app = new Hono<Vars>();
  const json = (c: Context, v: unknown, status = 200) => c.json(toJsonSafe(v) as object, status as 200);
  app.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 400) as 400));
  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw httpError(400, r.error.issues.map((i) => i.message).join("; "));
    return r.data;
  };

  /** Custodial: run + answer. Self-custody: answer needsSignature first; the second POST completes it. */
  const signable = async (c: Context<Vars>, b: { pendingId?: string; signedTx?: string }, purpose: string, action: () => Promise<StakingActionResponse>) => {
    const userId = c.get("userId");
    if (b.pendingId && b.signedTx) {
      if (!signing) throw httpError(400, "self-custody signing is not available");
      const { continuation } = await signing.complete(userId, b.pendingId, b.signedTx);
      return json(c, continuation ? await continuation : { ok: true, status: await staking.status(userId) });
    }
    if (!signing || !signing.selfWallet(userId)) return json(c, await action());
    const existing = signing.find(userId, (p) => p.purpose.startsWith(purpose));
    if (existing) return json(c, needsSig(existing));
    const r = await signing.run(userId, { purpose: undefined }, action);
    return json(c, r.kind === "done" ? r.value : needsSig(r.pending));
  };

  app.get("/staking", async (c) => json(c, await staking.status(c.get("userId"))));

  app.post("/staking/setup", async (c) => {
    const b = parse(StakingSetupBodySchema, await readBody(c));
    return signable(c, b, "Stake your wallet", () => staking.setup(c.get("userId"), { poolId: b.poolId, drepId: b.drepId }));
  });

  app.post("/staking/stop", async (c) => {
    const raw = await readBody(c);
    const b = parse(StakingStopBodySchema, raw.pendingId && raw.signedTx ? { confirm: true, ...raw } : raw);
    return signable(c, b, "Stop staking", () => staking.stop(c.get("userId")));
  });

  return app;
}
