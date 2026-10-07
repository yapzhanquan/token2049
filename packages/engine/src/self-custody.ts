// Self-custody signing (spec §2: "Connect wallet" users sign funding and approvals in the browser).
//
// The runtime funds sessions through chain.tx.fundSessions({ userId, … }) — for a custodial user the
// chain layer signs with the server-held treasury key. For a self-custody user there is no server key,
// so wireEngine() hands the runtime a chain whose TxService is wrapped by this broker:
//   fundSessions(self user) → buildUnsignedFunding(from the wallet address) → a PENDING signature
//   (the runtime's promise waits) → the browser signs with CIP-30 signTx(unsignedTx, true) → the API
//   calls complete(pendingId, signedTx) → submitSigned (TreasuryQueue) → the runtime continues.
// HTTP side (api.ts): a request whose action reaches fundSessions answers { needsSignature, unsignedTx,
// pendingId }; the browser POSTs the same route again with { pendingId, signedTx }.
// Session payments stay signed by session keys (Signer); sweeps by the captain key — unchanged.
// Session Vaults (walletMode "vault") work the same way: vaultFund(self user) → buildUnsignedVaultFunding
// (wallet UTxOs → vault outputs with inline datum Void; owner = the wallet's full address) → signature →
// submitSigned. Pay is signed by the session key, Revoke by the captain; both return funds to the wallet.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users, type DB } from "@bulkhead/db";
import type { Chain, FundingOutput, TxResult, TxService } from "@bulkhead/chain";
import type { PendingSignatureDTO } from "@bulkhead/shared";
import type { EventBus } from "./contracts";

export const SIGNATURE_TTL_MS = 15 * 60_000;

interface Pending {
  dto: PendingSignatureDTO;
  userId: string;
  fromAddress: string;
  ownerKeyHash: string;
  resolve: (r: TxResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  completing?: Promise<TxResult>;
}

interface Scope {
  userId: string;
  tag?: { goalId?: string; sessionId?: string; purpose?: string };
  onPending: (p: PendingSignatureDTO) => void;
}

export type RaceResult<T> = { kind: "done"; value: T } | { kind: "needsSignature"; pending: PendingSignatureDTO; continuation: Promise<T> };

export class SigningBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly scope = new AsyncLocalStorage<Scope>();
  /** Continuations of requests that answered needsSignature, keyed by pendingId. */
  private readonly continuations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: { db: DB; bus?: EventBus; ttlMs?: number; now?: () => number },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The self-custody wallet of a user, or null for custodial users. */
  selfWallet(userId: string): { address: string; ownerKeyHash: string } | null {
    const u = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    return u && u.custody === "self" ? { address: u.treasuryAddress, ownerKeyHash: u.ownerKeyHash } : null;
  }

  /** Wrap a chain so that treasury spends of self-custody users wait for a browser signature. */
  wrapChain<C extends Chain>(chain: C): C {
    const broker = this;
    const inner = chain.tx;
    const tx = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "fundSessions") return (args: Parameters<TxService["fundSessions"]>[0]) => broker.fundSessions(inner, args);
        if (prop === "previewFunding") return (args: Parameters<TxService["previewFunding"]>[0]) => broker.previewFunding(inner, args);
        // Session Vault funding (walletMode "vault"): same interception, only when the chain has a vault client.
        if (prop === "vaultFund" && inner.vaultFund) return (args: Parameters<NonNullable<TxService["vaultFund"]>>[0]) => broker.vaultFund(inner, args);
        if (prop === "previewVaultFunding" && inner.previewVaultFunding)
          return (args: Parameters<NonNullable<TxService["previewVaultFunding"]>>[0]) => broker.previewVaultFunding(inner, args);
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as TxService;
    return { ...chain, tx } as C;
  }

  private async previewFunding(inner: TxService, args: { userId: string; outputs: FundingOutput[] }) {
    const w = this.selfWallet(args.userId);
    if (!w) return inner.previewFunding(args);
    if (!inner.buildUnsignedFunding) throw new Error("this chain cannot build unsigned txs for self-custody");
    const u = await inner.buildUnsignedFunding({ fromAddress: w.address, outputs: args.outputs });
    return { feeLovelace: u.feeLovelace, totalLovelace: u.totalLovelace, totalTusdMicro: u.totalTusdMicro };
  }

  private async fundSessions(inner: TxService, args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult> {
    const w = this.selfWallet(args.userId);
    if (!w) return inner.fundSessions(args);
    if (!inner.buildUnsignedFunding || !inner.submitSigned) throw new Error("this chain cannot build unsigned txs for self-custody");
    const u = await inner.buildUnsignedFunding({ fromAddress: w.address, outputs: args.outputs, metadata: args.metadata });
    return this.awaitSignature(args.userId, w, u, `Fund ${args.outputs.length} session wallet${args.outputs.length === 1 ? "" : "s"} from your wallet`);
  }

  private async previewVaultFunding(inner: TxService, args: { userId: string; outputs: FundingOutput[] }) {
    const w = this.selfWallet(args.userId);
    if (!w) return inner.previewVaultFunding!(args);
    if (!inner.buildUnsignedVaultFunding) throw new Error("this chain cannot build unsigned Session Vault funding for self-custody");
    const u = await inner.buildUnsignedVaultFunding({ fromAddress: w.address, outputs: args.outputs });
    return { feeLovelace: u.feeLovelace, totalLovelace: u.totalLovelace, totalTusdMicro: u.totalTusdMicro };
  }

  /** Self-custody Session Vault funding: ONE unsigned tx from the wallet (one output per vault, inline datum
   * Void, exactly budget tUSD + min-ADA + ada_allowance headroom) → browser signTx → submitSigned. */
  private async vaultFund(inner: TxService, args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult> {
    const w = this.selfWallet(args.userId);
    if (!w) return inner.vaultFund!(args);
    if (!inner.buildUnsignedVaultFunding || !inner.submitSigned) throw new Error("this chain cannot build unsigned Session Vault funding for self-custody");
    const u = await inner.buildUnsignedVaultFunding!({ fromAddress: w.address, outputs: args.outputs, metadata: args.metadata });
    return this.awaitSignature(args.userId, w, u, `Fund ${args.outputs.length} Session Vault${args.outputs.length === 1 ? "" : "s"} from your wallet`);
  }

  /** Generic self-custody signature request for any engine-built unsigned tx spending the user's wallet
   * (e.g. staking / vote-delegation certificates). Resolves once the browser's signature is submitted. */
  requestSignature(args: { userId: string; unsigned: { unsignedTx: string; txHash: string; feeLovelace: bigint }; purpose: string }): Promise<TxResult> {
    const w = this.selfWallet(args.userId);
    if (!w) return Promise.reject(new Error("requestSignature: not a self-custody user"));
    return this.awaitSignature(args.userId, w, args.unsigned, args.purpose);
  }

  private awaitSignature(
    userId: string,
    w: { address: string; ownerKeyHash: string },
    u: { unsignedTx: string; txHash: string; feeLovelace: bigint },
    defaultPurpose: string,
  ): Promise<TxResult> {
    const args = { userId };
    const scope = this.scope.getStore();
    const at = this.now();
    const tag = scope && scope.userId === args.userId ? scope.tag : undefined;
    const dto: PendingSignatureDTO = {
      pendingId: `sig_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      purpose: tag?.purpose ?? defaultPurpose,
      unsignedTx: u.unsignedTx,
      txHash: u.txHash,
      feeLovelace: u.feeLovelace.toString(),
      ...(tag?.goalId ? { goalId: tag.goalId } : {}),
      ...(tag?.sessionId ? { sessionId: tag.sessionId } : {}),
      createdAt: at,
      expiresAt: at + (this.deps.ttlMs ?? SIGNATURE_TTL_MS),
    };
    return new Promise<TxResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(dto.pendingId);
        reject(new Error("wallet signature not received in time; approve again to retry"));
      }, this.deps.ttlMs ?? SIGNATURE_TTL_MS);
      timer.unref?.();
      this.pending.set(dto.pendingId, { dto, userId: args.userId, fromAddress: w.address, ownerKeyHash: w.ownerKeyHash, resolve, reject, timer });
      this.deps.bus?.emit("progress", {
        ...(dto.goalId ? { goalId: dto.goalId } : {}),
        ...(dto.sessionId ? { sessionId: dto.sessionId } : {}),
        data: { kind: "signature_needed", userId: args.userId, pendingId: dto.pendingId, txHash: dto.txHash, text: `Waiting for your wallet signature: ${dto.purpose}` },
      });
      if (scope && scope.userId === args.userId) scope.onPending(dto);
    });
  }

  /**
   * Run an action for a user. If it reaches a self-custody treasury spend, answer early with the pending
   * signature (the action keeps waiting in the background; its result is kept as the continuation).
   */
  async run<T>(userId: string, tag: Scope["tag"], action: () => Promise<T>): Promise<RaceResult<T>> {
    let onPending!: (p: PendingSignatureDTO) => void;
    const pendingSeen = new Promise<PendingSignatureDTO>((r) => (onPending = r));
    const p = this.scope.run({ userId, tag, onPending }, action);
    p.catch(() => undefined); // never an unhandled rejection when we answered needsSignature first
    const first = await Promise.race([p.then((value) => ({ kind: "done" as const, value })), pendingSeen.then((pending) => ({ kind: "needsSignature" as const, pending }))]);
    if (first.kind === "done") return first;
    this.continuations.set(first.pending.pendingId, p);
    return { kind: "needsSignature", pending: first.pending, continuation: p };
  }

  /** Submit the browser's signature for a pending tx; returns the submitted tx + the original action's continuation. */
  async complete(userId: string, pendingId: string, signedTx: string): Promise<{ tx: TxResult; continuation?: Promise<unknown> }> {
    const p = this.pending.get(pendingId);
    if (!p || p.userId !== userId) throw Object.assign(new Error("no pending signature with that id (expired or already submitted)"), { status: 404 });
    if (!p.completing) {
      const chainTx = this.innerTx;
      if (!chainTx?.submitSigned) throw new Error("this chain cannot submit signed txs");
      p.completing = chainTx.submitSigned({ fromAddress: p.fromAddress, unsignedTx: p.dto.unsignedTx, signed: signedTx, requiredKeyHash: p.ownerKeyHash });
    }
    try {
      const tx = await p.completing;
      clearTimeout(p.timer);
      this.pending.delete(pendingId);
      p.resolve(tx);
      const continuation = this.continuations.get(pendingId);
      this.continuations.delete(pendingId);
      return { tx, ...(continuation ? { continuation } : {}) };
    } catch (e) {
      p.completing = undefined; // a bad signature can be retried with a good one until the TTL
      throw Object.assign(e as Error, { status: 400 });
    }
  }

  /** Cancel a pending signature (the waiting action fails; the runtime keeps sessions AWAITING_APPROVAL). */
  cancel(userId: string, pendingId: string): boolean {
    const p = this.pending.get(pendingId);
    if (!p || p.userId !== userId) return false;
    clearTimeout(p.timer);
    this.pending.delete(pendingId);
    p.reject(new Error("signature cancelled by the user"));
    return true;
  }

  list(userId: string): PendingSignatureDTO[] {
    return [...this.pending.values()].filter((p) => p.userId === userId).map((p) => p.dto);
  }

  find(userId: string, pred: (p: PendingSignatureDTO) => boolean): PendingSignatureDTO | undefined {
    return this.list(userId).find(pred);
  }

  /** The runtime creates the EventBus after the chain is wrapped. */
  attachBus(bus: EventBus): this {
    this.deps.bus = bus;
    return this;
  }

  /** The unwrapped TxService (set by bind). */
  private innerTx: TxService | null = null;
  bind(chain: Chain): this {
    this.innerTx = chain.tx;
    return this;
  }

  shutdown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("engine shutting down"));
    }
    this.pending.clear();
  }
}

/** Convenience: broker bound to `chain`, and the wrapped chain to give the runtime. */
export function createSigningBroker(deps: { db: DB; bus?: EventBus; chain: Chain; ttlMs?: number }) {
  const broker = new SigningBroker(deps).bind(deps.chain);
  return { broker, chain: broker.wrapChain(deps.chain) };
}
