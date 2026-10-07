// Treasury staking + vote delegation DTOs (engine ⇄ web). Routes are scoped to the acting user (x-user-id).
import { z } from "zod";

export const STAKING_ROUTES = {
  status: "GET /staking",
  setup: "POST /staking/setup", // StakingSetupBody → StakingActionResponse | NeedsSignatureResponse
  stop: "POST /staking/stop", // StakingStopBody → StakingActionResponse | NeedsSignatureResponse
} as const;

/** "always_abstain" | "always_no_confidence" | a bech32 drep1… id. */
export type DRepLabel = string;

export const DREP_ID_RE = /^drep(_script)?1[02-9ac-hj-np-z]{20,}$/;
export const POOL_ID_RE = /^(pool1[02-9ac-hj-np-z]{50,60}|[0-9a-fA-F]{56})$/;

export const StakingSetupBodySchema = z.object({
  /** Optional pool (bech32 pool1… or hex); default STAKE_POOL_ID or an active preprod pool. */
  poolId: z.string().trim().regex(POOL_ID_RE, "pool id must be pool1… or 56 hex chars").optional(),
  /** Optional DRep id; default DREP_ID or always_abstain. */
  drepId: z
    .string()
    .trim()
    .refine((s) => s === "" || s === "always_abstain" || s === "always_no_confidence" || DREP_ID_RE.test(s), "DRep must be drep1… or always_abstain")
    .optional(),
  /** Self-custody second POST (after the wallet signed). */
  pendingId: z.string().optional(),
  signedTx: z.string().optional(),
});
export type StakingSetupBody = z.infer<typeof StakingSetupBodySchema>;

export const StakingStopBodySchema = z.object({
  confirm: z.literal(true, { message: "confirm: true is required to stop staking" }),
  pendingId: z.string().optional(),
  signedTx: z.string().optional(),
});
export type StakingStopBody = z.infer<typeof StakingStopBodySchema>;

export interface StakingTxRef {
  kind: "setup" | "stop" | "withdraw";
  txHash: string;
  at: number;
  /** e.g. ["stake_registration","stake_delegation","vote_delegation"]. */
  certs: string[];
  feeLovelace: string;
  /** + paid / − refunded deposit. */
  depositDeltaLovelace: string;
  confirmed?: boolean;
}

/** GET /staking */
export interface StakingStatusDTO {
  available: boolean;
  /** Why staking is unavailable (fixture/fake chain, no stake credential…). */
  reason?: string;
  custody: "custodial" | "self";
  stakeAddress: string | null;
  registered: boolean;
  poolId: string | null;
  poolTicker: string | null;
  /** "always_abstain" | "always_no_confidence" | drep1… | null. */
  drep: DRepLabel | null;
  /** Stake key deposit paid (lovelace, from live protocol params at registration). */
  depositLovelace: string | null;
  rewardsLovelace: string;
  /** Live from the provider (false = from the last stored record only). */
  live: boolean;
  /** A setup/stop tx is submitted but not yet visible on the provider. */
  pending: boolean;
  txs: StakingTxRef[];
  /** Default pool the setup would use (env STAKE_POOL_ID or the picked one), when known. */
  defaultPoolId?: string | null;
  updatedAt: number | null;
}

export interface StakingActionResponse {
  ok: true;
  tx: StakingTxRef;
  status: StakingStatusDTO;
}

/** "Voting power delegated: …" text. */
export function drepDisplay(d: DRepLabel | null | undefined): string {
  if (!d) return "not delegated";
  if (d === "always_abstain") return "Always abstain";
  if (d === "always_no_confidence") return "Always no confidence";
  return d.length > 24 ? `${d.slice(0, 14)}…${d.slice(-6)}` : d;
}
