// Trust-receipt verifier (lib/verify-proof.ts), offline: Mesh core-cst via the chain package's loader (the browser
// uses @meshsdk/core's `cst`, the same functions) and an in-memory Blockfrost. Run: pnpm --filter @bulkhead/web test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionProofDTO, VaultParamsDTO } from "@bulkhead/shared";
import { cst } from "../../../packages/chain/src/mesh";
import { applyVaultParams, vaultParamsFromJson } from "../../../packages/chain/src/vault/params";
import { BUNDLED_BLUEPRINT, REDEEMER_HASH, recomputeVault, verifySession, type ChainReader, type CstLike } from "./verify-proof";

const C = cst as unknown as CstLike;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const addr = (pkh: string, skh?: string) => cst.serializeAddress(skh ? { pubKeyHash: pkh, stakeCredentialHash: skh } : { pubKeyHash: pkh }, 0);
const OWNER = addr("11".repeat(28), "12".repeat(28));
const PAYEE = addr("15".repeat(28), "25".repeat(28));
const PAYEE2 = addr("16".repeat(28));
const ATTACKER = addr("17".repeat(28), "12".repeat(28));
const POLICY = "19".repeat(28);
const NAME = "0014df10745553444d";
const UNIT = POLICY + NAME;
const EXPIRY = 1_791_400_000_000;
const msToSlot = (ms: number) => Math.floor((ms - 1_655_769_600_000) / 1000) + 86_400;
const H = (n: number) => n.toString(16).padStart(64, "0");
const [F, P, X, CL] = [H(1), H(2), H(3), H(4)];
const GOAL = "g_test-goal";
const SID = "ses_test";
const HANDBACK = JSON.stringify({ result: "Prices compared ✓\nline 2", summary: "done" });

const params: VaultParamsDTO = {
  ownerAddress: OWNER,
  captainKeyHash: "13".repeat(28),
  sessionKeyHash: "14".repeat(28),
  expiryMs: EXPIRY,
  payees: [PAYEE, PAYEE2],
  perTxMaxTusdMicro: "5000000",
  adaAllowanceLovelace: "3000000",
  tusdPolicyId: POLICY,
  tusdAssetNameHex: NAME,
};
const applied = applyVaultParams(vaultParamsFromJson(params as unknown as Record<string, unknown>));
const V = applied.address;
const am = (lovelace: number, tok: number) => [{ unit: "lovelace", quantity: String(lovelace) }, ...(tok ? [{ unit: UNIT, quantity: String(tok) }] : [])];

function chainData(over: { payTo?: string; payAmount?: number; extraSpend?: boolean; open?: boolean } = {}) {
  const payAmount = over.payAmount ?? 2_000_000;
  const d = new Map<string, unknown>();
  const tx = (h: string, extra: Record<string, unknown> = {}) => d.set(`/txs/${h}`, { hash: h, block_height: 100, slot: 1, valid_contract: true, invalid_hereafter: null, invalid_before: null, ...extra });
  tx(F);
  d.set(`/txs/${F}/utxos`, { hash: F, inputs: [{ address: OWNER, amount: am(50_000_000, 50_000_000), tx_hash: H(9), output_index: 0, collateral: false }], outputs: [{ address: V, amount: am(4_000_000, 10_000_000), output_index: 0, inline_datum: "d87980", collateral: false }] });
  tx(P, { invalid_hereafter: String(msToSlot(EXPIRY) - 10) });
  d.set(`/txs/${P}/utxos`, {
    hash: P,
    inputs: [{ address: V, amount: am(4_000_000, 10_000_000), tx_hash: F, output_index: 0, collateral: false }],
    outputs: [
      { address: over.payTo ?? PAYEE, amount: am(1_200_000, payAmount), output_index: 0, inline_datum: null, collateral: false },
      { address: V, amount: am(2_500_000, 10_000_000 - payAmount), output_index: 1, inline_datum: "d87980", collateral: false },
    ],
  });
  d.set(`/txs/${P}/redeemers`, [{ tx_index: 0, purpose: "spend", script_hash: applied.scriptHash, redeemer_data_hash: REDEEMER_HASH.Pay }]);
  const left = 10_000_000 - payAmount;
  const history = [{ tx_hash: F, block_height: 100 }, { tx_hash: P, block_height: 101 }];
  let closeIn = { amount: am(2_500_000, left), tx_hash: P, output_index: 1 };
  if (over.extraSpend) {
    tx(X);
    d.set(`/txs/${X}/utxos`, {
      hash: X,
      inputs: [{ address: V, ...closeIn, collateral: false }],
      outputs: [
        { address: ATTACKER, amount: am(1_200_000, 1_000_000), output_index: 0, inline_datum: null, collateral: false },
        { address: V, amount: am(1_100_000, left - 1_000_000), output_index: 1, inline_datum: "d87980", collateral: false },
      ],
    });
    d.set(`/txs/${X}/redeemers`, [{ tx_index: 0, purpose: "spend", script_hash: applied.scriptHash, redeemer_data_hash: REDEEMER_HASH.Pay }]);
    history.push({ tx_hash: X, block_height: 102 });
    closeIn = { amount: am(1_100_000, left - 1_000_000), tx_hash: X, output_index: 1 };
  }
  tx(CL);
  const closeTok = Number(closeIn.amount[1]?.quantity ?? 0);
  d.set(`/txs/${CL}/utxos`, {
    hash: CL,
    inputs: [{ address: V, ...closeIn, collateral: false }, { address: addr("13".repeat(28)), amount: am(10_000_000, 0), tx_hash: H(8), output_index: 0, collateral: true }],
    outputs: [
      { address: OWNER, amount: am(900_000, closeTok), output_index: 0, inline_datum: null, collateral: false },
      { address: addr("13".repeat(28)), amount: am(9_500_000, 0), output_index: 1, inline_datum: null, collateral: true },
    ],
  });
  d.set(`/txs/${CL}/redeemers`, [{ tx_index: 0, purpose: "spend", script_hash: applied.scriptHash, redeemer_data_hash: REDEEMER_HASH.Revoke }]);
  d.set(`/txs/${CL}/metadata`, [{ label: "674", json_metadata: { msg: ["Bulkhead session close (vault revoke)"], session_id: SID, handback_sha256: sha(HANDBACK), status: "COMPLETED", goal_id: GOAL, log_sha256: "ab".repeat(32) } }]);
  if (!over.open) history.push({ tx_hash: CL, block_height: 103 });
  d.set(`/addresses/${V}/transactions?order=asc&count=100&page=1`, history);
  d.set(`/addresses/${V}/utxos`, over.open ? [{ address: V, ...closeIn }] : []);
  const reader: ChainReader = { get: async <T,>(path: string) => (d.has(path) ? (d.get(path) as T) : null) };
  return { reader, left };
}

function proof(over: Partial<SessionProofDTO> = {}, left = 8_000_000): SessionProofDTO {
  return {
    version: 1,
    network: "preprod",
    sessionId: SID,
    goalId: GOAL,
    letter: "A",
    role: "buyer",
    name: "Buyer",
    status: "CLOSED",
    walletMode: "vault",
    mandate: { ownerAddress: OWNER, captainKeyHash: params.captainKeyHash, sessionKeyHash: params.sessionKeyHash, expiresAt: EXPIRY, payees: [PAYEE, PAYEE2], perTxMaxMicro: "5000000", adaAllowanceLovelace: "3000000", assetUnit: UNIT, budgetMicro: "10000000" },
    vault: { scriptVersion: "1.0.0", plutusVersion: "V3", validatorTitle: BUNDLED_BLUEPRINT.title, unappliedValidatorHash: BUNDLED_BLUEPRINT.hash, params, plutusParams: [], appliedScriptHash: applied.scriptHash, address: V },
    native: null,
    fundings: [{ kind: "initial", txHash: F, address: V, amountMicro: "10000000" }],
    payments: [{ paymentId: "pay_1", txHash: P, payee: PAYEE, amountMicro: "2000000", status: "confirmed", memo: "" }],
    rotations: [],
    close: { txHash: CL, kind: "revoke", status: "COMPLETED", toAddress: OWNER, refundMicro: String(left), metadata674: { session_id: SID, handback_sha256: sha(HANDBACK), log_sha256: "ab".repeat(32), goal_id: GOAL } },
    handback: { text: HANDBACK, sha256: sha(HANDBACK), rule: "sha256(utf8(handback.text))" },
    spentMicro: "2000000",
    claims: [],
    ...over,
  };
}

const statuses = (v: { claims: { id: string; status: string }[] }) => Object.fromEntries(v.claims.map((c) => [c.id, c.status]));

test("independent recompute = the chain package's applyVaultParams (same hash + address) and the pinned unapplied hash", () => {
  const r = recomputeVault(C, params);
  assert.equal(r.scriptHash, applied.scriptHash);
  assert.equal(r.address, applied.address);
  assert.equal(r.unappliedHash, "edd870abd45786e6352dba8ed4ae5cd0cf1f8952574c889ffad7726a");
  assert.equal(BUNDLED_BLUEPRINT.hash, r.unappliedHash);
  assert.deepEqual(BUNDLED_BLUEPRINT.parameters, ["owner", "captain_vkh", "session_vkh", "expiry", "payees", "per_tx_max_tusd", "ada_allowance", "tusd_policy", "tusd_name"]);
});

test("pinned against a real preprod vault (goal g_844d6715 session A, closed on-chain): params → f6643ed0…", () => {
  const live: VaultParamsDTO = {
    ownerAddress: "addr_test1qrw53vhedgt07xr8sv84sw05u0zfw6lcd0vu7q3mdyk5zxe3r7n72nj7w6yc3pefqjs86k2eke33app7yersgs8rqxts4zzkgp",
    captainKeyHash: "0877d04ae6af8516f7ab8863eec97c65e5502d5a99a30c33e65e7b88",
    sessionKeyHash: "a836d5877291626c7f55aefb284f0b7e5dfba0e28c6d7067e7162a6b",
    expiryMs: 1791347006868,
    payees: ["addr_test1qrw53vhedgt07xr8sv84sw05u0zfw6lcd0vu7q3mdyk5zxe3r7n72nj7w6yc3pefqjs86k2eke33app7yersgs8rqxts4zzkgp"],
    perTxMaxTusdMicro: "400000",
    adaAllowanceLovelace: "3000000",
    tusdPolicyId: "7704eb3b92e66ff0b5fadcf9ad8db3f1f817cb9ce054d32a5c6eac30",
    tusdAssetNameHex: "0014df1074555344",
  };
  const r = recomputeVault(C, live);
  assert.equal(r.scriptHash, "f6643ed0d213ae5f4fbd428cf715f0fe202fe57ae4125cb924d29cb5");
  assert.equal(r.address, "addr_test1zrmxg0ks6gf6uh60h4pgeac47rlzqtl90tjpyh9eynffedf3r7n72nj7w6yc3pefqjs86k2eke33app7yersgs8rqxts4d9l55");
});

test("honest session: every claim passes", async () => {
  const { reader } = chainData();
  const v = await verifySession(proof(), { reader, cst: C });
  assert.deepEqual(statuses(v), { contract: "pass", vault_address: "pass", funding: "pass", history: "pass", payments: "pass", close: "pass", handback: "pass" });
  assert.equal(v.status, "pass");
  assert.equal(v.recomputed?.scriptHash, applied.scriptHash);
  assert.match(v.claims.find((c) => c.id === "handback")!.detail, /goal g_test-goa/);
  assert.ok(v.claims.find((c) => c.id === "close")!.links.some((l) => l.url === `https://preprod.cardanoscan.io/transaction/${CL}`));
});

test("edited handback text → the on-chain hash no longer matches", async () => {
  const { reader } = chainData();
  const v = await verifySession(proof({ handback: { text: HANDBACK.replace("✓", "✗"), sha256: sha(HANDBACK), rule: "sha256(utf8(handback.text))" } }), { reader, cst: C });
  assert.equal(statuses(v).handback, "fail");
  assert.match(v.claims.find((c) => c.id === "handback")!.detail, /text was changed/);
  assert.equal(v.status, "fail");
});

test("engine lies about the script hash / the params → vault_address fails (the verifier never trusts the engine's hash)", async () => {
  const { reader } = chainData();
  const bad = proof({ vault: { ...proof().vault!, appliedScriptHash: "00".repeat(28) } });
  assert.equal(statuses(await verifySession(bad, { reader, cst: C })).vault_address, "fail");
  // payee list shown ≠ payees applied on-chain (different params → different address → nothing at it)
  const swapped = proof({ vault: { ...proof().vault!, params: { ...params, payees: [PAYEE, ATTACKER] } } });
  const s = statuses(await verifySession(swapped, { reader, cst: C }));
  assert.equal(s.vault_address, "fail");
  assert.equal(s.funding, "fail");
});

test("a spend the engine did not report (to an attacker) → history + payments fail", async () => {
  const { reader, left } = chainData({ extraSpend: true });
  const v = await verifySession(proof({}, left - 1_000_000), { reader, cst: C });
  const s = statuses(v);
  assert.equal(s.history, "fail");
  assert.equal(s.payments, "fail");
  assert.match(v.claims.find((c) => c.id === "payments")!.detail, /non-allowed address|not reported/);
});

test("payment above perTxMax or to a stranger → payments fails", async () => {
  {
    const { reader, left } = chainData({ payAmount: 6_000_000 });
    const p = proof({ payments: [{ paymentId: "p", txHash: P, payee: PAYEE, amountMicro: "6000000", status: "confirmed", memo: "" }] }, left);
    const v = await verifySession(p, { reader, cst: C });
    assert.equal(statuses(v).payments, "fail");
    assert.match(v.claims.find((c) => c.id === "payments")!.detail, /> cap/);
  }
  {
    const { reader } = chainData({ payTo: ATTACKER });
    const p = proof({ payments: [{ paymentId: "p", txHash: P, payee: ATTACKER, amountMicro: "2000000", status: "confirmed", memo: "" }] });
    assert.equal(statuses(await verifySession(p, { reader, cst: C })).payments, "fail");
  }
});

test("open session: close + handback are skipped, not failed", async () => {
  const { reader } = chainData({ open: true });
  const v = await verifySession(proof({ status: "RUNNING", close: null }), { reader, cst: C });
  const s = statuses(v);
  assert.equal(s.close, "skip");
  assert.equal(s.handback, "skip");
  assert.equal(s.funding, "pass");
  assert.equal(s.payments, "pass");
  assert.equal(v.status, "pass");
});

test("a close the engine never recorded (e.g. a permissionless Recover) is found on-chain and still verified", async () => {
  const { reader } = chainData();
  const v = await verifySession(proof({ close: null }), { reader, cst: C });
  const s = statuses(v);
  assert.equal(s.history, "pass");
  assert.match(v.claims.find((c) => c.id === "history")!.detail, /found on-chain/);
  assert.equal(s.close, "pass");
  assert.equal(s.handback, "pass");
});
