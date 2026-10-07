"use client";
// Page layout: top bar, goal bar + tabs (Tree / Spending / Logbook / Decisions), tree canvas on the
// left, detail panel on the right (session, agent job, or goal + captain). Live over SSE.
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { TreeDTO, TreeNode } from "@bulkhead/shared";
import { signOutAction } from "@/app/actions";
import type { AgentCardDTO, GoalSummary, MeDTO, SessionDetailDTO } from "@bulkhead/shared";
import { api, ConfigContext, LiveContext, useLive, useLiveStream, useResource, type AppConfig } from "@/lib/client";
import { UNFUNDED_GOAL_TEXT, describeEvent, isGoalUnfunded } from "@/lib/describe";
import { dateTimeOf, myr, timeOf } from "@/lib/money";
import { WalletContext, type WalletState } from "@/lib/wallet-context";
import { PlannedGoalBar } from "./PlannedGoalBar";
import { ActivityLog } from "./ActivityLog";
import { AgentMap } from "./AgentMap";
import { CaptainPanel } from "./CaptainPanel";
import { GlyphIcon } from "./Glyph";
import { GoalComposer } from "./GoalComposer";
import { IdChip, LiveDot } from "./IdChip";
import { TxLink } from "./Links";
import { SessionPanel } from "./SessionPanel";
import { DecisionsTab, LogbookTab, SpendingTab } from "./Tabs";
import { ONRAMP_BANNER, TopUpDialog } from "./TopUpDialog";
import { TopBar } from "./TopBar";
import { TreeCanvas } from "./TreeCanvas";
import { TreeList } from "./TreeList";

type Tab = "tree" | "activity" | "spending" | "logbook" | "decisions";

// Mesh (CIP-30) is several MB: load it only when the user opens "Connect wallet" or is self-custody.
const WalletLayer = dynamic(() => import("./WalletConnect"), {
  ssr: false,
  loading: () => (
    <button type="button" className="btn" disabled>
      Loading wallets…
    </button>
  ),
});

export function AppShell({ user, fixture, stripe }: { user: { name: string | null; email: string }; fixture: boolean; stripe: boolean }) {
  const config = useMemo<AppConfig>(() => ({ fixture, stripe }), [fixture, stripe]);
  return (
    <ConfigContext.Provider value={config}>
      <LiveRoot user={user} />
    </ConfigContext.Provider>
  );
}

function LiveRoot({ user }: { user: { name: string | null; email: string } }) {
  const live = useLiveStream();
  return (
    <LiveContext.Provider value={live}>
      <Workspace user={user} />
    </LiveContext.Provider>
  );
}

function Workspace({ user }: { user: { name: string | null; email: string } }) {
  const { bump, recent } = useLive();
  const { data: me, reload: reloadMe } = useResource<MeDTO & { mode?: string }>("/me");
  const { data: goals } = useResource<GoalSummary[]>("/goals");
  const [goalId, setGoalId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tree");
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"auto" | "captain">("auto");
  const [modal, setModal] = useState<null | "agentMap" | "topup" | "composer">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activityQ, setActivityQ] = useState<string | undefined>(undefined);
  const showActivity = useCallback((q: string) => {
    setActivityQ(q);
    setTab("activity");
  }, []);
  const [wallet, setWallet] = useState<WalletState>({ connected: false });
  const [walletWanted, setWalletWanted] = useState(false);
  const onWalletState = useCallback((s: WalletState) => setWallet(s), []);
  const walletLoaded = walletWanted || me?.custody === "self";

  // Pick a goal: the newest running one, else the newest.
  useEffect(() => {
    if (!goals || goals.length === 0) return;
    if (goalId && goals.some((g) => g.id === goalId)) return;
    const pick = goals.find((g) => g.status === "running") ?? goals[0]!;
    setGoalId(pick.id);
  }, [goals, goalId]);

  const { data: tree } = useResource<TreeDTO>(goalId ? `/goals/${goalId}/tree` : null);
  const goal = goals?.find((g) => g.id === goalId) ?? null;
  const node: TreeNode | null = (selected && tree?.nodes.find((n) => n.id === selected)) || null;

  // Stripe return.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("topup");
    if (t === "success") setNotice("Payment received by Stripe (test mode). The on-ramp sends tUSD + ADA to your treasury on preprod; the balance updates when the deposit confirms.");
    if (t === "cancelled") setNotice("Top-up cancelled. Nothing was charged.");
    if (t) window.history.replaceState(null, "", "/");
  }, []);

  const selectSession = useCallback(
    async (sessionId: string, gid?: string) => {
      setTab("tree");
      setPanel("auto");
      setSelected(sessionId);
      let g = gid;
      if (!g) {
        try {
          g = (await api<SessionDetailDTO>(`/sessions/${sessionId}`)).goalId;
        } catch {
          /* agent job or unknown: stay on the current goal */
        }
      }
      if (g) setGoalId(g);
    },
    [],
  );

  const pauseAll = async () => {
    if (!window.confirm("Pause every running session?")) return;
    try {
      await api("/sessions/pause-all", { body: {} });
      setNotice("All running sessions paused.");
      bump();
    } catch (e) {
      setNotice(`Pause all failed: ${(e as Error).message}`);
    }
  };

  const onCard = (c: AgentCardDTO) => {
    setModal(null);
    if (c.kind === "agent_job") {
      setGoalId(c.goalId);
      setTab("tree");
      setPanel("auto");
      setSelected(c.id);
    } else void selectSession(c.id, c.goalId);
  };

  const lastEvent = [...recent].reverse().find((e) => !e.type.startsWith("captain_") && e.type !== "heartbeat_missed");
  const rate = me?.myrPerTusd ?? "4.70";
  const isSessionNode = node ? node.kind === "session" && node.glyph !== "planned" : !!selected && !selected.startsWith("goal:") && !selected.startsWith("plan:");

  const right =
    panel === "captain" ? (
      <CaptainPanel goalId={goalId} onSelectSession={(id) => void selectSession(id)} />
    ) : node?.kind === "agent_job" ? (
      <JobPanel node={node} rate={rate} onClose={() => setSelected(null)} onParent={(id) => setSelected(id)} onActivity={showActivity} />
    ) : isSessionNode && selected ? (
      <SessionPanel key={selected} sessionId={selected} me={me} onClose={() => setSelected(null)} onActivity={showActivity} />
    ) : (
      <div className="flex flex-col gap-3">
        {goal && <GoalCard goal={goal} tree={tree} rate={rate} onActivity={showActivity} />}
        <CaptainPanel goalId={goalId} onSelectSession={(id) => void selectSession(id)} />
      </div>
    );

  return (
    <WalletContext.Provider value={wallet}>
      <TopBar
        me={me}
        user={user}
        onAgentMap={() => setModal("agentMap")}
        onTopUp={() => setModal("topup")}
        onPauseAll={pauseAll}
        onDecisions={() => setTab("decisions")}
        onCaptain={() => setPanel((p) => (p === "captain" ? "auto" : "captain"))}
        onSignOut={() => void signOutAction()}
        wallet={
          walletLoaded ? (
            <WalletLayer
              me={me}
              startOpen={walletWanted}
              onState={onWalletState}
              onChanged={() => {
                reloadMe();
                bump();
              }}
            />
          ) : (
            <button type="button" className="btn" onClick={() => setWalletWanted(true)}>
              Connect wallet
            </button>
          )
        }
      />
      <main className="mx-auto max-w-[1600px] px-4 py-3 flex flex-col gap-3">
        {me?.mode === "fixture" && (
          <div className="banner banner-warn">
            <span>
              <b>Fixture mode</b> — ENGINE_URL is unset or MOCK_ENGINE=1, so this is sample data served by the web app. Nothing here is on-chain; hashes are
              not linked to the explorer.
            </span>
          </div>
        )}
        <div className="banner">
          <span>
            <b>Preprod testnet.</b> {me?.custody === "self" ? "Self-custody: your CIP-30 wallet is the treasury and signs funding." : "Custodial on testnet: the server derives and holds your treasury key (encrypted)."}{" "}
            {ONRAMP_BANNER}
          </span>
        </div>
        {notice && (
          <div className="banner">
            <span className="flex-1">{notice}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {/* Goal bar + tabs */}
        <div className="flex flex-wrap items-center gap-2">
          <select className="input" style={{ width: "auto", maxWidth: 420, fontWeight: 600 }} value={goalId ?? ""} onChange={(e) => { setGoalId(e.target.value); setSelected(null); }} aria-label="Goal">
            {!goals?.length && <option value="">No goals yet</option>}
            {goals?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.goal} — {g.status}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" onClick={() => setModal("composer")}>
            New goal
          </button>
          <div className="seg ml-auto" role="tablist">
            {(["tree", "activity", "spending", "logbook", "decisions"] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
                {t === "decisions" && (me?.openDecisions ?? 0) > 0 && <span className="badge-count">{me!.openDecisions}</span>}
              </button>
            ))}
          </div>
        </div>
        {lastEvent && (
          <div className="text-[12px] mid flex items-center gap-2 min-w-0" aria-live="polite">
            <LiveDot />
            <span className="mono muted">{timeOf(lastEvent.at)}</span>
            <span className="truncate">{describeEvent(lastEvent, rate).text}</span>
          </div>
        )}

        <div className="grid gap-3 items-start" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <div className="grid gap-3 items-start lg:[grid-template-columns:minmax(0,1fr)_440px]">
            <section className="min-w-0 flex flex-col gap-3">
              {tab === "tree" && goal && isGoalUnfunded(goal) && (
                <PlannedGoalBar goal={goal} rate={rate} onStarted={() => { reloadMe(); bump(); }} />
              )}
              {tab === "tree" &&
                (tree ? (
                  <>
                    <div className="panel only-wide" style={{ height: "calc(100vh - 250px)", minHeight: 480 }}>
                      <TreeCanvas tree={tree} selected={selected} onSelect={(id) => { setPanel("auto"); setSelected(id); }} />
                    </div>
                    <div className="panel only-narrow p-2">
                      <TreeList tree={tree} selected={selected} onSelect={(id) => { setPanel("auto"); setSelected(id); }} />
                    </div>
                  </>
                ) : (
                  <div className="panel p-8 flex flex-col items-start gap-3">
                    <div className="font-semibold">{goals && goals.length === 0 ? "No goals yet" : "Loading tree…"}</div>
                    {goals && goals.length === 0 && (
                      <>
                        <div className="mid">Top up your treasury, then give the captain a goal. It plans sessions that run in parallel, each with its own wallet and mandate.</div>
                        <button type="button" className="btn btn-primary" onClick={() => setModal("composer")}>
                          New goal
                        </button>
                      </>
                    )}
                  </div>
                ))}
              {tab === "activity" && <ActivityLog goalId={goalId} rate={rate} query={activityQ} onQuery={setActivityQ} onSelectSession={(sid, gid) => void selectSession(sid, gid)} />}
              {tab === "spending" && <SpendingTab me={me} onSelect={(sid, gid) => void selectSession(sid, gid)} />}
              {tab === "logbook" && <LogbookTab me={me} goals={goals ?? []} onSelect={(sid, gid) => void selectSession(sid, gid)} />}
              {tab === "decisions" && <DecisionsTab me={me} onSelect={(sid) => void selectSession(sid)} />}
            </section>
            <aside className="min-w-0 lg:sticky lg:top-[70px] lg:max-h-[calc(100vh-84px)] lg:overflow-auto">{right}</aside>
          </div>
        </div>
      </main>

      {modal === "agentMap" && <AgentMap me={me} onClose={() => setModal(null)} onSelect={onCard} />}
      {modal === "topup" && <TopUpDialog me={me} onClose={() => setModal(null)} onDone={() => { reloadMe(); bump(); }} />}
      {modal === "composer" && (
        <GoalComposer
          me={me}
          onClose={() => setModal(null)}
          onStarted={(gid) => {
            setModal(null);
            setGoalId(gid);
            setSelected(null);
            setTab("tree");
            bump();
          }}
        />
      )}
    </WalletContext.Provider>
  );
}

function GoalCard({ goal, tree, rate, onActivity }: { goal: GoalSummary; tree: TreeDTO | null | undefined; rate: string; onActivity: (q: string) => void }) {
  const sessions = tree?.nodes.filter((n) => n.kind === "session") ?? [];
  const count = (g: string) => sessions.filter((n) => n.glyph === g).length;
  return (
    <div className="panel p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <GlyphIcon kind="goal" />
        <span className="eyebrow">Goal</span>
        <span className="tag ml-auto">{goal.status}</span>
      </div>
      <div className="font-semibold text-[15px]">{goal.goal}</div>
      <div>
        <IdChip value={goal.id} label="goal" onPick={onActivity} />
      </div>
      {isGoalUnfunded(goal) && <div className="banner banner-warn">{UNFUNDED_GOAL_TEXT}</div>}
      <dl className="kv">
        <dt>Budget</dt>
        <dd>{myr(goal.budgetMicro, rate)}</dd>
        <dt>Deadline</dt>
        <dd>{dateTimeOf(goal.deadline)}</dd>
        {goal.rules && (
          <>
            <dt>Rules</dt>
            <dd>{goal.rules}</dd>
          </>
        )}
        <dt>Funding tx</dt>
        <dd>
          <TxLink hash={goal.fundingTx} />
        </dd>
        <dt>Sessions</dt>
        <dd>
          {sessions.length} · {count("running")} running · {count("awaiting") + count("quarantined")} need attention · {count("closed")} closed · {count("failed")} failed/killed
        </dd>
      </dl>
      <div className="text-[12px] muted">Select a node in the tree to see its session.</div>
    </div>
  );
}

function JobPanel({ node, rate, onClose, onParent, onActivity }: { node: TreeNode; rate: string; onClose: () => void; onParent: (id: string) => void; onActivity: (q: string) => void }) {
  return (
    <div className="panel p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <GlyphIcon kind={node.glyph} size={18} animate />
        <div className="font-semibold">{node.label}</div>
        <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="tag chip-task">agent_job</span>
        <IdChip value={node.id.replace(/^job_/, "")} label="job" onPick={onActivity} />
      </div>
      <div className="text-[13px] mid">A paid job at a specialised agent, hired by its parent session (Masumi-style job API). Its result and result hash go back to the parent as data.</div>
      <dl className="kv">
        <dt>Paid</dt>
        <dd>{node.spentMicro ? myr(node.spentMicro, rate) : "—"}</dd>
        <dt>Status</dt>
        <dd>{node.lines[0]}</dd>
        {node.startedAt && (
          <>
            <dt>Started</dt>
            <dd>{dateTimeOf(node.startedAt)}</dd>
          </>
        )}
      </dl>
      {node.parentId && (
        <button type="button" className="btn btn-sm self-start" onClick={() => onParent(node.parentId!)}>
          Open the hiring session →
        </button>
      )}
    </div>
  );
}
