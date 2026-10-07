// pnpm verify:chain — on-chain verification of Bulkhead's on-chain layer on Cardano PREPROD.
//
// Runs, SEQUENTIALLY (never in parallel — only one preprod submitter at a time):
//   1. runVaultOnchain()   from scripts/vault-onchain.ts   (Session Vault: fund → Pay → over-limit → attacker → Revoke → Recover)
//   2. runStakingOnchain() from scripts/staking-onchain.ts (stake registration + pool delegation + vote delegation)
// Each of those acquires and releases the chain lock (<repo>/.chain-lock) ITSELF, so this script must not hold it.
// Their detailed sections are written into CHAIN_VERIFICATION.md by them; this script maintains one summary
// block in that file (between the verify:chain markers), replacing only that block on every run.
// A step module that does not exist yet is reported as NOT RUN (and the exit code is non-zero).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { explorerTx } from "@bulkhead/shared";

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  txHash?: string;
}
interface RunResult {
  ok: boolean;
  steps: StepResult[];
}
type Runner = (opts?: { log?: (s: string) => void }) => Promise<RunResult>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const reportPath = join(repoRoot, "CHAIN_VERIFICATION.md");
const BEGIN = "<!-- verify:chain:begin -->";
const END = "<!-- verify:chain:end -->";

const SUITES: { title: string; file: string; fn: string }[] = [
  { title: "Session Vault (Aiken, Plutus V3)", file: "vault-onchain.ts", fn: "runVaultOnchain" },
  { title: "Staking + vote delegation", file: "staking-onchain.ts", fn: "runStakingOnchain" },
];

const log = (s: string) => console.log(`[verify:chain] ${s}`);

async function runSuite(s: (typeof SUITES)[number]): Promise<{ title: string; status: "PASS" | "FAIL" | "NOT RUN"; result?: RunResult; error?: string; ms: number }> {
  const t0 = Date.now();
  const path = join(here, s.file);
  if (!existsSync(path)) return { title: s.title, status: "NOT RUN", error: `scripts/${s.file} does not exist yet`, ms: 0 };
  let run: Runner | undefined;
  try {
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    run = typeof mod[s.fn] === "function" ? (mod[s.fn] as Runner) : undefined;
  } catch (e) {
    return { title: s.title, status: "NOT RUN", error: `could not load scripts/${s.file}: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  if (!run) return { title: s.title, status: "NOT RUN", error: `scripts/${s.file} does not export ${s.fn}()`, ms: 0 };
  log(`▶ ${s.title} (${s.fn})`);
  try {
    const result = await run({ log: (m) => console.log(`  [${s.fn}] ${m}`) });
    const ok = result.ok && result.steps.every((x) => x.ok);
    return { title: s.title, status: ok ? "PASS" : "FAIL", result, ms: Date.now() - t0 };
  } catch (e) {
    return { title: s.title, status: "FAIL", error: (e as Error).stack ?? String(e), ms: Date.now() - t0 };
  }
}

function summaryBlock(results: Awaited<ReturnType<typeof runSuite>>[], startedAt: Date): string {
  const lines: string[] = [BEGIN, "## pnpm verify:chain — summary", "", `Run ${startedAt.toISOString()} on Cardano **preprod** (sections below/above are written by each suite).`, ""];
  lines.push("| Suite | Result | Duration |", "|---|---|---|");
  for (const r of results) lines.push(`| ${r.title} | ${r.status} | ${(r.ms / 1000).toFixed(0)} s |`);
  for (const r of results) {
    lines.push("", `### ${r.title} — ${r.status}`);
    if (r.error) lines.push("", "```", r.error.slice(0, 2_000), "```");
    if (r.result?.steps.length) {
      lines.push("", "| Step | OK | Detail | Tx |", "|---|---|---|---|");
      for (const s of r.result.steps) {
        const detail = s.detail.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 400);
        lines.push(`| ${s.name} | ${s.ok ? "✓" : "✗"} | ${detail} | ${s.txHash ? `[${s.txHash.slice(0, 12)}…](${explorerTx(s.txHash)})` : "—"} |`);
      }
    }
  }
  lines.push("", END);
  return lines.join("\n");
}

function writeSummary(block: string) {
  const current = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "# Bulkhead — chain verification (Cardano preprod)\n";
  const b = current.indexOf(BEGIN);
  const e = current.indexOf(END);
  const next = b >= 0 && e > b ? current.slice(0, b) + block + current.slice(e + END.length) : `${current.trimEnd()}\n\n${block}\n`;
  writeFileSync(reportPath, next, "utf8");
}

async function main(): Promise<number> {
  const startedAt = new Date();
  if (/mainnet/i.test(process.env.NETWORK ?? "")) throw new Error("verify:chain is preprod-only");
  const results: Awaited<ReturnType<typeof runSuite>>[] = [];
  for (const s of SUITES) {
    const r = await runSuite(s); // sequential on purpose: each suite holds the chain lock while it submits
    results.push(r);
    log(`${r.status === "PASS" ? "✓" : "✗"} ${s.title}: ${r.status}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}`);
  }
  // Re-read the file after the suites (they append their own sections) and update only our block.
  writeSummary(summaryBlock(results, startedAt));
  log(`summary written to ${reportPath}`);
  return results.every((r) => r.status === "PASS") ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`verify:chain crashed: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
