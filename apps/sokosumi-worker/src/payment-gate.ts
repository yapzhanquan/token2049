// Paid Tasks: the seller side of a direct Sokosumi Task payment, against a dedicated Masumi Payment
// Service (MPS). The worker only talks to MPS through `PaymentGate`, so the lead can wire the
// dedicated MPS once it is funded and registered. Routes/schemas: masumi-payment-service
// src/routes/api/payments/{index,submit-result,resolve-blockchain-identifier} + docs/SOKOSUMI-PROTOCOL.md §3-4.
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import type { MpsPayment } from "./types";

/** Preprod test USDM (policy id + asset name hex). */
export const TUSDM_UNIT = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export interface SellerIdentity {
  agentIdentifier: string;
  supportedPaymentSourceIndex: number;
  /** MPS id of the dedicated Selling wallet; signed terms must name this wallet. */
  sellerWalletId: string;
  sellerAddress: string;
}

export interface TermsRequest {
  inputHash: string;
  identifierFromPurchaser: string;
  amountAtomic: string;
  payByTime: Date;
  submitResultTime: Date;
  unlockTime: Date;
  externalDisputeUnlockTime: Date;
  metadata: string;
}

export interface PaymentGate {
  /** Paid Tasks are taken only when this says ready (flag on, registration confirmed, token present). */
  readiness(): { ready: boolean; reason?: string };
  seller(): SellerIdentity;
  /** POST /api/v1/payment → signed terms (returned verbatim). */
  requestTerms(req: TermsRequest): Promise<MpsPayment>;
  /** POST /api/v1/payment/resolve-blockchain-identifier with history. */
  resolve(blockchainIdentifier: string): Promise<MpsPayment>;
  /** POST /api/v1/payment/submit-result. */
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<MpsPayment>;
}

/** Escrow/result proof: the state must have been reached by a CONFIRMED transaction. */
export function confirmedState(p: Pick<MpsPayment, "CurrentTransaction" | "TransactionHistory">, expected: string): boolean {
  const ok = (t: { status?: string; newOnChainState?: string | null } | null | undefined) => t?.status === "Confirmed" && t.newOnChainState === expected;
  return ok(p.CurrentTransaction) || (p.TransactionHistory ?? []).some(ok);
}

export const escrowConfirmed = (p: MpsPayment) => p.onChainState === "FundsLocked" && confirmedState(p, "FundsLocked");

/**
 * Build the Core `masumiPayment` payload from the signed terms, field for field. Refuses terms that a
 * Core Task event cannot preserve or that differ from what this Task quoted.
 */
export function buildPurchasePayload(payment: MpsPayment, nonce: string, seller: SellerIdentity, expectedAtomic: string, expectedInputHash: string): Record<string, unknown> {
  if (payment.sellerReturnAddress !== null && payment.sellerReturnAddress !== undefined) throw new Error("Signed terms carry a sellerReturnAddress; Core Task events cannot preserve it");
  if (payment.forceLayer !== undefined && payment.forceLayer !== null) throw new Error("Signed terms carry a forceLayer; Core Task events cannot preserve it");
  if (payment.PaymentSource?.network !== "Preprod" || payment.PaymentSource?.paymentSourceType !== "Web3CardanoV2") throw new Error("Payment source is not Preprod Web3CardanoV2");
  if (!payment.SmartContractWallet?.id || payment.SmartContractWallet.id !== seller.sellerWalletId) throw new Error("Payment wallet differs from the dedicated seller wallet");
  if (payment.agentIdentifier !== seller.agentIdentifier) throw new Error("Signed agentIdentifier differs from the registered agent");
  if (payment.inputHash !== expectedInputHash) throw new Error("Signed inputHash differs from the Task input hash");
  const f = payment.RequestedFunds;
  if (!Array.isArray(f) || f.length !== 1 || f[0].unit !== TUSDM_UNIT || f[0].amount !== expectedAtomic) throw new Error("Signed amount differs from this Task's quote");
  return {
    blockchainIdentifier: payment.blockchainIdentifier,
    agentIdentifier: payment.agentIdentifier,
    sellerVkey: payment.SmartContractWallet.walletVkey,
    submitResultTime: payment.submitResultTime,
    payByTime: payment.payByTime,
    unlockTime: payment.unlockTime,
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
    inputHash: payment.inputHash,
    identifierFromPurchaser: nonce,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: seller.supportedPaymentSourceIndex,
    Amounts: f.map(({ amount, unit }) => ({ amount, unit })),
    PaymentSource: { network: "Preprod", smartContractAddress: payment.PaymentSource.smartContractAddress, policyId: payment.PaymentSource.policyId },
  };
}

export interface MpsGateConfig {
  enabled: boolean; // PAID_TASKS_ENABLED=true
  mpsUrl: string | undefined; // MPS_URL
  runtimeEnvPath: string; // MPS_RUNTIME_ENV_PATH (default .local/mps-runtime.env), holds MPS_RUNTIME_TOKEN
  registrationConfirmed: boolean; // MASUMI_REGISTRATION_CONFIRMED=true (set once RegistrationConfirmed is observed)
  seller: Partial<SellerIdentity>;
  fetchImpl?: typeof fetch;
}

/** HTTP implementation. Not exercised against a live MPS yet. */
export class MpsPaymentGate implements PaymentGate {
  constructor(private readonly cfg: MpsGateConfig) {}

  readiness() {
    const c = this.cfg;
    if (!c.enabled) return { ready: false, reason: "PAID_TASKS_ENABLED is not true" };
    if (!c.mpsUrl) return { ready: false, reason: "MPS_URL missing" };
    if (!c.registrationConfirmed) return { ready: false, reason: "registration not confirmed" };
    if (!existsSync(c.runtimeEnvPath)) return { ready: false, reason: "MPS runtime token file missing" };
    const s = c.seller;
    if (!s.agentIdentifier || !s.sellerWalletId || !s.sellerAddress || !Number.isInteger(s.supportedPaymentSourceIndex)) return { ready: false, reason: "seller identity incomplete" };
    return { ready: true };
  }

  seller(): SellerIdentity {
    if (!this.readiness().ready) throw new Error("Payment gate not ready");
    return this.cfg.seller as SellerIdentity;
  }

  private token(): string {
    const t = parseEnv(readFileSync(this.cfg.runtimeEnvPath, "utf8")).MPS_RUNTIME_TOKEN;
    if (!t || /^\*+/.test(t)) throw new Error("MPS runtime token missing or masked; recovery required");
    return t;
  }

  private async post(path: string, body: unknown): Promise<MpsPayment> {
    const res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.mpsUrl!.replace(/\/+$/, "")}/api/v1${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", token: this.token() },
      body: JSON.stringify(body),
    });
    let data: { status?: string; data?: MpsPayment } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      /* fallthrough */
    }
    if (!res.ok || data.status !== "success" || !data.data) throw new Error(`MPS ${path} failed (HTTP ${res.status}). Inspect saved state before retry.`);
    return data.data;
  }

  requestTerms(r: TermsRequest) {
    const s = this.seller();
    return this.post("/payment", {
      network: "Preprod",
      agentIdentifier: s.agentIdentifier,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: s.supportedPaymentSourceIndex,
      inputHash: r.inputHash,
      identifierFromPurchaser: r.identifierFromPurchaser,
      RequestedFunds: [{ amount: r.amountAtomic, unit: TUSDM_UNIT }],
      payByTime: r.payByTime.toISOString(),
      submitResultTime: r.submitResultTime.toISOString(),
      unlockTime: r.unlockTime.toISOString(),
      externalDisputeUnlockTime: r.externalDisputeUnlockTime.toISOString(),
      metadata: r.metadata,
    });
  }
  resolve(blockchainIdentifier: string) {
    return this.post("/payment/resolve-blockchain-identifier", { network: "Preprod", blockchainIdentifier, includeHistory: "true" });
  }
  submitResult(blockchainIdentifier: string, resultHash: string) {
    if (!/^[0-9a-f]{64}$/.test(resultHash)) throw new Error("submitResultHash must be 64 hex chars");
    return this.post("/payment/submit-result", { network: "Preprod", blockchainIdentifier, submitResultHash: resultHash });
  }
}

/** A gate that is never ready (execution-only operation). */
export const disabledGate: PaymentGate = {
  readiness: () => ({ ready: false, reason: "paid Tasks disabled" }),
  seller: () => {
    throw new Error("paid Tasks disabled");
  },
  requestTerms: () => Promise.reject(new Error("paid Tasks disabled")),
  resolve: () => Promise.reject(new Error("paid Tasks disabled")),
  submitResult: () => Promise.reject(new Error("paid Tasks disabled")),
};
