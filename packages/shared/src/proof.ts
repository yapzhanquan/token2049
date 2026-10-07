// Trust receipts: everything needed to verify a session's money trail ON-CHAIN without trusting the engine.
//
//   GET /goals/:id/proof     → GoalProofDTO   (every session of the goal)
//   GET /sessions/:id/proof  → SessionProofDTO
//
// The engine only REPORTS here; an independent verifier (apps/web/lib/verify-proof.ts, runs in the browser)
// recomputes the applied Session Vault script hash + address from `vault.params` and the bundled blueprint
// (contracts/plutus.json), then reads Blockfrost directly and checks every claim in VERIFY_CLAIMS.
// Pure TypeScript (no Node / Cardano imports): usable by the engine, the web app and its tests.
//
// Units: amounts are decimal strings (micro settlement-asset units / lovelace); times are POSIX ms.
import type { SessionStatus, WalletMode } from "./index";

export const PROOF_VERSION = 1 as const;

/** How the handback hash anchored in the close tx (CIP-20 label 674, key `handback_sha256`) is computed:
 * lowercase hex SHA-256 of the exact UTF-8 bytes of `handback.text` (raw text, no nonce, no JSON re-encoding —
 * the MIP-004 raw-UTF-8 rule, `taskHashRaw` in @bulkhead/shared/mip004). No handback → SHA-256 of "". */
export const HANDBACK_HASH_RULE = "sha256(utf8(handback.text))" as const;
/** SHA-256 of the empty string: the anchored hash when a session produced no handback. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Session Vault parameters, as stored (sessions.script_json) and applied — bigints as decimal strings.
 * Blueprint order: owner, captain_vkh, session_vkh, expiry, payees, per_tx_max_tusd, ada_allowance, tusd_policy, tusd_name. */
export interface VaultParamsDTO {
  ownerAddress: string;
  captainKeyHash: string;
  sessionKeyHash: string;
  expiryMs: number;
  payees: string[];
  perTxMaxTusdMicro: string;
  adaAllowanceLovelace: string;
  tusdPolicyId: string;
  tusdAssetNameHex: string;
}

/** The mandate the contract enforces (vault) — or the engine enforces (native fallback; payees / caps off-chain). */
export interface ProofMandateDTO {
  /** Vault owner = where Revoke / Recover must send everything (the user's treasury). */
  ownerAddress: string;
  captainKeyHash: string | null;
  sessionKeyHash: string | null;
  expiresAt: number;
  payees: string[];
  perTxMaxMicro: string;
  adaAllowanceLovelace: string | null;
  /** Settlement asset unit (policy id + asset name hex). */
  assetUnit: string;
  budgetMicro: string;
}

export interface ProofVaultDTO {
  /** Session Vault validator version (VAULT_SCRIPT_VERSION) + Plutus language. */
  scriptVersion: string;
  plutusVersion: "V3";
  /** Blueprint validator title (contracts/plutus.json). */
  validatorTitle: string;
  /** Hash of the UNAPPLIED validator (pinned in code + by a test). The verifier recomputes it from its own blueprint copy. */
  unappliedValidatorHash: string;
  /** Typed parameters (exact values applied). */
  params: VaultParamsDTO;
  /** The 9 parameters as Mesh "JSON" Plutus data, in blueprint order (what applyParamsToScript received). */
  plutusParams: unknown[];
  /** Applied script hash + vault address as the engine recorded them (claims; the verifier recomputes both). */
  appliedScriptHash: string;
  address: string;
}

export interface ProofNativeDTO {
  /** Native script JSON (Mesh NativeScript shape). */
  script: unknown;
  scriptHash: string | null;
  address: string | null;
}

export type ProofFundingKind = "initial" | "raise" | "rotate" | "extend";
export interface ProofFundingDTO {
  kind: ProofFundingKind;
  txHash: string;
  /** Destination (the vault / session wallet address at that time). */
  address: string | null;
  /** Settlement-asset micro units this tx put into the session (initial = budget; raise = the addition). Null if unknown. */
  amountMicro: string | null;
}

export interface ProofPaymentDTO {
  paymentId: string;
  txHash: string;
  payee: string;
  amountMicro: string;
  status: string;
  memo: string;
}

export type ProofCloseKind = "revoke" | "recover" | "sweep";

/** Mid-session revoke (vault rotation: extend expiry / widen payees). The old vault's params are not kept. */
export interface ProofRotationDTO {
  revokeTx: string | null;
  fundTx: string | null;
  oldAddress: string | null;
  newAddress: string | null;
  phase: string;
}

export interface ProofCloseDTO {
  txHash: string;
  kind: ProofCloseKind;
  /** Session status that triggered the close (COMPLETED | FAILED | KILLED | EXPIRED | …). */
  status: string | null;
  /** Where the leftovers must go (vault owner / user treasury). */
  toAddress: string;
  /** Settlement-asset micro units returned (engine's record). */
  refundMicro: string | null;
  /** CIP-20 674 fields the close tx carries (expected on-chain). goal_id is present on closes made after the trust-receipt change. */
  metadata674: { session_id: string; handback_sha256: string | null; log_sha256: string | null; goal_id?: string };
}

export interface ProofHandbackDTO {
  /** The exact handback text that was hashed (sessions.handback_json). Null = no handback (hash of ""). */
  text: string | null;
  /** The engine's recorded hash (claim). */
  sha256: string | null;
  rule: typeof HANDBACK_HASH_RULE;
}

export type VerifyClaimId = "contract" | "vault_address" | "funding" | "payments" | "history" | "close" | "handback";

export interface ProofClaimDTO {
  id: VerifyClaimId;
  /** Short human statement of what an independent verifier checks. */
  statement: string;
}

/** What the verifier checks for every session (statement text shown in the UI). */
export const VERIFY_CLAIMS: Record<VerifyClaimId, string> = {
  contract: "The vault runs the pinned Bulkhead Session Vault validator (hash recomputed from the bundled plutus.json).",
  vault_address: "The vault address is derived from exactly these rules (applyParamsToScript → script hash → address).",
  funding: "The funding tx put the budget into that address (and nothing else holds the session's funds).",
  payments: "Every payment spent the vault through the validator, only to an allowed payee, at most perTxMax per tx.",
  history: "Every tx that ever touched the vault address is accounted for (funding, payments, close).",
  close: "The close tx returned all leftovers to the owner / treasury and left the vault empty.",
  handback: "The close tx's CIP-20 (674) metadata anchors sha256 of the handback shown (tamper-evident result).",
};

export interface SessionProofDTO {
  version: typeof PROOF_VERSION;
  network: "preprod";
  sessionId: string;
  goalId: string;
  letter: string;
  role: string;
  name: string;
  status: SessionStatus;
  walletMode: WalletMode;
  mandate: ProofMandateDTO | null;
  /** Vault mode only. */
  vault: ProofVaultDTO | null;
  /** Native-script fallback only. */
  native: ProofNativeDTO | null;
  fundings: ProofFundingDTO[];
  payments: ProofPaymentDTO[];
  rotations: ProofRotationDTO[];
  close: ProofCloseDTO | null;
  handback: ProofHandbackDTO;
  spentMicro: string;
  claims: ProofClaimDTO[];
}

export interface GoalProofDTO {
  version: typeof PROOF_VERSION;
  network: "preprod";
  goalId: string;
  goal: string;
  status: string;
  fundingTx: string | null;
  sessions: SessionProofDTO[];
  generatedAt: number;
}

// ───────────── verifier output (apps/web/lib/verify-proof.ts) ─────────────
export type ClaimStatus = "pass" | "fail" | "skip";
export interface ProofLink {
  label: string;
  url: string;
}
export interface ClaimResult {
  id: VerifyClaimId;
  statement: string;
  status: ClaimStatus;
  /** What was checked / what differed. */
  detail: string;
  links: ProofLink[];
}
export interface SessionVerification {
  sessionId: string;
  letter: string;
  /** pass = every applicable claim passed; fail = at least one failed; skip = nothing verifiable yet. */
  status: ClaimStatus;
  claims: ClaimResult[];
  /** Applied script hash / address recomputed by the verifier (null when not a vault). */
  recomputed: { scriptHash: string; address: string; unappliedHash: string } | null;
  verifiedAt: number;
}
