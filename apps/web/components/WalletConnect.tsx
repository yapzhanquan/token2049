"use client";
// "Connect wallet" (CIP-30 via Mesh 1.9 @meshsdk/react). Self-custody: the treasury becomes the
// user's own wallet and they sign funding / approvals in the browser. Preprod only: a wallet on
// mainnet (networkId 1) is refused before anything is linked or signed.
// Linking needs proof of control: the engine issues a one-time nonce, the wallet signs the message
// with CIP-30 signData (CIP-8 COSE_Sign1) and the engine verifies it (Mesh checkSignature) before the
// wallet becomes the treasury. The same signData is published to the app for signed decision approvals.
// Loaded lazily (next/dynamic, ssr: false) so Mesh is not in the first page load.
import { useEffect, useState } from "react";
import { MeshProvider, useWallet, useWalletList } from "@meshsdk/react";
import type { MeDTO } from "@bulkhead/shared";
import { api } from "@/lib/client";
import { shortAddr } from "@/lib/money";
import { signDataError, type WalletState } from "@/lib/wallet-context";

const TESTNET = 0;

export default function WalletLayer(props: { me: MeDTO | null; onChanged: () => void; onState: (s: WalletState) => void; startOpen?: boolean }) {
  return (
    <MeshProvider>
      <WalletMenu {...props} />
    </MeshProvider>
  );
}

function WalletMenu({ me, onChanged, onState, startOpen = false }: { me: MeDTO | null; onChanged: () => void; onState: (s: WalletState) => void; startOpen?: boolean }) {
  const wallets = useWalletList();
  const { connect, disconnect, connected, wallet, name, connecting } = useWallet();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Publish the signer to the rest of the app.
  useEffect(() => {
    if (!connected || !wallet) {
      onState({ connected: false });
      return;
    }
    onState({
      connected: true,
      name,
      signTx: async (unsignedTx: string) => {
        const net = await wallet.getNetworkId();
        if (net !== TESTNET) throw new Error("Your wallet is on mainnet. Switch it to preprod; Bulkhead never signs on mainnet.");
        return wallet.signTx(unsignedTx, true);
      },
      signData: async (payload: string, address: string) => {
        const net = await wallet.getNetworkId();
        if (net !== TESTNET) throw new Error("Your wallet is on mainnet. Switch it to preprod; Bulkhead never signs on mainnet.");
        if (!address.startsWith("addr_test1")) throw new Error("Refusing to sign for a non-preprod address.");
        try {
          const sig = await wallet.signData(payload, address);
          return { signature: sig.signature, key: sig.key };
        } catch (e) {
          throw new Error(signDataError(e, address));
        }
      },
    });
  }, [connected, wallet, name, onState]);

  const link = async (walletName: string) => {
    setErr(null);
    setBusy(true);
    try {
      await connect(walletName, false);
    } catch (e) {
      setErr(`Connection refused: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const useAsTreasury = async () => {
    if (!wallet) return;
    setErr(null);
    setBusy(true);
    try {
      const net = await wallet.getNetworkId();
      if (net !== TESTNET) throw new Error("This wallet is on mainnet. Switch it to preprod first.");
      const addr = await wallet.getChangeAddress();
      if (!addr.startsWith("addr_test1")) throw new Error(`Not a testnet address: ${addr.slice(0, 16)}…`);
      // Proof of control: sign the server's one-time message (no transaction, no fee).
      const n = await api<{ nonce: string; payload: string }>("/wallet-auth/nonce", { base: "/api", method: "POST", body: { purpose: "link", address: addr } });
      let sig: { signature: string; key: string };
      try {
        sig = await wallet.signData(n.payload, addr);
      } catch (e) {
        throw new Error(signDataError(e, addr));
      }
      await api("/custody", { base: "/api", method: "POST", body: { custody: "self", walletAddress: addr, nonce: n.nonce, signature: sig.signature, key: sig.key } });
      onChanged();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const backToCustodial = async () => {
    setBusy(true);
    try {
      await api("/custody", { base: "/api", method: "POST", body: { custody: "custodial" } });
      disconnect();
      onChanged();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {connected ? `${name ?? "Wallet"} connected` : "Connect wallet"}
      </button>
      {open && (
        <div className="panel absolute right-0 top-10 z-40 w-[320px] p-3 flex flex-col gap-3">
          <div className="text-[13px]">
            <b>Custody:</b>{" "}
            {me?.custody === "self" ? "Self-custody — your wallet is the treasury." : "Custodial on testnet — the server holds your treasury key (encrypted)."}
          </div>
          {!connected && (
            <>
              <div className="label">CIP-30 wallets in this browser (set the wallet to preprod):</div>
              {wallets.length === 0 && <div className="text-[12px] mid">No Cardano wallet extension found. Install Lace, Eternl or similar.</div>}
              <div className="flex flex-col gap-1">
                {wallets.map((w) => (
                  <button key={w.id} type="button" className="btn justify-start" disabled={busy || connecting} onClick={() => link(w.id)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
                    {w.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {connected && (
            <>
              {me?.custody === "self" ? (
                <div className="text-[12px] mid">
                  Treasury: <span className="mono">{shortAddr(me.treasuryAddress)}</span>. Funding and approvals ask your wallet to sign.
                </div>
              ) : (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={useAsTreasury}>
                  Sign to use this wallet as my treasury (self-custody)
                </button>
              )}
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={() => disconnect()}>
                  Disconnect
                </button>
                {me?.custody === "self" && (
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={backToCustodial}>
                    Switch back to custodial
                  </button>
                )}
              </div>
            </>
          )}
          {err && <div className="text-[12px] bad">{err}</div>}
        </div>
      )}
    </div>
  );
}
