"use client";
// Short id / tx hash / address chip: click the value to "use" it (e.g. search the Activity log), COPY to
// copy the full value, ↗ to open preprod.cardanoscan.io for tx hashes and addresses.
import { useState } from "react";
import { explorerAddress, explorerTx } from "@bulkhead/shared";
import { copyText, useConfig, useLive } from "@/lib/client";
import { shortAddr, shortHash } from "@/lib/money";

export type IdKind = "id" | "tx" | "addr";

export function IdChip({ value, kind = "id", label, onPick, title }: { value: string; kind?: IdKind; label?: string; onPick?: (v: string) => void; title?: string }) {
  const { fixture } = useConfig();
  const [copied, setCopied] = useState(false);
  const shown = kind === "addr" ? shortAddr(value, 9) : kind === "tx" ? shortHash(value) : value.length > 18 ? shortHash(value) : value;
  const href = fixture ? null : kind === "tx" ? explorerTx(value) : kind === "addr" ? explorerAddress(value) : null;
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <span className="idchip" title={title ?? value}>
      {label && <span className="idchip-k">{label}</span>}
      {onPick ? (
        <button type="button" onClick={() => onPick(value)} title={`Show the activity of ${value}`}>
          {shown}
        </button>
      ) : (
        <span style={{ padding: "1px 5px" }}>{shown}</span>
      )}
      <span className="idchip-sep" />
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${value}`} className={copied ? "good" : undefined}>
        {copied ? "COPIED" : "COPY"}
      </button>
      {href && (
        <>
          <span className="idchip-sep" />
          <a href={href} target="_blank" rel="noreferrer" aria-label="Open on cardanoscan (preprod)">
            ↗
          </a>
        </>
      )}
    </span>
  );
}

/** "Reconnecting…" line shown while the engine restarts (instead of "Failed to fetch"). */
export function Reconnecting({ what, className }: { what?: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 text-[12.5px] mid ${className ?? ""}`} role="status" aria-live="polite">
      <span className="live-dot off" />
      Reconnecting to the engine{what ? ` (${what})` : ""}… data refreshes automatically.
    </div>
  );
}

/** Small live/offline indicator for the SSE stream. */
export function LiveDot() {
  const { connected, reconnecting } = useLive();
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] muted" title={connected ? "Live: events stream in over SSE" : "Reconnecting to the live event stream"}>
      <span className={`live-dot ${connected ? "" : "off"}`} />
      {connected ? "Live" : reconnecting ? "Reconnecting…" : "Connecting…"}
    </span>
  );
}
