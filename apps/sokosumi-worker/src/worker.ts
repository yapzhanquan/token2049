// The continuous polling loop. One failing Task never blocks the others; a failing list read never
// stops polling. Must run under the single-executor lock (lock.ts).
import type { EnginePort } from "./engine";
import type { JournalStore } from "./journal";
import { clip, type SokosumiPort } from "./sokosumi";
import type { TaskRunner } from "./task-runner";

export const ENGINE_USER_EMAIL = "sokosumi-coworker@bulkhead.local";

export interface WorkerDeps {
  coworkerId: string;
  soko: SokosumiPort;
  runner: TaskRunner;
  log?: (msg: string) => void;
}

/** Engine user id, created once (custodial) and remembered in worker-state.json. */
export function engineUserResolver(engine: EnginePort, store: JournalStore, email = ENGINE_USER_EMAIL): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    const s = store.loadWorkerState();
    if (s.engineUserId && s.engineUserEmail === email) return (cached = s.engineUserId);
    const id = await engine.ensureUser(email, "Sokosumi Coworker"); // upsert by email: safe to repeat
    store.saveWorkerState({ ...s, engineUserId: id, engineUserEmail: email });
    return (cached = id);
  };
}

export class Worker {
  private readonly log: (msg: string) => void;
  private readonly lastError = new Map<string, string>();
  constructor(private readonly d: WorkerDeps) {
    this.log = d.log ?? ((m) => console.log(m));
  }

  /** Log a Task's error once until it changes (avoids a line every poll for a parked Task). */
  private report(key: string, e: unknown) {
    const msg = clip(e);
    if (this.lastError.get(key) === msg) return;
    this.lastError.set(key, msg);
    this.log(`${key}: ${msg}`);
  }

  async pass(): Promise<void> {
    let tasks;
    try {
      tasks = await this.d.soko.listTasks();
      this.lastError.delete("poll");
    } catch (e) {
      this.report("poll", e);
      return;
    }
    for (const t of tasks.filter((t) => t.coworkerId === this.d.coworkerId)) {
      try {
        await this.d.runner.process(t);
        this.lastError.delete(`task ${t.id}`);
      } catch (e) {
        this.report(`task ${t.id}`, e);
      }
      try {
        await this.d.runner.handleComments(t);
        this.lastError.delete(`comments ${t.id}`);
      } catch (e) {
        this.report(`comments ${t.id}`, e);
      }
    }
  }

  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pass();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}
