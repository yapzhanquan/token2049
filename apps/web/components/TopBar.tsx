"use client";
import type { ReactNode } from "react";
import type { MeDTO } from "@bulkhead/shared";
import { useLive } from "@/lib/client";
import { ada, myr, tusd } from "@/lib/money";
import { AddrLink } from "./Links";
import { TreasuryStakingChip } from "./TreasuryCard";

export function TopBar({
  me,
  user,
  onAgentMap,
  onTopUp,
  onPauseAll,
  onDecisions,
  onCaptain,
  onSignOut,
  wallet,
}: {
  me: MeDTO | null;
  user: { name: string | null; email: string };
  onAgentMap: () => void;
  onTopUp: () => void;
  onPauseAll: () => void;
  onDecisions: () => void;
  onCaptain: () => void;
  onSignOut: () => void;
  wallet: ReactNode;
}) {
  const { connected } = useLive();
  const open = me?.openDecisions ?? 0;
  return (
    <header className="sticky top-0 z-30 border-b" style={{ borderColor: "var(--rule)", background: "color-mix(in srgb, var(--paper) 90%, transparent)", backdropFilter: "blur(8px)" }}>
      <div className="mx-auto max-w-[1600px] px-4 min-h-[54px] py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 font-semibold text-[15px]">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="1.5" y="1.5" width="15" height="15" rx="4" fill="none" stroke="var(--good)" strokeWidth="1.6" />
            <path d="M6 1.5v15M12 1.5v15" stroke="var(--good)" strokeWidth="1.6" />
          </svg>
          Bulkhead
        </div>
        <div className="flex items-center gap-2 text-[13px]" title={me?.treasuryAddress}>
          <span className="label">Treasury</span>
          <b className="tabular-nums">{me ? myr(me.balances.tusdMicro, me.myrPerTusd) : "…"}</b>
          <span className="mid tabular-nums">{me ? tusd(me.balances.tusdMicro) : ""}</span>
          <span className="muted tabular-nums hidden lg:inline">{me ? ada(me.balances.lovelace) : ""}</span>
          <span className="tag tag-run">preprod</span>
          <span className={`tag ${me?.custody === "self" ? "tag-good" : ""}`} title={me ? undefined : ""}>
            {me?.custody === "self" ? "Self-custody" : "Custodial on testnet"}
          </span>
          <span className="hidden xl:inline text-[12px]">{me && <AddrLink address={me.treasuryAddress} />}</span>
          {me && <TreasuryStakingChip />}
        </div>
        <span title={connected ? "Live updates connected" : "Live updates reconnecting"} className="inline-flex items-center gap-1 text-[11px] muted">
          <span style={{ width: 7, height: 7, borderRadius: 99, background: connected ? "var(--good)" : "var(--ink-faint)", display: "inline-block" }} />
          {connected ? "live" : "offline"}
        </span>
        <nav className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={onDecisions}>
            Open decisions {open > 0 ? <span className="badge-count">{open}</span> : <span className="muted">0</span>}
          </button>
          <button type="button" className="btn" onClick={onAgentMap}>
            Agent map
          </button>
          <button type="button" className="btn" onClick={onCaptain}>
            Captain
          </button>
          <button type="button" className="btn btn-primary" onClick={onTopUp}>
            Top up RM50
          </button>
          <button type="button" className="btn btn-danger" onClick={onPauseAll}>
            Pause all
          </button>
          {wallet}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut} title={user.email}>
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
