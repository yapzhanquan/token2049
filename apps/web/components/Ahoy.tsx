"use client";
// Ahoy: on load, "Since you last looked: …" + the open decisions, most impact first, each with a
// recommendation and one-click Approve / Reject. GET /ahoy when the engine has it; otherwise derived
// from the goal's events + open decisions ("suggested" — never presented as the captain's words).
// Dismissing it ("Aye") marks it seen (POST /ahoy/seen, plus a per-browser timestamp).
import { useEffect, useMemo, useState } from "react";
import type { Decision, DecisionDTO, MeDTO } from "@bulkhead/shared";
import { deriveAhoy, normAhoy, type AhoyDecisionView, type AhoyView } from "@/lib/bridge";
import { api, useLive, useResource } from "@/lib/client";
import { useGoalEvents, useOptionalResource } from "@/lib/goal-events";
import { duration, myr } from "@/lib/money";
import { useWalletState } from "@/lib/wallet-context";
import { answerDecision } from "@/lib/wallet-decisions";
import { LineItem, RiskChip } from "./BridgeBits";
import { decisionText } from "./SessionPanel";

const SEEN_KEY = "bulkhead.ahoy.lastSeen";
const readSeen = (): number => {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
};
const writeSeen = (at: number) => {
  try {
    window.localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    /* storage blocked: the banner just shows again next load */
  }
};

export function AhoyBanner({ me, rate, letterOf, onSelectSession, onActivity }: { me: MeDTO | null; rate: string; letterOf: (sid?: string) => string | undefined; onSelectSession: (id: string) => void; onActivity: (q: string) => void }) {
  const [hidden, setHidden] = useState(false);
  // The "since" for this page load is frozen at load time, so the recap doesn't shrink while you read it.
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    const s = readSeen();
    setSince(s || Date.now() - 12 * 3600_000);
  }, []);
  const { data: raw } = useOptionalResource<unknown>(hidden ? null : "/ahoy");
  const engine = useMemo(() => normAhoy(raw), [raw]);
  const { events, replayed } = useGoalEvents();
  const { data: open, reload } = useResource<DecisionDTO[]>(hidden ? null : "/decisions?status=open");
  const { bump } = useLive();
  const wallet = useWalletState();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, "approved" | "rejected">>({});

  const view: AhoyView | null = useMemo(() => {
    if (engine) return engine;
    if (since === null || !replayed) return null;
    return deriveAhoy({ since, events, openDecisions: (open ?? []).filter((d) => d.status === "open"), rate, letterOf, decisionText: (d: Decision) => decisionText(d, rate) });
  }, [engine, since, replayed, events, open, rate, letterOf]);

  if (hidden || !view) return null;
  // Only decisions that are still open (an engine list may lag a click by one refresh).
  const openIds = open ? new Set(open.filter((d) => d.status === "open").map((d) => d.id)) : null;
  const decisions = view.decisions.filter((d) => !done[d.decisionId] && (!openIds || openIds.has(d.decisionId)));
  const hasNews = view.groups.length > 0;
  if (!hasNews && decisions.length === 0 && Object.keys(done).length === 0) return null;

  const dismiss = () => {
    setHidden(true);
    writeSeen(Date.now());
    void api("/ahoy/seen", { body: view.latestEventId ? { eventId: view.latestEventId } : {}, retries: 0 }).catch(() => {});
  };
  const decide = async (d: AhoyDecisionView, status: "approved" | "rejected") => {
    setBusy(d.decisionId);
    setErr(null);
    try {
      await answerDecision({ id: d.decisionId }, status, { me, wallet });
      setDone((x) => ({ ...x, [d.decisionId]: status }));
      reload();
      bump();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const ago = view.since ? duration(Math.max(0, Date.now() - view.since)) : null;

  return (
    <div className="panel p-4 flex flex-col gap-3" style={{ borderColor: "color-mix(in srgb, var(--good) 40%, var(--rule))" }} role="region" aria-label="Ahoy: since you last looked">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Ahoy</span>
        <span className="font-semibold">Since you last looked{ago ? ` (${ago} ago)` : ""}</span>
        <button type="button" className="btn btn-sm ml-auto" onClick={dismiss}>
          Aye, seen
        </button>
      </div>
      {view.headline && <div className="text-[13.5px]">{view.headline}</div>}
      {hasNews ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {view.groups.map((g) => (
            <section key={g.key} className="min-w-0">
              <h3 className="section-title m-0">
                {g.title} <span className="mono">{g.count}</span>
              </h3>
              <ul className="m-0 p-0 list-none">
                {g.lines.slice(-6).map((l) => (
                  <LineItem key={l.key} l={l} onOpen={onSelectSession} onPick={onActivity} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        !view.headline && <div className="text-[12.5px] mid">Nothing new to report — the crew stayed inside its mandates.</div>
      )}
      {view.routine > 0 && <div className="text-[11.5px] muted">+ {view.routine} routine event{view.routine === 1 ? "" : "s"} absorbed without bothering you.</div>}
      {(decisions.length > 0 || Object.keys(done).length > 0) && (
        <section className="flex flex-col gap-2">
          <h3 className="section-title m-0">
            {decisions.length} decision{decisions.length === 1 ? "" : "s"} for you — most impact first
          </h3>
          {decisions.map((d, i) => {
            const rec = d.recommendation;
            return (
              <div key={d.decisionId} className="panel p-3 flex flex-col gap-1.5" style={{ boxShadow: "none" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono muted text-[11px]">#{i + 1}</span>
                  <b className="text-[13.5px]">{d.title}</b>
                  {d.amountMicro && <span className="tag">{myr(d.amountMicro, rate)}</span>}
                  {d.sessionId && (
                    <button type="button" className="btn btn-sm btn-ghost good ml-auto" style={{ height: 20 }} onClick={() => onSelectSession(d.sessionId!)}>
                      open session →
                    </button>
                  )}
                </div>
                {d.detail && <div className="text-[12.5px] mid">{d.detail}</div>}
                {(d.impact || d.risk) && (
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <RiskChip risk={d.risk} />
                    {d.impact && <span className="mid">Impact: {d.impact}</span>}
                  </div>
                )}
                {rec && (
                  <div className="text-[12.5px]">
                    <span className={`font-semibold ${rec.action === "approve" ? "good" : rec.action === "reject" ? "bad" : "warn"}`}>
                      {d.fromCaptain ? "Captain recommends" : "Suggested"}: {rec.action}
                    </span>
                    {rec.why && <span className="mid"> — {rec.why}</span>}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-0.5">
                  <button type="button" className={`btn btn-sm ${rec?.action === "reject" ? "" : "btn-primary"}`} disabled={busy === d.decisionId} onClick={() => void decide(d, "approved")}>
                    Approve{me?.custody === "self" ? " (sign)" : ""}
                  </button>
                  <button type="button" className={`btn btn-sm ${rec?.action === "reject" ? "btn-danger" : ""}`} disabled={busy === d.decisionId} onClick={() => void decide(d, "rejected")}>
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
          {Object.entries(done).map(([id, st]) => (
            <div key={id} className="text-[12px] muted">
              ✓ {st} <span className="mono">{id.slice(0, 14)}</span> — recorded in the decision ledger.
            </div>
          ))}
        </section>
      )}
      {err && <div className="banner banner-bad">{err}</div>}
    </div>
  );
}
