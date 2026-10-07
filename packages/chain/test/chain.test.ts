// createChain wiring + the SQLite stores against the real migrated schema (temp file).
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb, rawSqlite } from "@bulkhead/db";
import { createChain, slotFromTime, timeFromSlot, sqliteStores } from "../src/index";
import { FakeProvider, TEST_MASTER, TEST_MNEMONIC, TIP_SLOT } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "bulkhead-chain-"));
afterAll(() => {
  closeDb();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows file locks */
  }
});

describe("createChain", () => {
  it("wires provider/keys/tx/watcher with SQLite-backed keys + kv + sessions", async () => {
    openDb(join(dir, "t.sqlite"));
    const db = rawSqlite();
    const stores = sqliteStores(db);
    const provider = new FakeProvider();
    const chain = await createChain({ env: { MASTER_SECRET: TEST_MASTER, OPERATOR_MNEMONIC: TEST_MNEMONIC }, provider, mainnetProvider: null, stores });
    expect(chain.tx.tusdUnit()).toMatch(/^[0-9a-f]{56}0014df1074555344$/);
    const t = await chain.keys.treasury("user-x", 4);
    const row = db.prepare("SELECT id, path, key_hash, ciphertext FROM keys WHERE id = ?").get("treasury:user-x") as Record<string, string>;
    expect(row.path).toBe("m/1852'/1815'/4'/0/0");
    expect(row.key_hash).toBe(t.keyHash);
    expect(row.ciphertext.length).toBeGreaterThan(100);

    // sessions lookup reads the runtime's columns
    const now = Date.now();
    db.prepare("INSERT INTO users (id, email, custody, account_index, treasury_address, owner_key_hash, created_at) VALUES (?,?,?,?,?,?,?)").run(
      "user-x", "x@example.com", "custodial", 4, t.address, t.keyHash, now,
    );
    db.prepare("INSERT INTO goals (id, user_id, goal, budget_micro, deadline, status, plan_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
      "g1", "user-x", "goal", "1", now, "planned", "{}", now,
    );
    db.prepare(
      `INSERT INTO sessions (id, goal_id, user_id, letter, name, role, agent_type, task_type, goal, status, budget_micro,
        per_payment_max_micro, approval_threshold_micro, allowed_payees_json, expires_at, expiry_slot, key_index, script_cbor, address, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("s1", "g1", "user-x", "A", "n", "r", "a", "research", "g", "RUNNING", "1", "1", "1", "[]", now, TIP_SLOT + 10, 0, "8200", "addr_test1w", now, now);
    expect(await stores.sessions("s1")).toMatchObject({ sessionId: "s1", userId: "user-x", address: "addr_test1w", scriptCbor: "8200", expirySlot: TIP_SLOT + 10 });
    // Vault fields are read too (defensively: script_hash may not exist yet → null)
    expect(await stores.sessions("s1")).toMatchObject({ walletMode: "native", scriptJson: null });
    expect(await stores.sessions("nope")).toBeNull();

    stores.kv.set("k", "v1");
    stores.kv.set("k", "v2");
    expect(stores.kv.get("k")).toBe("v2");
    await chain.watcher.stop();
  });

  it("slot <-> time use the preprod slot config", () => {
    const t = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(timeFromSlot(slotFromTime(t))).toBe(t);
    expect(slotFromTime(1655769600000)).toBe(86400); // preprod zeroTime / zeroSlot
  });
});
