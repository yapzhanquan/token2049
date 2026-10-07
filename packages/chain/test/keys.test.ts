import { describe, expect, it } from "vitest";
import { decryptKey, deriveKek, encryptKey, KeyVault, parseMasterSecret, signTxWith, operatorKeyFromMnemonic } from "../src/keys";
import { memoryStores } from "../src/store";
import { agentWallet, tusdUnit, operatorInfo } from "../src/index";
import { cst, EmbeddedWallet, ensureCryptoReady } from "../src/mesh";
import { TEST_MASTER, TEST_MNEMONIC } from "./helpers";

const vault = () => {
  const stores = memoryStores();
  return { stores, v: new KeyVault({ masterSecret: TEST_MASTER, operatorMnemonic: TEST_MNEMONIC, repo: stores.keys, kv: stores.kv }) };
};

describe("KeyVault derivation", () => {
  it("treasury: m/1852'/1815'/<account>'/0/0 with stake /2/0, deterministic, preprod base address", async () => {
    const { v, stores } = vault();
    const t = await v.treasury("u1", 7);
    expect(t.keyId).toBe("treasury:u1");
    expect(t.address.startsWith("addr_test1q")).toBe(true);
    expect(stores.keyRows.get("treasury:u1")!.path).toBe("m/1852'/1815'/7'/0/0");
    const d = cst.deserializeBech32Address(t.address);
    expect(d.pubKeyHash).toBe(t.keyHash);
    expect(d.stakeCredentialHash).toBe(t.stakeKeyHash);
    // Same as a standard CIP-1852 wallet restored from the 24-word mnemonic whose entropy is MASTER_SECRET.
    const w = new EmbeddedWallet({ networkId: 0, key: { type: "bip32Bytes", bip32Bytes: cst.buildBip32PrivateKey(TEST_MASTER).bytes() } });
    await w.init();
    expect(w.getAccount(7, 0).baseAddressBech32).toBe(t.address);
    // Deterministic across vault instances
    expect((await vault().v.treasury("u1", 7)).address).toBe(t.address);
  });

  it("sessions use account 1000000', index = keyIndex; captain 1000001'", async () => {
    const { v, stores } = vault();
    const s0 = await v.session("s0", 0);
    const s1 = await v.session("s1", 1);
    expect(s0.keyHash).not.toBe(s1.keyHash);
    expect(stores.keyRows.get("session:s1")!.path).toBe("m/1852'/1815'/1000000'/0/1");
    const c = await v.captain();
    expect(stores.keyRows.get("captain")!.path).toBe("m/1852'/1815'/1000001'/0/0");
    expect(c.address.startsWith("addr_test1q")).toBe(true);
  });

  it("refuses reusing a session keyIndex or a treasury account for another owner", async () => {
    const { v } = vault();
    await v.session("a", 5);
    await expect(v.session("b", 5)).rejects.toThrow(/already used/);
    await v.treasury("u1", 3);
    await expect(v.treasury("u2", 3)).rejects.toThrow(/already used/);
    await expect(v.treasury("u1", 4)).rejects.toThrow(/already derived/);
    await expect(v.treasury("u9", 1_000_000)).rejects.toThrow();
  });

  it("operator = standard wallet m/1852'/1815'/0'/0/0 from OPERATOR_MNEMONIC", async () => {
    const { v } = vault();
    const op = await v.operator();
    const w = new EmbeddedWallet({ networkId: 0, key: { type: "mnemonic", words: TEST_MNEMONIC.split(" ") } });
    await w.init();
    expect(op.address).toBe(w.getAccount(0, 0).baseAddressBech32);
    const info = await operatorInfo({ OPERATOR_MNEMONIC: TEST_MNEMONIC });
    expect(info.address).toBe(op.address);
    expect(await tusdUnit({ OPERATOR_MNEMONIC: TEST_MNEMONIC })).toBe(info.policyId + "0014df1074555344");
    expect(await tusdUnit({ TUSD_UNIT: "ab" })).toBe("ab");
  });

  it("agentWallet(i) is derived from MASTER_SECRET (account 1000002') and distinct per i", async () => {
    const a0 = await agentWallet(0, { MASTER_SECRET: TEST_MASTER });
    const a1 = await agentWallet(1, { MASTER_SECRET: TEST_MASTER });
    expect(a0.address.startsWith("addr_test1q")).toBe(true);
    expect(a0.path).toBe("m/1852'/1815'/1000002'/0/0");
    expect(a0.address).not.toBe(a1.address);
    expect((await agentWallet(0, { MASTER_SECRET: TEST_MASTER })).address).toBe(a0.address);
  });

  it("rejects a bad MASTER_SECRET", () => {
    expect(() => parseMasterSecret("abc")).toThrow(/32 bytes/);
    expect(() => parseMasterSecret(undefined)).toThrow();
  });
});

describe("encryption at rest", () => {
  it("AES-256-GCM round-trips, binds the row id (AAD) and hides plaintext", async () => {
    const kek = deriveKek(parseMasterSecret(TEST_MASTER));
    const secret = Buffer.from("ab".repeat(64), "hex");
    const ct = encryptKey(kek, secret, "session:x");
    expect(Buffer.from(ct, "base64").toString("hex")).not.toContain("ab".repeat(16));
    expect(decryptKey(kek, ct, "session:x").equals(secret)).toBe(true);
    expect(() => decryptKey(kek, ct, "session:y")).toThrow();
    const otherKek = deriveKek(parseMasterSecret("00".repeat(32)));
    expect(() => decryptKey(otherKek, ct, "session:x")).toThrow();
  });

  it("stored ciphertext decrypts to the key matching keyHash; rows never hold plaintext", async () => {
    const { v, stores } = vault();
    const s = await v.session("s9", 9);
    const row = stores.keyRows.get("session:s9")!;
    expect(row.keyHash).toBe(s.keyHash);
    const plain = decryptKey(deriveKek(parseMasterSecret(TEST_MASTER)), row.ciphertext, row.id);
    expect(plain.length).toBe(64);
    expect(row.ciphertext).not.toContain(plain.toString("hex"));
    await ensureCryptoReady();
    expect(cst.Ed25519PrivateKey.fromExtendedBytes(new Uint8Array(plain)).toPublic().hash().hex()).toBe(s.keyHash);
  });
});

describe("signing", () => {
  it("signTxWith adds one valid vkey witness and keeps the body hash", async () => {
    const op = await operatorKeyFromMnemonic(TEST_MNEMONIC);
    // minimal unsigned tx built offline
    const { MeshTxBuilder, DEFAULT_PROTOCOL_PARAMETERS } = await import("../src/mesh");
    const b = new MeshTxBuilder({ params: DEFAULT_PROTOCOL_PARAMETERS });
    const unsigned = await b
      .txIn("ab".repeat(32), 0, [{ unit: "lovelace", quantity: "10000000" }], op.address!, 0)
      .txOut(op.address!, [{ unit: "lovelace", quantity: "2000000" }])
      .changeAddress(op.address!)
      .complete();
    const signed = signTxWith(unsigned, op.paymentKey);
    expect(cst.resolveTxHash(signed)).toBe(cst.resolveTxHash(unsigned));
    const { witnesses } = await import("./helpers");
    expect(witnesses(signed)).toEqual([{ keyHash: op.keyHash, valid: true }]);
  });
});
