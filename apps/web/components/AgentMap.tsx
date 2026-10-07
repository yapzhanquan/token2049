"use client";
// Agent map (spec §6.7): captain root card → bracket → column of session cards → hired-agent jobs
// further right. Running first, then awaiting / quarantined / paused, then closed; newest first in
// each group. Elapsed time ticks every second; click a card to open its session.
import type { ReactNode } from "react";
import type { AgentCardDTO, AgentMapDTO, MeDTO } from "@bulkhead/shared";
import { useNow, useResource } from "@/lib/client";
import { clip, duration, myr, myrShort, tokens } from "@/lib/money";
import { sessionStatusWord } from "@/lib/describe";
import { GlyphIcon } from "./Glyph";
import { Modal } from "./Modal";

const GROUP: Record<string, number> = { running: 0, awaiting: 1, quarantined: 1, paused: 1, planned: 2, closed: 3, failed: 3 };

function sortCards(cards: AgentCardDTO[]): AgentCardDTO[] {
  return [...cards].sort((a, b) => (GROUP[a.glyph] ?? 2) - (GROUP[b.glyph] ?? 2) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
}

export function AgentMap({ me, onClose, onSelect }: { me: MeDTO | null; onClose: () => void; onSelect: (card: AgentCardDTO) => void }) {
  const { data, error } = useResource<AgentMapDTO>("/agent-map");
  const now = useNow(1000);
  const rate = me?.myrPerTusd ?? "4.70";
  const cards = data?.cards ?? [];
  const byParent = new Map<string | null, AgentCardDTO[]>();
  const ids = new Set(cards.map((c) => c.id));
  for (const c of cards) {
    const p = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }

  const row = (c: AgentCardDTO, depth: number): ReactNode => {
    const kids = depth < 3 ? sortCards(byParent.get(c.id) ?? []) : [];
    return (
      <div key={c.id} className="am-row">
        <Card c={c} now={now} rate={rate} onClick={() => onSelect(c)} />
        {kids.length > 0 && (
          <>
            <span className="am-stub" />
            <div className="am-children">{kids.map((k) => row(k, depth + 1))}</div>
          </>
        )}
      </div>
    );
  };

  const top = sortCards(byParent.get(null) ?? []);
  return (
    <Modal title="Agent map" subtitle={`${cards.length} agents · click an agent for details`} onClose={onClose} width={1280}>
      {error && <div className="banner banner-bad">{error}</div>}
      {!data && !error && <div className="muted">Loading…</div>}
      {data && (
        <div className="overflow-auto pb-2">
          <div className="am-row" style={{ minWidth: "max-content" }}>
            <div className="am-card captain">
              <div className="am-l1">
                <GlyphIcon kind="goal" />
                <span>{data.captain.name}</span>
                <span className="tag ml-auto">orchestrator</span>
              </div>
              <div className="am-lines mt-1 flex flex-col gap-0.5">
                <div className="am-l2">model {data.captain.model}</div>
                <div className="am-l2">context {tokens(data.captain.contextTokens)}</div>
                <div className="am-l2">treasury {myr(data.captain.treasuryMicro, rate)}</div>
                <div className="am-l2">
                  {data.captain.running} running · {data.captain.closed} closed
                </div>
              </div>
            </div>
            {top.length > 0 && (
              <>
                <span className="am-stub" />
                <div className="am-children">{top.map((c) => row(c, 1))}</div>
              </>
            )}
          </div>
          {top.length === 0 && <div className="muted mt-4">No sessions yet. Start a goal.</div>}
        </div>
      )}
    </Modal>
  );
}

function Card({ c, now, rate, onClick }: { c: AgentCardDTO; now: number; rate: string; onClick: () => void }) {
  const ghost = c.glyph === "closed" || c.glyph === "failed";
  const elapsed = c.startedAt ? duration((c.endedAt ?? now) - c.startedAt) : "not started";
  const head = c.kind === "agent_job" ? `${c.role}: ${c.shortGoal}` : `${c.letter ? `${c.letter} ` : ""}${c.role}: ${c.shortGoal}`;
  return (
    <button type="button" className={`am-card${ghost ? " ghost" : ""}`} onClick={onClick} title={head}>
      <div className="am-l1">
        <GlyphIcon kind={c.glyph} animate={!ghost} />
        <span>{clip(head, 60)}</span>
      </div>
      <div className="am-l2 mt-0.5">
        {elapsed} · {tokens(c.tokensUsed)} · {myrShort(c.spentMicro, rate)} / {myrShort(c.budgetMicro, rate)}
      </div>
      {!ghost && c.latest && <div className="am-l3 am-lines mt-0.5">{c.latest}</div>}
      {ghost && (
        <div className="am-l3 am-lines mt-0.5">
          {c.refundMicro !== null && <span className="good">{myrShort(c.refundMicro, rate)} returned · </span>}
          {c.handbackSummary ?? sessionStatusWord(c.status, c.glyph)}
        </div>
      )}
    </button>
  );
}
