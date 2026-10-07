// An in-memory, random Ed25519 key for permissionless-Recover tests ("a random party recovers the vault").
// The private key lives only in this closure: never persisted, never logged, gone when the process exits.
import { randomBytes } from "node:crypto";
import type { ChainProvider, Utxo } from "../types";
import { cst, ensureCryptoReady, MeshTxBuilder, type MeshProtocol, type MeshUTxO } from "../mesh";
import { signTxWith } from "../keys";

export interface ThrowawayKey {
  keyHash: string;
  /** Enterprise preprod address of the key. */
  address: string;
  /** Add this key's vkey witness to a tx. */
  sign(txHex: string): string;
  /** Send everything at the key's address to `toAddress` (signed + submitted); returns the tx hash. */
  sweepAll(provider: ChainProvider, toAddress: string, protocolParams: MeshProtocol): Promise<string | null>;
}

export async function createThrowawayKey(): Promise<ThrowawayKey> {
  await ensureCryptoReady();
  const seed = randomBytes(32);
  const key = cst.Ed25519PrivateKey.fromNormalBytes(new Uint8Array(seed));
  seed.fill(0);
  const keyHash = key.toPublic().hash().hex();
  const address = cst.serializeAddress({ pubKeyHash: keyHash }, 0);
  const sign = (txHex: string) => signTxWith(txHex, key);
  return {
    keyHash,
    address,
    sign,
    async sweepAll(provider, toAddress, protocolParams) {
      const utxos: Utxo[] = await provider.fetchUtxos(address);
      if (utxos.length === 0) return null;
      const tip = await provider.fetchTip();
      const b = new MeshTxBuilder({ params: protocolParams });
      for (const u of utxos) b.txIn(u.txHash, u.outputIndex, u.amount, u.address, 0);
      const hex = await b
        .selectUtxosFrom(utxos.map((u): MeshUTxO => ({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } })))
        .changeAddress(toAddress)
        .invalidHereafter(tip.slot + 900)
        .complete();
      return provider.submitTx(sign(hex));
    },
  };
}

/**
 * An in-memory stand-in for a CIP-30 browser wallet (tests + the self-custody preprod run): a random payment
 * key AND a random stake key → a BASE preprod address (so vaults owned by it carry its stake credential).
 * `signTx(tx, partialSign)` mirrors CIP-30: it returns ONLY the TransactionWitnessSet CBOR (one vkey witness).
 * Keys live only in this closure: never persisted, never logged.
 */
export interface ThrowawayWallet {
  address: string;
  paymentKeyHash: string;
  stakeKeyHash: string;
  /** CIP-30 api.signTx(txCbor, true) → witness set CBOR hex. */
  signTx(txHex: string): string;
  /** Send everything at the wallet to `toAddress` (signed + submitted); returns the tx hash, or null if empty. */
  sweepAll(provider: ChainProvider, toAddress: string, protocolParams: MeshProtocol): Promise<string | null>;
}

export async function createThrowawayWallet(): Promise<ThrowawayWallet> {
  await ensureCryptoReady();
  const mk = () => {
    const seed = randomBytes(32);
    const k = cst.Ed25519PrivateKey.fromNormalBytes(new Uint8Array(seed));
    seed.fill(0);
    return k;
  };
  const pay = mk();
  const stake = mk();
  const paymentKeyHash = pay.toPublic().hash().hex();
  const stakeKeyHash = stake.toPublic().hash().hex();
  const address = cst.serializeAddress({ pubKeyHash: paymentKeyHash, stakeCredentialHash: stakeKeyHash }, 0);
  const signTx = (txHex: string) => cst.deserializeTx(signTxWith(txHex, pay)).witnessSet().toCbor();
  return {
    address,
    paymentKeyHash,
    stakeKeyHash,
    signTx,
    async sweepAll(provider, toAddress, protocolParams) {
      const utxos: Utxo[] = await provider.fetchUtxos(address);
      if (utxos.length === 0) return null;
      const tip = await provider.fetchTip();
      const b = new MeshTxBuilder({ params: protocolParams });
      for (const u of utxos) b.txIn(u.txHash, u.outputIndex, u.amount, u.address, 0);
      const hex = await b
        .selectUtxosFrom(utxos.map((u): MeshUTxO => ({ input: { txHash: u.txHash, outputIndex: u.outputIndex }, output: { address: u.address, amount: u.amount } })))
        .changeAddress(toAddress)
        .invalidHereafter(tip.slot + 900)
        .complete();
      return provider.submitTx(signTxWith(hex, pay));
    },
  };
}
