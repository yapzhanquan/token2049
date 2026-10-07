// SiloRunner: one child_process.fork per session (spec §1, §5.5).
// The child gets a minimal env (no secrets, no keys), its own temp dir (deleted on close) and IPC as the
// ONLY channel. Every tool call is checked against allowedTools(taskType) and executed HERE, never in the child.
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { agentJobs, payments, type DB } from "@bulkhead/db";
import type { Chain } from "@bulkhead/chain";
import {
  DEFINITION_OF_DONE,
  HANDBACK_MAX_BYTES,
  HandbackSchema,
  allowedTools,
  microToTusd,
  tusdToMicro,
  type FromSilo,
  type PayDecision,
  type SiloCheckpoint,
  type TaskSpec,
  type ToSilo,
} from "@bulkhead/shared";
import type { AgentMarket, EventBus, LLM, SiloRunner } from "../contracts";
import type { RuntimeSigner } from "../signer";
import type { RuntimeSessionManager } from "../sessions";
import { toJson } from "../bus";
import { getSessionDb, newId, sleep, updateSessionDb, type RuntimeConfig } from "../sessions-store";
import { egressFetch, type LookupFn } from "./egress";

export interface RuntimeSiloRunner extends SiloRunner {
  bind(sessions: RuntimeSessionManager): void;
  lastHeartbeat(sessionId: string): number | undefined;
  /** Stop every silo (shutdown). */
  stopAll(reason: string): Promise<void>;
  /** For tests: the temp dir + pid of a live silo. */
  info(sessionId: string): { pid: number | undefined; tempDir: string } | undefined;
}

export interface SiloRunnerDeps {
  db: DB;
  bus: EventBus;
  chain: Chain;
  signer: RuntimeSigner;
  market: AgentMarket;
  config: RuntimeConfig;
  /** Needed only in "anthropic" mode: silos request completions over IPC (they never hold the key). */
  llm?: LLM;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}

interface Silo {
  child: ChildProcess;
  tempDir: string;
  taskType: TaskSpec["taskType"];
  allowWebFetch: boolean;
  dataScope: string[];
  lastHeartbeat: number;
  stopping: boolean;
  exited: Promise<void>;
  startMsg: ToSilo;
}

function tsxLoaderUrl(): string {
  const req = createRequire(import.meta.url);
  const pkg = req.resolve("tsx/package.json");
  return pathToFileURL(join(dirname(pkg), "dist", "loader.mjs")).href;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createSiloRunner(deps: SiloRunnerDeps): RuntimeSiloRunner {
  const { db, bus, chain, signer, market, config } = deps;
  const now = () => config.now();
  const silos = new Map<string, Silo>();
  let sessions: RuntimeSessionManager | null = null;
  const childEntry = config.childEntry ?? fileURLToPath(new URL("./child.ts", import.meta.url));
  let loader: string | null = null;

  const goalOf = (id: string) => getSessionDb(db, id)?.goalId;
  const ev = (type: Parameters<EventBus["emit"]>[0], sessionId: string, data: Record<string, unknown>) => bus.emit(type, { goalId: goalOf(sessionId), sessionId, data });
  const sendTo = (s: Silo | undefined, msg: ToSilo) => {
    if (s && s.child.connected && !s.child.killed) {
      try {
        s.child.send(msg);
      } catch {
        /* channel closed */
      }
    }
  };

  function checkpointOf(sessionId: string): SiloCheckpoint {
    const pays = db.select().from(payments).where(and(eq(payments.sessionId, sessionId), inArray(payments.status, ["submitted", "confirmed"]))).all();
    const jobs = db.select().from(agentJobs).where(and(eq(agentJobs.sessionId, sessionId), eq(agentJobs.status, "completed"))).all();
    const last = getSessionDb(db, sessionId)?.lastCheckpoint;
    return {
      payments: pays.map((p) => ({ payee: p.payee, amountTUSD: microToTusd(BigInt(p.amountMicro)), txHash: p.txHash! })),
      jobs: jobs.map((j) => ({ serviceId: j.serviceId, jobId: j.externalJobId ?? "", result: j.result ?? "", resultHash: j.resultHash ?? "" })),
      ...(last ? { lastProgress: (JSON.parse(last) as { progress?: string }).progress } : {}),
    };
  }

  function taskSpecOf(sessionId: string): TaskSpec {
    const r = getSessionDb(db, sessionId);
    if (!r) throw new Error(`session ${sessionId} not found`);
    const taskType = r.taskType as TaskSpec["taskType"];
    return {
      sessionId,
      role: r.role,
      agentType: r.agentType as TaskSpec["agentType"],
      taskType,
      definitionOfDone: DEFINITION_OF_DONE[taskType],
      goal: r.goal,
      budgetTUSD: microToTusd(BigInt(r.budgetMicro)),
      perPaymentMaxTUSD: microToTusd(BigInt(r.perPaymentMaxMicro)),
      allowedPayees: JSON.parse(r.allowedPayeesJson),
      deadline: r.expiresAt,
      ...(r.watchJson ? { watch: JSON.parse(r.watchJson) } : {}),
    };
  }

  // ─────────── tool execution (orchestrator side) ───────────
  type CallMsg = Extract<FromSilo, { type: "tool_call" }>;

  async function payAndWait(sessionId: string, req: { payee: string; amountMicro: bigint; memo: string; reference?: string }): Promise<PayDecision> {
    const d = await signer.pay(sessionId, req);
    if (d.kind !== "needs_approval") return d;
    ev("progress", sessionId, { kind: "log", level: "info", text: `payment ${microToTusd(req.amountMicro)} tUSD waits for user approval` });
    return signer.awaitResolution(d.paymentId);
  }

  async function runTool(sessionId: string, s: Silo, msg: CallMsg): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const allowed = allowedTools(s.taskType, { allowWebFetch: s.allowWebFetch });
    if (!allowed.includes(msg.tool)) {
      ev("tool_denied", sessionId, { tool: msg.tool, taskType: s.taskType, allowed });
      return { ok: false, error: `tool_denied: "${msg.tool}" is not allowed for a ${s.taskType} session (allowed: ${allowed.join(", ")})` };
    }
    const row = getSessionDb(db, sessionId);
    if (!row) return { ok: false, error: "session not found" };
    if (msg.tool !== "report_progress" && row.status !== "RUNNING") return { ok: false, error: `session is ${row.status}` };

    switch (msg.tool) {
      case "report_progress": {
        const text = clip(String(msg.args?.text ?? ""), 280);
        ev("progress", sessionId, { text });
        updateSessionDb(db, sessionId, { lastCheckpoint: toJson({ progress: text, at: now() }) }, now());
        return { ok: true, result: { recorded: true } };
      }
      case "web_fetch": {
        const url = String(msg.args?.url ?? "");
        const r = await egressFetch(url, {
          dataScope: s.dataScope,
          maxBytes: config.webFetchMaxBytes,
          timeoutMs: config.webFetchTimeoutMs,
          allowPrivateHosts: config.allowPrivateHosts,
          untrustedUrlPatterns: config.untrustedUrlPatterns,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.lookup ? { lookup: deps.lookup } : {}),
        });
        if (r.kind === "blocked") {
          ev("web_fetch", sessionId, { url: clip(url, 300), blocked: true, reason: r.reason });
          if (r.suspicious) {
            await sessions!.taint(sessionId, { url: clip(url, 300), reason: `egress blocked: ${r.reason}`, quarantine: true });
            return { ok: false, error: `quarantined: egress blocked (${r.reason}); awaiting user review` };
          }
          return { ok: false, error: `egress blocked: ${r.reason}` };
        }
        ev("web_fetch", sessionId, { url: clip(r.url, 300), status: r.status, bytes: r.bytes, truncated: r.truncated, untrusted: r.untrusted });
        // Any fetched content taints the session; flagged content quarantines it.
        await sessions!.taint(sessionId, { url: clip(r.url, 300), reason: r.untrusted ?? "read external content", quarantine: !!r.untrusted });
        if (r.untrusted) return { ok: false, error: `quarantined: ${r.untrusted}; awaiting user review` };
        return { ok: true, result: { url: r.url, status: r.status, contentType: r.contentType, truncated: r.truncated, text: r.text } };
      }
      case "pay": {
        let amountMicro = 0n;
        try {
          amountMicro = tusdToMicro(String(msg.args?.amountTUSD ?? ""));
        } catch {
          amountMicro = 0n; // → Signer rejects with invalid_amount
        }
        const d = await payAndWait(sessionId, { payee: String(msg.args?.payee ?? ""), amountMicro, memo: clip(String(msg.args?.memo ?? ""), 120) });
        return { ok: true, result: d };
      }
      case "hire_agent": {
        const serviceId = String(msg.args?.serviceId ?? "");
        const input = clip(String(msg.args?.input ?? ""), 4_000);
        let job;
        try {
          const allowedPayees = (() => {
            try {
              return JSON.parse(row.allowedPayeesJson) as { id: string; address: string; also?: string[] }[];
            } catch {
              return [];
            }
          })();
          job = await market.startJob(serviceId, input, { sessionId, allowedPayees });
        } catch (e) {
          return { ok: false, error: `hire failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        const jobRowId = newId("job");
        const t = now();
        db.insert(agentJobs).values({ id: jobRowId, sessionId, serviceId, externalJobId: job.jobId, input, priceMicro: job.amountMicro.toString(), status: "started", createdAt: t, updatedAt: t }).run();
        ev("agent_hired", sessionId, { jobRowId, jobId: job.jobId, serviceId, paymentAddress: job.paymentAddress, priceMicro: job.amountMicro.toString(), priceTUSD: microToTusd(job.amountMicro) });
        const setJob = (patch: Partial<typeof agentJobs.$inferSelect>) => db.update(agentJobs).set({ ...patch, updatedAt: now() }).where(eq(agentJobs.id, jobRowId)).run();
        // The agent's payment goes through the Signer like any other payment (allowlist, max, budget, approval).
        const d = await payAndWait(sessionId, { payee: job.paymentAddress, amountMicro: job.amountMicro, memo: `hire ${serviceId} ref:${job.reference}`, reference: job.reference });
        if (d.kind !== "submitted") {
          setJob({ status: "failed", paymentId: d.paymentId });
          return { ok: false, error: d.kind === "rejected" ? `payment rejected (${d.reason}): ${d.detail}` : "payment not approved" };
        }
        setJob({ status: "paid", paymentId: d.paymentId });
        ev("agent_job_paid", sessionId, { jobRowId, jobId: job.jobId, serviceId, txHash: d.txHash, paymentId: d.paymentId });
        const until = Math.min(getSessionDb(db, sessionId)!.expiresAt, now() + config.jobTimeoutMs);
        while (now() < until) {
          const st = getSessionDb(db, sessionId)?.status;
          if (!st || !["RUNNING", "PAUSED", "QUARANTINED"].includes(st) || !silos.has(sessionId)) return { ok: false, error: `session is ${st}` };
          try {
            const r = await market.status(serviceId, job.jobId);
            if (r.status === "completed") {
              setJob({ status: "completed", result: clip(r.result ?? "", 8_000), resultHash: r.resultHash ?? null });
              ev("agent_job_result", sessionId, { jobRowId, jobId: job.jobId, serviceId, resultHash: r.resultHash ?? null, preview: clip(r.result ?? "", 200) });
              return { ok: true, result: { jobId: job.jobId, result: r.result ?? "", resultHash: r.resultHash ?? "", txHash: d.txHash } };
            }
            if (r.status === "failed") {
              setJob({ status: "failed" });
              return { ok: false, error: "the agent reported the job failed" };
            }
            if (r.status === "running") setJob({ status: "running" });
          } catch {
            /* transient market error: keep polling */
          }
          await sleep(config.jobPollMs);
        }
        setJob({ status: "failed" });
        return { ok: false, error: "agent job timed out" };
      }
      case "read_chain": {
        const a = msg.args ?? ({} as CallMsg["args"] & { query?: string });
        const q = (a as { query?: string }).query;
        const address = (a as { address?: string }).address ?? row.address ?? undefined;
        try {
          if (q === "balance") {
            if (!address) return { ok: false, error: "address required" };
            const b = await chain.tx.balanceOf(address);
            return { ok: true, result: { address, lovelace: b.lovelace.toString(), tusdMicro: b.tusdMicro.toString(), tusd: microToTusd(b.tusdMicro), utxoCount: b.utxoCount } };
          }
          if (q === "utxos") {
            if (!address) return { ok: false, error: "address required" };
            return { ok: true, result: (await chain.provider.fetchUtxos(address)).slice(0, 50) };
          }
          if (q === "tip") return { ok: true, result: await chain.provider.fetchTip() };
          if (q === "tx") {
            const h = (a as { txHash?: string }).txHash;
            if (!h || !/^[0-9a-f]{64}$/.test(h)) return { ok: false, error: "txHash required" };
            return { ok: true, result: { txHash: h, confirmation: await chain.provider.fetchTxConfirmation(h) } };
          }
        } catch (e) {
          return { ok: false, error: `chain read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        return { ok: false, error: `unknown query ${String(q)}` };
      }
      case "submit_handback": {
        // Firewall: size limit first, then schema. The text is stored as DATA, never executed.
        const raw = toJson(msg.args ?? {});
        const bytes = Buffer.byteLength(raw, "utf8");
        if (bytes > HANDBACK_MAX_BYTES) {
          ev("error", sessionId, { kind: "handback_invalid", error: `handback is ${bytes} bytes (max ${HANDBACK_MAX_BYTES})` });
          return { ok: false, error: `handback too large: ${bytes} bytes (max ${HANDBACK_MAX_BYTES})` };
        }
        const parsed = HandbackSchema.safeParse(msg.args);
        if (!parsed.success) {
          const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          ev("error", sessionId, { kind: "handback_invalid", error: why });
          return { ok: false, error: `invalid handback: ${why}` };
        }
        await sessions!.acceptSubmission(sessionId, parsed.data);
        // Review asynchronously: the silo hears back via handback_rejected or stop.
        void sessions!.reviewHandback(sessionId).catch((e) => ev("error", sessionId, { kind: "review_failed", error: e instanceof Error ? e.message : String(e) }));
        return { ok: true, result: { status: "under_review" } };
      }
    }
    return { ok: false, error: "unknown tool" };
  }

  async function onMessage(sessionId: string, s: Silo, msg: FromSilo) {
    switch (msg.type) {
      case "ready":
        sendTo(s, s.startMsg);
        return;
      case "heartbeat":
        s.lastHeartbeat = now();
        return;
      case "log":
        ev("progress", sessionId, { kind: "log", level: msg.level, text: clip(String(msg.text), 300) });
        return;
      case "llm_usage": {
        const add = Math.max(0, Math.floor(msg.inputTokens + msg.outputTokens)) || 0;
        const r = getSessionDb(db, sessionId);
        if (r) updateSessionDb(db, sessionId, { tokensUsed: r.tokensUsed + add }, now());
        ev("llm_usage", sessionId, { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, by: "silo" });
        return;
      }
      case "llm_request": {
        if (!deps.llm) {
          sendTo(s, { type: "llm_result", requestId: msg.requestId, ok: false, error: "no LLM configured" });
          return;
        }
        try {
          const res = await deps.llm.complete({ model: "subagent", system: msg.system, messages: msg.messages, ...(msg.tools ? { tools: msg.tools } : {}), maxTokens: Math.min(msg.maxTokens ?? 1024, 4096) });
          const r = getSessionDb(db, sessionId);
          if (r) updateSessionDb(db, sessionId, { tokensUsed: r.tokensUsed + res.usage.inputTokens + res.usage.outputTokens }, now());
          ev("llm_usage", sessionId, { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, model: "subagent" });
          sendTo(s, { type: "llm_result", requestId: msg.requestId, ok: true, response: { text: res.text, toolCalls: res.toolCalls, stopReason: res.stopReason } });
        } catch (e) {
          sendTo(s, { type: "llm_result", requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "tool_call": {
        let out: { ok: true; result: unknown } | { ok: false; error: string };
        try {
          out = await runTool(sessionId, s, msg);
        } catch (e) {
          out = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        sendTo(s, out.ok ? { type: "tool_result", requestId: msg.requestId, ok: true, result: out.result } : { type: "tool_result", requestId: msg.requestId, ok: false, error: out.error });
        return;
      }
    }
  }

  const runner: RuntimeSiloRunner = {
    bind(m) {
      sessions = m;
    },
    lastHeartbeat: (id) => silos.get(id)?.lastHeartbeat,
    info: (id) => {
      const s = silos.get(id);
      return s ? { pid: s.child.pid, tempDir: s.tempDir } : undefined;
    },
    async start({ sessionId, taskType, allowWebFetch, contextIn, dataScope }) {
      if (runner.isAlive(sessionId)) return;
      if (!sessions) throw new Error("SiloRunner not bound to a SessionManager");
      const tempDir = await mkdtemp(join(tmpdir(), "bulkhead-silo-"));
      loader ??= tsxLoaderUrl();
      // Minimal env: no secrets, no keys, no API tokens. Only what Node needs to run.
      const env: Record<string, string> = {
        NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
        BULKHEAD_SILO: "1",
        SILO_SESSION_ID: sessionId,
        SILO_HEARTBEAT_MS: String(config.heartbeatMs),
        TMPDIR: tempDir,
        TEMP: tempDir,
        TMP: tempDir,
        HOME: tempDir,
        USERPROFILE: tempDir,
      };
      if (process.env.PATH) env.PATH = process.env.PATH;
      if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const child = fork(childEntry, [], { cwd: tempDir, env, execArgv: ["--import", loader], stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
      let resolveExit!: () => void;
      const exited = new Promise<void>((r) => (resolveExit = r));
      const startMsg: ToSilo = {
        type: "start",
        taskSpec: taskSpecOf(sessionId),
        dataScope,
        contextIn,
        tools: allowedTools(taskType, { allowWebFetch }),
        llm: config.llmMode,
        checkpoint: checkpointOf(sessionId),
      };
      const s: Silo = { child, tempDir, taskType, allowWebFetch, dataScope, lastHeartbeat: now(), stopping: false, exited, startMsg };
      silos.set(sessionId, s);
      const lines = (level: "info" | "warn") => (buf: Buffer) => {
        for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(0, 20)) ev("progress", sessionId, { kind: "log", level, text: clip(line, 300), stream: level === "info" ? "stdout" : "stderr" });
      };
      child.stdout?.on("data", lines("info"));
      child.stderr?.on("data", lines("warn"));
      child.on("message", (m) => void onMessage(sessionId, s, m as FromSilo));
      child.on("error", (e) => ev("error", sessionId, { kind: "silo_error", error: e.message }));
      child.on("exit", (code, signal) => {
        resolveExit();
        void rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
        if (silos.get(sessionId) === s) silos.delete(sessionId);
        if (s.stopping) return;
        ev("error", sessionId, { kind: "silo_exited", code, signal });
        const st = getSessionDb(db, sessionId)?.status;
        if (st && ["RUNNING", "PAUSED", "QUARANTINED"].includes(st)) {
          void sessions!.transition(sessionId, "FAILED", `silo process exited (code ${code ?? signal})`).catch(() => undefined);
        }
      });
      ev("progress", sessionId, { kind: "log", level: "info", text: `silo started (pid ${child.pid})` });
    },
    send(sessionId, msg) {
      sendTo(silos.get(sessionId), msg);
    },
    async stop(sessionId, reason) {
      const s = silos.get(sessionId);
      if (!s) return;
      s.stopping = true;
      sendTo(s, { type: "stop", reason });
      const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref?.());
      if ((await Promise.race([s.exited.then(() => "exited" as const), timeout(2_000)])) === "timeout") {
        s.child.kill();
        if ((await Promise.race([s.exited.then(() => "exited" as const), timeout(2_000)])) === "timeout") s.child.kill("SIGKILL");
      }
      if (silos.get(sessionId) === s) silos.delete(sessionId);
      await rm(s.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    },
    isAlive(sessionId) {
      const s = silos.get(sessionId);
      return !!s && s.child.exitCode === null && s.child.signalCode === null;
    },
    async stopAll(reason) {
      await Promise.all([...silos.keys()].map((id) => runner.stop(id, reason)));
    },
  };
  return runner;
}
