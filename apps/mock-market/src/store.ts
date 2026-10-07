// Job persistence. Uses the existing `kv` table of @bulkhead/db (no new tables):
// one row per job, key "market:job:<job_id>", value = JSON(JobRecord).
import { openDb, rawSqlite } from "@bulkhead/db";
import type { JobStatusResponse } from "@bulkhead/shared";

export interface JobRecord {
  job_id: string;
  agent_id: string;
  identifier_from_purchaser: string | null;
  input: string;
  input_hash: string;
  status: JobStatusResponse["status"];
  payment_address: string;
  amount_micro: string; // bigint as decimal string
  payment_reference: string;
  created_at: number; // ms
  pay_by: number; // ms
  payment_tx?: string;
  payment_output?: string; // "<txHash>#<index>" that paid this job
  paid_at?: number;
  result?: string;
  result_hash?: string;
  completed_at?: number;
  error?: string;
}

export interface JobStore {
  get(id: string): JobRecord | undefined;
  put(job: JobRecord): void;
  all(): JobRecord[];
}

export class MemoryJobStore implements JobStore {
  private m = new Map<string, JobRecord>();
  get(id: string) {
    const j = this.m.get(id);
    return j ? { ...j } : undefined;
  }
  put(job: JobRecord) {
    this.m.set(job.job_id, { ...job });
  }
  all() {
    return [...this.m.values()].map((j) => ({ ...j }));
  }
}

const PREFIX = "market:job:";

export class KvJobStore implements JobStore {
  constructor(dbPath?: string) {
    openDb(dbPath); // runs migrations; creates the kv table if needed
  }
  get(id: string) {
    const row = rawSqlite().prepare("SELECT value FROM kv WHERE key = ?").get(PREFIX + id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as JobRecord) : undefined;
  }
  put(job: JobRecord) {
    rawSqlite()
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(PREFIX + job.job_id, JSON.stringify(job));
  }
  all() {
    const rows = rawSqlite().prepare("SELECT value FROM kv WHERE key LIKE ?").all(`${PREFIX}%`) as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as JobRecord);
  }
}
