// Sokosumi access.
// - CLI (argv array, no shell): `tasks list` (account OAuth; NO --personal), `runtime start|complete`
//   (Coworker key from the CLI's OS vault; `--personal --coworker-id`, or `--organization-id` for CLI 1.0.0).
// - Coworker HTTP client from the installed CLI package (its own credential interface; this worker never
//   reads, stores or prints the key): events (all pages), comments, masumiPayment and paid COMPLETED
//   events, receipt. These must act as the Coworker with no user-context header (Core 422 otherwise).
import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CoreReceipt, SokoEvent, SokoTask, StartedTask } from "./types";

export interface SokosumiPort {
  listTasks(): Promise<SokoTask[]>;
  startTask(taskId: string): Promise<StartedTask>;
  /** Execution-only completion via `runtime complete --result-file`. */
  completeTask(taskId: string, resultFile: string): Promise<{ eventId: string | null }>;
  /** Every event page, oldest first. */
  listEvents(taskId: string): Promise<SokoEvent[]>;
  postComment(taskId: string, comment: string): Promise<{ eventId: string | null }>;
  postPaymentEvent(taskId: string, comment: string, masumiPayment: Record<string, unknown>): Promise<{ eventId: string | null }>;
  /** Paid completion: Core event `{status: COMPLETED, comment: <exact result>}` as the Coworker. */
  postCompletionEvent(taskId: string, result: string): Promise<{ eventId: string | null }>;
  getReceipt(taskId: string): Promise<CoreReceipt | null>;
}

/** Minimal Core HTTP surface (the CLI's createCoworkerHttpClient). */
export interface CoreClient {
  get(path: string, signal?: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
}

export type CliRunner = (args: string[]) => Promise<unknown>;

export interface SokosumiConfig {
  coworkerId: string;
  /** CLI 1.0.0 needs `--organization-id`; CLI ≥ 1.0.4 uses `--personal` (default). */
  organizationId?: string;
  /** CLI 1.0.0 `tasks` commands select an organization Workspace with `--organization-slug` (they reject --organization-id). */
  organizationSlug?: string;
  timeoutMs?: number;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const taskPath = (taskId: string) => `/v1/tasks/${encodeURIComponent(taskId)}`;
const MAX_EVENT_PAGES = 100;

export function clip(message: unknown, n = 200): string {
  return String(message instanceof Error ? message.message : message).replace(/\s+/g, " ").slice(0, n);
}

/** Read every events page: `?limit=100`, follow `meta.pagination.nextCursor` (string → next, null → end). */
export async function fetchAllEvents(core: CoreClient, taskId: string, timeoutMs = 30_000): Promise<SokoEvent[]> {
  const out: SokoEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const body = rec(await core.get(`${taskPath(taskId)}/events?${q}`, AbortSignal.timeout(timeoutMs)));
    const data = Array.isArray(body.data) ? body.data : Array.isArray(body) ? (body as unknown[]) : [];
    for (const e of data) {
      const ev = rec(e);
      if (typeof ev.id === "string" && !seen.has(ev.id)) {
        seen.add(ev.id);
        out.push(ev as unknown as SokoEvent);
      }
    }
    const pagination = rec(rec(body.meta).pagination);
    if (!("nextCursor" in pagination)) {
      // No pagination block at all: a single unpaged list. A pagination block without a
      // string/null nextCursor is NOT treated as end-of-history.
      if (!("pagination" in rec(body.meta))) return out;
      throw new Error("Events page has pagination without nextCursor; refusing to assume end of history");
    }
    const next = pagination.nextCursor;
    if (next === null) return out;
    if (typeof next !== "string" || !next || next === cursor) throw new Error("Events pagination cursor is invalid");
    cursor = next;
  }
  throw new Error(`Events exceeded ${MAX_EVENT_PAGES} pages`);
}

function eventIdOf(response: unknown): string | null {
  const r = rec(response);
  return str(rec(r.data).id) ?? str(rec(r.event).id) ?? str(r.eventId) ?? str(r.id);
}

export class CliSokosumi implements SokosumiPort {
  constructor(
    private readonly cfg: SokosumiConfig,
    private readonly run: CliRunner,
    private readonly core: () => Promise<CoreClient>,
  ) {}

  private runtimeScope(): string[] {
    return this.cfg.organizationId ? ["--organization-id", this.cfg.organizationId] : ["--personal"];
  }

  async listTasks(): Promise<SokoTask[]> {
    // `tasks list` rejects --personal (CLI 1.0.4) and --organization-id/--workspace-id (CLI 1.0.0);
    // an organization Workspace is selected with --organization-slug.
    const scope = this.cfg.organizationSlug ? ["--organization-slug", this.cfg.organizationSlug] : [];
    const out = rec(await this.run(["tasks", "list", "--coworker-id", this.cfg.coworkerId, ...scope]));
    const tasks = Array.isArray(out.tasks) ? out.tasks : [];
    return tasks
      .map((t) => rec(t))
      .filter((t) => typeof t.id === "string")
      .map((t) => ({
        id: t.id as string,
        status: str(t.status),
        coworkerId: str(t.coworkerId) ?? str(t.assigneeId),
        name: str(t.name),
        description: str(t.description),
        organizationId: str(t.organizationId),
        updatedAt: str(t.updatedAt),
      }));
  }

  async startTask(taskId: string): Promise<StartedTask> {
    const t = rec(await this.run(["runtime", "start", taskId, ...this.runtimeScope(), "--coworker-id", this.cfg.coworkerId]));
    if (t.id !== taskId) throw new Error("runtime start returned a different Task");
    return { id: taskId, name: str(t.name), description: str(t.description), status: str(t.status) ?? "RUNNING" };
  }

  async completeTask(taskId: string, resultFile: string) {
    const r = rec(await this.run(["runtime", "complete", taskId, ...this.runtimeScope(), "--coworker-id", this.cfg.coworkerId, "--result-file", resultFile]));
    return { eventId: str(r.eventId) };
  }

  async listEvents(taskId: string) {
    return fetchAllEvents(await this.core(), taskId, this.cfg.timeoutMs);
  }

  private async post(taskId: string, body: Record<string, unknown>) {
    const core = await this.core();
    return { eventId: eventIdOf(await core.post(`${taskPath(taskId)}/events`, body, AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000))) };
  }
  postComment(taskId: string, comment: string) {
    return this.post(taskId, { comment });
  }
  postPaymentEvent(taskId: string, comment: string, masumiPayment: Record<string, unknown>) {
    return this.post(taskId, { comment, masumiPayment });
  }
  postCompletionEvent(taskId: string, result: string) {
    return this.post(taskId, { status: "COMPLETED", comment: result });
  }
  async getReceipt(taskId: string): Promise<CoreReceipt | null> {
    const core = await this.core();
    const r = rec(await core.get(`${taskPath(taskId)}/receipt`, AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000)));
    const data = rec(r.data);
    return Object.keys(data).length ? (data as CoreReceipt) : null;
  }
}

// ─────────────── Locating and loading the installed CLI ───────────────

export interface CliInstall {
  root: string; // package root (contains package.json, dist/)
  bin: string; // absolute path of the JS entry
  version: string;
}

const CLI_PACKAGE_NAMES = new Set(["sokosumi", "@masumi_network/sokosumi"]);

function readInstall(root: string): CliInstall | null {
  const pj = join(root, "package.json");
  if (!existsSync(pj)) return null;
  const p = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string; bin?: string | Record<string, string> };
  if (!p.name || !CLI_PACKAGE_NAMES.has(p.name)) return null;
  const binRel = typeof p.bin === "string" ? p.bin : p.bin?.sokosumi;
  if (!binRel) return null;
  return { root, bin: join(root, binRel), version: p.version ?? "unknown" };
}

/** Runs a fixed, constant command line (no user input) through the platform shell, so `.cmd` shims work on Windows. */
function execText(command: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    exec(command, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(new Error(clip(err))) : resolve(stdout.trim()))),
  );
}

/** SOKOSUMI_CLI_ROOT, else `sokosumi skills path` (≥1.0.4), else `npm root -g`. */
export async function locateCli(env: NodeJS.ProcessEnv = process.env): Promise<CliInstall> {
  if (env.SOKOSUMI_CLI_ROOT) {
    const i = readInstall(env.SOKOSUMI_CLI_ROOT);
    if (!i) throw new Error("SOKOSUMI_CLI_ROOT is not a Sokosumi CLI package");
    return i;
  }
  try {
    const skills = await execText("sokosumi skills path");
    if (isAbsolute(skills)) {
      const i = readInstall(dirname(skills));
      if (i) return i;
    }
  } catch {
    /* older CLI: no `skills path` */
  }
  const globalRoot = await execText("npm root -g");
  for (const name of CLI_PACKAGE_NAMES) {
    const i = readInstall(join(globalRoot, ...name.split("/")));
    if (i) return i;
  }
  throw new Error("Sokosumi CLI not found. Install it globally or set SOKOSUMI_CLI_ROOT.");
}

/** Runs `node <cli bin> --preprod …args --json` and parses stdout JSON. Output is never logged. */
export function nodeCliRunner(install: CliInstall, timeoutMs = 60_000): CliRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      // Preprod only. Shell env overrides (SOKOSUMI_API_KEY / SOKOSUMI_AUTH_TOKEN) are passed through untouched.
      execFile(process.execPath, [install.bin, "--preprod", ...args, "--json"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`sokosumi ${args.slice(0, 2).join(" ")} failed: ${clip(stderr || err.message)}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`sokosumi ${args.slice(0, 2).join(" ")} returned non-JSON output`));
        }
      });
    });
}

/**
 * Lazily builds the Coworker HTTP client from the CLI package's internal modules (pin the CLI version:
 * these are not a public API). The key goes from the CLI's vault reader straight into the client.
 */
export function coworkerCoreLoader(install: CliInstall, coworkerId: string): () => Promise<CoreClient> {
  let p: Promise<CoreClient> | undefined;
  return () =>
    (p ??= (async () => {
      const load = (rel: string) => import(pathToFileURL(join(install.root, "dist", "src", rel)).href);
      const [creds, http] = await Promise.all([load("coworker/runtime-credentials.js"), load("api/http-client.js")]);
      return http.createCoworkerHttpClient({ apiKey: creds.readRuntimeCredential(coworkerId) }) as CoreClient;
    })().catch((e) => {
      p = undefined;
      throw new Error(`Coworker runtime client unavailable: ${clip(e)}`);
    }));
}
