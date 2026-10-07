// Single-executor lock: `<dir>/worker.lock` holds the owner pid. A lock is recovered ONLY when its
// owner pid is confirmed dead (ESRCH). Empty/zero/garbage owners are never removed automatically.
// A `<lock>.recovery` guard (exclusive create) serialises concurrent starters during acquire.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type PidProbe = (pid: number) => "alive" | "dead";

/** signal 0 probes existence without delivering a signal. EPERM = exists but not ours = alive. */
export const probePid: PidProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    throw e;
  }
};

function readOwner(path: string): number {
  const text = readFileSync(path, "utf8");
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error("Worker lock owner is invalid. Inspect the lock file before recovery.");
  }
  return Number(text);
}

const isCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code;

export interface AcquireOptions {
  pid?: number;
  probe?: PidProbe;
}

/** Returns an idempotent release function. Throws when another live worker owns the lock. */
export function acquireWorkerLock(path: string, opts: AcquireOptions = {}): () => void {
  const pid = opts.pid ?? process.pid;
  const probe = opts.probe ?? probePid;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const guardPath = `${path}.recovery`;
  let guard: number;
  try {
    guard = openSync(guardPath, "wx", 0o600);
  } catch (e) {
    if (isCode(e, "EEXIST")) throw new Error("Worker lock recovery guard exists. Inspect its owner before retry.");
    throw e;
  }
  let fd: number | undefined;
  try {
    writeSync(guard, String(pid));
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
      const owner = readOwner(path);
      if (owner === pid || probe(owner) === "alive") throw new Error(`Worker already running: pid ${owner}`);
      unlinkSync(path); // owner confirmed dead
      fd = openSync(path, "wx", 0o600);
    }
    writeSync(fd, String(pid));
    const identity = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        const now = statSync(path);
        // Never delete a replacement lock written by someone else.
        if (now.dev === identity.dev && now.ino === identity.ino && readOwner(path) === pid) unlinkSync(path);
      } catch (e) {
        if (!isCode(e, "ENOENT") && !(e instanceof Error && /owner is invalid/.test(e.message))) throw e;
      }
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(guard);
    unlinkSync(guardPath);
  }
}
