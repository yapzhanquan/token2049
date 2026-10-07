// Masumi buyer-path smoke: ONE capped purchase from a real Masumi registry agent through the dedicated MPS,
// using exactly the production code path (market-masumi.ts: discovery → MIP-003 start_job → POST /purchase →
// escrow lock → seller result → MIP-004 check). Cardano PREPROD only.
//
//   pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/masumi-hire-smoke.ts [mode] [flags]
//
// Modes (default: preflight):
//   preflight  read-only. MPS auth + scope, purchasing wallet, payment source, wallet balance (Blockfrost),
//              on-chain agent discovery, the chosen agent's /availability + /input_schema. Moves nothing.
//   quote      preflight + the seller's MIP-003 POST /start_job (the seller creates an UNPAID payment request;
//              still no money moves). Prints the signed terms it would buy.
//   buy        quote + MPS POST /purchase (locks the price from the purchasing wallet in the Masumi escrow),
//              then polls until the seller's result is verified (MIP-004) or the job fails. Needs
//              --confirm-purchase. Refuses unless the wallet holds the price + MASUMI_SMOKE_MIN_ADA.
// Flags:
//   --agent <agentIdentifier|catalog id>   which agent (default: cheapest listed Fixed-price agent)
//   --input "<text>"                        free-text job input (default: a short Cardano question)
//   --max <tUSDM>                           hard price cap, default 1 (also MASUMI_MAX_PRICE_TUSD)
//   --confirm-purchase                      required for `buy`
//   --timeout-min <n>                       buy: give up polling after n minutes (default 45; the job is resumable)
//   --resume <jobId>                        buy: continue polling a job saved by an earlier run
//
// Funding (from the purchasing wallet itself — this smoke does NOT use a Session Vault): the wallet pays the
// agent's price in tUSDM (unit 16a55b2a…ddde0014df10745553444d) plus ADA for the lock tx: min-UTxO in the
// escrow output (returned at settlement), a 5 ADA collateral "splitter" self-output and fees. Send at least
// 20 tADA + the price in tUSDM (we suggest 25 tADA + 2 tUSDM) to the purchasing wallet address it prints.
//
// Secrets: the MPS buyer key comes from bulkhead/.local/mps-buyer.env (MPS_BUYER_TOKEN, wallet-scoped
// ReadAndPay) and Blockfrost from BLOCKFROST_PREPROD_PROJECT_ID. Neither is ever printed. No admin key is used:
// a refund stays in the purchasing wallet (state "unswept") for the operator. Job state is journalled to
// bulkhead/.local/masumi-smoke/jobs.json (gitignored) BEFORE every external write.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { microToTusd, tusdToMicro } from "@bulkhead/shared";
import { PREPROD_TUSDM_UNIT, createMasumiMarket, inputFieldOf, masumiConfigFromEnv, type MasumiJobRecord, type MasumiStore } from "../src/market-masumi";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STORE_FILE = resolve(REPO, ".local/masumi-smoke/jobs.json");
const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const say = (m: string) => console.log(`[masumi-smoke] ${m}`);

function args(argv: string[]) {
  const a = { mode: "preflight", agent: undefined as string | undefined, input: "In three bullet points: what does a Cardano preprod faucet give you and what are its limits?", max: undefined as string | undefined, confirm: false, timeoutMin: 45, resume: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "preflight" || k === "quote" || k === "buy") a.mode = k;
    else if (k === "--agent") a.agent = v();
    else if (k === "--input") a.input = v();
    else if (k === "--max") a.max = v();
    else if (k === "--confirm-purchase") a.confirm = true;
    else if (k === "--timeout-min") a.timeoutMin = Number(v());
    else if (k === "--resume") a.resume = v();
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Atomic JSON-file store (owner-only), so a crashed run can be resumed and nothing is ever re-posted blindly. */
function fileStore(path: string): MasumiStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const read = (): Record<string, string> => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {});
  return {
    get: (k) => read()[k] ?? null,
    set: (k, v) => {
      const all = read();
      all[k] = v;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
      renameSync(tmp, path);
    },
    list: (prefix) => Object.entries(read()).filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}

async function balance(address: string, key: string | undefined): Promise<{ lovelace: bigint; tusdm: bigint } | "unfunded" | "unknown"> {
  if (!key) return "unknown";
  const r = await fetch(`${BF}/addresses/${address}`, { headers: { project_id: key }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return "unfunded"; // Blockfrost: address never seen on-chain
  if (!r.ok) return "unknown";
  const j = (await r.json()) as { amount?: { unit: string; quantity: string }[] };
  const q = (u: string) => BigInt(j.amount?.find((a) => a.unit === u)?.quantity ?? "0");
  return { lovelace: q("lovelace"), tusdm: q(PREPROD_TUSDM_UNIT) };
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { __nonJson: t.slice(0, 60) };
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const env = process.env;
  if (/mainnet/i.test(env.NETWORK ?? "") || (env.MASUMI_NETWORK && env.MASUMI_NETWORK !== "Preprod")) throw new Error("preprod only");
  const maxTusdm = a.max ?? env.MASUMI_MAX_PRICE_TUSD ?? "1";
  const minAda = BigInt(env.MASUMI_SMOKE_MIN_ADA ?? "20") * 1_000_000n;
  // A dummy tUSD unit: the smoke pays from the purchasing wallet's own tUSDM float, never Bulkhead tUSD.
  const cfg = { ...masumiConfigFromEnv({ ...env, MASUMI_MAX_PRICE_TUSD: maxTusdm }, "00".repeat(28) + "00", REPO), requireOnChainResult: true };
  if (!cfg.blockfrostProjectId) say("BLOCKFROST_PREPROD_PROJECT_ID not set: on-chain discovery and the balance check are off");
  const store = fileStore(STORE_FILE);
  let walletAddr = "";
  /** Only the job this run is buying counts as funded (an older quote in the journal must never be purchased). */
  let activeNonce: string | null = null;
  const market = createMasumiMarket(cfg, {
    store,
    // This smoke plays the vault's role: the funding IS the purchasing wallet's own float, already on-chain.
    funding: ({ reference }) => {
      if (a.mode !== "buy" || reference !== activeNonce) return null;
      const rec = store
        .list("masumi:job:")
        .map((r) => JSON.parse(r.value) as MasumiJobRecord)
        .find((r) => r.nonce === reference && r.terms);
      return rec ? { status: "confirmed", txHash: null, amountMicro: BigInt(rec.amountMicro), payee: walletAddr } : null;
    },
    sweepTarget: () => null, // never move funds out of the purchasing wallet from here
    emit: (type, _s, data) => say(`${type}: ${JSON.stringify(data)}`),
    log: (m) => say(m),
  });

  // ── preflight (read-only) ──
  const mps = cfg.mpsUrl.replace(/\/+$/, "");
  const health = (await getJson(`${mps}/health`)) as { data?: { status?: string } };
  say(`MPS ${mps.replace(/\/api\/v1$/, "")} health: ${health.data?.status ?? "?"}`);
  const st = (await (await fetch(`${mps}/api-key-status`, { headers: { token: cfg.buyerToken } })).json()) as { data?: Record<string, unknown> };
  const k = st.data ?? {};
  say(`buyer key: canRead=${String(k.canRead)} canPay=${String(k.canPay)} canAdmin=${String(k.canAdmin)} networks=${JSON.stringify(k.NetworkLimit)} walletScopes=${JSON.stringify(k.WalletScopes)}`);
  if (k.canPay !== true || k.canAdmin === true) throw new Error("the buyer key must be canPay and NOT admin");
  walletAddr = await market.purchasingWallet();
  say(`purchasing wallet: ${walletAddr}`);
  const bal = await balance(walletAddr, cfg.blockfrostProjectId);
  say(`balance: ${typeof bal === "string" ? bal : `${microToTusd(bal.lovelace)} tADA, ${microToTusd(bal.tusdm)} tUSDM`}`);

  if (a.resume) return poll(a.resume);

  const cat = await market.catalog();
  const rep = market.discoveryReport();
  say(`discovery: ${rep.listed} hireable agents, ${rep.excluded.length} excluded`);
  const fixed = cat.filter((x) => x.pricingType === "Fixed" && tusdToMicro(x.priceTUSD) > 0n).sort((x, y) => Number(tusdToMicro(x.priceTUSD) - tusdToMicro(y.priceTUSD)));
  // Default: the cheapest Fixed-price agent that is up and whose /input_schema takes one free-text field.
  const candidates = a.agent ? cat.filter((x) => x.id === a.agent || x.agentIdentifier === a.agent) : fixed;
  let agent: (typeof cat)[number] | undefined;
  for (const c of candidates.slice(0, 15)) {
    const av = (await getJson(`${c.endpoint}/availability`).catch(() => ({}))) as Record<string, unknown>;
    const field = inputFieldOf(await getJson(`${c.endpoint}/input_schema`).catch(() => null));
    say(`  candidate ${c.name} ${c.priceTUSD} @ ${c.endpoint}: availability=${String(av.status ?? "no JSON")} field=${field ?? "-"}`);
    if (av.status === "available" && field) {
      agent = c;
      break;
    }
  }
  if (!agent) throw new Error(a.agent ? `agent ${a.agent} is not hireable now (discovery/cap ${maxTusdm}/availability/input schema)` : "no available Fixed-price agent under the cap with a free-text input");
  say(`agent: ${agent.name} (${agent.agentIdentifier}) ${agent.pricingType} ${agent.priceTUSD} tUSDM-equivalent at ${agent.endpoint}`);
  if (a.mode === "preflight") return say("preflight done (nothing written anywhere). Next: `quote`, then `buy --confirm-purchase`.");

  if (a.mode === "buy") {
    if (!a.confirm) throw new Error("buy needs --confirm-purchase");
    if (typeof bal === "string") throw new Error(`wallet balance ${bal}: fund ${walletAddr} first (≥ ${microToTusd(minAda)} tADA + the price in tUSDM)`);
    const price = tusdToMicro(agent.priceTUSD);
    if (agent.pricingType !== "Fixed") say("Dynamic agent: the price is only known from the signed quote; it is capped at --max");
    if (bal.lovelace < minAda) throw new Error(`need ≥ ${microToTusd(minAda)} tADA in the purchasing wallet, have ${microToTusd(bal.lovelace)}`);
    if (bal.tusdm < price) throw new Error(`need ≥ ${agent.priceTUSD} tUSDM, have ${microToTusd(bal.tusdm)}`);
  }

  // ── quote: MIP-003 start_job (seller-side unpaid payment request; journalled first) ──
  const job = await market.startJob(agent.id, a.input, { sessionId: "masumi-smoke" });
  const rec = market.job(job.jobId)!;
  say(`quote: job ${job.jobId}, ${microToTusd(job.amountMicro)} (${rec.amounts.map((x) => `${x.amount} ${x.unit ? x.unit.slice(-18) : "lovelace"}`).join(" + ")}), payBy ${new Date(Number(rec.terms.payByTime)).toISOString()}, submitResult ${new Date(Number(rec.terms.submitResultTime)).toISOString()}, blockchainIdentifier ${rec.terms.blockchainIdentifier.slice(0, 24)}…`);
  if (a.mode === "quote") return say("quote done. No purchase posted; the seller's payment request simply expires at payByTime.");
  if (typeof bal !== "string" && bal.tusdm < job.amountMicro) throw new Error("signed price exceeds the wallet's tUSDM; not purchasing");
  activeNonce = job.reference;
  return poll(job.jobId);

  async function poll(jobId: string) {
    const r0 = market.job(jobId);
    if (!r0) throw new Error(`no saved job ${jobId} in ${STORE_FILE}`);
    if (a.mode !== "buy" || !a.confirm) throw new Error("--resume is only for buy --confirm-purchase");
    activeNonce = r0.nonce;
    const until = Date.now() + a.timeoutMin * 60_000;
    let last = "";
    while (Date.now() < until) {
      const s = await market.status(r0.serviceId, jobId);
      await market.tick();
      const r = market.job(jobId)!;
      const line = `${r.phase} / ${s.status}${r.purchaseId ? ` purchase ${r.purchaseId}` : ""}${r.error ? ` (${r.error})` : ""}`;
      if (line !== last) say(line);
      last = line;
      if (s.status === "completed") {
        say(`RESULT verified: MIP-004 sha256(nonce;result) = ${s.resultHash} matches the seller's on-chain resultHash`);
        say(`result (first 400 chars): ${(s.result ?? "").slice(0, 400)}`);
        return;
      }
      if (["failed", "refunded", "unswept", "swept"].includes(r.phase) && s.status === "failed") return say(`job ended: ${r.phase}${r.refundReason ? ` — ${r.refundReason}` : ""}`);
      await new Promise((res) => setTimeout(res, 20_000));
    }
    say(`stopped polling after ${a.timeoutMin} min; resume with: buy --confirm-purchase --resume ${jobId}`);
  }
}

main().catch((e: unknown) => {
  console.error(`[masumi-smoke] ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
