"use client";
// The same tree as an indented list, for narrow screens.
import type { ReactNode } from "react";
import type { TreeDTO } from "@bulkhead/shared";
import { layoutTree, nodeLabel } from "@/lib/tree-layout";
import { GlyphIcon } from "./Glyph";
import { IdChip } from "./IdChip";

export function TreeList({ tree, selected, onSelect }: { tree: TreeDTO; selected: string | null; onSelect: (id: string) => void }) {
  const laid = layoutTree(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const handbackFrom = new Map<string, string[]>();
  for (const e of tree.edges) if (e.kind === "handback") handbackFrom.set(e.to, [...(handbackFrom.get(e.to) ?? []), e.from]);

  const branch = (id: string): ReactNode => {
    const n = byId.get(id);
    if (!n) return null;
    const kids = laid.children.get(id) ?? [];
    const from = (handbackFrom.get(id) ?? []).map((f) => byId.get(f)?.letter ?? "?");
    return (
      <li key={id}>
        <button
          type="button"
          className={`tl-row${selected === id ? " selected" : ""}${n.ghost ? " ghost" : ""}`}
          aria-pressed={selected === id}
          onClick={() => onSelect(id)}
        >
          <span style={{ paddingTop: 2 }}>
            <GlyphIcon kind={n.kind === "goal" ? "goal" : n.glyph} size={16} animate />
          </span>
          <span className="flex flex-col min-w-0">
            <span className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[13px]">{nodeLabel(n)}</span>
              {n.taskType && <span className="tag chip-task">{n.kind === "agent_job" ? "agent_job" : n.taskType}</span>}
              {!!n.openDecisions && <span className="badge-count">{n.openDecisions}</span>}
            </span>
            {n.lines[0] && <span className="text-[12px] mid">{n.lines[0]}</span>}
            {n.lines[1] && <span className="mono text-[11px] mid">{n.lines[1]}</span>}
            {from.length > 0 && <span className="text-[11px] good">← handback from {from.join(", ")} (data)</span>}
          </span>
        </button>
        {(n.kind === "session" || n.kind === "agent_job") && !n.id.startsWith("plan:") && n.glyph !== "planned" && (
          <div style={{ paddingLeft: 34, marginTop: -2, marginBottom: 4 }}>
            <IdChip value={n.kind === "agent_job" ? n.id.replace(/^job_/, "") : n.id} label={n.kind === "agent_job" ? "job" : "id"} />
          </div>
        )}
        {kids.length > 0 && <ul>{kids.map(branch)}</ul>}
      </li>
    );
  };
  return <ul className="tree-list">{laid.roots.map(branch)}</ul>;
}
