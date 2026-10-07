// Settlement check for paid Tasks (= Bulkhead's reimbursement for the treasury float):
// 1. Core receipt must be settled with a txHash and the same blockchainIdentifier as our MPS payment.
// 2. MPS must hold a CONFIRMED Withdrawn/DisputedWithdrawn transaction with that exact txHash.
// 3. Blockfrost tx UTxOs: net receipt = Σ unit in outputs at the seller address − Σ in inputs there
//    (seller change is not income). Verified only when net > 0.
// Not proof: Task COMPLETED, credit debits, PURCHASED, or an empty/non-empty withdrawnForSeller summary.
import type { CoreReceipt, MpsPayment, MpsTx, SettlementEvidence } from "./types";

export interface TxUtxos {
  inputs: { address: string; amount: { unit: string; quantity: string }[]; collateral?: boolean; reference?: boolean }[];
  outputs: { address: string; amount: { unit: string; quantity: string }[]; collateral?: boolean }[];
}

export function sellerNetReceipt(utxos: TxUtxos, sellerAddress: string, unit: string): bigint {
  const sum = (rows: { address: string; amount: { unit: string; quantity: string }[]; collateral?: boolean; reference?: boolean }[]) =>
    rows
      .filter((r) => r.address === sellerAddress && !r.collateral && !r.reference)
      .reduce((n, r) => n + r.amount.filter((a) => a.unit === unit).reduce((m, a) => m + BigInt(a.quantity), 0n), 0n);
  return sum(utxos.outputs) - sum(utxos.inputs);
}

const WITHDRAWN = new Set(["Withdrawn", "DisputedWithdrawn"]);

export interface SettlementInputs {
  receipt: CoreReceipt | null;
  payment: MpsPayment; // freshly resolved, with history
  sellerAddress: string;
  unit: string;
  /** Fetches Blockfrost /txs/{hash}/utxos; returns null when not determinable (404, no key, …). */
  fetchUtxos: (txHash: string) => Promise<TxUtxos | null>;
  now?: number;
}

export async function verifySettlement(i: SettlementInputs): Promise<SettlementEvidence> {
  const checkedAt = i.now ?? Date.now();
  const r = i.receipt;
  if (!r?.settled || typeof r.txHash !== "string" || !r.txHash) return { verified: false, reason: "Core receipt not settled yet", checkedAt };
  if (r.blockchainIdentifier !== i.payment.blockchainIdentifier) throw new Error("Core receipt blockchainIdentifier does not match the MPS payment");
  const txs: (MpsTx | null | undefined)[] = [i.payment.CurrentTransaction, ...(i.payment.TransactionHistory ?? [])];
  const match = txs.find((t) => t?.status === "Confirmed" && WITHDRAWN.has(t.newOnChainState ?? "") && t.txHash === r.txHash);
  if (!match) return { verified: false, reason: "No confirmed MPS withdrawal with the receipt txHash", txHash: r.txHash, checkedAt };
  const utxos = await i.fetchUtxos(r.txHash);
  if (!utxos) return { verified: false, reason: "Transaction UTxOs not determinable yet", txHash: r.txHash, checkedAt };
  const net = sellerNetReceipt(utxos, i.sellerAddress, i.unit);
  return {
    verified: net > 0n,
    ...(net > 0n ? {} : { reason: "No positive net token receipt at the seller address" }),
    txHash: r.txHash,
    netAtomicUnits: net.toString(),
    method: "Core receipt txHash = confirmed MPS withdrawal txHash; Blockfrost net seller outputs − inputs",
    checkedAt,
  };
}

/** Blockfrost preprod fetcher. 404 / missing key → null ("not determined"), never zero. */
export function blockfrostUtxos(projectId: string | undefined, fetchImpl: typeof fetch = fetch) {
  return async (txHash: string): Promise<TxUtxos | null> => {
    if (!projectId || !/^[0-9a-f]{64}$/.test(txHash)) return null;
    const res = await fetchImpl(`https://cardano-preprod.blockfrost.io/api/v0/txs/${txHash}/utxos`, { headers: { project_id: projectId }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return (await res.json()) as TxUtxos;
  };
}
