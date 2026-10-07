// MIP-004 hashing. Expected digests are the reference vectors from the TOKEN2049 demo agent
// (live-team-names standard-hash / paid-task tests and the event-guide payment-hashing doc);
// only the vector values are reused here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  inputSchemaHash,
  isPurchaserNonce,
  isSha256Hex,
  Mip004Error,
  mip004InputHash,
  mip004ResultHash,
  sha256Hex,
  sokosumiCompatResultHash,
  taskHashRaw,
  taskInputHashNonceCanonical,
  taskResultHashNonceEscaped,
} from "../src/mip004";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("reference vectors (demo agent)", () => {
  it("input hash: nonce-prefixed canonical JSON", () => {
    expect(mip004InputHash({ prompt: "Cardano payments" }, "aabbccddeeff0011")).toBe(
      "25f3afe66b39b0582711c9faf53930c7b6a6feffd10294750ec77be47fd63080",
    );
  });

  it("result hash: raw newline bytes, not the escaped form", () => {
    const h = mip004ResultHash("Line 1\nLine 2", "aabbccddeeff0011");
    expect(h).toBe("6fa3bfa69364318f78619b87652c725d705c90f18f8bdcb5d7041c17b73ea57a");
    expect(h).not.toBe(mip004ResultHash("Line 1\\nLine 2", "aabbccddeeff0011"));
  });

  it("MIP-004 vs Sokosumi-compat result hash (newline, two quotes, one backslash)", () => {
    const nonce = "01234567890123456789";
    const result = 'line\n"next"\\end';
    expect(mip004ResultHash(result, nonce)).toBe("7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd");
    expect(sokosumiCompatResultHash(result, nonce)).toBe("36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3");
  });

  it("Standard result: escaped pre-image gives a different digest", () => {
    expect(sha256Hex("aabbccddeeff0011;Line 1\\nLine 2")).toBe("85ba9cdbfafd6984e7a57a04c2e0fe378f48b998e327aa851b4e5459b990fb19");
  });

  it("direct Task payment, LIVE rule: plain UTF-8 sha256, no nonce, no JSON escapes", () => {
    expect(taskHashRaw("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(taskHashRaw("a\nb")).toBe("7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78");
    expect(taskHashRaw("a\\nb")).toBe("b5b65540b7c88230a6d62d928cd450d3be458c25e870d4750f754404324797b4");
    expect(taskHashRaw('line\n"next"\\end')).toBe("70e5c09899daacf6f01610cf34fc57f7bbed37a21cf3e81bd2f17bec7ca52393");
  });

  it("direct Task payment, GUIDE rule: nonce + canonical input, nonce + escaped result", () => {
    const nonce = "01234567890123456789";
    expect(taskResultHashNonceEscaped('line\n"next"\\end', nonce)).toBe("36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3");
    const task = { taskId: "one", name: "Tiny Eve", description: 'line\n"quote"' };
    expect(taskInputHashNonceCanonical(task, nonce)).toBe(sha(`${nonce};{"description":"line\\n\\"quote\\"","name":"Tiny Eve","taskId":"one"}`));
    expect(taskResultHashNonceEscaped('hello\n"world"\\end', nonce)).toBe(sha(`${nonce};hello\\n\\"world\\"\\\\end`));
  });
});

describe("canonicalJson (RFC 8785 subset)", () => {
  it("sorts nested keys, keeps array order, normalises -0, keeps non-ASCII as UTF-8", () => {
    const value = { z: [true, -0, { b: "😀", a: null }], a: 1.5 };
    const canonical = '{"a":1.5,"z":[true,0,{"a":null,"b":"😀"}]}';
    expect(canonicalJson(value)).toBe(canonical);
    const nonce = "01234567890123456789";
    expect(mip004InputHash(value, nonce)).toBe(sha(`${nonce};${canonical}`));
  });

  it("escapes control characters and quotes like JSON.stringify", () => {
    expect(canonicalJson({ description: 'line\n"quote"', name: "Tiny Eve", taskId: "one" })).toBe(
      '{"description":"line\\n\\"quote\\"","name":"Tiny Eve","taskId":"one"}',
    );
  });

  it("key order does not change the hash", () => {
    const nonce = "aabbccddeeff0011";
    expect(mip004InputHash({ b: 1, a: "x" }, nonce)).toBe(mip004InputHash({ a: "x", b: 1 }, nonce));
  });

  it("rejects non-JSON values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [{ a: undefined }, { a: Number.NaN }, { a: Infinity }, { a: "\ud800" }, new Date(), [undefined], { a: 1n }, cyclic])
      expect(() => canonicalJson(bad)).toThrow(Mip004Error);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe("nonce + input validation", () => {
  it("requires a 14–26 char hex purchaser nonce", () => {
    expect(isPurchaserNonce("aabbccddeeff0011")).toBe(true);
    expect(isPurchaserNonce("a".repeat(13))).toBe(false);
    expect(isPurchaserNonce("a".repeat(27))).toBe(false);
    expect(isPurchaserNonce("resume-job-123x")).toBe(false);
    expect(() => mip004InputHash({}, "nope")).toThrow(Mip004Error);
    expect(() => mip004ResultHash("x", "nope")).toThrow(Mip004Error);
  });

  it("rejects results with invalid Unicode", () => {
    expect(() => mip004ResultHash("\ud800", "aabbccddeeff0011")).toThrow(Mip004Error);
    expect(() => sokosumiCompatResultHash("\udc00", "aabbccddeeff0011")).toThrow(Mip004Error);
  });

  it("result hash is exactly what MPS submit-result accepts (64 hex)", () => {
    expect(isSha256Hex(mip004ResultHash("ok", "aabbccddeeff0011"))).toBe(true);
    expect(isSha256Hex("ab".repeat(64))).toBe(false);
  });

  it("input_schema_hash = sha256 of the canonical schema", () => {
    const schema = { input_data: [{ type: "string", id: "goal", name: "Goal" }] };
    expect(inputSchemaHash(schema)).toBe(sha256Hex('{"input_data":[{"id":"goal","name":"Goal","type":"string"}]}'));
  });
});
