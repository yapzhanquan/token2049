// e2e reporting: progress logs, assertions, PASS/FAIL per spec step, explorer links.
import { EXPLORER, explorerAddress, explorerTx } from "@bulkhead/shared";

const T0 = Date.now();
const elapsed = () => {
  const s = Math.floor((Date.now() - T0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function log(msg: string) {
  console.log(`[e2e ${elapsed()}] ${msg}`);
}

export class AssertionError extends Error {}
/** A prerequisite from an earlier (failed) step is missing: the step is reported as SKIP (still a failure). */
export class SkipError extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new SkipError(`missing prerequisite: ${what}`);
  return v;
}

export interface StepResult {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "SKIP";
  checks: string[];
  error?: string;
  ms: number;
}

export interface Link {
  label: string;
  url: string;
}

export class Report {
  readonly steps: StepResult[] = [];
  readonly links: Link[] = [];
  private current: StepResult | null = null;

  constructor(readonly dry: boolean) {}

  private tag() {
    return this.dry ? " (fake chain)" : "";
  }
  tx(label: string, hash: string | null | undefined) {
    if (!hash) return;
    if (this.links.some((l) => l.url.endsWith(hash))) return;
    this.links.push({ label: `${label}${this.tag()}`, url: explorerTx(hash) });
  }
  address(label: string, addr: string | null | undefined) {
    if (!addr) return;
    this.links.push({ label: `${label}${this.tag()}`, url: explorerAddress(addr) });
  }

  /** Record a passed sub-check of the current step (printed in the summary). */
  ok(text: string) {
    log(`  ✓ ${text}`);
    this.current?.checks.push(text);
  }

  async step<T>(id: string, title: string, fn: () => Promise<T>): Promise<T | undefined> {
    const r: StepResult = { id, title, status: "PASS", checks: [], ms: 0 };
    this.steps.push(r);
    this.current = r;
    const t = Date.now();
    log(`── step ${id}: ${title}`);
    try {
      const v = await fn();
      r.ms = Date.now() - t;
      log(`── step ${id}: PASS (${(r.ms / 1000).toFixed(1)} s)`);
      return v;
    } catch (e) {
      r.status = e instanceof SkipError ? "SKIP" : "FAIL";
      r.error = e instanceof Error ? e.message : String(e);
      r.ms = Date.now() - t;
      log(`── step ${id}: ${r.status} — ${r.error}`);
      if (!(e instanceof AssertionError) && !(e instanceof SkipError) && e instanceof Error && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
      return undefined;
    } finally {
      this.current = null;
    }
  }

  skip(id: string, title: string, why: string) {
    this.steps.push({ id, title, status: "SKIP", checks: [], error: why, ms: 0 });
    log(`── step ${id}: SKIP — ${why}`);
  }

  get failed() {
    return this.steps.some((s) => s.status !== "PASS");
  }

  print(extra: string[] = []) {
    const line = "═".repeat(78);
    console.log(`\n${line}\nBulkhead e2e ${this.dry ? "— DRY RUN on the in-memory FakeChain (NOTHING was on-chain)" : "— Cardano PREPROD"}\n${line}`);
    for (const s of this.steps) {
      console.log(`${s.status === "PASS" ? "PASS" : s.status === "SKIP" ? "SKIP" : "FAIL"}  ${s.id.padEnd(4)} ${s.title}  (${(s.ms / 1000).toFixed(1)} s)`);
      for (const c of s.checks) console.log(`        ✓ ${c}`);
      if (s.error) console.log(`        ✗ ${s.error}`);
    }
    if (this.links.length) {
      console.log(`\nExplorer links (${EXPLORER})${this.dry ? " — FAKE CHAIN: these hashes do not exist on preprod" : ""}:`);
      for (const l of this.links) console.log(`  ${l.label}\n    ${l.url}`);
    }
    for (const x of extra) console.log(x);
    const passed = this.steps.filter((s) => s.status === "PASS").length;
    console.log(`\n${this.failed ? "FAILED" : "PASSED"}: ${passed}/${this.steps.length} steps passed${this.dry ? " (dry run, fake chain)" : " (preprod)"}\n${line}`);
  }
}
