import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkerLock, probePid } from "../src/lock";
import { tmpDir } from "./fakes";

const deadPid = () => Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());

describe("worker lock", () => {
  it("creates the directory, writes our pid, releases", () => {
    const path = join(tmpDir(), "nested", "worker.lock");
    const release = acquireWorkerLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    expect(existsSync(`${path}.recovery`)).toBe(false);
    release();
    release(); // idempotent
    expect(existsSync(path)).toBe(false);
  });

  it("never removes a live owner's lock", () => {
    const path = join(tmpDir(), "worker.lock");
    writeFileSync(path, "4242");
    expect(() => acquireWorkerLock(path, { pid: 1000, probe: () => "alive" })).toThrow(/already running: pid 4242/);
    expect(readFileSync(path, "utf8")).toBe("4242");
  });

  it("refuses a second executor in the same process", () => {
    const path = join(tmpDir(), "worker.lock");
    const release = acquireWorkerLock(path);
    expect(() => acquireWorkerLock(path)).toThrow(/already running/);
    release();
  });

  it("recovers a lock only when the owner pid is dead (stub probe)", () => {
    const path = join(tmpDir(), "worker.lock");
    writeFileSync(path, "4242");
    const release = acquireWorkerLock(path, { pid: 777, probe: (p) => (p === 4242 ? "dead" : "alive") });
    expect(readFileSync(path, "utf8")).toBe("777");
    release();
  });

  it("recovers a lock left by a real exited process", () => {
    const path = join(tmpDir(), "worker.lock");
    const pid = deadPid();
    expect(probePid(pid)).toBe("dead");
    writeFileSync(path, String(pid));
    const release = acquireWorkerLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    release();
  });

  it("empty, zero or garbage owners need inspection and stay untouched", () => {
    const path = join(tmpDir(), "worker.lock");
    for (const text of ["", "0", "abc", "-5"]) {
      writeFileSync(path, text);
      expect(() => acquireWorkerLock(path, { probe: () => "dead" })).toThrow(/owner is invalid/);
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("refuses while a recovery guard exists", () => {
    const path = join(tmpDir(), "worker.lock");
    writeFileSync(`${path}.recovery`, "1");
    expect(() => acquireWorkerLock(path)).toThrow(/recovery guard/);
  });

  it("release never deletes a replacement lock", () => {
    const path = join(tmpDir(), "worker.lock");
    const release = acquireWorkerLock(path);
    unlinkSync(path);
    writeFileSync(path, "123");
    release();
    expect(readFileSync(path, "utf8")).toBe("123");
  });
});
