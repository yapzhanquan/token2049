// Entry: `pnpm --filter @bulkhead/sokosumi-worker start` (continuous) or `… once` (one pass).
// Preprod only. Credentials: Coworker key stays in the Sokosumi CLI's OS vault; ENGINE_TOKEN and the
// MPS runtime token are read from env/private files and never printed.
import { join } from "node:path";
import { loadConfig } from "./config";
import { HttpEngine } from "./engine";
import { RAW_UTF8_SHA256 } from "./hash";
import { JournalStore } from "./journal";
import { acquireWorkerLock } from "./lock";
import { disabledGate, MpsPaymentGate } from "./payment-gate";
import { blockfrostUtxos } from "./settlement";
import { CliSokosumi, clip, coworkerCoreLoader, locateCli, nodeCliRunner } from "./sokosumi";
import { TaskRunner } from "./task-runner";
import { engineUserResolver, Worker } from "./worker";

async function main() {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const store = new JournalStore(cfg.stateDir);
  const release = acquireWorkerLock(join(cfg.stateDir, "worker.lock"));
  process.once("exit", release);
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => controller.abort());

  const cli = await locateCli();
  const soko = new CliSokosumi({ coworkerId: cfg.coworkerId, organizationId: cfg.organizationId, organizationSlug: cfg.organizationSlug }, nodeCliRunner(cli), coworkerCoreLoader(cli, cfg.coworkerId));
  const engine = new HttpEngine(cfg.engineUrl, cfg.engineToken, fetch, 180_000);
  const gate = cfg.gate.enabled ? new MpsPaymentGate(cfg.gate) : disabledGate;
  const readiness = gate.readiness();
  const runner = new TaskRunner({
    soko,
    engine,
    gate,
    store,
    cfg: cfg.runner,
    hashRule: RAW_UTF8_SHA256,
    fetchUtxos: blockfrostUtxos(cfg.blockfrostProjectId),
    engineUserId: engineUserResolver(engine, store, cfg.engineUserEmail),
  });
  const worker = new Worker({ coworkerId: cfg.coworkerId, soko, runner });
  console.log(
    `Sokosumi worker pid ${process.pid} · CLI ${cli.version} · coworker ${cfg.coworkerId} · engine ${cfg.engineUrl} · paid Tasks ${readiness.ready ? "ON" : `off (${readiness.reason})`} · hash ${RAW_UTF8_SHA256.name} · state ${cfg.stateDir}`,
  );
  if (once) await worker.pass();
  else await worker.run(cfg.pollIntervalMs, controller.signal);
  release();
}

main().catch((e) => {
  console.error(`sokosumi-worker: ${clip(e, 300)}`);
  process.exit(1);
});
