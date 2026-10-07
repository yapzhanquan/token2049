// Persistence used by the chain layer: the `keys` and `kv` tables (packages/db/src/schema.ts),
// plus a read-only lookup of a session's wallet script from the `sessions` table.
// Kept behind tiny interfaces so tests run fully in memory.

export interface KeyRow {
  id: string;
  purpose: string;
  path: string;
  keyHash: string;
  ciphertext: string;
  createdAt: number;
}

export interface KeyRepo {
  get(id: string): KeyRow | undefined;
  /** Insert if absent (never overwrites); returns the stored row. */
  insert(row: KeyRow): KeyRow;
}

export interface KvStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** What TxService needs about a session wallet (written by the runtime into `sessions`). */
export interface SessionWalletInfo {
  sessionId: string;
  userId: string;
  address: string;
  scriptCbor: string;
  expirySlot: number;
  /** "native" (default) | "vault". */
  walletMode?: "native" | "vault";
  /** sessions.script_json — for vault sessions: VaultParams JSON (bigints as decimal strings). */
  scriptJson?: string | null;
  /** sessions.script_hash (vault sessions; the column may not exist on older DBs). */
  scriptHash?: string | null;
}
export type SessionLookup = (sessionId: string) => SessionWalletInfo | null | Promise<SessionWalletInfo | null>;

export interface ChainStores {
  keys: KeyRepo;
  kv: KvStore;
  sessions: SessionLookup;
}

export function memoryStores(sessions: SessionLookup = () => null): ChainStores & { keyRows: Map<string, KeyRow>; kvMap: Map<string, string> } {
  const keyRows = new Map<string, KeyRow>();
  const kvMap = new Map<string, string>();
  return {
    keyRows,
    kvMap,
    keys: {
      get: (id) => keyRows.get(id),
      insert: (row) => {
        const existing = keyRows.get(row.id);
        if (existing) return existing;
        keyRows.set(row.id, row);
        return row;
      },
    },
    kv: {
      get: (k) => kvMap.get(k),
      set: (k, v) => void kvMap.set(k, v),
      delete: (k) => void kvMap.delete(k),
    },
    sessions,
  };
}

/** Minimal better-sqlite3 surface (avoids a direct dependency on its types). */
export interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

export function sqliteStores(db: SqliteLike): ChainStores {
  const getKey = db.prepare("SELECT id, purpose, path, key_hash AS keyHash, ciphertext, created_at AS createdAt FROM keys WHERE id = ?");
  const insKey = db.prepare("INSERT OR IGNORE INTO keys (id, purpose, path, key_hash, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const getKv = db.prepare("SELECT value FROM kv WHERE key = ?");
  const setKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const delKv = db.prepare("DELETE FROM kv WHERE key = ?");
  const getSession = db.prepare(
    "SELECT id AS sessionId, user_id AS userId, address, script_cbor AS scriptCbor, expiry_slot AS expirySlot FROM sessions WHERE id = ?",
  );
  // Vault fields, read defensively: wallet_mode / script_json / script_hash may not exist on older DBs.
  const tryPrepare = (sql: string) => {
    try {
      return db.prepare(sql);
    } catch {
      return null;
    }
  };
  const getVaultFields =
    tryPrepare("SELECT wallet_mode AS walletMode, script_json AS scriptJson, script_hash AS scriptHash FROM sessions WHERE id = ?") ??
    tryPrepare("SELECT wallet_mode AS walletMode, script_json AS scriptJson, NULL AS scriptHash FROM sessions WHERE id = ?");
  return {
    keys: {
      get: (id) => (getKey.get(id) as KeyRow | undefined) ?? undefined,
      insert: (row) => {
        insKey.run(row.id, row.purpose, row.path, row.keyHash, row.ciphertext, row.createdAt);
        return getKey.get(row.id) as KeyRow;
      },
    },
    kv: {
      get: (k) => (getKv.get(k) as { value: string } | undefined)?.value,
      set: (k, v) => void setKv.run(k, v),
      delete: (k) => void delKv.run(k),
    },
    sessions: (sessionId) => {
      const r = getSession.get(sessionId) as
        | { sessionId: string; userId: string; address: string | null; scriptCbor: string | null; expirySlot: number | null }
        | undefined;
      if (!r || !r.address || !r.scriptCbor || r.expirySlot == null) return null;
      const v = getVaultFields?.get(sessionId) as { walletMode: string | null; scriptJson: string | null; scriptHash: string | null } | undefined;
      return {
        sessionId: r.sessionId,
        userId: r.userId,
        address: r.address,
        scriptCbor: r.scriptCbor,
        expirySlot: r.expirySlot,
        ...(v ? { walletMode: v.walletMode === "vault" ? ("vault" as const) : ("native" as const), scriptJson: v.scriptJson, scriptHash: v.scriptHash } : {}),
      };
    },
  };
}
