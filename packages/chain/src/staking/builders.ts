// Offline Mesh builders for stake + vote-delegation certificates and reward withdrawals (Mesh 1.9.1).
//
// Certificates used (Mesh 1.9.1 MeshTxBuilder, verified in @meshsdk/transaction/dist/index.d.ts):
//   registerStakeCertificate(rewardAddress)            → legacy StakeRegistration (cert 0); deposit = live
//                                                         protocol param `keyDeposit` (Mesh balances it)
//   delegateStakeCertificate(rewardAddress, poolId)     → StakeDelegation (cert 2), stake key witness
//   voteDelegationCertificate({ alwaysAbstain: null } | { dRepId }, rewardAddress)
//                                                       → Conway VoteDelegation (cert 9), stake key witness
//   deregisterStakeCertificate(rewardAddress)           → legacy StakeDeregistration (cert 1); refunds keyDeposit
//   withdrawal(rewardAddress, coin)                     → reward withdrawal (must equal the FULL balance)
// All of these may share one tx; the ledger applies certificates in order and withdrawals before them.
import type { Utxo } from "../types";
import { cst, MeshTxBuilder, type MeshProtocol, type MeshUTxO } from "../mesh";

export type DRepChoice = { kind: "always_abstain" } | { kind: "always_no_confidence" } | { kind: "drep"; drepId: string };

export const ALWAYS_ABSTAIN: DRepChoice = { kind: "always_abstain" };

const DREP_RE = /^drep(_script)?1[02-9ac-hj-np-z]{20,}$/;
const POOL_BECH32_RE = /^pool1[02-9ac-hj-np-z]{50,60}$/;
const POOL_HEX_RE = /^[0-9a-f]{56}$/i;

/** Parse a user/env DRep value: "", "always_abstain", "always_no_confidence" or a bech32 drep id. */
export function parseDRep(v: string | null | undefined): DRepChoice {
  const s = (v ?? "").trim();
  if (!s || /^(always[_-]?)?abstain$/i.test(s) || s === "drep_always_abstain") return ALWAYS_ABSTAIN;
  if (/^(always[_-]?)?no[_-]?confidence$/i.test(s) || s === "drep_always_no_confidence") return { kind: "always_no_confidence" };
  if (!DREP_RE.test(s)) throw new Error(`DRep id must be a bech32 drep1… id (or "always_abstain"), got ${s.slice(0, 24)}`);
  try {
    cst.toDRep(s);
  } catch (e) {
    throw new Error(`invalid DRep id ${s}: ${(e as Error).message}`);
  }
  return { kind: "drep", drepId: s };
}

/** Display / storage form: "always_abstain" | "always_no_confidence" | drep1… (same strings Blockfrost uses, minus "drep_"). */
export function drepLabel(d: DRepChoice): string {
  return d.kind === "drep" ? d.drepId : d.kind;
}

/** Normalise a provider's DRep value ("drep_always_abstain", "drep1…", null) to drepLabel form. */
export function normaliseProviderDRep(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (v === "drep_always_abstain" || v === "always_abstain") return "always_abstain";
  if (v === "drep_always_no_confidence" || v === "always_no_confidence") return "always_no_confidence";
  return v;
}

/** Same DRep? Compares bech32 ids via their CIP-105 form so CIP-105/CIP-129 spellings match. */
export function sameDRep(a: string | null, b: DRepChoice): boolean {
  if (!a) return false;
  if (b.kind !== "drep") return a === b.kind;
  if (a === b.drepId) return true;
  try {
    return cst.getDRepIds(a).cip105 === cst.getDRepIds(b.drepId).cip105;
  } catch {
    return false;
  }
}

function meshDRep(d: DRepChoice) {
  if (d.kind === "always_abstain") return { alwaysAbstain: null } as const;
  if (d.kind === "always_no_confidence") return { alwaysNoConfidence: null } as const;
  return { dRepId: d.drepId };
}

export function assertPoolId(poolId: string): string {
  const p = poolId.trim();
  if (POOL_BECH32_RE.test(p)) return p;
  if (POOL_HEX_RE.test(p)) return cst.resolvePoolId(p.toLowerCase());
  throw new Error(`pool id must be bech32 pool1… or 28-byte hex, got ${p.slice(0, 24)}`);
}

/** stake_test1… reward address of a stake key hash (preprod, network id 0). */
export function rewardAddressOf(stakeKeyHash: string): string {
  if (!/^[0-9a-f]{56}$/i.test(stakeKeyHash)) throw new Error("stake key hash must be 28-byte hex");
  return String(cst.keyHashToRewardAddress(stakeKeyHash.toLowerCase(), 0));
}

function assertPreprodAddress(addr: string): void {
  if (!/^addr_test1[02-9ac-hj-np-z]+$/.test(addr)) throw new Error(`address must be a preprod addr_test1… address, got ${addr.slice(0, 20)}…`);
}

function assertRewardAddress(addr: string): void {
  if (!/^stake_test1[02-9ac-hj-np-z]+$/.test(addr)) throw new Error(`reward address must be stake_test1… (preprod), got ${addr.slice(0, 20)}…`);
}

const toMesh = (u: Utxo): MeshUTxO => ({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } });

interface Common {
  /** Live protocol params (keyDeposit is read from here — never hardcoded). */
  params: MeshProtocol;
  /** Wallet UTxOs paying the fee/deposit (key-based payment credential). */
  utxos: Utxo[];
  changeAddress: string;
  rewardAddress: string;
  ttlSlot: number;
  /** CIP-20 message (metadata 674). */
  memo?: string[];
}

export interface SetupArgs extends Common {
  /** Add the stake registration certificate (pays keyDeposit). */
  register: boolean;
  /** Pool to delegate to (omit to leave the pool delegation unchanged). */
  poolId?: string;
  /** Vote delegation (omit to leave it unchanged). */
  drep?: DRepChoice;
}

export interface BuiltStakingTx {
  unsignedTx: string;
  txHash: string;
  feeLovelace: bigint;
  /** Deposit paid (+) or refunded (−) by the certificates, from live keyDeposit. */
  depositDeltaLovelace: bigint;
  certs: Array<"stake_registration" | "stake_delegation" | "vote_delegation" | "stake_deregistration">;
  withdrawalLovelace: bigint;
}

function finishInfo(hex: string, certs: BuiltStakingTx["certs"], deposit: bigint, withdrawal: bigint): BuiltStakingTx {
  const body = cst.deserializeTx(hex).body();
  return { unsignedTx: hex, txHash: cst.resolveTxHash(hex), feeLovelace: BigInt(body.fee()), depositDeltaLovelace: deposit, certs, withdrawalLovelace: withdrawal };
}

function newBuilder(a: Common) {
  assertPreprodAddress(a.changeAddress);
  assertRewardAddress(a.rewardAddress);
  if (a.utxos.length === 0) throw new Error("no UTxOs to pay the fee/deposit (fund the wallet first)");
  const b = new MeshTxBuilder({ params: a.params });
  if (a.memo?.length) b.metadataValue(674, { msg: a.memo.map((m) => m.slice(0, 64)) });
  return b;
}

/** Register (optional) + delegate to a pool (optional) + delegate the vote (optional), in ONE tx. */
export async function buildStakingSetupTx(a: SetupArgs): Promise<BuiltStakingTx> {
  const b = newBuilder(a);
  const certs: BuiltStakingTx["certs"] = [];
  if (a.register) {
    b.registerStakeCertificate(a.rewardAddress);
    certs.push("stake_registration");
  }
  if (a.poolId) {
    b.delegateStakeCertificate(a.rewardAddress, assertPoolId(a.poolId));
    certs.push("stake_delegation");
  }
  if (a.drep) {
    b.voteDelegationCertificate(meshDRep(a.drep), a.rewardAddress);
    certs.push("vote_delegation");
  }
  if (certs.length === 0) throw new Error("nothing to do: already registered and delegated as requested");
  const hex = await b.selectUtxosFrom(a.utxos.map(toMesh)).changeAddress(a.changeAddress).invalidHereafter(a.ttlSlot).complete();
  return finishInfo(hex, certs, a.register ? BigInt(a.params.keyDeposit) : 0n, 0n);
}

export interface WithdrawArgs extends Common {
  /** Must equal the reward account's FULL current balance (ledger rule); 0 is valid when the balance is 0. */
  amountLovelace: bigint;
}

/**
 * Withdraw rewards. Conway (PV ≥ 10): a key-hash reward account can only withdraw if its stake credential
 * has delegated its vote (DRep / always_abstain / always_no_confidence) — callers check that first.
 */
export async function buildWithdrawRewardsTx(a: WithdrawArgs): Promise<BuiltStakingTx> {
  if (a.amountLovelace < 0n) throw new Error("withdrawal amount must be ≥ 0");
  const b = newBuilder(a);
  b.withdrawal(a.rewardAddress, a.amountLovelace.toString());
  const hex = await b.selectUtxosFrom(a.utxos.map(toMesh)).changeAddress(a.changeAddress).invalidHereafter(a.ttlSlot).complete();
  return finishInfo(hex, [], 0n, a.amountLovelace);
}

export interface StopArgs extends Common {
  /** Current reward balance: withdrawn in the same tx (deregistration requires a zero balance). */
  rewardsLovelace: bigint;
}

/** Stop staking: withdraw any rewards (same tx) + deregister the stake credential (refunds keyDeposit). */
export async function buildStopStakingTx(a: StopArgs): Promise<BuiltStakingTx> {
  if (a.rewardsLovelace < 0n) throw new Error("rewards must be ≥ 0");
  const b = newBuilder(a);
  if (a.rewardsLovelace > 0n) b.withdrawal(a.rewardAddress, a.rewardsLovelace.toString());
  b.deregisterStakeCertificate(a.rewardAddress);
  const hex = await b.selectUtxosFrom(a.utxos.map(toMesh)).changeAddress(a.changeAddress).invalidHereafter(a.ttlSlot).complete();
  return finishInfo(hex, ["stake_deregistration"], -BigInt(a.params.keyDeposit), a.rewardsLovelace);
}

/** Decoded certificates of a tx (for tests and the on-chain script's pre-submit check). */
export function certificatesOf(hex: string): Array<{ kind: string; stakeKeyHash?: string; poolKeyHash?: string; drep?: string }> {
  const certs = cst.deserializeTx(hex).body().certs();
  if (!certs) return [];
  return [...certs.values()].map((c) => {
    const core = c.toCore() as unknown as { __typename: string; stakeCredential?: { hash: string }; poolId?: string; dRep?: unknown };
    const out: { kind: string; stakeKeyHash?: string; poolKeyHash?: string; drep?: string } = { kind: core.__typename };
    if (core.stakeCredential?.hash) out.stakeKeyHash = String(core.stakeCredential.hash);
    if (core.poolId) out.poolKeyHash = String(core.poolId);
    if (core.dRep !== undefined) out.drep = JSON.stringify(core.dRep);
    return out;
  });
}

/** Withdrawals of a tx as { stake_test1…: lovelace }. */
export function withdrawalsOf(hex: string): Record<string, bigint> {
  const w = cst.deserializeTx(hex).body().withdrawals();
  if (!w) return {};
  return Object.fromEntries([...w.entries()].map(([k, v]) => [String(k), BigInt(v)]));
}
