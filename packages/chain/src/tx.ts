// TxService (spec §5.1): builds transactions with Mesh MeshTxBuilder (offline: we hand it the UTxOs
// and LIVE protocol parameters; no Mesh provider is used), signs server-side with KeyVault, submits
// through the ChainProvider. Every spend from a wallet goes through TreasuryQueue keyed by address.
import type { Asset, Balance, ChainProvider, FundingOutput, TxResult, TxService, UnsignedTx, Utxo } from "./types";
import type { KeyVault } from "./keys";
import type { SessionLookup, SessionWalletInfo } from "./store";
import { TreasuryQueue, refOf, type QueueContext } from "./queue";
import { cst, MeshTxBuilder, SLOT_CONFIG_NETWORK, slotToBeginUnixTime, type MeshProtocol, type MeshTxBuilderT, type MeshUTxO } from "./mesh";
import { tusdPolicy, TUSD_ASSET_NAME_HEX, TUSD_REF_ASSET_NAME_HEX, LEGACY_TUSD_ASSET_NAME_HEX, TUSD_METADATA } from "./script";
import { assetFingerprint, cip68DatumCbor, type Cip68Metadata } from "./cip68";
import { VaultOps, type VaultTxServiceResult } from "./vault/service";
import type { Metadata674 } from "./vault/build";

export class NothingToSweepError extends Error {
  readonly code = "NOTHING_TO_SWEEP";
  constructor(address: string) {
    super(`Session wallet ${address} holds no UTxOs — nothing to sweep`);
    this.name = "NothingToSweepError";
  }
}
export class NotYetExpiredError extends Error {
  readonly code = "NOT_YET_EXPIRED";
  constructor(
    readonly tipSlot: number,
    readonly expirySlot: number,
  ) {
    super(
      `Owner recovery is only valid after the session expiry: chain tip slot ${tipSlot} < expiry slot ${expirySlot} ` +
        `(~${Math.ceil((expirySlot - tipSlot) / 60)} min to go). The native script's owner branch requires invalidBefore ≥ expiry.`,
    );
    this.name = "NotYetExpiredError";
  }
}
export class SessionExpiredError extends Error {
  readonly code = "SESSION_EXPIRED";
  constructor(tipSlot: number, expirySlot: number) {
    super(`Session key can no longer spend: chain tip slot ${tipSlot} ≥ expiry slot ${expirySlot}`);
    this.name = "SessionExpiredError";
  }
}

export interface TxServiceOptions {
  provider: ChainProvider;
  keys: KeyVault;
  sessions: SessionLookup;
  queue?: TreasuryQueue;
  /** TTL for txs without a tighter bound, in slots (= seconds on preprod). Default 900. */
  ttlSlots?: number;
  /** Call provider.evaluateTx before submitting (native-script txs have no redeemers). Default false. */
  evaluateBeforeSubmit?: boolean;
  /** Protocol params cache lifetime. Default 10 min. */
  paramsTtlMs?: number;
  now?: () => number;
  /**
   * Settlement asset unit (policyId + asset name hex) every budget, funding output, payment and balance uses.
   * Default (unset): Bulkhead's own operator-minted tUSD. createChain sets it from SETTLEMENT_ASSET / SETTLEMENT_UNIT
   * (default tUSDM, see @bulkhead/shared settlement.ts).
   */
  settlementUnit?: string | null;
}

const toMesh = (u: Utxo): MeshUTxO => ({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } });

export function sumUnit(utxos: Utxo[], unit: string): bigint {
  let s = 0n;
  for (const u of utxos) for (const a of u.amount) if (a.unit === unit) s += BigInt(a.quantity);
  return s;
}

/** Drop UTxOs holding `unit` (the tUSD CIP-68 reference NFT must never be swept into change: its datum would be lost). */
export function withoutUnit(utxos: Utxo[], unit: string | null): Utxo[] {
  return unit ? utxos.filter((u) => !u.amount.some((a) => a.unit === unit)) : utxos;
}

export class NothingToMigrateError extends Error {
  readonly code = "NOTHING_TO_MIGRATE";
  constructor(address: string) {
    super(`${address} holds no legacy (pre-CIP-68) tUSD, nothing to migrate`);
    this.name = "NothingToMigrateError";
  }
}

/** Public description of the tUSD token (CIP-68 333 + reference NFT, CIP-14 fingerprints). */
export interface TusdTokenInfo {
  standard: "CIP-68 (333)";
  policyId: string;
  unit: string;
  assetNameHex: string;
  fingerprint: string;
  referenceUnit: string;
  referenceFingerprint: string;
  /** Where the reference NFT (and its metadata datum) is kept: the operator address (demo; production: a script). */
  referenceHolder: string;
  metadata: typeof TUSD_METADATA;
  /** @deprecated pre-CIP-68 unit (policyId + "tUSD"); only read for balance reporting / migration. */
  legacyUnit: string;
}

/** Split a string into ≤ max-byte UTF-8 chunks (CIP-20 / metadata string limit is 64 bytes). */
export function chunkUtf8(s: string, max = 64): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, "utf8") > max) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** CIP-20 message metadata: { msg: [...] } with every entry ≤ 64 bytes. */
export function cip20(...parts: Array<string | undefined | null>): { msg: string[] } {
  return { msg: parts.filter((p): p is string => !!p).flatMap((p) => chunkUtf8(p)) };
}

function assertPreprodAddress(addr: string, what: string): void {
  if (!/^addr_test1[02-9ac-hj-np-z]+$/.test(addr)) throw new Error(`${what} must be a preprod (addr_test1…) address, got ${addr.slice(0, 20)}…`);
}

/** Drop undefined fields (optional CIP-20 keys such as goal_id). */
function definedStrings(obj: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function assertMeta64(obj: Record<string, string>): void {
  for (const [k, v] of Object.entries(obj))
    if (Buffer.byteLength(v, "utf8") > 64) throw new Error(`metadata field ${k} exceeds 64 bytes`);
}

export interface ParsedTx {
  txHash: string;
  fee: bigint;
  inputs: Array<{ txHash: string; outputIndex: number }>;
  outputs: Utxo[];
  validityStart?: number;
  ttl?: number;
}

export function parseTx(hex: string): ParsedTx {
  const tx = cst.deserializeTx(hex);
  const body = tx.body();
  const txHash = cst.resolveTxHash(hex);
  const inputs = body
    .inputs()
    .values()
    .map((i) => ({ txHash: i.transactionId().toString(), outputIndex: Number(i.index()) }));
  const outputs = body.outputs().map((o, idx) => ({
    txHash,
    outputIndex: idx,
    address: o.address().toBech32().toString(),
    amount: cst.fromValue(o.amount()) as Asset[],
  }));
  const vs = body.validityStartInterval();
  const ttl = body.ttl();
  return { txHash, fee: BigInt(body.fee()), inputs, outputs, validityStart: vs == null ? undefined : Number(vs), ttl: ttl == null ? undefined : Number(ttl) };
}

export class MeshTxService implements TxService {
  readonly queue: TreasuryQueue;
  private readonly provider: ChainProvider;
  private readonly keys: KeyVault;
  private readonly sessions: SessionLookup;
  private readonly ttlSlots: number;
  private readonly evaluate: boolean;
  private readonly paramsTtlMs: number;
  private readonly now: () => number;
  private paramsCache: { at: number; params: MeshProtocol } | null = null;
  private policyCache: { policyId: string; scriptCbor: string } | null = null;
  private readonly settlementUnit: string | null;

  constructor(opts: TxServiceOptions) {
    if (opts.provider.network !== "preprod") throw new Error(`TxService refuses a ${opts.provider.network} provider (preprod only)`);
    this.provider = opts.provider;
    this.keys = opts.keys;
    this.sessions = opts.sessions;
    this.queue = opts.queue ?? new TreasuryQueue();
    this.ttlSlots = opts.ttlSlots ?? 900;
    this.evaluate = opts.evaluateBeforeSubmit ?? false;
    this.paramsTtlMs = opts.paramsTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    const su = opts.settlementUnit?.trim().toLowerCase();
    if (su && !/^[0-9a-f]{56}[0-9a-f]{0,64}$/.test(su)) throw new Error("settlementUnit must be policyId (56 hex) + asset name hex");
    this.settlementUnit = su || null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────
  private async params(): Promise<MeshProtocol> {
    if (this.paramsCache && this.now() - this.paramsCache.at < this.paramsTtlMs) return this.paramsCache.params;
    const params = (await this.provider.fetchProtocolParameters()) as MeshProtocol;
    if (!params || typeof params !== "object" || !("coinsPerUtxoSize" in params) || !params.coinsPerUtxoSize)
      throw new Error("Provider returned protocol parameters without coinsPerUtxoSize");
    this.paramsCache = { at: this.now(), params };
    return params;
  }

  private async builder(): Promise<MeshTxBuilderT> {
    return new MeshTxBuilder({ params: await this.params() });
  }

  /** min-ADA (from live coinsPerUtxoSize, via the builder) + extra. */
  private outputLovelace(b: MeshTxBuilderT, address: string, tokens: Asset[], extra: bigint, floor = 0n): bigint {
    let total = (extra > floor ? extra : floor) + 1_000_000n;
    for (let i = 0; i < 4; i++) {
      const min = b.calculateMinLovelaceForOutput({ address, amount: [{ unit: "lovelace", quantity: total.toString() }, ...tokens] });
      const want = min + extra > floor ? min + extra : floor;
      if (want === total) break;
      total = want;
    }
    return total;
  }

  private async operatorPolicy(): Promise<{ policyId: string; scriptCbor: string }> {
    if (!this.policyCache) {
      const op = await this.keys.operator();
      const p = tusdPolicy(op.keyHash);
      this.policyCache = { policyId: p.policyId, scriptCbor: p.scriptCbor };
    }
    return this.policyCache;
  }

  /**
   * The SETTLEMENT unit (what budgets / funding / payments / balances use): the configured settlement asset
   * (default tUSDM via createChain), else Bulkhead's own operator tUSD. Name kept for the TxService contract.
   */
  tusdUnit(): string {
    if (this.settlementUnit) return this.settlementUnit;
    if (!this.policyCache) throw new Error("tusdUnit() not ready: call `await chain.ready()` (or any operator tx) first");
    return this.policyCache.policyId + TUSD_ASSET_NAME_HEX;
  }

  /** Resolve the settlement unit (async-safe variant of tusdUnit()). */
  async tusdUnitAsync(): Promise<string> {
    if (this.settlementUnit) return this.settlementUnit;
    return this.operatorTusdUnitAsync();
  }

  /** Bulkhead's own operator-minted tUSD (CIP-68 333) unit, whatever the settlement asset is. */
  async operatorTusdUnitAsync(): Promise<string> {
    const p = await this.operatorPolicy();
    return p.policyId + TUSD_ASSET_NAME_HEX;
  }

  private slotToMs(slot: number): number {
    return slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK.preprod);
  }

  /** Sign → (evaluate) → submit → reserve in the queue. */
  private async finish(ctx: QueueContext, keyId: string, unsignedHex: string, ownAddress: string): Promise<TxResult> {
    const signed = await this.keys.signTx(keyId, unsignedHex);
    return this.submitAndReserve(ctx, signed, cst.resolveTxHash(unsignedHex), ownAddress);
  }

  /** (evaluate) → submit → reserve in the queue. */
  private async submitAndReserve(ctx: QueueContext, signed: string, expectedHash: string, ownAddress: string): Promise<TxResult> {
    const parsed = parseTx(signed);
    if (parsed.txHash !== expectedHash) throw new Error("internal: tx body changed while signing");
    if (this.evaluate && this.provider.evaluateTx) await this.provider.evaluateTx(signed);
    let submitted: string;
    try {
      submitted = await this.provider.submitTx(signed);
    } catch (e) {
      throw new Error(`Submit failed via ${this.provider.name}: ${(e as Error).message}`);
    }
    if (submitted && submitted !== parsed.txHash) throw new Error(`Provider returned tx hash ${submitted}, expected ${parsed.txHash}`);
    // All our txs set a TTL; fall back to +2 h of slots if one ever does not.
    const ttlSlot = parsed.ttl ?? (parsed.validityStart ?? 0) + 7200;
    ctx.reserve(parsed.txHash, parsed.inputs, parsed.outputs.filter((o) => o.address === ownAddress), ttlSlot);
    return { txHash: parsed.txHash, feeLovelace: parsed.fee, cborHex: signed };
  }

  /** Build with confirmed UTxOs first; if that fails and in-flight change exists, retry chaining it. */
  private async buildWithFallback(
    ctx: QueueContext,
    chainUtxos: Utxo[],
    tipSlot: number,
    build: (available: Utxo[]) => Promise<{ hex: string }>,
  ): Promise<{ hex: string }> {
    const confirmed = ctx.available(chainUtxos, { tipSlot });
    const withChained = ctx.available(chainUtxos, { withChained: true, tipSlot });
    try {
      if (confirmed.length === 0) throw new Error("no confirmed UTxOs available");
      return await build(confirmed);
    } catch (e) {
      if (withChained.length === confirmed.length) throw e;
      return await build(withChained);
    }
  }

  private fundingOutputs(b: MeshTxBuilderT, outputs: FundingOutput[], unit: string) {
    if (outputs.length === 0) throw new Error("fundSessions: no outputs");
    let lovelace = 0n;
    let tusd = 0n;
    for (const o of outputs) {
      assertPreprodAddress(o.address, "funding output address");
      if (o.tusdMicro < 0n || (o.extraLovelace ?? 0n) < 0n) throw new Error("funding amounts must be ≥ 0");
      const tokens: Asset[] = o.tusdMicro > 0n ? [{ unit, quantity: o.tusdMicro.toString() }] : [];
      const l = this.outputLovelace(b, o.address, tokens, o.extraLovelace ?? 0n);
      b.txOut(o.address, [{ unit: "lovelace", quantity: l.toString() }, ...tokens]);
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

  // ── TxService ──────────────────────────────────────────────────────────────────────────
  async fundSessions(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult> {
    const keyId = `treasury:${args.userId}`;
    const { address } = await this.keys.publicInfo(keyId);
    if (!address) throw new Error(`No treasury address for ${args.userId}`);
    const unit = await this.tusdUnitAsync();
    return this.queue.run(address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(address), this.provider.fetchTip()]);
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        const b = await this.builder();
        this.fundingOutputs(b, args.outputs, unit);
        this.applyMetadata(b, args.metadata);
        const hex = await b
          .selectUtxosFrom(available.map(toMesh))
          .changeAddress(address)
          .invalidHereafter(tip.slot + this.ttlSlots)
          .complete();
        return { hex };
      });
      return this.finish(ctx, keyId, hex, address);
    });
  }

  /** Self-custody: build the funding tx from a CIP-30 wallet address, unsigned (nothing reserved). */
  async buildUnsignedFunding(args: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx> {
    assertPreprodAddress(args.fromAddress, "wallet address");
    const address = args.fromAddress;
    const unit = await this.tusdUnitAsync();
    return this.queue.run(address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(address), this.provider.fetchTip()]);
      let totals = { lovelace: 0n, tusd: 0n };
      const ttlSlot = tip.slot + this.ttlSlots;
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        const b = await this.builder();
        totals = this.fundingOutputs(b, args.outputs, unit);
        this.applyMetadata(b, args.metadata);
        const hex = await b.selectUtxosFrom(available.map(toMesh)).changeAddress(address).invalidHereafter(ttlSlot).complete();
        return { hex };
      });
      const p = parseTx(hex);
      return { unsignedTx: hex, txHash: p.txHash, feeLovelace: p.fee, totalLovelace: totals.lovelace + p.fee, totalTusdMicro: totals.tusd, ttlSlot };
    });
  }

  /** Self-custody: merge the wallet's witness set (or take a full signed tx with the SAME body), verify the
   * signatures, then submit + reserve under the wallet address's queue key. */
  async submitSigned(args: { fromAddress: string; unsignedTx: string; signed: string; requiredKeyHash?: string }): Promise<TxResult> {
    assertPreprodAddress(args.fromAddress, "wallet address");
    const expected = cst.resolveTxHash(args.unsignedTx);
    const signedHex = attachSignature(args.unsignedTx, args.signed);
    const w = vkeyWitnesses(signedHex);
    if (w.length === 0) throw new Error("signed tx carries no vkey witness");
    const bad = w.find((x) => !x.valid);
    if (bad) throw new Error(`invalid signature from key ${bad.keyHash}`);
    if (args.requiredKeyHash && !w.some((x) => x.keyHash === args.requiredKeyHash))
      throw new Error(`tx is not signed by the wallet's payment key ${args.requiredKeyHash}`);
    return this.queue.run(args.fromAddress, async (ctx) => {
      const parsed = parseTx(signedHex);
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(args.fromAddress), this.provider.fetchTip()]);
      if (parsed.ttl != null && tip.slot > parsed.ttl) throw new Error("the signed tx has expired (TTL passed); rebuild and sign again");
      const free = new Set(ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot }).map(refOf));
      const spent = parsed.inputs.filter((i) => !free.has(refOf(i)));
      if (spent.length) throw new Error(`input ${refOf(spent[0]!)} is already spent or reserved by another tx; rebuild and sign again`);
      return this.submitAndReserve(ctx, signedHex, expected, args.fromAddress);
    });
  }

  async previewFunding(args: { userId: string; outputs: FundingOutput[] }) {
    const { address } = await this.keys.publicInfo(`treasury:${args.userId}`);
    if (!address) throw new Error(`No treasury address for ${args.userId}`);
    const unit = await this.tusdUnitAsync();
    const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(address), this.provider.fetchTip()]);
    // Read-only peek at the queue state (no lock held, nothing reserved).
    const available = await this.queue.run(address, async (ctx) => ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot }));
    const b = await this.builder();
    const totals = this.fundingOutputs(b, args.outputs, unit);
    const hex = await b
      .selectUtxosFrom(available.map(toMesh))
      .changeAddress(address)
      .invalidHereafter(tip.slot + this.ttlSlots)
      .complete();
    const fee = parseTx(hex).fee;
    return { feeLovelace: fee, totalLovelace: totals.lovelace + fee, totalTusdMicro: totals.tusd };
  }

  private async sessionInfo(sessionId: string): Promise<SessionWalletInfo> {
    const info = await this.sessions(sessionId);
    if (!info) throw new Error(`Session ${sessionId} has no wallet (address/script/expiry) recorded`);
    return info;
  }

  async sessionPay(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }): Promise<TxResult> {
    assertPreprodAddress(args.payee, "payee");
    if (args.tusdMicro <= 0n) throw new Error("sessionPay amount must be > 0");
    const info = await this.sessionInfo(args.sessionId);
    const unit = await this.tusdUnitAsync();
    return this.queue.run(info.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(info.address), this.provider.fetchTip()]);
      if (tip.slot >= info.expirySlot) throw new SessionExpiredError(tip.slot, info.expirySlot);
      // TTL must be ≤ expirySlot for the `before(expirySlot)` branch.
      const ttl = Math.min(info.expirySlot, tip.slot + this.ttlSlots);
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        if (sumUnit(available, unit) < args.tusdMicro)
          throw new Error(`Session wallet holds ${sumUnit(available, unit)} µtUSD, payment needs ${args.tusdMicro}`);
        const b = await this.builder();
        for (const u of available) b.txIn(u.txHash, u.outputIndex, u.amount, u.address, 0).txInScript(info.scriptCbor);
        const tokens: Asset[] = [{ unit, quantity: args.tusdMicro.toString() }];
        b.txOut(args.payee, [{ unit: "lovelace", quantity: this.outputLovelace(b, args.payee, tokens, 0n).toString() }, ...tokens]);
        const meta = cip20(args.reference, args.memo);
        if (meta.msg.length) b.metadataValue(674, meta);
        const hex = await b.changeAddress(info.address).invalidHereafter(ttl).complete();
        return { hex };
      });
      return this.finish(ctx, `session:${args.sessionId}`, hex, info.address);
    });
  }

  async sweep(args: {
    sessionId: string;
    signer: "captain" | "owner";
    toAddress: string;
    metadata674: { session_id: string; log_sha256: string; handback_sha256: string; status: string; goal_id?: string };
  }): Promise<TxResult> {
    assertPreprodAddress(args.toAddress, "sweep destination");
    const meta674 = definedStrings(args.metadata674);
    assertMeta64(meta674);
    const info = await this.sessionInfo(args.sessionId);
    const keyId = args.signer === "captain" ? "captain" : `treasury:${info.userId}`;
    return this.queue.run(info.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(info.address), this.provider.fetchTip()]);
      const all = ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot });
      if (all.length === 0) throw new NothingToSweepError(info.address);
      if (args.signer === "owner" && tip.slot < info.expirySlot) throw new NotYetExpiredError(tip.slot, info.expirySlot);
      const b = await this.builder();
      for (const u of all) b.txIn(u.txHash, u.outputIndex, u.amount, u.address, 0).txInScript(info.scriptCbor);
      b.metadataValue(674, { msg: ["Bulkhead session close"], ...meta674 });
      if (args.signer === "owner") b.invalidBefore(info.expirySlot);
      const hex = await b
        .changeAddress(args.toAddress)
        .invalidHereafter(tip.slot + this.ttlSlots)
        .complete();
      return this.finish(ctx, keyId, hex, info.address);
    });
  }

  async operatorSend(args: { toAddress: string; tusdMicro: bigint; lovelace: bigint; reference: string }): Promise<TxResult> {
    assertPreprodAddress(args.toAddress, "top-up destination");
    if (args.tusdMicro < 0n || args.lovelace < 0n) throw new Error("operatorSend amounts must be ≥ 0");
    const op = await this.keys.operator();
    const policy = await this.operatorPolicy();
    // Top-ups pay the SETTLEMENT asset. Only Bulkhead's own tUSD can be minted on demand; any other settlement asset
    // (tUSDM by default) must already be held by the operator.
    const unit = await this.tusdUnitAsync();
    const mintable = unit === policy.policyId + TUSD_ASSET_NAME_HEX;
    return this.queue.run(op.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(op.address), this.provider.fetchTip()]);
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        available = withoutUnit(available, policy.policyId + TUSD_REF_ASSET_NAME_HEX);
        const b = await this.builder();
        const have = sumUnit(available, unit);
        const mintQty = args.tusdMicro > have ? args.tusdMicro - have : 0n;
        if (mintQty > 0n && !mintable)
          throw new Error(`Operator holds ${have} micro of settlement unit ${unit.slice(0, 12)}…, top-up needs ${args.tusdMicro} (this asset cannot be minted; send it to the operator)`);
        if (mintQty > 0n) b.mint(mintQty.toString(), policy.policyId, TUSD_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
        const tokens: Asset[] = args.tusdMicro > 0n ? [{ unit, quantity: args.tusdMicro.toString() }] : [];
        const l = this.outputLovelace(b, args.toAddress, tokens, 0n, args.lovelace);
        b.txOut(args.toAddress, [{ unit: "lovelace", quantity: l.toString() }, ...tokens]);
        b.metadataValue(674, cip20("Bulkhead top-up (testnet simulation)", args.reference));
        const hex = await b
          .selectUtxosFrom(available.map(toMesh))
          .changeAddress(op.address)
          .invalidHereafter(tip.slot + this.ttlSlots)
          .complete();
        return { hex };
      });
      return this.finish(ctx, "operator", hex, op.address);
    });
  }

  async mintTusd(args: { tusdMicro: bigint; toAddress?: string }): Promise<TxResult> {
    if (args.tusdMicro <= 0n) throw new Error("mintTusd amount must be > 0");
    if (args.toAddress) assertPreprodAddress(args.toAddress, "mint destination");
    const op = await this.keys.operator();
    const policy = await this.operatorPolicy();
    const unit = policy.policyId + TUSD_ASSET_NAME_HEX;
    return this.queue.run(op.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(op.address), this.provider.fetchTip()]);
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (available) => {
        available = withoutUnit(available, policy.policyId + TUSD_REF_ASSET_NAME_HEX);
        const b = await this.builder();
        b.mint(args.tusdMicro.toString(), policy.policyId, TUSD_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
        if (args.toAddress && args.toAddress !== op.address) {
          const tokens: Asset[] = [{ unit, quantity: args.tusdMicro.toString() }];
          b.txOut(args.toAddress, [{ unit: "lovelace", quantity: this.outputLovelace(b, args.toAddress, tokens, 0n).toString() }, ...tokens]);
        }
        b.metadataValue(674, cip20("Bulkhead tUSD mint (preprod test stablecoin)"));
        const hex = await b
          .selectUtxosFrom(available.map(toMesh))
          .changeAddress(op.address)
          .invalidHereafter(tip.slot + this.ttlSlots)
          .complete();
        return { hex };
      });
      return this.finish(ctx, "operator", hex, op.address);
    });
  }

  // ── tUSD as a CIP-68 fungible token ───────────────────────────────────────────────────
  /** Token facts for UIs / scripts (no chain reads). */
  async tusdTokenInfo(): Promise<TusdTokenInfo> {
    const { policyId } = await this.operatorPolicy();
    const op = await this.keys.operator();
    return {
      standard: "CIP-68 (333)",
      policyId,
      unit: policyId + TUSD_ASSET_NAME_HEX,
      assetNameHex: TUSD_ASSET_NAME_HEX,
      fingerprint: assetFingerprint(policyId, TUSD_ASSET_NAME_HEX),
      referenceUnit: policyId + TUSD_REF_ASSET_NAME_HEX,
      referenceFingerprint: assetFingerprint(policyId, TUSD_REF_ASSET_NAME_HEX),
      referenceHolder: op.address,
      metadata: TUSD_METADATA,
      legacyUnit: policyId + LEGACY_TUSD_ASSET_NAME_HEX,
    };
  }

  /**
   * CIP-68 setup mint (one tx, operator policy): the (100) reference NFT with the metadata inline datum → operator
   * address (only when `mintReference`), plus `supplyMicro` of the (333) fungible tUSD → operator (change).
   * Production would send the reference NFT to a script address (immutable or update-controlled metadata).
   */
  async mintTusdCip68(args: { supplyMicro: bigint; mintReference: boolean; metadata?: Cip68Metadata }): Promise<TxResult> {
    if (args.supplyMicro < 0n) throw new Error("supplyMicro must be ≥ 0");
    if (args.supplyMicro === 0n && !args.mintReference) throw new Error("mintTusdCip68: nothing to mint");
    const op = await this.keys.operator();
    const policy = await this.operatorPolicy();
    const refUnit = policy.policyId + TUSD_REF_ASSET_NAME_HEX;
    // JSON Plutus data (metadataToCip68 workaround) serialised to CBOR: Mesh's JSON datum path rejects the
    // `constructor` key in min-ADA cloning, so the inline datum is handed over as CBOR.
    const datum = cip68DatumCbor(args.metadata ?? TUSD_METADATA, 1);
    return this.queue.run(op.address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(op.address), this.provider.fetchTip()]);
      if (args.mintReference && chainUtxos.some((u) => u.amount.some((a) => a.unit === refUnit)))
        throw new Error(`the tUSD reference NFT ${refUnit} already exists at the operator (CIP-68 allows exactly one)`);
      const { hex } = await this.buildWithFallback(ctx, chainUtxos, tip.slot, async (avail) => {
        const available = withoutUnit(avail, refUnit);
        const b = await this.builder();
        if (args.mintReference) b.mint("1", policy.policyId, TUSD_REF_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
        if (args.supplyMicro > 0n) b.mint(args.supplyMicro.toString(), policy.policyId, TUSD_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
        if (args.mintReference) {
          const tokens: Asset[] = [{ unit: refUnit, quantity: "1" }];
          let l = 2_000_000n;
          for (let i = 0; i < 3; i++) {
            const min = b.calculateMinLovelaceForOutput({
              address: op.address,
              amount: [{ unit: "lovelace", quantity: l.toString() }, ...tokens],
              datum: { type: "Inline", data: { type: "CBOR", content: datum } },
            });
            if (min <= l) break;
            l = min;
          }
          b.txOut(op.address, [{ unit: "lovelace", quantity: l.toString() }, ...tokens]).txOutInlineDatumValue(datum, "CBOR");
        }
        b.metadataValue(674, cip20("Bulkhead tUSD CIP-68 mint (preprod test stablecoin)", args.mintReference ? "(100) reference NFT + (333) supply" : "(333) supply"));
        const hex = await b
          .selectUtxosFrom(available.map(toMesh))
          .changeAddress(op.address)
          .invalidHereafter(tip.slot + this.ttlSlots)
          .complete();
        return { hex };
      });
      return this.finish(ctx, "operator", hex, op.address);
    });
  }

  /**
   * Swap a custodial wallet's legacy (pre-CIP-68) tUSD 1:1 for CIP-68 (333) tUSD: burn the legacy units and mint the
   * same quantity of the new unit back to the wallet. Signed by the wallet key (inputs) + the operator key (policy).
   * keyId: "treasury:<userId>" or "operator".
   */
  async migrateLegacyTusd(args: { keyId: string }): Promise<TxResult & { migratedMicro: bigint }> {
    const policy = await this.operatorPolicy();
    const legacyUnit = policy.policyId + LEGACY_TUSD_ASSET_NAME_HEX;
    const refUnit = policy.policyId + TUSD_REF_ASSET_NAME_HEX;
    const address = args.keyId === "operator" ? (await this.keys.operator()).address : (await this.keys.publicInfo(args.keyId)).address;
    if (!address) throw new Error(`key ${args.keyId} has no address`);
    let qty = 0n;
    const r = await this.queue.run(address, async (ctx) => {
      const [chainUtxos, tip] = await Promise.all([this.provider.fetchUtxos(address), this.provider.fetchTip()]);
      const all = withoutUnit(ctx.available(chainUtxos, { withChained: true, tipSlot: tip.slot }), refUnit);
      const legacy = all.filter((u) => u.amount.some((a) => a.unit === legacyUnit));
      qty = sumUnit(legacy, legacyUnit);
      if (qty === 0n) throw new NothingToMigrateError(address);
      const rest = all.filter((u) => !legacy.includes(u));
      const b = await this.builder();
      for (const u of legacy) b.txIn(u.txHash, u.outputIndex, u.amount, u.address, 0);
      b.mint((-qty).toString(), policy.policyId, LEGACY_TUSD_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
      b.mint(qty.toString(), policy.policyId, TUSD_ASSET_NAME_HEX).mintingScript(policy.scriptCbor);
      b.metadataValue(674, cip20("Bulkhead tUSD migration: legacy -> CIP-68 (333), 1:1"));
      const hex = await b
        .selectUtxosFrom(rest.map(toMesh))
        .changeAddress(address)
        .invalidHereafter(tip.slot + this.ttlSlots)
        .complete();
      let signed = await this.keys.signTx(args.keyId, hex);
      if (args.keyId !== "operator") signed = await this.keys.signTx("operator", signed);
      return this.submitAndReserve(ctx, signed, cst.resolveTxHash(hex), address);
    });
    return { ...r, migratedMicro: qty };
  }

  // ── Session Vault (walletMode "vault"; logic in ./vault/service.ts) ──────────────────────
  private vaultOpsInstance?: VaultOps;
  /** Vault operations with this service's provider, keys, queue and session lookup. */
  vaultOps(): VaultOps {
    if (!this.vaultOpsInstance)
      this.vaultOpsInstance = new VaultOps({
        provider: this.provider,
        keys: this.keys,
        queue: this.queue,
        sessions: this.sessions,
        ttlSlots: this.ttlSlots,
        params: () => this.params(),
        tusdUnit: () => this.tusdUnitAsync(),
        submitAndReserve: (ctx, signed, hash, own) => this.submitAndReserve(ctx, signed, hash, own),
        buildWithFallback: (ctx, utxos, tip, build) => this.buildWithFallback(ctx, utxos, tip, build),
      });
    return this.vaultOpsInstance;
  }

  vaultFund(args: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<TxResult> {
    return this.vaultOps().fund(args);
  }

  /** Self-custody: vault funding from a CIP-30 wallet, unsigned (submit with submitSigned). */
  async buildUnsignedVaultFunding(args: { fromAddress: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }): Promise<UnsignedTx> {
    assertPreprodAddress(args.fromAddress, "wallet address");
    return this.vaultOps().buildUnsignedFund(args);
  }

  previewVaultFunding(args: { userId: string; outputs: FundingOutput[] }) {
    return this.vaultOps().previewFund(args);
  }

  vaultPay(args: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }): Promise<VaultTxServiceResult> {
    return this.vaultOps().pay(args);
  }

  vaultRevoke(args: { sessionId: string; toAddress: string; metadata674: Metadata674 }): Promise<VaultTxServiceResult> {
    return this.vaultOps().revoke(args);
  }

  vaultRecover(args: { sessionId: string; signerKeyId?: string; metadata674?: Record<string, string> }): Promise<VaultTxServiceResult> {
    return this.vaultOps().recover(args);
  }

  async balanceOf(address: string): Promise<Balance> {
    const utxos = await this.provider.fetchUtxos(address);
    let tusdMicro = 0n;
    let legacyTusdMicro = 0n;
    if (this.settlementUnit) tusdMicro = sumUnit(utxos, this.settlementUnit);
    if (this.policyCache || (await this.tryPolicy())) {
      if (!this.settlementUnit) tusdMicro = sumUnit(utxos, this.tusdUnit());
      legacyTusdMicro = sumUnit(utxos, this.policyCache!.policyId + LEGACY_TUSD_ASSET_NAME_HEX);
    }
    return { lovelace: sumUnit(utxos, "lovelace"), tusdMicro, utxoCount: utxos.length, ...(legacyTusdMicro > 0n ? { legacyTusdMicro } : {}) };
  }

  private async tryPolicy(): Promise<boolean> {
    try {
      await this.operatorPolicy();
      return true;
    } catch {
      return false;
    }
  }
}

export { refOf };

/** Attach a CIP-30 signature to an unsigned tx. `signed` is either a TransactionWitnessSet CBOR hex
 * (what signTx(tx, true) returns) or a full signed tx whose body hash equals the unsigned one. */
export function attachSignature(unsignedHex: string, signed: string): string {
  const hex = signed.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) throw new Error("signedTx must be CBOR hex");
  const expected = cst.resolveTxHash(unsignedHex);
  let fullTx: ReturnType<typeof cst.deserializeTx> | null;
  try {
    fullTx = cst.deserializeTx(hex);
  } catch {
    fullTx = null;
  }
  let witnessSetHex: string;
  if (fullTx) {
    if (cst.resolveTxHash(hex) !== expected) throw new Error("the wallet returned a tx with a different body than the one built (refusing)");
    witnessSetHex = fullTx.witnessSet().toCbor();
  } else {
    try {
      cst.TransactionWitnessSet.fromCbor(cst.HexBlob(hex));
    } catch (e) {
      throw new Error(`signedTx is neither a transaction nor a witness set: ${(e as Error).message}`);
    }
    witnessSetHex = hex;
  }
  const merged = cst.addVKeyWitnessSetToTransaction(unsignedHex, witnessSetHex);
  if (cst.resolveTxHash(merged) !== expected) throw new Error("internal: tx body changed while attaching the signature");
  return merged;
}

/** vkey witnesses of a tx, each verified against the body hash. */
export function vkeyWitnesses(hex: string): Array<{ keyHash: string; valid: boolean }> {
  const tx = cst.deserializeTx(hex);
  const txHash = cst.resolveTxHash(hex);
  const vkeys = tx.witnessSet().vkeys();
  if (!vkeys) return [];
  return [...vkeys.values()].map((w) => {
    const pk = cst.Ed25519PublicKey.fromHex(w.vkey());
    return { keyHash: pk.hash().hex(), valid: pk.verify(cst.Ed25519Signature.fromHex(w.signature()), cst.HexBlob(txHash)) };
  });
}

/** Payment (+ stake) key hash of a key-based preprod address (self-custody owner key). */
export function addressKeyHashes(address: string): { paymentKeyHash: string; stakeKeyHash: string | null } {
  assertPreprodAddress(address, "wallet address");
  let paymentKeyHash: string;
  try {
    paymentKeyHash = cst.resolvePaymentKeyHash(address);
  } catch (e) {
    throw new Error(`wallet address must have a key (not script) payment credential: ${(e as Error).message}`);
  }
  let stakeKeyHash: string | null = null;
  try {
    stakeKeyHash = cst.resolveStakeKeyHash(address) || null;
  } catch {
    stakeKeyHash = null;
  }
  return { paymentKeyHash, stakeKeyHash };
}
