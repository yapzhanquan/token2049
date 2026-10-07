"use client";
import { explorerAddress, explorerTx } from "@bulkhead/shared";
import { useConfig } from "@/lib/client";
import { shortAddr, shortHash } from "@/lib/money";

/** preprod.cardanoscan.io link. In fixture mode the hash is sample data, so no link is drawn. */
export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  const { fixture } = useConfig();
  if (!hash) return <span className="muted">—</span>;
  if (fixture)
    return (
      <span className="mono" title="Fixture data: not on-chain">
        {label ?? shortHash(hash)} <span className="muted">(fixture)</span>
      </span>
    );
  return (
    <a className="mono good" href={explorerTx(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? shortHash(hash)} ↗
    </a>
  );
}

export function AddrLink({ address }: { address: string | null | undefined }) {
  const { fixture } = useConfig();
  if (!address) return <span className="muted">—</span>;
  if (fixture)
    return (
      <span className="mono" title={address}>
        {shortAddr(address)} <span className="muted">(fixture)</span>
      </span>
    );
  return (
    <a className="mono good" href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>
      {shortAddr(address)} ↗
    </a>
  );
}
