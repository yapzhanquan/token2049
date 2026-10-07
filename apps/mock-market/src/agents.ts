// The three mock paid agents (spec §5.6). Their "work" is deterministic and LLM-free:
// the same input always yields the same result text, so result_hash is reproducible.
import { createHash } from "node:crypto";

export interface AgentDef {
  id: string;
  name: string;
  skills: string[];
  priceTUSD: string;
  /** Index into the chain package's agent wallets (agentWallet(i)). */
  walletIndex: number;
  description: string;
  work(input: string): string;
}

/** MIP-003 /input_schema body. Every mock agent takes one free-text field. */
export function inputSchemaFor(agent: AgentDef) {
  return {
    input_data: [
      {
        id: "text",
        type: "string",
        name: agent.id === "summariser" ? "Text to summarise" : agent.id === "fact-checker" ? "Claims to check" : "Research topic",
        data: { description: agent.description, placeholder: "Plain text, max 20000 characters" },
        validations: [
          { validation: "min", value: "1" },
          { validation: "max", value: "20000" },
        ],
      },
    ],
  };
}

export const MAX_INPUT_CHARS = 20_000;

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with not but can into than then there their these those about over after also more most such".split(" "),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

function keywords(text: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const w of words(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function marketResearch(input: string): string {
  const topic = clip(input.trim().replace(/\s+/g, " "), 160);
  const kws = keywords(input, 6);
  const seed = parseInt(sha256Hex(input).slice(0, 8), 16);
  const segments = ["Consumers", "SMEs", "Enterprises", "Developers", "Public sector"];
  const lines = [
    `# Market research note`,
    `Topic: ${topic}`,
    ``,
    `## Key themes`,
    ...(kws.length ? kws.map((k, i) => `${i + 1}. ${k}`) : ["1. (input too short to extract themes)"]),
    ``,
    `## Segments to examine`,
    ...[0, 1, 2].map((i) => `- ${segments[(seed + i) % segments.length]}`),
    ``,
    `## Questions for follow-up`,
    `- Who currently pays for "${kws[0] ?? "this"}" and how much?`,
    `- What substitutes exist for "${kws[1] ?? kws[0] ?? "this"}"?`,
    `- Which regulation applies in the target market?`,
    ``,
    `## Method`,
    `Deterministic keyword analysis of the brief (mock agent, no external sources, no LLM).`,
  ];
  return lines.join("\n");
}

function summarise(input: string): string {
  const ss = sentences(input);
  const kws = new Set(keywords(input, 8));
  const scored = ss.map((s, i) => ({ s, i, score: words(s).filter((w) => kws.has(w)).length }));
  const top = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 3).sort((a, b) => a.i - b.i);
  const lines = [
    `# Summary`,
    ...(top.length ? top.map((t) => `- ${clip(t.s, 240)}`) : ["- (empty input)"]),
    ``,
    `Keywords: ${[...kws].join(", ") || "(none)"}`,
    `Source length: ${ss.length} sentence(s), ${input.length} character(s).`,
    `Method: extractive keyword scoring (mock agent, no LLM).`,
  ];
  return lines.join("\n");
}

function factCheck(input: string): string {
  const claims = sentences(input).slice(0, 10);
  const verdict = (c: string) => {
    if (/\d/.test(c)) return "NEEDS SOURCE (contains a figure that must be verified against a primary source)";
    if (/\b(always|never|all|none|every|guaranteed|100%)\b/i.test(c)) return "LIKELY OVERSTATED (absolute wording)";
    if (/\b(may|might|could|some|often|reportedly)\b/i.test(c)) return "HEDGED (no factual commitment to check)";
    return "UNVERIFIED (no checkable specifics)";
  };
  const lines = [
    `# Fact-check report`,
    ...(claims.length ? claims.map((c, i) => `${i + 1}. "${clip(c, 200)}" → ${verdict(c)}`) : ["(no claims found)"]),
    ``,
    `Method: rule-based claim triage (mock agent, no external lookups, no LLM).`,
  ];
  return lines.join("\n");
}

export const AGENTS: AgentDef[] = [
  {
    id: "market-research",
    name: "Market Research Agent",
    skills: ["market research", "competitor analysis", "segmentation"],
    priceTUSD: "2",
    walletIndex: 0,
    description: "Produces a structured market research note for a topic or product brief.",
    work: marketResearch,
  },
  {
    id: "summariser",
    name: "Summariser Agent",
    skills: ["summarisation", "keyword extraction"],
    priceTUSD: "1",
    walletIndex: 1,
    description: "Extractive summary (top sentences + keywords) of the supplied text.",
    work: summarise,
  },
  {
    id: "fact-checker",
    name: "Fact-checker Agent",
    skills: ["fact checking", "claim triage"],
    priceTUSD: "1.5",
    walletIndex: 2,
    description: "Splits text into claims and triages each one (needs source / overstated / hedged / unverified).",
    work: factCheck,
  },
];

export function findAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}
