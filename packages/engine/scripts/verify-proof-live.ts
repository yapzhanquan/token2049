// Live, READ-ONLY trust-receipt check: build the proof of a goal from the DB (opened read-only, the running
// engine is not touched) exactly as GET /goals/:id/proof does, then run the browser verifier
// (apps/web/lib/verify-proof.ts) against Blockfrost preprod. Nothing is signed or submitted.
//
//   pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists=../../.env scripts/verify-proof-live.ts g_844d6715 [g_…]
//
// Needs BLOCKFROST_PREPROD_PROJECT_ID (never printed). Goal ids may be given as a unique prefix.
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { dbPath, schema } from "@bulkhead/db";
import { settlementAssetFromEnv } from "@bulkhead/shared";
import { cst } from "../../chain/src/mesh";
import { buildGoalProof } from "../src/api-proof";
import { blockfrostReader, verifyGoal, type CstLike } from "../../../apps/web/lib/verify-proof";

const require = createRequire(import.meta.resolve("@bulkhead/db"));
interface RoSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
const Database = require("better-sqlite3") as new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => RoSqlite;

async function main() {
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) throw new Error("BLOCKFROST_PREPROD_PROJECT_ID is not set (.env)");
  const prefixes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (prefixes.length === 0) throw new Error("usage: verify-proof-live.ts <goalId|prefix> […]");
  const sqlite = new Database(dbPath(), { readonly: true, fileMustExist: true });
  const db = drizzle(sqlite as never, { schema });
  const reader = blockfrostReader({ baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", headers: { project_id: key } });
  let unit: string | null = null;
  try {
    unit = settlementAssetFromEnv(process.env, { tusdUnit: process.env.TUSD_UNIT }).unit; // what the engine's chain.tx.tusdUnit() reports
  } catch {
    unit = null;
  }
  let failed = 0;
  for (const prefix of prefixes) {
    const ids = (sqlite.prepare("SELECT id FROM goals WHERE id LIKE ?").all(`${prefix}%`) as { id: string }[]).map((r) => r.id);
    if (ids.length !== 1) throw new Error(`${prefix}: ${ids.length} goals match`);
    const proof = buildGoalProof(db as never, ids[0]!, { assetUnit: () => unit });
    if (!proof) throw new Error(`${prefix}: goal not found`);
    console.log(`\n═══ ${proof.goalId} (${proof.status}) — ${proof.sessions.length} session(s)`);
    const results = await verifyGoal(proof, { reader, cst: cst as unknown as CstLike });
    for (const v of results) {
      const s = proof.sessions.find((x) => x.sessionId === v.sessionId)!;
      console.log(`\n  ${v.letter} ${v.sessionId} [${s.walletMode}] ${s.status} → ${v.status.toUpperCase()}`);
      if (v.recomputed) console.log(`    recomputed script ${v.recomputed.scriptHash}\n    recomputed address ${v.recomputed.address}`);
      for (const cl of v.claims) {
        console.log(`    ${cl.status === "pass" ? "✓" : cl.status === "fail" ? "✗" : "–"} ${cl.id.padEnd(13)} ${cl.detail}`);
        for (const l of cl.links) console.log(`        ${l.label}: ${l.url}`);
      }
      if (v.status === "fail") failed++;
    }
  }
  sqlite.close();
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
