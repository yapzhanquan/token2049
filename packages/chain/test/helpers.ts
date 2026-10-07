// Offline test fixtures: a fake preprod provider (static UTxO sets, records submissions) and tx
// inspection helpers. Nothing here touches the network.
import type { ChainProvider, Tip, Utxo } from "../src/types";
import { cst, DEFAULT_PROTOCOL_PARAMETERS, EmbeddedWallet } from "../src/mesh";
import { timeFromSlot } from "../src/index";

export const TEST_MASTER = "7f".repeat(16) + "a1".repeat(16);
export const TEST_MNEMONIC = EmbeddedWallet.generateMnemonic(256).join(" ");
export const TIP_SLOT = 110_000_000;

let n = 0;
export const fakeHash = () => (++n).toString(16).padStart(64, "c");

export class FakeProvider implements ChainProvider {
  readonly name = "blockfrost" as const;
  readonly network = "preprod" as const;
  utxos = new Map<string, Utxo[]>();
  submitted: string[] = [];
  tipSlot = TIP_SLOT;
  submitDelayMs = 0;
  fetchUtxosCalls = 0;

  add(address: string, lovelace: bigint, tokens: Record<string, bigint> = {}, txHash = fakeHash(), outputIndex = 0): Utxo {
    const u: Utxo = {
      txHash,
      outputIndex,
      address,
      amount: [{ unit: "lovelace", quantity: lovelace.toString() }, ...Object.entries(tokens).map(([unit, q]) => ({ unit, quantity: q.toString() }))],
    };
    this.utxos.set(address, [...(this.utxos.get(address) ?? []), u]);
    return u;
  }
  async fetchUtxos(address: string): Promise<Utxo[]> {
    this.fetchUtxosCalls++;
    await new Promise((r) => setTimeout(r, 1));
    return (this.utxos.get(address) ?? []).map((u) => ({ ...u, amount: u.amount.map((a) => ({ ...a })) }));
  }
  async fetchTip(): Promise<Tip> {
    return { slot: this.tipSlot, time: timeFromSlot(this.tipSlot), height: 1 };
  }
  async fetchProtocolParameters(): Promise<unknown> {
    return { ...DEFAULT_PROTOCOL_PARAMETERS };
  }
  async submitTx(cborHex: string): Promise<string> {
    if (this.submitDelayMs) await new Promise((r) => setTimeout(r, this.submitDelayMs));
    this.submitted.push(cborHex);
    return cst.resolveTxHash(cborHex);
  }
  async fetchTxConfirmation(_txHash: string): Promise<{ blockHeight: number; slot: number } | null> {
    return null;
  }
}

/** vkey witnesses of a signed tx, each verified against the tx body hash. */
export function witnesses(hex: string): Array<{ keyHash: string; valid: boolean }> {
  const tx = cst.deserializeTx(hex);
  const txHash = cst.resolveTxHash(hex);
  const vkeys = tx.witnessSet().vkeys();
  if (!vkeys) return [];
  return [...vkeys.values()].map((w) => {
    const pk = cst.Ed25519PublicKey.fromHex(w.vkey());
    return { keyHash: pk.hash().hex(), valid: pk.verify(cst.Ed25519Signature.fromHex(w.signature()), cst.HexBlob(txHash)) };
  });
}

function metaToJs(m: unknown): unknown {
  if (typeof m === "bigint") return Number(m);
  if (m instanceof Map) return Object.fromEntries([...m].map(([k, v]) => [String(metaToJs(k)), metaToJs(v)]));
  if (Array.isArray(m)) return m.map(metaToJs);
  return m;
}

/** Transaction metadata as plain JS: { "674": {...} }. */
export function metadataOf(hex: string): Record<string, any> {
  const aux = cst.deserializeTx(hex).auxiliaryData();
  const md = aux?.metadata()?.toCore();
  return md ? (metaToJs(md) as Record<string, any>) : {};
}
