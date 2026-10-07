import type { Glyph as GlyphKind } from "@bulkhead/shared";

export type GlyphName = GlyphKind | "goal";

/** Status drawn by SHAPE first, colour second (spec §6.4). Reads without colour:
 * closed ● filled · running ◎ ring+dot (pulse) · paused ‖ two bars · quarantined ◇ diamond ·
 * awaiting ring+"!" · failed/killed ring+✕ · planned dashed ring · goal ■ square. */
export function Glyph({ kind, cx, cy, r, animate = true }: { kind: GlyphName; cx: number; cy: number; r: number; animate?: boolean }) {
  const d = r * 0.5;
  switch (kind) {
    case "closed":
      return <circle className="g-closed" cx={cx} cy={cy} r={r} />;
    case "running":
      return (
        <g>
          {animate && <circle className="g-pulse" cx={cx} cy={cy} r={r} />}
          <circle className="g-ring g-running" cx={cx} cy={cy} r={r} />
          <circle className="g-running-dot" cx={cx} cy={cy} r={r * 0.36} />
        </g>
      );
    case "paused":
      return (
        <g>
          <rect className="g-bars" x={cx - r * 0.85} y={cy - r} width={r * 0.6} height={r * 2} rx={r * 0.18} />
          <rect className="g-bars" x={cx + r * 0.25} y={cy - r} width={r * 0.6} height={r * 2} rx={r * 0.18} />
        </g>
      );
    case "quarantined":
      return <path className="g-diamond" d={`M${cx} ${cy - r * 1.15} L${cx + r * 1.15} ${cy} L${cx} ${cy + r * 1.15} L${cx - r * 1.15} ${cy} Z`} />;
    case "awaiting":
      return (
        <g>
          <circle className="g-ring g-await" cx={cx} cy={cy} r={r} />
          <text className="g-bang" x={cx} y={cy + r * 0.45} fontSize={r * 1.35} textAnchor="middle">
            !
          </text>
        </g>
      );
    case "failed":
      return (
        <g>
          <circle className="g-ring g-failed" cx={cx} cy={cy} r={r} />
          <path className="g-x" d={`M${cx - d} ${cy - d} L${cx + d} ${cy + d} M${cx + d} ${cy - d} L${cx - d} ${cy + d}`} />
        </g>
      );
    case "planned":
      return <circle className="g-ring g-planned" cx={cx} cy={cy} r={r} />;
    case "goal":
      return <rect className="g-goal" x={cx - r * 0.85} y={cy - r * 0.85} width={r * 1.7} height={r * 1.7} rx={r * 0.3} />;
  }
}

/** A glyph as a tiny inline icon. */
export function GlyphIcon({ kind, size = 14, animate = false }: { kind: GlyphName; size?: number; animate?: boolean }) {
  const r = size * 0.34;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: "none", overflow: "visible" }}>
      <Glyph kind={kind} cx={size / 2} cy={size / 2} r={r} animate={animate} />
    </svg>
  );
}

export const GLYPH_WORD: Record<GlyphName, string> = {
  closed: "closed",
  running: "running",
  paused: "paused",
  quarantined: "quarantined",
  awaiting: "awaiting approval",
  failed: "failed / killed",
  planned: "planned",
  goal: "goal",
};
