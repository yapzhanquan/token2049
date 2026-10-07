// Live Sokosumi check through the engine's market (market-sokosumi.ts), preprod only. Never prints the API key.
//   pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/sokosumi-live.ts            (read-only)
//   … scripts/sokosumi-live.ts --hire <sokosumi agent id> "<input>" [budgetTUSD=0.02]                          (ONE paid job)
//   … scripts/sokosumi-live.ts --resume <job id>                                       (poll an earlier job; read-only)
// The hire uses a stand-in session mandate: budget = per-payment max = budgetTUSD → maxCredits = floor(budget × rate)
// (0.02 tUSD × 100 credits/tUSDM = 2 credits). Credits come only from SOKOSUMI_HIRE_ORGANIZATION_SLUG.
// Job records (balances before/after, deltas, result hash — never the key) persist in bulkhead/.local/sokosumi-live.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tusdToMicro } from "@bulkhead/shared";
import { createSokosumiMarket, sokosumiConfigFromEnv, type SokosumiStore } from "../src/market-sokosumi";

const FILE = fileURLToPath(new URL("../../../.local/sokosumi-live.json", import.meta.url));
const mem = new Map<string, string>(existsSync(FILE) ? Object.entries(JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>) : []);
const persist = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(mem), null, 1));
};
const store: SokosumiStore = {
  get: (k) => mem.get(k) ?? null,
  set: (k, v) => {
    mem.set(k, v);
    persist();
  },
  list: (p) => [...mem].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
};
const cfg = sokosumiConfigFromEnv(process.env);
console.log(`SOKOSUMI_API_KEY: set (${cfg.apiKey.length} chars) · api ${cfg.apiUrl} · org ${cfg.organizationSlug} (${cfg.organizationId}) · rate ${cfg.creditsPerTusd} credits/tUSDM · ceiling ${cfg.maxCreditsPerHire}`);
const args = process.argv.slice(2);
const budget = tusdToMicro(args[0] === "--hire" ? (args[3] ?? "0.02") : "0.02");
const market = createSokosumiMarket(cfg, {
  store,
  mandate: () => ({ status: "RUNNING", budgetMicro: budget, spentMicro: 0n, creditSpentMicro: 0n, perPaymentMaxMicro: budget }),
  emit: (type, _s, data) => console.log(`[event ${type}] ${JSON.stringify(data)}`),
});

async function poll(serviceId: string, jobId: string) {
  const until = Date.now() + Number(process.env.SOKOSUMI_JOB_TIMEOUT_MS ?? 15 * 60_000);
  let r = { status: "running" } as Awaited<ReturnType<typeof market.status>>;
  let authErrors = 0;
  while (Date.now() < until) {
    try {
      r = await market.status(serviceId, jobId);
      authErrors = 0;
      if (r.status !== "running") break;
    } catch (e) {
      const status = (e as { status?: number }).status;
      console.log(`status read failed: ${e instanceof Error ? e.message : String(e)}`);
      // 401/403: stop (no retry storm with a dead key); rerun with --resume once the key is valid.
      if (status === 401 || status === 403 || ++authErrors >= 5) break;
    }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  const rec = market.job(jobId);
  console.log(`final status ${r.status} · resultHash ${r.resultHash ?? "-"} · result ${r.result ? `${r.result.length} chars` : "-"}`);
  if (rec) console.log(`record ${JSON.stringify({ ...rec, result: rec.result ? `${rec.result.slice(0, 400)}…` : undefined })}`);
  console.log(`disabled: ${market.disabled() ?? "no"}`);
}

if (args[0] === "--resume") {
  const jobId = args[1]!;
  const rec = market.job(jobId);
  if (!rec) throw new Error(`no stored record for ${jobId} in .local/sokosumi-live.json`);
  await poll(rec.serviceId, jobId);
} else {
  const list = await market.catalog();
  console.log(`catalog: ${list.length} credit-priced agents; ≤2 credits: ${list.filter((a) => a.credits <= 2).map((a) => `${a.name} (${a.credits})`).join(", ")}`);
  const b = await market.balances();
  console.log(`balances: org ${b.org} · no-slug context scope ${b.contextScope} · personal ${b.personal ?? "not readable with this key"} · other orgs ${JSON.stringify(b.others)}`);
  if (args[0] === "--hire") {
    const serviceId = args[1]!.startsWith("sokosumi:") ? args[1]! : `sokosumi:${args[1]}`;
    const schema = await market.inputSchema(serviceId);
    console.log(`input fields: ${schema.fields.map((f) => `${f.id}:${f.type}${f.required ? "*" : ""}`).join(", ")}`);
    const job = await market.startJob(serviceId, args[2] ?? "", { sessionId: "live-check" });
    console.log(`job ${job.jobId} created · billing ${JSON.stringify(job.billing)} · tUSD-equivalent ${job.amountMicro}`);
    await poll(serviceId, job.jobId);
  }
}
