"use client";
// Decision answers from the browser. Custodial users: click-to-approve (unchanged). Self-custody users
// sign every approval with their wallet: the engine issues a one-time nonce + the canonical payload
// {decisionId, kind, sessionId, amount, payee, status, nonce, at}, the wallet signs it with CIP-30
// signData (CIP-8 COSE_Sign1), and the engine verifies it against the treasury address and stores the
// signature as evidence before the decision is applied. If the approval also needs a funding tx
// (self-custody budget raise), postSigned then asks the wallet for signTx as before.
import type { Decision, MeDTO } from "@bulkhead/shared";
import { api, postSigned } from "./client";
import type { WalletState } from "./wallet-context";

export interface DecisionEvidenceDTO {
  decisionId: string;
  address: string;
  keyHash: string;
  payload: string;
  signature: string;
  key: string;
  signedAt: number;
}

export async function walletProofForDecision(decisionId: string, wallet: WalletState): Promise<{ nonce: string; signature: string; key: string }> {
  if (!wallet.connected || !wallet.signData) throw new Error("Self-custody approval: connect your wallet (top bar → Connect wallet) to sign it.");
  const n = await api<{ nonce: string; payload: string; address: string }>("/wallet-auth/nonce", { base: "/api", method: "POST", body: { purpose: "decision", decisionId } });
  const sig = await wallet.signData(n.payload, n.address);
  return { nonce: n.nonce, signature: sig.signature, key: sig.key };
}

export async function answerDecision(d: Pick<Decision, "id">, status: "approved" | "rejected", ctx: { me: MeDTO | null; wallet: WalletState; path?: string }) {
  const body: Record<string, unknown> = { status };
  if (status === "approved" && ctx.me?.custody === "self") body.walletProof = await walletProofForDecision(d.id, ctx.wallet);
  const signTx = ctx.wallet.connected && ctx.wallet.signTx ? ctx.wallet.signTx : null;
  return postSigned(ctx.path ?? `/decisions/${d.id}`, body, signTx);
}

export const shortHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);
