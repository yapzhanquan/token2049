// Per-Task journals under the private state dir (default apps/sokosumi-worker/.local/).
// - <dir>/tasks/<key>.json         phase machine + ledger + comment progress (atomic replace)
// - <dir>/tasks/<key>.result.txt   exact result bytes, written ONCE (exclusive create) before completion
// - <dir>/worker-state.json        worker-wide state (engine user id)
// Every external write is preceded by a saved `*-pending` marker (see task-runner.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskJournal, WorkerState } from "./types";

/** File-name key for a Task id; unusual ids are hashed so they cannot escape the directory. */
export function taskKey(taskId: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(taskId) ? taskId : `h_${createHash("sha256").update(taskId, "utf8").digest("hex").slice(0, 40)}`;
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class ResultImmutableError extends Error {}

export class JournalStore {
  readonly tasksDir: string;
  constructor(readonly dir: string) {
    this.tasksDir = join(dir, "tasks");
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
  }

  journalPath(taskId: string) {
    return join(this.tasksDir, `${taskKey(taskId)}.json`);
  }
  resultPath(taskId: string) {
    return join(this.tasksDir, `${taskKey(taskId)}.result.txt`);
  }

  load(taskId: string): TaskJournal | null {
    const p = this.journalPath(taskId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as TaskJournal;
  }

  save(j: TaskJournal): TaskJournal {
    j.updatedAt = Date.now();
    writeAtomic(this.journalPath(j.taskId), JSON.stringify(j, null, 1));
    return j;
  }

  listTaskIds(): string[] {
    // Journals carry their own taskId; read them instead of reversing file names.
    return readdirSync(this.tasksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => (JSON.parse(readFileSync(join(this.tasksDir, f), "utf8")) as TaskJournal).taskId);
  }

  /**
   * Save the exact result bytes ONCE. If a result already exists it must be byte-identical
   * (a restart re-saving the same text is fine); a different text is refused — a saved/completed
   * result is never changed.
   */
  saveResultOnce(taskId: string, text: string): { bytes: Buffer; path: string } {
    const path = this.resultPath(taskId);
    const bytes = Buffer.from(text, "utf8");
    try {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = readFileSync(path);
      if (!existing.equals(bytes)) throw new ResultImmutableError(`Result for Task ${taskId} already saved with different bytes; it is never changed.`);
    }
    return { bytes, path };
  }

  readResult(taskId: string): Buffer | null {
    const p = this.resultPath(taskId);
    return existsSync(p) ? readFileSync(p) : null;
  }

  loadWorkerState(): WorkerState {
    const p = join(this.dir, "worker-state.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as WorkerState) : {};
  }
  saveWorkerState(s: WorkerState) {
    writeAtomic(join(this.dir, "worker-state.json"), JSON.stringify(s, null, 1));
  }
}
