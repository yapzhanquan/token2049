"use client";
// Sign in with a Cardano wallet:
//  1. connect a CIP-30 wallet (Mesh @meshsdk/react), refuse mainnet (getNetworkId() must be 0);
//  2. ask the server for a one-time nonce bound to the wallet's preprod address (stored with an expiry);
//  3. the wallet signs the returned message with CIP-30 signData (CIP-8 COSE_Sign1) — no tx, no fee;
//  4. Auth.js credentials provider "wallet" sends it to the engine, which verifies the signature against
//     the address (Mesh checkSignature), burns the nonce and upserts the user (identity wallet:<stake_test1…>,
//     custody self: this wallet is the treasury).
import { useState } from "react";
import { signIn } from "next-auth/react";
import { MeshProvider, useWallet, useWalletList } from "@meshsdk/react";
import { signDataError } from "@/lib/wallet-context";

const TESTNET = 0;

export default function WalletLoginInner() {
  return (
    <MeshProvider>
      <Picker />
    </MeshProvider>
  );
}

function Picker() {
  const wallets = useWalletList();
  const { connect, wallet, connected, name } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const go = async (walletId: string) => {
    setErr(null);
    setBusy(walletId);
    try {
      if (!connected || name !== walletId) await connect(walletId, false);
    } catch (e) {
      setErr(`Connection refused: ${(e as Error).message}`);
      setBusy(null);
      return;
    }
    setBusy(null);
  };

  const signInWithWallet = async () => {
    if (!wallet) return;
    setErr(null);
    setBusy("sign");
    try {
      const net = await wallet.getNetworkId();
      if (net !== TESTNET) throw new Error("This wallet is on mainnet. Switch it to preprod; Bulkhead is testnet-only.");
      const address = await wallet.getChangeAddress();
      if (!address.startsWith("addr_test1")) throw new Error(`Not a preprod address: ${address.slice(0, 16)}…`);
      const res = await fetch("/api/wallet-auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "login", address }), cache: "no-store" });
      const n = (await res.json().catch(() => ({}))) as { nonce?: string; payload?: string; error?: string };
      if (!res.ok || !n.nonce || !n.payload) throw new Error(n.error ?? `Could not start wallet sign-in (${res.status})`);
      let sig: { signature: string; key: string };
      try {
        sig = await wallet.signData(n.payload, address);
      } catch (e) {
        throw new Error(signDataError(e, address));
      }
      const r = await signIn("wallet", { address, nonce: n.nonce, signature: sig.signature, key: sig.key, redirect: false });
      if (!r || r.error) throw new Error("The server could not verify the wallet signature. Try again.");
      window.location.href = "/";
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!connected && (
        <>
          {wallets.length === 0 && <div className="text-[12px] mid">No Cardano wallet extension found. Install Lace, Eternl or similar and set it to preprod.</div>}
          {wallets.map((w) => (
            <button key={w.id} type="button" className="btn justify-start w-full" disabled={!!busy} onClick={() => void go(w.id)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
              {w.name}
            </button>
          ))}
        </>
      )}
      {connected && (
        <button type="button" className="btn btn-primary w-full h-10" disabled={!!busy} onClick={() => void signInWithWallet()}>
          {busy === "sign" ? "Waiting for your wallet…" : `Sign the sign-in message with ${name ?? "wallet"}`}
        </button>
      )}
      <div className="text-[12px] mid">
        You sign a one-time text message (CIP-8). It is not a transaction and costs nothing. Your wallet becomes your self-custody treasury.
      </div>
      {err && <div className="text-[12px] bad">{err}</div>}
    </div>
  );
}
