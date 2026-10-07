// Owner recovery after expiry for the e2e (spec §8.8).
//  - preprod: spawns the real CLI (`tsx scripts/recover.ts --session <id> --wait`) against the e2e DB;
//  - dry run: the same logic in-process against the FakeChain (recover.ts builds its chain from env, so it
//    cannot see an in-memory FakeChain). Kept line-for-line equivalent to scripts/recover.ts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rawSqlite } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import { vaultRecoverOf } from "../../src/vault";

export interface RecoverResult {
  /** 0 = swept (or nothing to sweep), 2 = not expired yet (nothing submitted), 1 = error. */
  code: number;
  txHash?: string;
  feeLovelace?: bigint;
  output: string;
}

type Row = { id: string; status: string; address: string | null; expiry_slot: number | null; wallet_mode: string | null; log_sha256: string | null; handback_sha256: string | null; treasury_address: string };

function sessionRow(sessionId: string): Row | undefined {
  return rawSqlite()
    .prepare("SELECT s.id, s.status, s.address, s.expiry_slot, s.wallet_mode, s.log_sha256, s.handback_sha256, u.treasury_address FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?")
    .get(sessionId) as Row | undefined;
}

/** The log hash recover.ts puts in metadata 674 when the engine never stored one. */
export function recoverLogSha(sessionId: string): string {
  const s = sessionRow(sessionId);
  if (s?.log_sha256) return s.log_sha256;
  const rows = rawSqlite().prepare("SELECT id, at, type, data_json FROM events WHERE session_id = ? ORDER BY id").all(sessionId);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function recoverInProcess(chain: Chain, sessionId: string): Promise<RecoverResult> {
  const s = sessionRow(sessionId);
  if (!s || !s.address || s.expiry_slot == null) return { code: 1, output: `session ${sessionId} has no wallet` };
  const tip = await chain.provider.fetchTip();
  const vault = s.wallet_mode === "vault";
  if (vault ? tip.slot <= s.expiry_slot : tip.slot < s.expiry_slot) return { code: 2, output: `Not expired yet: tip ${tip.slot} < expiry slot ${s.expiry_slot}. Nothing submitted.` };
  const logSha = recoverLogSha(sessionId);
  try {
    const metadata674 = { session_id: s.id, log_sha256: logSha, handback_sha256: s.handback_sha256 ?? "none", status: "RECOVERED_BY_OWNER" };
    const recover = vault ? vaultRecoverOf(chain) : null;
    if (vault && !recover) return { code: 1, output: "chain has no vaultRecover" };
    const r = recover ? await recover({ sessionId: s.id, metadata674 }) : await chain.tx.sweep({ sessionId: s.id, signer: "owner", toAddress: s.treasury_address, metadata674 });
    return { code: 0, txHash: r.txHash, feeLovelace: r.feeLovelace, output: `${vault ? "Vault Recover" : "Owner sweep"} submitted: tx ${r.txHash}` };
  } catch (e) {
    if ((e as { name?: string }).name === "NothingToSweepError" || (e as { code?: string }).code === "NOTHING_TO_SWEEP") return { code: 0, output: "Nothing to recover" };
    return { code: 1, output: (e as Error).message };
  }
}

export function recoverCli(args: { sessionId: string; dbPath: string; env: NodeJS.ProcessEnv; wait: boolean; timeoutMs: number }): Promise<RecoverResult> {
  const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const argv = [tsxCli, "scripts/recover.ts", "--session", args.sessionId, ...(args.wait ? ["--wait"] : [])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: engineDir, env: { ...args.env, DATABASE_PATH: args.dbPath }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b: Buffer) => (output += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (output += b.toString("utf8")));
    const timer = setTimeout(() => child.kill(), args.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const m = /tx ([0-9a-f]{64}) \(fee ([\d.]+) ADA\)/.exec(output);
      resolve({
        code: code ?? 1,
        output,
        ...(m ? { txHash: m[1], feeLovelace: BigInt(Math.round(Number(m[2]) * 1_000_000)) } : {}),
      });
    });
  });
}
