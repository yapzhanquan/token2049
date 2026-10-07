"use client";
// Bearings: the 4-section digest at the top of a goal — Done / In flight / Needs you / Money — plus
// "File report". Reads GET /bearings?goalId= when the engine has it; otherwise derives the same
// digest from the goal tree, the live event history, open decisions and the logbook.
import { useMemo, useState } from "react";
import type { Decision, DecisionDTO, GoalSummary, LogbookEntryDTO, TreeDTO } from "@bulkhead/shared";
import { bearingsMarkdown, deriveBearings, normBearings, type BearingsView } from "@/lib/bridge";
import { api, copyText, useResource } from "@/lib/client";
import { useGoalEvents, useOptionalResource } from "@/lib/goal-events";
import { big, myr } from "@/lib/money";
import { EvidenceRow, LineItem } from "./BridgeBits";
import { decisionText } from "./SessionPanel";

export function useBearings(goal: GoalSummary | null, tree: TreeDTO | null | undefined, rate: string): BearingsView | null {
  const goalId = goal?.id ?? null;
  const { data: raw, missing } = useOptionalResource<unknown>(goalId ? `/bearings?goalId=${encodeURIComponent(goalId)}` : null);
  const engine = useMemo(() => normBearings(raw), [raw]);
  const { events } = useGoalEvents();
  const needDerive = !engine;
  const { data: open } = useResource<DecisionDTO[]>(needDerive && goalId ? "/decisions?status=open" : null);
  const { data: book } = useResource<LogbookEntryDTO[]>(needDerive && goalId ? `/logbook?goalId=${encodeURIComponent(goalId)}` : null);
  const derived = useMemo(
    () =>
      needDerive && goal
        ? deriveBearings({ goal, tree: tree ?? null, events, openDecisions: (open ?? []).filter((d) => d.status === "open"), logbook: book ?? [], rate, decisionText: (d: Decision) => decisionText(d, rate) })
        : null,
    [needDerive, goal, tree, events, open, book, rate],
  );
  void missing;
  return engine ?? derived;
}

export function BearingsPanel({
  goal,
  bearings,
  rate,
  onSelectSession,
  onActivity,
  onDecisions,
}: {
  goal: GoalSummary | null;
  bearings: BearingsView | null;
  rate: string;
  onSelectSession: (id: string) => void;
  onActivity: (q: string) => void;
  onDecisions: () => void;
}) {
  const [filed, setFiled] = useState<{ text: string; ref?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!goal) return null;
  const b = bearings;

  const file = async () => {
    if (!b) return;
    setBusy(true);
    setFiled(null);
    try {
      const r = await api<Record<string, unknown>>("/bearings/file", { body: { goalId: goal.id }, retries: 0 });
      const ref = String(r?.path ?? r?.url ?? r?.id ?? r?.sha256 ?? "");
      setFiled({ text: `Filed by the engine${r?.at ? ` at ${new Date(Number(r.at)).toLocaleTimeString()}` : ""}.`, ref: ref || undefined });
    } catch {
      // Engine cannot file it (route not there yet): save the same digest locally as Markdown.
      const md = bearingsMarkdown(goal, b, rate);
      const blob = new Blob([md], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bearings-${goal.id.slice(0, 12)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setFiled({ text: "Saved the Bearings digest to your downloads (Markdown)." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel p-4 flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Bearings</span>
        <span className="font-semibold text-[14px] min-w-0 truncate" style={{ maxWidth: "100%" }} title={goal.goal}>
          {goal.goal}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {b && (
            <span className="text-[11px] muted" title={b.source === "engine" ? "Digest computed by the engine" : "Digest derived in the browser from the live event stream + goal tree"}>
              {b.source === "engine" ? "from engine" : "live digest"}
            </span>
          )}
          <button type="button" className="btn btn-sm" disabled={!b || busy} onClick={() => void file()}>
            {busy ? "Filing…" : "File report"}
          </button>
        </span>
      </div>
      {filed && (
        <div className="banner flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-0">{filed.text}</span>
          {filed.ref && (
            <button type="button" className="btn btn-sm" onClick={() => void copyText(filed.ref!)}>
              Copy ref
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFiled(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {b?.overall && <div className="text-[13.5px]">{b.overall}</div>}
      {!b ? (
        <div className="text-[12.5px] muted">Taking bearings…</div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
          <Section title="Done" count={b.done.length} empty={b.empty?.done ?? "Nothing finished yet."}>
            {b.done.map((l) => (
              <LineItem key={l.key} l={l} onOpen={onSelectSession} onPick={onActivity} />
            ))}
          </Section>
          <Section title="In flight" count={b.inFlight.length} empty={b.empty?.inFlight ?? "No session running."}>
            {b.inFlight.map((l) => (
              <LineItem key={l.key} l={l} onOpen={onSelectSession} onPick={onActivity} />
            ))}
          </Section>
          <Section title="Needs you" count={b.needsYou.length} tone={b.needsYou.length ? "warn" : undefined} empty={b.empty?.needsYou ?? "Nothing. The crew is within its mandates."}>
            {b.needsYou.map((l) => (
              <LineItem key={l.key} l={l} onOpen={onSelectSession} onPick={onActivity} />
            ))}
            {b.needsYou.length > 0 && (
              <li className="pt-1">
                <button type="button" className="btn btn-sm" onClick={onDecisions}>
                  Decide →
                </button>
              </li>
            )}
          </Section>
          <Money m={b.money} rate={rate} onPick={onActivity} />
        </div>
      )}
    </div>
  );
}

function Section({ title, count, tone, empty, children }: { title: string; count: number; tone?: "warn"; empty: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className={`section-title flex items-center gap-2 ${tone ?? ""}`}>
        {title} <span className="mono">{count}</span>
      </h3>
      {count === 0 ? <div className="text-[12px] muted">{empty}</div> : <ul className="m-0 p-0 list-none">{children}</ul>}
    </section>
  );
}

function Money({ m, rate, onPick }: { m: BearingsView["money"]; rate: string; onPick: (v: string) => void }) {
  const budget = big(m.budget);
  const spent = big(m.spent);
  const vaults = big(m.inVaults);
  const returned = big(m.returned);
  const whole = budget > spent + vaults + returned ? budget : spent + vaults + returned || 1n;
  const w = (x: bigint) => `${Number((x * 10_000n) / (whole || 1n)) / 100}%`;
  const rows: [string, bigint, string][] = [
    ["Spent", spent, "var(--good)"],
    [m.inVaultsSource === "chain" ? "In session vaults (on-chain)" : "In session vaults", vaults, "var(--run)"],
    ["Returned to treasury", returned, "color-mix(in srgb, var(--good) 35%, var(--rule))"],
  ];
  return (
    <section className="min-w-0">
      <h3 className="section-title">Money</h3>
      <div className="text-[13px]">
        Budget <b className="tabular-nums">{myr(budget, rate)}</b>
      </div>
      <div className="flex h-2.5 rounded-full overflow-hidden my-2" style={{ background: "var(--rule-soft)" }} role="img" aria-label={`Spent ${myr(spent, rate)}, in vaults ${myr(vaults, rate)}, returned ${myr(returned, rate)} of ${myr(budget, rate)}`}>
        {rows.map(([k, v, c]) => (v > 0n ? <span key={k} style={{ width: w(v), background: c }} title={`${k}: ${myr(v, rate)}`} /> : null))}
      </div>
      <dl className="kv" style={{ fontSize: 12.5 }}>
        {rows.map(([k, v, c]) => (
          <div key={k} className="contents">
            <dt className="flex items-center gap-1.5">
              <span style={{ width: 8, height: 8, borderRadius: 2, background: c, display: "inline-block" }} />
              {k}
            </dt>
            <dd className="tabular-nums">{myr(v, rate)}</dd>
          </div>
        ))}
        <dt>Pending txs</dt>
        <dd className={m.pendingTx ? "warn" : "muted"}>{m.pendingTx ? `${m.pendingTx} awaiting confirmation` : "none"}</dd>
      </dl>
      {m.pendingTxs && m.pendingTxs.length > 0 && (
        <div className="mt-1.5">
          <EvidenceRow evidence={m.pendingTxs.slice(0, 4)} onPick={onPick} />
        </div>
      )}
    </section>
  );
}
