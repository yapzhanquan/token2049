// Trust receipts (Hono sub-router), mounted by createApi after its auth middleware (userId = acting user).
//   GET /goals/:id/proof     → GoalProofDTO
//   GET /sessions/:id/proof  → SessionProofDTO
// Everything an independent verifier needs to check a session's money trail on-chain: the mandate, the exact
// Session Vault parameters (typed + as Plutus JSON), the applied script hash + vault address the engine recorded,
// the pinned unapplied validator hash, funding / payment / close txs, and the exact handback text whose
// sha256 the close tx anchors in CIP-20 (674) metadata. The engine only REPORTS: apps/web/lib/verify-proof.ts
// recomputes the script hash/address from the params + its own blueprint copy and reads the chain directly.
import { Hono, type Context } from "hono";
import { and, asc, eq, inArray } from "drizzle-orm";
import { events, goals, payments, sessions as sessionsT, users, type DB } from "@bulkhead/db";
import { UNAPPLIED_VAULT_HASH, VAULT_BLUEPRINT, VAULT_SCRIPT_VERSION, vaultParamsFromJson, vaultParamsToPlutusJson } from "@bulkhead/chain";
import {
  EMPTY_SHA256,
  HANDBACK_HASH_RULE,
  PROOF_VERSION,
  VERIFY_CLAIMS,
  type GoalProofDTO,
  type ProofClaimDTO,
  type ProofCloseKind,
  type ProofFundingDTO,
  type ProofFundingKind,
  type ProofPaymentDTO,
  type ProofRotationDTO,
  type SessionProofDTO,
  type SessionStatus,
  type VaultParamsDTO,
  type VerifyClaimId,
  type WalletMode,
} from "@bulkhead/shared";
import { parseVaultParams } from "./vault";

type Vars = { Variables: { userId: string } };
type SessionDbRow = typeof sessionsT.$inferSelect;

export interface ProofApiDeps {
  db: DB;
  /** Settlement asset unit for native-script sessions (vault sessions carry it in their params). */
  assetUnit?: () => string | null;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const PAID = new Set(["submitted", "confirmed"]);

function fundingKind(phase: string): ProofFundingKind | null {
  if (phase === "submitted") return "initial";
  if (phase === "raise_submitted") return "raise";
  if (phase === "rotate_submitted") return "rotate";
  if (phase === "extend_submitted") return "extend";
  return null;
}

/** Build the proof of one session from the DB (no chain access). Exported for tests and the live verify script. */
export function buildSessionProof(db: DB, r: SessionDbRow, deps: Pick<ProofApiDeps, "assetUnit"> = {}): SessionProofDTO {
  const evs = db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, r.id), inArray(events.type, ["session_funded", "close_submitted", "close_confirmed"])))
    .orderBy(asc(events.id))
    .all()
    .map((e) => ({ type: e.type, data: JSON.parse(e.dataJson) as Record<string, unknown> }));

  // ── fundings (event log; the session row keeps only the first funding tx) ──
  const fundings: ProofFundingDTO[] = [];
  const rotations: ProofRotationDTO[] = [];
  let lastRevoke: string | null = null;
  for (const e of evs) {
    if (e.type !== "session_funded") continue;
    const phase = String(e.data.phase ?? "");
    const txHash = str(e.data.txHash);
    if (phase === "rotate_revoked") {
      lastRevoke = txHash;
      continue;
    }
    const kind = fundingKind(phase);
    if (!kind || !txHash || fundings.some((f) => f.txHash === txHash && f.kind === kind)) continue;
    const amount = kind === "initial" ? str(e.data.budgetMicro) : kind === "raise" ? str(e.data.addMicro) : null;
    fundings.push({ kind, txHash, address: str(e.data.newAddress) ?? str(e.data.address) ?? (kind === "initial" ? r.address : null), amountMicro: amount });
    if (kind === "rotate" || kind === "extend") {
      // Native extend sweeps old → new directly (txHash = the sweep); vault rotation = Revoke then a treasury funding tx.
      rotations.push({ phase, revokeTx: r.walletMode === "vault" ? lastRevoke : txHash, fundTx: r.walletMode === "vault" ? txHash : null, oldAddress: str(e.data.oldAddress), newAddress: str(e.data.newAddress) });
      lastRevoke = null;
    }
  }
  if (r.fundingTx && !fundings.some((f) => f.txHash === r.fundingTx)) {
    fundings.unshift({ kind: "initial", txHash: r.fundingTx, address: rotations[0]?.oldAddress ?? r.address, amountMicro: null });
  }

  // ── payments that left the session wallet ──
  const pays: ProofPaymentDTO[] = db
    .select()
    .from(payments)
    .where(eq(payments.sessionId, r.id))
    .orderBy(asc(payments.createdAt))
    .all()
    .filter((p) => p.txHash && PAID.has(p.status))
    .map((p) => ({ paymentId: p.id, txHash: p.txHash!, payee: p.payee, amountMicro: p.amountMicro, status: p.status, memo: p.memo }));

  // ── mandate + vault ──
  const walletMode = r.walletMode as WalletMode;
  const owner = db.select({ treasury: users.treasuryAddress }).from(users).where(eq(users.id, r.userId)).get()?.treasury ?? "";
  const vp = walletMode === "vault" ? parseVaultParams(r.scriptJson) : null;
  let vault: SessionProofDTO["vault"] = null;
  if (vp && r.scriptHash && r.address) {
    const params: VaultParamsDTO = {
      ownerAddress: vp.ownerAddress,
      captainKeyHash: vp.captainKeyHash,
      sessionKeyHash: vp.sessionKeyHash,
      expiryMs: vp.expiryMs,
      payees: [...vp.payees],
      perTxMaxTusdMicro: vp.perTxMaxTusdMicro.toString(),
      adaAllowanceLovelace: vp.adaAllowanceLovelace.toString(),
      tusdPolicyId: vp.tusdPolicyId,
      tusdAssetNameHex: vp.tusdAssetNameHex,
    };
    let plutusParams: unknown[] = [];
    try {
      plutusParams = vaultParamsToPlutusJson(vaultParamsFromJson(r.scriptJson!)).map((p) => JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v))));
    } catch {
      plutusParams = []; // params that do not encode (e.g. the offline FakeChain's fake addresses)
    }
    vault = {
      scriptVersion: VAULT_SCRIPT_VERSION,
      plutusVersion: "V3",
      validatorTitle: VAULT_BLUEPRINT.title,
      unappliedValidatorHash: UNAPPLIED_VAULT_HASH,
      params,
      plutusParams,
      appliedScriptHash: r.scriptHash,
      address: r.address,
    };
  }
  let nativeScript: unknown = null;
  if (walletMode === "native" && r.scriptJson) {
    try {
      nativeScript = JSON.parse(r.scriptJson);
    } catch {
      nativeScript = null;
    }
  }
  const payees = vp ? [...vp.payees] : ((): string[] => {
    try {
      return (JSON.parse(r.allowedPayeesJson) as { address?: string }[]).map((p) => p.address ?? "").filter(Boolean);
    } catch {
      return [];
    }
  })();
  const assetUnit = vp ? vp.tusdPolicyId + vp.tusdAssetNameHex : (deps.assetUnit?.() ?? "");
  const mandate: SessionProofDTO["mandate"] = {
    ownerAddress: vp?.ownerAddress ?? owner,
    captainKeyHash: vp?.captainKeyHash ?? null,
    sessionKeyHash: vp?.sessionKeyHash ?? r.sessionKeyHash ?? null,
    expiresAt: vp?.expiryMs ?? r.expiresAt,
    payees,
    perTxMaxMicro: vp ? vp.perTxMaxTusdMicro.toString() : r.perPaymentMaxMicro,
    adaAllowanceLovelace: vp ? vp.adaAllowanceLovelace.toString() : null,
    assetUnit,
    budgetMicro: r.budgetMicro,
  };

  // ── close ──
  const closeEv = [...evs].reverse().find((e) => e.type === "close_submitted" && str(e.data.txHash) === r.closeTx);
  const closeKind: ProofCloseKind = walletMode === "vault" ? "revoke" : "sweep";
  const close: SessionProofDTO["close"] = r.closeTx
    ? {
        txHash: r.closeTx,
        kind: closeKind,
        status: r.closeStatus ?? (closeEv ? str(closeEv.data.status) : null),
        toAddress: vp?.ownerAddress ?? owner,
        refundMicro: r.refundMicro,
        metadata674: { session_id: r.id, handback_sha256: r.handbackSha256, log_sha256: r.logSha256, goal_id: r.goalId },
      }
    : null;

  const claimIds: VerifyClaimId[] = ["contract", "vault_address", "funding", "payments", "history", "close", "handback"];
  const claims: ProofClaimDTO[] = claimIds.map((id) => ({ id, statement: VERIFY_CLAIMS[id] }));

  return {
    version: PROOF_VERSION,
    network: "preprod",
    sessionId: r.id,
    goalId: r.goalId,
    letter: r.letter,
    role: r.role,
    name: r.name,
    status: r.status as SessionStatus,
    walletMode,
    mandate,
    vault,
    native: walletMode === "native" ? { script: nativeScript, scriptHash: r.scriptHash, address: r.address } : null,
    fundings,
    payments: pays,
    rotations,
    close,
    handback: { text: r.handbackJson ?? null, sha256: r.handbackSha256 ?? (r.closeTx ? EMPTY_SHA256 : null), rule: HANDBACK_HASH_RULE },
    spentMicro: r.spentMicro,
    claims,
  };
}

export function buildGoalProof(db: DB, goalId: string, deps: Pick<ProofApiDeps, "assetUnit"> = {}, now = Date.now()): GoalProofDTO | null {
  const g = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!g) return null;
  const rows = db.select().from(sessionsT).where(eq(sessionsT.goalId, goalId)).all();
  rows.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : a.createdAt - b.createdAt));
  return {
    version: PROOF_VERSION,
    network: "preprod",
    goalId: g.id,
    goal: g.goal,
    status: g.status,
    fundingTx: g.fundingTx,
    sessions: rows.map((r) => buildSessionProof(db, r, deps)),
    generatedAt: now,
  };
}

export function createProofRoutes(deps: ProofApiDeps) {
  const { db } = deps;
  const app = new Hono<Vars>();

  app.get("/goals/:id/proof", (c: Context<Vars>) => {
    const g = db.select({ userId: goals.userId }).from(goals).where(eq(goals.id, c.req.param("id") ?? "")).get();
    if (!g || g.userId !== c.get("userId")) throw httpError(404, "goal not found");
    return c.json(buildGoalProof(db, c.req.param("id")!, deps)!);
  });

  app.get("/sessions/:id/proof", (c: Context<Vars>) => {
    const r = db.select().from(sessionsT).where(eq(sessionsT.id, c.req.param("id") ?? "")).get();
    if (!r || r.userId !== c.get("userId")) throw httpError(404, "session not found");
    return c.json(buildSessionProof(db, r, deps));
  });

  return app;
}
