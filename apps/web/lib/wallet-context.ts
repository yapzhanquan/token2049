"use client";
// The CIP-30 wallet lives in a lazily loaded layer (components/WalletConnect.tsx pulls in Mesh,
// several MB). The rest of the app only sees this small context.
import { createContext, useContext } from "react";

/** CIP-30 DataSignature (CIP-8 COSE_Sign1 + COSE_Key, hex CBOR). */
export interface DataSignature {
  signature: string;
  key: string;
}

export interface WalletState {
  connected: boolean;
  name?: string;
  /** Signs an engine-built unsigned tx (partial sign); refuses a mainnet wallet. */
  signTx?: (unsignedTx: string) => Promise<string>;
  /** CIP-30 signData (Mesh wallet.signData(payload, address)); refuses a mainnet wallet. */
  signData?: (payload: string, address: string) => Promise<DataSignature>;
}

export const WalletContext = createContext<WalletState>({ connected: false });

export function useWalletSigner(): ((unsignedTx: string) => Promise<string>) | null {
  const w = useContext(WalletContext);
  return w.connected && w.signTx ? w.signTx : null;
}

export function useWalletState(): WalletState {
  return useContext(WalletContext);
}

/** CIP-30 DataSignError codes: 1 ProofGeneration, 2 AddressNotPK, 3 UserDeclined. */
export function signDataError(e: unknown, address: string): string {
  const code = (e as { code?: number } | null)?.code;
  const info = (e as { info?: string; message?: string } | null)?.info ?? (e as Error | null)?.message ?? String(e);
  if (code === 3 || /declin|reject|cancel/i.test(info)) return "You declined the signature request in your wallet.";
  if (code === 1) return `Your wallet could not sign for ${address.slice(0, 16)}… (is that address in this wallet account?)`;
  if (code === 2) return "That address is not a key address, so the wallet cannot sign for it.";
  return `Wallet signature failed: ${info}`;
}
