"use client";
// The session tree: a tidy tree on a pan + zoom canvas. Goal at the root, sessions and hired-agent
// jobs as children, S-curve parent edges, dashed violet "handback" edges, glyphs by shape first.
// Closed / killed sessions stay as muted ghost nodes. New nodes animate in.
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { TreeDTO, TreeNode } from "@bulkhead/shared";
import { clip } from "@/lib/money";
import { layoutTree, nodeLabel } from "@/lib/tree-layout";
import { Glyph, GlyphIcon } from "./Glyph";
import { usePanZoom, ZOOM_STEP } from "./usePanZoom";

const COL = 380;
const ROW = 108;
const PAD_X = 40;
const PAD_Y = 64;
const LABEL_W = 310;
const R = 8;

export function TreeCanvas({
  tree,
  selected,
  onSelect,
  showLegend = true,
  height = "100%",
}: {
  tree: TreeDTO;
  selected: string | null;
  onSelect: (id: string) => void;
  showLegend?: boolean;
  height?: number | string;
}) {
  const laid = useMemo(() => layoutTree(tree), [tree]);
  const byId = useMemo(() => new Map(tree.nodes.map((n) => [n.id, n])), [tree]);
  const at = (id: string) => {
    const s = laid.slots.get(id);
    return s ? { x: PAD_X + s.depth * COL, y: PAD_Y + s.row * ROW } : null;
  };
  const width = PAD_X * 2 + laid.maxDepth * COL + LABEL_W;
  const heightPx = PAD_Y * 2 + (laid.rows - 1) * ROW;
  const svgRef = useRef<SVGSVGElement>(null);
  const pz = usePanZoom(svgRef, width, heightPx);

  // New-node animation: remember when each id was first seen.
  const firstSeen = useRef<Map<string, number> | null>(null);
  const now = Date.now();
  if (firstSeen.current === null) firstSeen.current = new Map(tree.nodes.map((n) => [n.id, 0]));
  for (const n of tree.nodes) if (!firstSeen.current.has(n.id)) firstSeen.current.set(n.id, now);
  const isNew = (id: string) => now - (firstSeen.current?.get(id) ?? 0) < 900;

  // Selecting a node from elsewhere (agent map, decisions list) brings it into view.
  const sel = selected ? at(selected) : null;
  const selKey = sel ? `${sel.x},${sel.y}` : "";
  useEffect(() => {
    if (sel) pz.reveal({ x: sel.x + 120, y: sel.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const key = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  const parentEdges = tree.edges.filter((e) => e.kind === "parent");
  // Also draw an edge for any node whose parentId has no explicit edge.
  for (const n of tree.nodes) if (n.parentId && byId.has(n.parentId) && !parentEdges.some((e) => e.to === n.id)) parentEdges.push({ from: n.parentId, to: n.id, kind: "parent" });
  const handbacks = tree.edges.filter((e) => e.kind === "handback");

  return (
    <div className="canvas" style={{ height }}>
      <svg
        ref={svgRef}
        className={pz.panning ? "panning" : undefined}
        role="group"
        aria-label={`Session tree with ${tree.nodes.length} nodes`}
        tabIndex={0}
        {...pz.svgProps}
      >
        <g transform={pz.transform}>
          {parentEdges.map((e) => {
            const a = at(e.from);
            const b = at(e.to);
            if (!a || !b) return null;
            const child = byId.get(e.to);
            const mx = (a.x + b.x) / 2;
            const cls = `t-edge${child?.ghost ? " ghost" : ""}${child?.glyph === "planned" ? " planned" : ""}`;
            return <path key={`p-${e.from}-${e.to}`} className={cls} d={`M${a.x + R} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - R} ${b.y}`} />;
          })}
          {handbacks.map((e) => {
            const a = at(e.from);
            const b = at(e.to);
            if (!a || !b) return null;
            let d: string;
            let lx: number;
            let ly: number;
            if (Math.abs(a.x - b.x) < 1) {
              const bend = 78;
              d = `M${a.x - R - 2} ${a.y} C ${a.x - bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x - R - 2} ${b.y}`;
              lx = a.x - bend * 0.75 - 4;
              ly = (a.y + b.y) / 2;
            } else {
              const mx = (a.x + b.x) / 2;
              d = `M${a.x} ${a.y + R + 2} C ${a.x} ${b.y}, ${mx} ${b.y}, ${b.x - R - 2} ${b.y}`;
              lx = mx;
              ly = b.y - 2;
            }
            return (
              <g key={`h-${e.from}-${e.to}`}>
                <path className="t-handback" d={d} markerEnd="url(#hb-arrow)">
                  <title>Handback passed as context (data, never instructions)</title>
                </path>
                <rect className="t-handback-bg" x={lx - 26} y={ly - 8} width={52} height={14} rx={4} />
                <text className="t-handback-label" x={lx} y={ly + 2.5} textAnchor="middle">
                  handback
                </text>
              </g>
            );
          })}
          <defs>
            <marker id="hb-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--good)" />
            </marker>
          </defs>
          {tree.nodes.map((n) => {
            const p = at(n.id);
            if (!p) return null;
            return (
              <NodeG
                key={n.id}
                n={n}
                x={p.x}
                y={p.y}
                selected={n.id === selected}
                fresh={isNew(n.id)}
                onSelect={onSelect}
                onKey={key}
              />
            );
          })}
        </g>
      </svg>
      {showLegend && <Legend />}
      <div className="zoom-ctl" role="group" aria-label="Zoom" title="Ctrl/⌘ + scroll or pinch to zoom · drag or scroll to pan">
        <button type="button" onClick={() => pz.zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">
          −
        </button>
        <span>{pz.zoom === null ? "" : `${Math.round(pz.zoom * 100)}%`}</span>
        <button type="button" onClick={() => pz.zoomBy(ZOOM_STEP)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={pz.fit}>
          Fit
        </button>
      </div>
    </div>
  );
}

function NodeG({
  n,
  x,
  y,
  selected,
  fresh,
  onSelect,
  onKey,
}: {
  n: TreeNode;
  x: number;
  y: number;
  selected: boolean;
  fresh: boolean;
  onSelect: (id: string) => void;
  onKey: (e: KeyboardEvent, id: string) => void;
}) {
  const isGoal = n.kind === "goal";
  const label = clip(nodeLabel(n), isGoal ? 40 : 44);
  const l1 = clip(n.lines[0] ?? "", 52);
  const l2 = clip(n.lines[1] ?? "", 56);
  const textW = Math.min(LABEL_W - 24, Math.max(label.length * (isGoal ? 8 : 7.4), l1.length * 5.9, l2.length * 6.3, 120) + 10);
  const chip = n.kind === "agent_job" ? "agent_job" : n.taskType;
  const cls = `t-node${selected ? " selected" : ""}${n.ghost ? " ghost" : ""}${fresh ? " node-new" : ""}`;
  return (
    <g
      className={cls}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${nodeLabel(n)}. ${n.lines.join(". ")}`}
      onClick={() => onSelect(n.id)}
      onKeyDown={(e) => onKey(e, n.id)}
    >
      {/* Backdrops hide edges under the text but leave an open band at dot height. */}
      <rect className="hit" x={x - 16} y={y - 48} width={textW + 40} height={88} rx={8} />
      <rect fill="var(--surface)" opacity={selected ? 0 : 1} x={x + 14} y={y - 46} width={textW} height={40} />
      <rect fill="var(--surface)" opacity={selected ? 0 : 1} x={x + 14} y={y + 6} width={textW} height={32} />
      {selected && <circle className="t-sel-ring" cx={x} cy={y} r={R + 5} />}
      <Glyph kind={isGoal ? "goal" : n.glyph} cx={x} cy={y} r={isGoal ? R + 1 : R} />
      {chip && (
        <g className="t-chip">
          <rect x={x + 18} y={y - 43} width={chip.length * 6.3 + 10} height={14} rx={4} />
          <text x={x + 23} y={y - 33}>
            {chip}
          </text>
        </g>
      )}
      {isGoal && (
        <text className="eyebrow" x={x + 18} y={y - 33} style={{ fill: "var(--ink-faint)", fontSize: 10 }}>
          GOAL
        </text>
      )}
      {!!n.openDecisions && (
        <g className="t-badge">
          <title>{`${n.openDecisions} open decision${n.openDecisions === 1 ? "" : "s"}`}</title>
          <circle cx={x + 18 + (chip ? chip.length * 6.3 + 10 : 0) + 12} cy={y - 36} r={7} />
          <text x={x + 18 + (chip ? chip.length * 6.3 + 10 : 0) + 12} y={y - 32.5} textAnchor="middle">
            {n.openDecisions}
          </text>
        </g>
      )}
      <text className={isGoal ? "t-goal-label" : "t-label"} x={x + 18} y={y - 10}>
        {label}
      </text>
      {l1 && (
        <text className="t-line" x={x + 18} y={y + 19}>
          {l1}
        </text>
      )}
      {l2 && (
        <text className="t-line2" x={x + 18} y={y + 33}>
          {l2}
        </text>
      )}
      <title>{[nodeLabel(n), ...n.lines].join("\n")}</title>
    </g>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span>
        <GlyphIcon kind="running" /> running
      </span>
      <span>
        <GlyphIcon kind="closed" /> closed
      </span>
      <span>
        <GlyphIcon kind="awaiting" /> awaiting approval / funding
      </span>
      <span>
        <GlyphIcon kind="quarantined" /> quarantined
      </span>
      <span>
        <GlyphIcon kind="paused" /> paused
      </span>
      <span>
        <GlyphIcon kind="failed" /> failed / killed
      </span>
      <span>
        <GlyphIcon kind="planned" /> planned
      </span>
      <span>
        <svg width="24" height="10" aria-hidden="true">
          <line x1="1" x2="23" y1="5" y2="5" className="t-handback" />
        </svg>
        handback (data)
      </span>
    </div>
  );
}
