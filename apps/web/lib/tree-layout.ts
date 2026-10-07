// Tidy-tree slot layout for TreeDTO: depth → column, leaves take one row each in order, a parent
// sits centred on its children. Children are ordered by letter (creation order) so the tree is
// stable as statuses change and new sessions animate in at the bottom of their branch.
import type { Plan, TreeDTO, TreeNode } from "@bulkhead/shared";
import { sessionStatusWord } from "./describe";

export interface Slot {
  depth: number;
  row: number;
}
export interface Laid {
  slots: Map<string, Slot>;
  rows: number;
  maxDepth: number;
  children: Map<string, string[]>;
  roots: string[];
}

const order = (a: TreeNode, b: TreeNode) =>
  (a.kind === "agent_job" ? 1 : 0) - (b.kind === "agent_job" ? 1 : 0) ||
  (a.letter ?? "").localeCompare(b.letter ?? "", undefined, { numeric: true }) ||
  (a.startedAt ?? 0) - (b.startedAt ?? 0);

export function layoutTree(tree: TreeDTO): Laid {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const kids = new Map<string, TreeNode[]>();
  for (const n of tree.nodes) {
    if (!n.parentId || !byId.has(n.parentId)) {
      roots.push(n.id);
      continue;
    }
    const list = kids.get(n.parentId) ?? [];
    list.push(n);
    kids.set(n.parentId, list);
  }
  for (const [p, list] of kids) children.set(p, list.sort(order).map((n) => n.id));

  const slots = new Map<string, Slot>();
  let leaf = 0;
  let maxDepth = 0;
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return; // defensive: never loop on a malformed tree
    seen.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const ks = (children.get(id) ?? []).filter((k) => !seen.has(k));
    if (ks.length === 0) {
      slots.set(id, { depth, row: leaf++ });
      return;
    }
    for (const k of ks) visit(k, depth + 1);
    const rs = ks.map((k) => slots.get(k)?.row ?? 0);
    slots.set(id, { depth, row: (Math.min(...rs) + Math.max(...rs)) / 2 });
  };
  for (const r of roots) visit(r, 0);
  return { slots, rows: Math.max(leaf, 1), maxDepth, children, roots };
}

/** Build a preview tree (planned, dashed nodes) from a plan, before it is approved. */
export function planToTree(goalId: string, goalText: string, plan: Plan, fmtBudget: (tusd: string) => string): TreeDTO {
  const rootId = `goal:${goalId}`;
  const nodes: TreeNode[] = [{ id: rootId, kind: "goal", parentId: null, label: goalText, glyph: "planned", ghost: false, lines: ["preview — nothing funded yet"] }];
  const edges: TreeDTO["edges"] = [];
  plan.sessions.forEach((s, i) => {
    const id = `plan:${i}`;
    const letter = String.fromCharCode(65 + i);
    const parentId = s.parent !== undefined && s.parent < plan.sessions.length ? `plan:${s.parent}` : rootId;
    nodes.push({
      id,
      kind: "session",
      parentId,
      letter,
      role: s.role,
      label: `${letter} ${s.role} - planned`,
      status: "PLANNED",
      glyph: "planned",
      ghost: false,
      taskType: s.taskType,
      lines: [s.goal, `budget ${fmtBudget(s.budgetTUSD)} · max/payment ${fmtBudget(s.perPaymentMaxTUSD)}`],
    });
    edges.push({ from: parentId, to: id, kind: "parent" });
    for (const c of s.contextFrom ?? []) if (c < plan.sessions.length) edges.push({ from: `plan:${c}`, to: id, kind: "handback" });
  });
  return { goalId, nodes, edges };
}

/** "<letter> <role> - <status>" (spec §6.4). */
export function nodeLabel(n: TreeNode): string {
  if (n.kind === "goal") return n.label;
  if (n.kind === "session" && n.letter && n.role) {
    const word = sessionStatusWord(n.status, n.glyph);
    return `${n.letter} ${n.role} - ${word}`;
  }
  return n.label;
}
