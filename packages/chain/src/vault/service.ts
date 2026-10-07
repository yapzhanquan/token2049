// Vault operations behind MeshTxService (vaultFund / previewVaultFunding / vaultPay / vaultRevoke /
// vaultRecover). Keys never leave KeyVault: the session key signs Pay, the captain key signs Revoke,
// the collateral provider (captain by default) witnesses its collateral input.
//
// Exec units come from the provider's evaluateTx (Blockfrost /utils/txs/evaluate) — or, if the provider
// has none, from the offline Scalus evaluator. A script failure at evaluation or submission is thrown
// as VaultScriptError (code "SCRIPT_FAILED") carrying the evaluator/node error text.
import type { Asset, ChainProvider, FundingOutput, TxResult, UnsignedTx, Utxo } from "../types";
import type { KeyVault } from "../keys";
import type { SessionLookup, SessionWalletInfo } from "../store";
import type { QueueContext, TreasuryQueue } from "../queue";
import { cst, MeshTxBuilder, type MeshProtocol, type MeshTxBuilderT, type MeshUTxO } from "../mesh";
import { applyVaultParams, isVaultParamsJson, vaultParamsFromJson, VAULT_DATUM_VOID, type AppliedVault } from "./params";
import {
  buildVaultPay,
  buildVaultRecover,
  buildVaultRevoke,
  offlineEvaluator,
  providerEvaluator,
  vaultPayTtlSlot,
  vaultRecoverFromSlot,
  VaultScriptError,
  type Metadata674,
  type VaultEvaluator,
  type VaultTxResult,
} from "./build";

/** Min lovelace of a collateral UTxO we pick (ADA-only). */
export const MIN_COLLATERAL_LOVELACE = 5_000_000n;
const PREPROD_ADDR = /^addr_test1[02-9ac-hj-np-z]+$/;
const VOID_STR = JSON.stringify(VAULT_DATUM_VOID);

export interface VaultOpsDeps {
  provider: ChainProvider;
  keys: KeyVault;
  queue: TreasuryQueue;
  sessions: SessionLookup;
  ttlSlots: number;
  params: () => Promise<MeshProtocol>;
  tusdUnit: () => Promise<string>;
  /** (evaluate) → submit → reserve; returns the TxResult. */
  submitAndReserve: (ctx: QueueContext, signed: string, expectedHash: string, ownAddress: string) => Promise<TxResult>;
  /** Fallback build helper (confirmed UTxOs first, then chained change). */
  buildWithFallback: (ctx: QueueContext, chainUtxos: Utxo[], tipSlot: number, build: (available: Utxo[]) => Promise<{ hex: string }>) => Promise<{ hex: string }>;
}

export interface VaultTxServiceResult extends TxResult {
  /** Exec units declared in the tx (measured + 10 % margin), per redeemer. */
  exUnits: Array<{ mem: number; steps: number }>;
  /** Exec units measured by the evaluator (Blockfrost evaluate / offline), per redeemer. */
  measured?: Array<{ mem: number; steps: number }>;
  txSizeBytes: number;
  vaultAddress: string;
  scriptHash: string;
}

const toMesh = (u: Utxo): MeshUTxO => ({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } });
const lovelaceOf = (u: Utxo) => BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
const qty = (utxos: Utxo[], unit: string) => utxos.reduce((s, u) => s + BigInt(u.amount.find((a) => a.unit === unit)?.quantity ?? "0"), 0n);

/** Pick the smallest ADA-only UTxO with ≥ MIN_COLLATERAL_LOVELACE. */
export function pickCollateral(utxos: Utxo[]): Utxo | null {
  const ok = utxos.filter((u) => u.amount.every((a) => a.unit === "lovelace") && lovelaceOf(u) >= MIN_COLLATERAL_LOVELACE);
  ok.sort((a, b) => (lovelaceOf(a) < lovelaceOf(b) ? -1 : lovelaceOf(a) > lovelaceOf(b) ? 1 : 0));
  return ok[0] ?? null;
}

export class NoCollateralError extends Error {
  readonly code = "NO_COLLATERAL";
  constructor(address: string) {
    super(`No ADA-only UTxO ≥ ${Number(MIN_COLLATERAL_LOVELACE) / 1e6} ADA at ${address} to use as collateral (run \`pnpm setup:chain\` to fund the captain's collateral UTxO)`);
    this.name = "NoCollateralError";
  }
}

/** Is this error text a Plutus script failure (evaluation or ledger phase-2 / script-related submit error)? */
export function isScriptFailureText(msg: string): boolean {
  return /EvaluationFailure|ScriptFailures|validatorFailed|ValidationTagMismatch|PlutusFailure|ScriptFailure|script.*fail|evaluat/i.test(msg);
}

export class VaultOps {
  private costModelsCache: number[][] | null | undefined;
  constructor(private readonly d: VaultOpsDeps) {}

  // ── helpers ──────────────────────────────────────────────────────────────────────────────
  async costModels(): Promise<number[][] | undefined> {
    if (this.costModelsCache === undefined) {
      try {
        this.costModelsCache = this.d.provider.fetchCostModels ? await this.d.provider.fetchCostModels() : null;
      } catch {
        this.costModelsCache = null;
      }
    }
    return this.costModelsCache ?? undefined;
  }

  evaluator(): VaultEvaluator {
    const p = this.d.provider;
    if (p.evaluateTx) return providerEvaluator((hex) => p.evaluateTx!(hex));
    return async (hex, spent, coll) => offlineEvaluator(await this.costModels())(hex, spent, coll);
  }

  /** The session's vault, from the `sessions` row (script_json = VaultParams JSON). */
  async sessionVault(sessionId: string): Promise<{ info: SessionWalletInfo; vault: AppliedVault }> {
    const info = await this.d.sessions(sessionId);
    if (!info) throw new Error(`Session ${sessionId} has no wallet (address/script/expiry) recorded`);
    if (!info.scriptJson || !isVaultParamsJson(info.scriptJson)) throw new Error(`Session ${sessionId} is not a vault session (script_json holds no VaultParams)`);
    const vault = applyVaultParams(vaultParamsFromJson(info.scriptJson));
    if (vault.address !== info.address) throw new Error(`Session ${sessionId}: stored address ${info.address} ≠ vault address ${vault.address} re-derived from its params`);
    if (info.scriptHash && info.scriptHash !== vault.scriptHash) throw new Error(`Session ${sessionId}: stored script hash ≠ re-derived ${vault.scriptHash}`);
    return { info, vault };
  }

  /** Collateral UTxO + key id of its provider (captain unless another key id is given). */
  async collateral(keyId = "captain"): Promise<{ keyId: string; utxo: Utxo; address: string }> {
    let address: string | undefined;
    if (keyId === "captain") address = (await this.d.keys.captain()).address;
    else if (keyId === "operator") address = (await this.d.keys.operator()).address;
    else address = (await this.d.keys.publicInfo(keyId)).address;
    if (!address) throw new Error(`key ${keyId} has no address to take collateral from`);
    const utxo = pickCollateral(await this.d.provider.fetchUtxos(address));
    if (!utxo) throw new NoCollateralError(address);
    return { keyId, utxo, address };
  }

  /** Sign with every key (dedup), evaluate-check is done at build time; submit; map script failures. */
  private async signSubmit(ctx: QueueContext, keyIds: string[], built: VaultTxResult, vault: AppliedVault): Promise<VaultTxServiceResult> {
    let signed = built.unsignedTx;
    for (const k of [...new Set(keyIds)]) signed = await this.d.keys.signTx(k, signed);
    try {
      const r = await this.d.submitAndReserve(ctx, signed, built.txHash, vault.address);
      return { ...r, exUnits: built.exUnits, measured: built.measured, txSizeBytes: built.txSizeBytes, vaultAddress: vault.address, scriptHash: vault.scriptHash };
    } catch (e) {
      const msg = (e as Error).message;
      if (isScriptFailureText(msg)) throw new VaultScriptError(`Session Vault script rejected the tx at submission: ${msg}`, msg);
      throw e;
    }
  }

  // ── treasury → vaults ────────────────────────────────────────────────────────────────────
  private fundingOutputs(b: MeshTxBuilderT, outputs: FundingOutput[], unit: string) {
    if (outputs.length === 0) throw new Error("vaultFund: no outputs");
    let lovelace = 0n;
    let tusd = 0n;
    for (const o of outputs) {
      if (!PREPROD_ADDR.test(o.address)) throw new Error("vaultFund: output address must be a preprod addr_test1… address");
      let isScript = false;
      try {
        isScript = !!cst.deserializeBech32Address(o.address).scriptHash;
      } catch {
        isScript = false;
      }
      if (!isScript) throw new Error(`vaultFund: ${o.address.slice(0, 24)}… is not a script (vault) address`);
      if (o.tusdMicro < 0n || (o.extraLovelace ?? 0n) < 0n) throw new Error("vaultFund amounts must be ≥ 0");
      const tokens: Asset[] = o.tusdMicro > 0n ? [{ unit, quantity: o.tusdMicro.toString() }] : [];
      let l = 2_000_000n;
      for (let i = 0; i < 4; i++) {
        const min = b.calculateMinLovelaceForOutput({
          address: o.address,
          amount: [{ unit: "lovelace", quantity: l.toString() }, ...tokens],
          datum: { type: "Inline", data: { type: "JSON", content: VOID_STR } },
        });
        const want = min + (o.extraLovelace ?? 0n);
        if (want === l) break;
        l = want;
      }
      b.txOut(o.address, [{ unit: "lovelace", quantity: l.toString() }, ...tokens]).txOutInlineDatumValue(VOID_STR, "JSON");
      lovelace += l;
      tusd += o.tusdMicro;
    }
    return { lovelace, tusd };
  }

  private applyMetadata(b: MeshTxBuilderT, metadata?: Record<string, unknown>) {
    if (!metadata || Object.keys(metadata).length === 0) return;
    const keys = Object.keys(metadata);
    if (keys.every((k) => /^\d+$/.test(k))) for (const k of keys) b.metadataValue(Number(k), metadata[k] as object);
    else b.metadataValue(674, metadata);
  }

  /** Treasury → vault(s): each output = min-ADA (with inline datum Void) + extraLovelace + tUSD. */
  async fund(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult> {
    const keyId = `treasury:${args.userId}`;
    const { address } = await this.d.keys.publicInfo(keyId);
    if (!address) throw new Error(`No treasury address for ${args.userId}`);
    const unit = await this.d.tusdUnit();
    const pp = await this.d.params();
    return this.d.queue.run(address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(address), this.d.provider.fetchTip()]);
      const { hex } = await this.d.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        const b = new MeshTxBuilder({ params: pp });
        this.fundingOutputs(b, args.outputs, unit);
        this.applyMetadata(b, args.metadata);
        const hex = await b
          .selectUtxosFrom(available.map(toMesh))
          .changeAddress(address)
          .invalidHereafter(tip.slot + this.d.ttlSlots)
          .complete();
        return { hex };
      });
      const signed = await this.d.keys.signTx(keyId, hex);
      return this.d.submitAndReserve(ctx, signed, cst.resolveTxHash(hex), address);
    });
  }

  /**
   * Self-custody (CIP-30) vault funding: the SAME tx shape as fund() — one output per vault, each exactly
   * budget tUSD + min-ADA + extraLovelace (ada_allowance headroom) with inline datum Void — but built from
   * the wallet address's UTxOs (change → wallet) and left UNSIGNED for the browser wallet
   * (signTx(tx, partialSign=true)). Nothing is reserved here; TxService.submitSigned reserves on submit.
   * Guard: every output must be a script address carrying the wallet's OWN stake credential (a vault owned
   * by this wallet has address = Script(vault hash) + owner stake credential, see applyVaultParams).
   */
  async buildUnsignedFund(args: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx> {
    if (!PREPROD_ADDR.test(args.fromAddress)) throw new Error("buildUnsignedVaultFunding: wallet address must be a preprod addr_test1… address");
    const owner = cst.deserializeBech32Address(args.fromAddress);
    if (!owner.pubKeyHash) throw new Error("buildUnsignedVaultFunding: the wallet address must have a key payment credential");
    for (const o of args.outputs) {
      let d: ReturnType<typeof cst.deserializeBech32Address> | null = null;
      try {
        d = cst.deserializeBech32Address(o.address);
      } catch {
        d = null;
      }
      if (d && d.scriptHash && (d.stakeCredentialHash !== owner.stakeCredentialHash || d.stakeScriptCredentialHash !== owner.stakeScriptCredentialHash))
        throw new Error(`buildUnsignedVaultFunding: vault ${o.address.slice(0, 24)}… does not carry the wallet's stake credential (not a vault owned by this wallet)`);
    }
    const address = args.fromAddress;
    const unit = await this.d.tusdUnit();
    const pp = await this.d.params();
    return this.d.queue.run(address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(address), this.d.provider.fetchTip()]);
      const ttlSlot = tip.slot + this.d.ttlSlots;
      let totals = { lovelace: 0n, tusd: 0n };
      const { hex } = await this.d.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        const b = new MeshTxBuilder({ params: pp });
        totals = this.fundingOutputs(b, args.outputs, unit); // validates: script (vault) addresses only
        this.applyMetadata(b, args.metadata);
        const hex = await b.selectUtxosFrom(available.map(toMesh)).changeAddress(address).invalidHereafter(ttlSlot).complete();
        return { hex };
      });
      const fee = BigInt(cst.deserializeTx(hex).body().fee());
      return { unsignedTx: hex, txHash: cst.resolveTxHash(hex), feeLovelace: fee, totalLovelace: totals.lovelace + fee, totalTusdMicro: totals.tusd, ttlSlot };
    });
  }

  async previewFund(args: { userId: string; outputs: FundingOutput[] }): Promise<{ feeLovelace: bigint; totalLovelace: bigint; totalTusdMicro: bigint }> {
    const { address } = await this.d.keys.publicInfo(`treasury:${args.userId}`);
    if (!address) throw new Error(`No treasury address for ${args.userId}`);
    const unit = await this.d.tusdUnit();
    const pp = await this.d.params();
    const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(address), this.d.provider.fetchTip()]);
    const available = await this.d.queue.run(address, async (ctx) => ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot }));
    const b = new MeshTxBuilder({ params: pp });
    const totals = this.fundingOutputs(b, args.outputs, unit);
    const hex = await b
      .selectUtxosFrom(available.map(toMesh))
      .changeAddress(address)
      .invalidHereafter(tip.slot + this.d.ttlSlots)
      .complete();
    const fee = BigInt(cst.deserializeTx(hex).body().fee());
    return { feeLovelace: fee, totalLovelace: totals.lovelace + fee, totalTusdMicro: totals.tusd };
  }

  // ── Pay / Revoke / Recover ───────────────────────────────────────────────────────────────
  /** Pay: session key signs. NO local policy pre-check here (the Signer does that); the script decides. */
  async pay(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string; lovelace?: bigint }): Promise<VaultTxServiceResult> {
    if (!PREPROD_ADDR.test(args.payee)) throw new Error("vaultPay: payee must be a preprod addr_test1… address");
    if (args.tusdMicro <= 0n) throw new Error("vaultPay amount must be > 0");
    const { vault } = await this.sessionVault(args.sessionId);
    const unit = vault.params.tusdPolicyId + vault.params.tusdAssetNameHex;
    const [pp, costModels, coll] = await Promise.all([this.d.params(), this.costModels(), this.collateral("captain")]);
    return this.d.queue.run(vault.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(vault.address), this.d.provider.fetchTip()]);
      const ttlSlot = vaultPayTtlSlot(vault.params.expiryMs, tip.slot, this.d.ttlSlots);
      if (ttlSlot <= tip.slot) throw new VaultScriptError(`vault expired: chain tip slot ${tip.slot} ≥ last valid Pay slot ${ttlSlot}`);
      let built: VaultTxResult | undefined;
      await this.d.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        const utxos = selectPayInputs(available, unit, args.tusdMicro);
        built = await buildVaultPay({
          vault,
          utxos,
          collateral: coll.utxo,
          protocolParams: pp,
          costModels,
          evaluate: this.evaluator(),
          payee: args.payee,
          tusdMicro: args.tusdMicro,
          lovelace: args.lovelace,
          memo: args.memo,
          reference: args.reference,
          changeTo: vault.address,
          ttlSlot,
        });
        return { hex: built.unsignedTx };
      });
      return this.signSubmit(ctx, [`session:${args.sessionId}`, coll.keyId], built!, vault);
    });
  }

  /** Revoke: captain signs (and provides collateral); everything → owner, metadata 674. */
  async revoke(args: { sessionId: string; toAddress: string; metadata674: Metadata674 }): Promise<VaultTxServiceResult> {
    const { vault } = await this.sessionVault(args.sessionId);
    if (args.toAddress !== vault.params.ownerAddress) throw new Error("vaultRevoke: toAddress must be the vault's owner address (the script enforces it)");
    const [pp, costModels, coll] = await Promise.all([this.d.params(), this.costModels(), this.collateral("captain")]);
    return this.d.queue.run(vault.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(vault.address), this.d.provider.fetchTip()]);
      const all = ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot });
      if (all.length === 0) throw new (await import("../tx")).NothingToSweepError(vault.address);
      const built = await buildVaultRevoke({
        vault,
        utxos: all,
        collateral: coll.utxo,
        protocolParams: pp,
        costModels,
        evaluate: this.evaluator(),
        ownerAddress: args.toAddress,
        metadata674: args.metadata674,
        ttlSlot: tip.slot + this.d.ttlSlots,
      });
      return this.signSubmit(ctx, ["captain", coll.keyId], built, vault);
    });
  }

  /** Recover: permissionless after expiry. `signerKeyId` (default captain) only provides + signs collateral. */
  async recover(args: { sessionId: string; signerKeyId?: string; metadata674?: Partial<Metadata674> & Record<string, string> }): Promise<VaultTxServiceResult> {
    const { vault } = await this.sessionVault(args.sessionId);
    const [pp, costModels, coll] = await Promise.all([this.d.params(), this.costModels(), this.collateral(args.signerKeyId ?? "captain")]);
    const validFromSlot = vaultRecoverFromSlot(vault.params.expiryMs);
    return this.d.queue.run(vault.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.d.provider.fetchUtxos(vault.address), this.d.provider.fetchTip()]);
      const tx = await import("../tx");
      if (tip.slot < validFromSlot) throw new tx.NotYetExpiredError(tip.slot, validFromSlot);
      const all = ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot });
      if (all.length === 0) throw new tx.NothingToSweepError(vault.address);
      const built = await buildVaultRecover({
        vault,
        utxos: all,
        collateral: coll.utxo,
        protocolParams: pp,
        costModels,
        evaluate: this.evaluator(),
        ownerAddress: vault.params.ownerAddress,
        validFromSlot,
        ttlSlot: tip.slot + this.d.ttlSlots,
        metadata674: args.metadata674,
      });
      return this.signSubmit(ctx, [coll.keyId], built, vault);
    });
  }
}

/** Greedy: largest tUSD UTxOs first until the amount is covered (≤ 4 inputs keeps the O(n²) script cost small). */
export function selectPayInputs(available: Utxo[], unit: string, tusdMicro: bigint): Utxo[] {
  if (available.length === 0) throw new Error("vault holds no UTxOs");
  const sorted = [...available].sort((a, b) => {
    const qa = qty([a], unit);
    const qb = qty([b], unit);
    return qa === qb ? (lovelaceOf(b) > lovelaceOf(a) ? 1 : -1) : qb > qa ? 1 : -1;
  });
  const out: Utxo[] = [];
  for (const u of sorted) {
    out.push(u);
    if (qty(out, unit) >= tusdMicro && out.length >= 1) break;
    if (out.length >= 4) break;
  }
  // The amount may still exceed what the vault holds: build anyway — the builder reports the shortfall.
  return out;
}

/** Inspect a (signed or unsigned) tx: vkey witness count + the output at `address` (inline datum CBOR, lovelace). */
export function txOutputInfo(txHex: string, address: string): { vkeyWitnesses: number; inlineDatumCbor: string | null; lovelace: bigint | null } {
  const tx = cst.deserializeTx(txHex);
  const out = tx.body().outputs().find((o) => o.address().toBech32().toString() === address);
  return {
    vkeyWitnesses: tx.witnessSet().vkeys()?.values().length ?? 0,
    inlineDatumCbor: out?.datum()?.asInlineData()?.toCbor() ?? null,
    lovelace: out ? BigInt(out.amount().coin()) : null,
  };
}
