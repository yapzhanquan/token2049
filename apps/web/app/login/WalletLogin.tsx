"use client";
// "Sign in with Cardano wallet". Mesh (several MB, needs window) loads only when the user asks for it.
import dynamic from "next/dynamic";
import { useState } from "react";

const Inner = dynamic(() => import("./WalletLoginInner"), {
  ssr: false,
  loading: () => <div className="text-[12px] mid">Loading wallet support…</div>,
});

export default function WalletLogin() {
  const [show, setShow] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="label">Cardano wallet (CIP-30, preprod)</div>
      {show ? (
        <Inner />
      ) : (
        <button type="button" className="btn btn-primary w-full h-10" onClick={() => setShow(true)}>
          Sign in with Cardano wallet
        </button>
      )}
    </div>
  );
}
