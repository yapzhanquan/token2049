// In-memory Chain for unit tests (runtime + captain). Implements packages/chain/src/types.ts.
// Deterministic tx hashes, per-address balances, confirmations on tick() (or automatically
// after `autoConfirmMs`). Nothing here touches a real network — tests only.
//
// Keep this file STABLE: the captain agent's tests import it too.
import { createHash } from "node:crypto";
import type {
  Asset,
  Balance,
  Chain,
  ChainEvent,
  ChainProvider,
  ChainWatcher,
  FundingOutput,
  KeyStore,
  SessionScript,
  SessionScriptParams,
  Tip,
  TxResult,
  TxService,
  UnsignedTx,
  Utxo,
} from "@bulkhead/chain";

export const FAKE_TUSD_UNIT = "fa4e0000000000000000000000000000000000000000000000000000" + "0014df10" + "74555344"; // policy + CIP-68 (333) "tUSD"
export const FAKE_FEE_LOVELACE = 180_000n;
export const FAKE_MIN_ADA = 1_500_000n;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Deterministic preprod-looking bech32-ish address (lowercase alnum, passes MandateSchema). */
export const fakeAddress = (seed: string) => `addr_test1${sha(`addr:${seed}`).slice(0, 52)}`;
const keyHashOf = (seed: string) => sha(`key:${seed}`).slice(0, 56);
const toHex = (o: unknown) => Buffer.from(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), "utf8").toString("hex");
const fromHex = (h: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(h, "hex").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};
/** Fake self-custody wallet: payment key hash of a (fake) wallet address. */
export const fakeWalletKeyHash = (address: string) => keyHashOf(`wallet:${address}`);
/** Fake CIP-30 signTx(unsignedTx, true): a "witness set" binding the wallet key to the fake tx hash. */
export function fakeWalletSign(unsignedTx: string, address: string): string {
  const u = fromHex(unsignedTx);
  return toHex({ witness: fakeWalletKeyHash(address), txHash: u.txHash });
}

type FailOp = "fundSessions" | "sessionPay" | "sweep" | "operatorSend" | "mintTusd" | "vaultFund" | "vaultPay" | "vaultRevoke" | "vaultRecover";

/** Fake Session Vault parameters (same shape as @bulkhead/chain VaultParams). */
export interface FakeVaultParams {
  ownerAddress: string;
  captainKeyHash: string;
  sessionKeyHash: string;
  expiryMs: number;
  payees: string[];
  perTxMaxTusdMicro: bigint;
  adaAllowanceLovelace: bigint;
  tusdPolicyId: string;
  tusdAssetNameHex: string;
}
/** What the fake validator says when a vault rule fails (mirrors a Plutus evaluation failure). */
export class FakeVaultScriptError extends Error {
  readonly name = "VaultScriptError";
  readonly code = "SCRIPT_FAILED";
}

export interface FakeTx {
  txHash: string;
  kind: FailOp;
  at: number;
  confirmed: boolean;
  slot?: number;
  from: string[];
  outputs: { address: string; lovelace: bigint; tusdMicro: bigint }[];
  metadata?: Record<string, unknown>;
  args: unknown;
}

export interface FakeChainOptions {
  /** Confirm submitted txs automatically after this many ms (default: manual tick()). */
  autoConfirmMs?: number;
  /** Clock (POSIX ms). Default Date.now. */
  now?: () => number;
  /** Initial treasury top-up for every treasury created via keys.treasury (default 0). */
  treasuryStart?: { tusdMicro: bigint; lovelace: bigint };
}

export interface FakeChain extends Chain {
  /** Confirm every pending tx (emits tx_confirmed / deposit / spend for watched items) and check expiries. */
  tick(): void;
  /** Credit an address directly (test setup, e.g. operator funds). */
  credit(address: string, tusdMicro: bigint, lovelace?: bigint): void;
  /** Make the next `times` calls of an op throw. */
  failNext(op: FailOp, times?: number, message?: string): void;
  balance(address: string): { tusdMicro: bigint; lovelace: bigint };
  txs: FakeTx[];
  /** sessionId → script address (as registered via keys.session + buildSessionScript). */
  sessionAddress(sessionId: string): string | undefined;
  calls: Record<FailOp, number>;
  setNow(ms: number): void;
  watched: { addresses: Set<string>; txs: Set<string> };
  /** Fake Session Vault: params → deterministic script hash + address (registered for the session). */
  applyVaultParams(p: FakeVaultParams): { scriptCbor: string; scriptHash: string; address: string; paramsJson: unknown };
  /** Vault params of a vault address (tests). */
  vaultAt(address: string): FakeVaultParams | undefined;
  /** Vault txs the fake validator rejected (no tx, nothing spent). */
  vaultRejections: { op: string; sessionId: string; error: string }[];
}

export function createFakeChain(opts: FakeChainOptions = {}): FakeChain {
  let clock: number | null = null;
  const now = () => (clock ?? (opts.now ? opts.now() : Date.now()));
  const balances = new Map<string, { tusdMicro: bigint; lovelace: bigint }>();
  const txs: FakeTx[] = [];
  const listeners = new Set<(e: ChainEvent) => void>();
  const watchedAddresses = new Set<string>();
  const watchedTxs = new Set<string>();
  const expiries = new Map<string, number>();
  const failures = new Map<FailOp, { times: number; message: string }>();
  const calls: Record<FailOp, number> = { fundSessions: 0, sessionPay: 0, sweep: 0, operatorSend: 0, mintTusd: 0, vaultFund: 0, vaultPay: 0, vaultRevoke: 0, vaultRecover: 0 };
  const vaults = new Map<string, FakeVaultParams>(); // vault address → params
  const vaultRejections: { op: string; sessionId: string; error: string }[] = [];
  const keyHashToSession = new Map<string, string>();
  const sessionToAddress = new Map<string, string>(); // latest script address per session
  const sessionAddresses = new Map<string, string[]>(); // every script address a session ever had (extend = new wallet)
  const treasuries = new Map<string, { keyId: string; address: string; keyHash: string; stakeKeyHash: string }>();
  let txCounter = 0;

  const bal = (a: string) => {
    let b = balances.get(a);
    if (!b) balances.set(a, (b = { tusdMicro: 0n, lovelace: 0n }));
    return b;
  };
  const emit = (e: ChainEvent) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        /* listener errors never break the fake chain */
      }
    }
  };
  const checkFail = (op: FailOp) => {
    calls[op]++;
    const f = failures.get(op);
    if (f && f.times > 0) {
      f.times--;
      throw new Error(f.message);
    }
  };
  const slotFromTime = (ms: number) => Math.floor(ms / 1000) - 1_655_683_200; // preprod-ish shelley offset
  const timeFromSlot = (slot: number) => (slot + 1_655_683_200) * 1000;

  const submit = (kind: FailOp, from: string[], outputs: FakeTx["outputs"], args: unknown, metadata?: Record<string, unknown>): TxResult => {
    // Debit inputs (spend everything from `from` that the outputs need; sweeps pass explicit outputs).
    const txHash = sha(`tx:${++txCounter}:${kind}:${JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const tx: FakeTx = { txHash, kind, at: now(), confirmed: false, from, outputs, metadata, args };
    txs.push(tx);
    for (const o of outputs) {
      const b = bal(o.address);
      b.tusdMicro += o.tusdMicro;
      b.lovelace += o.lovelace;
    }
    if (opts.autoConfirmMs !== undefined) setTimeout(() => confirm(tx), opts.autoConfirmMs);
    return { txHash, feeLovelace: FAKE_FEE_LOVELACE, cborHex: `84a4${txHash}` };
  };
  const confirm = (tx: FakeTx) => {
    if (tx.confirmed) return;
    tx.confirmed = true;
    tx.slot = slotFromTime(now());
    if (watchedTxs.has(tx.txHash)) emit({ type: "tx_confirmed", txHash: tx.txHash, slot: tx.slot });
    for (const a of new Set(tx.from)) if (watchedAddresses.has(a)) emit({ type: "spend", address: a, txHash: tx.txHash });
    for (const o of tx.outputs) {
      if (!watchedAddresses.has(o.address)) continue;
      const amount: Asset[] = [{ unit: "lovelace", quantity: o.lovelace.toString() }];
      if (o.tusdMicro > 0n) amount.push({ unit: FAKE_TUSD_UNIT, quantity: o.tusdMicro.toString() });
      emit({ type: "deposit", address: o.address, txHash: tx.txHash, amount });
    }
  };
  const debit = (address: string, tusdMicro: bigint, lovelace: bigint) => {
    const b = bal(address);
    if (b.tusdMicro < tusdMicro) throw new Error(`fake chain: insufficient tUSD at ${address.slice(0, 20)}… (${b.tusdMicro} < ${tusdMicro})`);
    if (b.lovelace < lovelace) throw new Error(`fake chain: insufficient lovelace at ${address.slice(0, 20)}… (${b.lovelace} < ${lovelace})`);
    b.tusdMicro -= tusdMicro;
    b.lovelace -= lovelace;
  };

  const provider: ChainProvider = {
    name: "blockfrost",
    network: "preprod",
    async fetchUtxos(address: string): Promise<Utxo[]> {
      const b = balances.get(address);
      if (!b || (b.lovelace === 0n && b.tusdMicro === 0n)) return [];
      const amount: Asset[] = [{ unit: "lovelace", quantity: b.lovelace.toString() }];
      if (b.tusdMicro > 0n) amount.push({ unit: FAKE_TUSD_UNIT, quantity: b.tusdMicro.toString() });
      return [{ txHash: sha(`utxo:${address}`), outputIndex: 0, address, amount }];
    },
    async fetchTip(): Promise<Tip> {
      return { slot: slotFromTime(now()), time: now(), height: 1_000_000 + txs.filter((t) => t.confirmed).length };
    },
    async fetchProtocolParameters() {
      return { minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: "4310" };
    },
    async submitTx(cborHex: string) {
      return sha(`raw:${cborHex}`);
    },
    async fetchTxConfirmation(txHash: string) {
      const t = txs.find((x) => x.txHash === txHash);
      return t?.confirmed ? { blockHeight: 1_000_000, slot: t.slot ?? 0 } : null;
    },
    async evaluateTx() {
      return [];
    },
  };

  const watcher: ChainWatcher = {
    async start() {},
    async stop() {},
    watchAddress(a) {
      watchedAddresses.add(a);
    },
    unwatchAddress(a) {
      watchedAddresses.delete(a);
    },
    watchTx(h) {
      watchedTxs.add(h);
      // A polling watcher would notice an already-confirmed tx on its next poll.
      const t = txs.find((x) => x.txHash === h);
      if (t?.confirmed) queueMicrotask(() => emit({ type: "tx_confirmed", txHash: h, slot: t.slot ?? 0 }));
    },
    watchExpiry(sessionId, slot) {
      expiries.set(sessionId, slot);
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  const keys: KeyStore = {
    async treasury(userId, accountIndex) {
      let t = treasuries.get(userId);
      if (!t) {
        t = { keyId: `treasury:${userId}`, address: fakeAddress(`treasury:${userId}:${accountIndex}`), keyHash: keyHashOf(`treasury:${userId}`), stakeKeyHash: keyHashOf(`stake:${userId}`) };
        treasuries.set(userId, t);
        if (opts.treasuryStart) {
          const b = bal(t.address);
          b.tusdMicro += opts.treasuryStart.tusdMicro;
          b.lovelace += opts.treasuryStart.lovelace;
        }
      }
      return t;
    },
    async session(sessionId, keyIndex) {
      const keyHash = keyHashOf(`session:${sessionId}:${keyIndex}`);
      keyHashToSession.set(keyHash, sessionId);
      return { keyId: `session:${sessionId}`, keyHash };
    },
    async captain() {
      return { keyId: "captain", keyHash: keyHashOf("captain"), address: fakeAddress("captain") };
    },
    async operator() {
      return { keyId: "operator", keyHash: keyHashOf("operator"), address: fakeAddress("operator") };
    },
  };

  const treasuryAddressFor = (userId: string) => {
    const t = treasuries.get(userId);
    if (!t) throw new Error(`fake chain: no treasury for user ${userId} (call keys.treasury first)`);
    return t.address;
  };

  /** The session's current vault: newest vault address that holds funds, else the newest one. */
  const currentVault = (sessionId: string): string => {
    const all = (sessionAddresses.get(sessionId) ?? []).filter((a) => vaults.has(a));
    if (!all.length) throw new Error(`fake chain: session ${sessionId} has no Session Vault`);
    return [...all].reverse().find((a) => bal(a).tusdMicro > 0n || bal(a).lovelace > 0n) ?? all[all.length - 1]!;
  };
  const sweepVaults = (sessionId: string, kind: FailOp, toAddress: string, metadata: Record<string, unknown> | undefined, args: unknown): TxResult => {
    const addr = currentVault(sessionId);
    const b = bal(addr);
    if (b.tusdMicro === 0n && b.lovelace === 0n) throw Object.assign(new Error(`fake chain: nothing to sweep for ${sessionId}`), { name: "NothingToSweepError", code: "NOTHING_TO_SWEEP" });
    const t = b.tusdMicro;
    const l = b.lovelace - FAKE_FEE_LOVELACE;
    b.tusdMicro = 0n;
    b.lovelace = 0n;
    return submit(kind, [addr], [{ address: toAddress, tusdMicro: t, lovelace: l > 0n ? l : 0n }], args, metadata);
  };

  const tx: TxService = {
    async fundSessions({ userId, outputs, metadata }) {
      checkFail("fundSessions");
      const from = treasuryAddressFor(userId);
      const outs = outputs.map((o: FundingOutput) => ({ address: o.address, tusdMicro: o.tusdMicro, lovelace: FAKE_MIN_ADA + (o.extraLovelace ?? 0n) }));
      const totalT = outs.reduce((s, o) => s + o.tusdMicro, 0n);
      const totalL = outs.reduce((s, o) => s + o.lovelace, 0n) + FAKE_FEE_LOVELACE;
      debit(from, totalT, totalL);
      return submit("fundSessions", [from], outs, { userId, outputs }, metadata);
    },
    async previewFunding({ outputs }) {
      const totalTusdMicro = outputs.reduce((s, o) => s + o.tusdMicro, 0n);
      const totalLovelace = outputs.reduce((s, o) => s + FAKE_MIN_ADA + (o.extraLovelace ?? 0n), 0n) + FAKE_FEE_LOVELACE;
      return { feeLovelace: FAKE_FEE_LOVELACE, totalLovelace, totalTusdMicro };
    },
    async sessionPay({ sessionId, payee, tusdMicro, memo, reference }) {
      checkFail("sessionPay");
      // The session's current wallet = the newest address that holds funds (an extend moves funds to a new one).
      const from = [...(sessionAddresses.get(sessionId) ?? [])].reverse().find((a) => bal(a).tusdMicro > 0n || bal(a).lovelace > 0n) ?? sessionToAddress.get(sessionId);
      if (!from) throw new Error(`fake chain: unknown session ${sessionId}`);
      // Payee receives tUSD + min-ADA; the session pays fee + min-ADA out of its lovelace.
      debit(from, tusdMicro, FAKE_MIN_ADA + FAKE_FEE_LOVELACE);
      return submit("sessionPay", [from], [{ address: payee, tusdMicro, lovelace: FAKE_MIN_ADA }], { sessionId, payee, tusdMicro, memo, reference }, {
        674: { msg: [memo], ...(reference ? { ref: reference } : {}) },
      });
    },
    async sweep({ sessionId, signer, toAddress, metadata674 }) {
      checkFail("sweep");
      // Spend ALL UTxOs of the session's wallet(s) (except the destination, for extend-to-new-wallet).
      const froms = (sessionAddresses.get(sessionId) ?? []).filter((a) => a !== toAddress && (bal(a).tusdMicro > 0n || bal(a).lovelace > 0n));
      if (!sessionAddresses.has(sessionId)) throw new Error(`fake chain: unknown session ${sessionId}`);
      if (froms.length === 0) throw Object.assign(new Error(`fake chain: nothing to sweep for ${sessionId}`), { name: "NothingToSweepError", code: "NOTHING_TO_SWEEP" });
      let t = 0n;
      let l = -FAKE_FEE_LOVELACE;
      for (const a of froms) {
        const b = bal(a);
        t += b.tusdMicro;
        l += b.lovelace;
        b.tusdMicro = 0n;
        b.lovelace = 0n;
      }
      return submit("sweep", froms, [{ address: toAddress, tusdMicro: t, lovelace: l > 0n ? l : 0n }], { sessionId, signer, toAddress, metadata674 }, { 674: metadata674 });
    },
    async operatorSend({ toAddress, tusdMicro, lovelace, reference }) {
      checkFail("operatorSend");
      const op = fakeAddress("operator");
      return submit("operatorSend", [op], [{ address: toAddress, tusdMicro, lovelace }], { toAddress, tusdMicro, lovelace, reference }, { 674: { msg: ["bulkhead topup", reference] } });
    },
    async mintTusd({ tusdMicro, toAddress }) {
      checkFail("mintTusd");
      return submit("mintTusd", [], [{ address: toAddress ?? fakeAddress("operator"), tusdMicro, lovelace: FAKE_MIN_ADA }], { tusdMicro, toAddress });
    },
    async balanceOf(address): Promise<Balance> {
      const b = balances.get(address) ?? { tusdMicro: 0n, lovelace: 0n };
      return { lovelace: b.lovelace, tusdMicro: b.tusdMicro, utxoCount: b.lovelace > 0n || b.tusdMicro > 0n ? 1 : 0 };
    },
    tusdUnit: () => FAKE_TUSD_UNIT,
    async buildUnsignedFunding({ fromAddress, outputs, metadata }): Promise<UnsignedTx> {
      const outs = outputs.map((o: FundingOutput) => ({ address: o.address, tusdMicro: o.tusdMicro, lovelace: FAKE_MIN_ADA + (o.extraLovelace ?? 0n) }));
      const totalTusdMicro = outs.reduce((s, o) => s + o.tusdMicro, 0n);
      const totalLovelace = outs.reduce((s, o) => s + o.lovelace, 0n) + FAKE_FEE_LOVELACE;
      const b = bal(fromAddress);
      if (b.tusdMicro < totalTusdMicro || b.lovelace < totalLovelace) throw new Error(`fake chain: insufficient funds at ${fromAddress.slice(0, 20)}…`);
      const txHash = sha(`unsigned:${++txCounter}:${fromAddress}`);
      return { unsignedTx: toHex({ fake: "unsigned", txHash, fromAddress, outputs: outs, metadata }), txHash, feeLovelace: FAKE_FEE_LOVELACE, totalLovelace, totalTusdMicro };
    },
    async submitSigned({ fromAddress, unsignedTx, signed, requiredKeyHash }) {
      checkFail("fundSessions");
      const u = fromHex(unsignedTx);
      const w = fromHex(signed);
      if (u.fake !== "unsigned" || u.fromAddress !== fromAddress) throw new Error("fake chain: not an unsigned tx for this wallet");
      if (!w.witness || w.txHash !== u.txHash) throw new Error("fake chain: signature does not match the tx");
      if (requiredKeyHash && w.witness !== requiredKeyHash) throw new Error("fake chain: tx is not signed by the wallet's payment key");
      if (txs.some((t) => t.txHash === u.txHash)) throw new Error("fake chain: already submitted");
      const outs = (u.outputs as { address: string; tusdMicro: string; lovelace: string }[]).map((o) => ({ address: o.address, tusdMicro: BigInt(o.tusdMicro), lovelace: BigInt(o.lovelace) }));
      debit(fromAddress, outs.reduce((s, o) => s + o.tusdMicro, 0n), outs.reduce((s, o) => s + o.lovelace, 0n) + FAKE_FEE_LOVELACE);
      const tx: FakeTx = { txHash: String(u.txHash), kind: "fundSessions", at: now(), confirmed: false, from: [fromAddress], outputs: outs, metadata: u.metadata as Record<string, unknown> | undefined, args: { fromAddress, selfCustody: true } };
      txs.push(tx);
      for (const o of outs) {
        const b = bal(o.address);
        b.tusdMicro += o.tusdMicro;
        b.lovelace += o.lovelace;
      }
      if (opts.autoConfirmMs !== undefined) setTimeout(() => confirm(tx), opts.autoConfirmMs);
      return { txHash: tx.txHash, feeLovelace: FAKE_FEE_LOVELACE, cborHex: signed };
    },
  };

  const vaultTx = {
    // ── Fake Session Vault (walletMode "vault"): same rules as contracts/validators/session_vault.ak ──
    async vaultFund({ userId, outputs, metadata }: { userId: string; outputs: FundingOutput[]; metadata?: Record<string, unknown> }) {
      checkFail("vaultFund");
      for (const o of outputs) if (!vaults.has(o.address)) throw new Error(`fake chain: ${o.address.slice(0, 20)}… is not a Session Vault address`);
      const from = treasuryAddressFor(userId);
      const outs = outputs.map((o: FundingOutput) => ({ address: o.address, tusdMicro: o.tusdMicro, lovelace: FAKE_MIN_ADA + (o.extraLovelace ?? 0n) }));
      debit(from, outs.reduce((s, o) => s + o.tusdMicro, 0n), outs.reduce((s, o) => s + o.lovelace, 0n) + FAKE_FEE_LOVELACE);
      return submit("vaultFund", [from], outs, { userId, outputs, datum: "Void" }, metadata);
    },
    async vaultPay({ sessionId, payee, tusdMicro, memo, reference }: { sessionId: string; payee: string; tusdMicro: bigint; memo: string; reference?: string }) {
      checkFail("vaultPay");
      const from = currentVault(sessionId);
      const v = vaults.get(from)!;
      const leavingLovelace = FAKE_MIN_ADA + FAKE_FEE_LOVELACE;
      const fail = (rule: string) => {
        const error = `fake chain: script evaluation failed (session_vault.spend, redeemer Pay): ${rule}`;
        vaultRejections.push({ op: "vaultPay", sessionId, error });
        throw new FakeVaultScriptError(error);
      };
      if (now() >= v.expiryMs) fail("validity upper bound > expiry");
      if (!v.payees.includes(payee)) fail("output to a payment credential not in payees");
      if (tusdMicro > v.perTxMaxTusdMicro) fail(`leaving tUSD ${tusdMicro} > per_tx_max_tusd ${v.perTxMaxTusdMicro}`);
      if (leavingLovelace > v.adaAllowanceLovelace) fail(`leaving lovelace ${leavingLovelace} > ada_allowance ${v.adaAllowanceLovelace}`);
      debit(from, tusdMicro, leavingLovelace);
      return submit("vaultPay", [from], [{ address: payee, tusdMicro, lovelace: FAKE_MIN_ADA }], { sessionId, payee, tusdMicro, memo, reference }, {
        674: { msg: [memo], ...(reference ? { ref: reference } : {}) },
      });
    },
    async vaultRevoke({ sessionId, toAddress, metadata674 }: { sessionId: string; toAddress: string; metadata674: Record<string, unknown> }) {
      checkFail("vaultRevoke");
      const addr = currentVault(sessionId);
      const v = vaults.get(addr)!;
      if (toAddress !== v.ownerAddress) {
        const error = "fake chain: script evaluation failed (session_vault.spend, redeemer Revoke): non-own output not to owner";
        vaultRejections.push({ op: "vaultRevoke", sessionId, error });
        throw new FakeVaultScriptError(error);
      }
      return sweepVaults(sessionId, "vaultRevoke", toAddress, { 674: metadata674 }, { sessionId, toAddress, metadata674, redeemer: "Revoke" });
    },
    async vaultRecover({ sessionId, signerKeyId, metadata674 }: { sessionId: string; signerKeyId?: string; metadata674?: Record<string, unknown> }) {
      checkFail("vaultRecover");
      const addr = currentVault(sessionId);
      const v = vaults.get(addr)!;
      if (now() <= v.expiryMs) throw Object.assign(new Error(`fake chain: vault not expired yet (expiry ${new Date(v.expiryMs).toISOString()})`), { name: "NotYetExpiredError", code: "NOT_YET_EXPIRED" });
      return sweepVaults(sessionId, "vaultRecover", v.ownerAddress, metadata674 ? { 674: metadata674 } : undefined, { sessionId, signerKeyId, metadata674, redeemer: "Recover" });
    },
  };
  Object.assign(tx, vaultTx);

  const chain: FakeChain = {
    provider,
    watcher,
    keys,
    tx,
    buildSessionScript(p: SessionScriptParams): SessionScript {
      const scriptJson = {
        type: "any",
        scripts: [
          { type: "all", scripts: [{ type: "sig", keyHash: p.sessionKeyHash }, { type: "before", slot: String(p.expirySlot) }] },
          { type: "sig", keyHash: p.captainKeyHash },
          { type: "all", scripts: [{ type: "sig", keyHash: p.ownerKeyHash }, { type: "after", slot: String(p.expirySlot) }] },
        ],
      };
      const scriptHash = sha(JSON.stringify(scriptJson)).slice(0, 56);
      const address = fakeAddress(`script:${scriptHash}:${p.ownerStakeKeyHash ?? ""}`);
      const sessionId = keyHashToSession.get(p.sessionKeyHash);
      if (sessionId) {
        sessionToAddress.set(sessionId, address);
        const all = sessionAddresses.get(sessionId) ?? [];
        if (!all.includes(address)) all.push(address);
        sessionAddresses.set(sessionId, all);
      }
      return { scriptJson, scriptCbor: `8201${scriptHash}`, scriptHash, address };
    },
    slotFromTime,
    timeFromSlot,
    addressKeyHashes: (address: string) => ({ paymentKeyHash: fakeWalletKeyHash(address), stakeKeyHash: null }),
    tick() {
      for (const t of txs) confirm(t);
      const slot = slotFromTime(now());
      for (const [sessionId, s] of [...expiries]) {
        if (slot >= s) {
          expiries.delete(sessionId);
          emit({ type: "expiry_reached", sessionId, slot });
        }
      }
    },
    credit(address, tusdMicro, lovelace = 0n) {
      const b = bal(address);
      b.tusdMicro += tusdMicro;
      b.lovelace += lovelace;
    },
    failNext(op, times = 1, message = `fake chain: injected ${op} failure`) {
      failures.set(op, { times, message });
    },
    balance(address) {
      const b = balances.get(address) ?? { tusdMicro: 0n, lovelace: 0n };
      return { ...b };
    },
    txs,
    sessionAddress: (id) => sessionToAddress.get(id),
    calls,
    setNow(ms) {
      clock = ms;
    },
    watched: { addresses: watchedAddresses, txs: watchedTxs },
    applyVaultParams(p: FakeVaultParams) {
      // Same validation as the real client (validateVaultParams).
      if (!p.payees.length) throw new Error("fake chain: payees must be a non-empty list");
      if (p.payees.length > 10) throw new Error("fake chain: at most 10 payees");
      const paramsJson = { ...p, perTxMaxTusdMicro: p.perTxMaxTusdMicro.toString(), adaAllowanceLovelace: p.adaAllowanceLovelace.toString() };
      const scriptHash = sha(`vault:${JSON.stringify(paramsJson)}`).slice(0, 56);
      const address = fakeAddress(`vault:${scriptHash}`);
      vaults.set(address, { ...p, payees: [...p.payees] });
      const sessionId = keyHashToSession.get(p.sessionKeyHash);
      if (sessionId) {
        sessionToAddress.set(sessionId, address);
        const all = sessionAddresses.get(sessionId) ?? [];
        if (!all.includes(address)) all.push(address);
        sessionAddresses.set(sessionId, all);
      }
      return { scriptCbor: `5900${scriptHash}`, scriptHash, address, paramsJson };
    },
    vaultAt: (address) => vaults.get(address),
    vaultRejections,
  };
  return chain;
}
