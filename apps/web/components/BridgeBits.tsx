"use client";
// Small shared pieces of the Bridge: risk chip, evidence chips, a section line.
import type { Evidence, Risk, BridgeLine } from "@/lib/bridge";
import { evidenceHref } from "@/lib/bridge";
import { useConfig } from "@/lib/client";
import { useEffect, useState } from "react";
import { IdChip } from "./IdChip";

/** Live "work m:ss left" for a running session (WORK_DEADLINE_SECONDS after its wallet was funded). */
export function WorkLeft({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((at - now) / 1000));
  return <span className={`tabular-nums ${left <= 15 ? "bad" : ""}`}>{left > 0 ? `work ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "work time up — handing back"}</span>;
}

const RISK_CLASS: Record<Risk, string> = { low: "tag-good", medium: "tag-warn", high: "tag-bad" };
const RISK_WORD: Record<Risk, string> = { low: "low", medium: "med", high: "high" };

export function RiskChip({ risk, reason }: { risk?: Risk; reason?: string }) {
  if (!risk) return null;
  return (
    <span className={`tag ${RISK_CLASS[risk]}`} title={reason ? `risk: ${risk} — ${reason}` : `risk: ${risk}`}>
      risk: {RISK_WORD[risk]}
    </span>
  );
}

/** One piece of evidence: a tx (copy + cardanoscan), a hash (copy, click to filter the activity log), a source link, or DoD ✓. */
export function EvidenceChip({ e, onPick }: { e: Evidence; onPick?: (v: string) => void }) {
  const { fixture } = useConfig();
  if (e.kind === "dod")
    return (
      <span className="tag tag-good" title={e.ref || "Definition of done met (checked by the engine, not the agent)"}>
        {e.label && e.label !== "dod" ? e.label : "DoD ✓"}
      </span>
    );
  if (e.kind === "tx") return <IdChip value={e.ref} kind="tx" label={e.label} onPick={onPick} />;
  if (e.kind === "vault") return <IdChip value={e.ref} kind={e.ref.startsWith("addr") ? "addr" : "id"} label={e.label || "vault"} onPick={onPick} />;
  if (e.kind === "handback_hash") return <IdChip value={e.ref} kind="id" label={e.label || "handback"} onPick={onPick} title={`sha256 of the handback, anchored on-chain at close: ${e.ref}`} />;
  const href = evidenceHref(e, fixture);
  let host = e.ref;
  try {
    host = new URL(e.ref).hostname.replace(/^www\./, "");
  } catch {
    /* not a URL */
  }
  return href ? (
    <a className="tag" href={href} target="_blank" rel="noreferrer" title={e.ref}>
      {e.label && e.label !== "source" ? `${e.label}: ` : "source: "}
      {host.length > 28 ? `${host.slice(0, 27)}…` : host} ↗
    </a>
  ) : (
    <span className="tag" title={e.ref}>
      {e.label}: {host.length > 28 ? `${host.slice(0, 27)}…` : host}
    </span>
  );
}

export function EvidenceRow({ evidence, onPick }: { evidence: Evidence[]; onPick?: (v: string) => void }) {
  if (!evidence.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {evidence.map((e, i) => (
        <EvidenceChip key={`${e.kind}:${e.ref}:${i}`} e={e} onPick={onPick} />
      ))}
    </div>
  );
}

/** A Bearings / Ahoy line: text, optional risk, sub-line, evidence, "open" link. */
export function LineItem({ l, onOpen, onPick }: { l: BridgeLine; onOpen?: (sessionId: string) => void; onPick?: (v: string) => void }) {
  return (
    <li className="flex flex-col gap-1 py-1.5" style={{ borderTop: "1px solid var(--rule-soft)" }}>
      <div className="flex items-start gap-2 min-w-0">
        <span className="min-w-0 flex-1 text-[13px]" style={{ overflowWrap: "anywhere" }}>
          {l.text}
        </span>
        <RiskChip risk={l.risk} reason={l.riskReason} />
        {l.sessionId && onOpen && (
          <button type="button" className="btn btn-sm btn-ghost good" style={{ height: 20, padding: "0 4px" }} onClick={() => onOpen(l.sessionId!)} aria-label="Open session">
            →
          </button>
        )}
      </div>
      {(l.sub || l.riskReason || l.workDeadlineAt) && (
        <div className="text-[11.5px] mid">
          {l.workDeadlineAt && (
            <>
              <WorkLeft at={l.workDeadlineAt} />
              {l.sub || l.riskReason ? " · " : ""}
            </>
          )}
          {l.sub}
          {l.sub && l.riskReason ? " · " : ""}
          {l.riskReason && <span className="muted">{l.riskReason}</span>}
        </div>
      )}
      {l.recommendation && (
        <div className="text-[11.5px]">
          <span className={`font-semibold ${l.recommendation.action === "approve" ? "good" : l.recommendation.action === "reject" ? "bad" : "warn"}`}>Captain recommends: {l.recommendation.action}</span>
          {l.recommendation.why && <span className="mid"> — {l.recommendation.why}</span>}
        </div>
      )}
      <EvidenceRow evidence={l.evidence} onPick={onPick} />
    </li>
  );
}
