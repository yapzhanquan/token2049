// MIP-004 hashing for the Masumi Standard API (MIP-003) — pure functions, no I/O.
//
// Node-only (node:crypto): import it as "@bulkhead/shared/mip004", never from the browser bundle.
//
// Two different hash paths exist in the Masumi ecosystem. Use the right one:
//
// 1. MIP-003 Standard API jobs (this module's mip004* functions, used by packages/engine/src/standard-api.ts):
//      input_hash  = sha256_hex( nonce + ";" + canonicalJson(input_data) )
//      result_hash = sha256_hex( nonce + ";" + result )          (result = raw UTF-8 text, NOT JSON-escaped)
//    `nonce` is the purchaser's identifier_from_purchaser (MPS requires 14–26 hex chars).
//    The Masumi Payment Service stores both hashes opaquely: POST /payment takes `inputHash` (hex ≤ 250),
//    POST /payment/submit-result takes `submitResultHash` (exactly 64 hex). The seller submits the
//    result hash alone — NOT inputHash+resultHash concatenated (older docs; MPS rejects 128 chars).
//
// 2. Direct Sokosumi Task payments (seller posts a masumiPayment event on a Sokosumi Task). The two demo
//    branches disagree (docs/SOKOSUMI-PROTOCOL.md §6.4); both rules are exported, clearly named:
//    a) taskHashRaw(text) — LIVE branch (2026-10-06), adopted by the Bulkhead brief:
//         input hash  = sha256_hex(started Task description), result hash = sha256_hex(result)
//         no nonce, no JSON, raw UTF-8. Verified up to ResultSubmitted; seller withdrawal NOT verified.
//    b) taskInputHashNonceCanonical / taskResultHashNonceEscaped — GUIDE branch (2026-10-05), from Sokosumi
//         source hash.ts: input = sha256(nonce + ";" + canonicalJson({taskId, name, description})),
//         result = sha256(nonce + ";" + JSON.stringify(result).slice(1, -1)) (JSON-escaped body).
//         Seller collection verified on that branch.
//    The Standard API never uses either; Task-path code must journal which rule it used per Task.
//
// sokosumiCompatResultHash is the same escaped-result rule as (b), kept as the name used for verifying a
// Standard API result against Sokosumi's local helper. It differs from MIP-004 for newlines, quotes and
// backslashes.
import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** MPS: identifierFromPurchaser is 14–26 chars and must be hex. */
export const PURCHASER_NONCE_RE = /^[0-9a-fA-F]{14,26}$/;
export function isPurchaserNonce(value: unknown): value is string {
  return typeof value === "string" && PURCHASER_NONCE_RE.test(value);
}
function assertNonce(nonce: string) {
  if (!isPurchaserNonce(nonce)) throw new Mip004Error("identifier_from_purchaser must be 14–26 hex characters");
}

export class Mip004Error extends Error {
  override name = "Mip004Error";
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** True when the string is valid Unicode (no lone UTF-16 surrogates), i.e. it has a unique UTF-8 encoding. */
export function isWellFormedText(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/**
 * RFC 8785 (JCS) canonical JSON for plain JSON values: object keys sorted by UTF-16 code units
 * (JS default sort), no whitespace, ECMAScript number/string serialisation (JSON.stringify).
 * Rejects anything that is not a finite JSON value: undefined, NaN/±Infinity, bigint, functions,
 * symbols, class instances (Date, Map…), cycles, and strings with lone surrogates.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, new Set());
}
function canon(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Mip004Error("canonical JSON: non-finite number");
      return JSON.stringify(value); // -0 → "0", ES shortest round-trip form (RFC 8785 §3.2.2.3)
    case "string":
      if (!isWellFormedText(value)) throw new Mip004Error("canonical JSON: string contains invalid Unicode");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Mip004Error(`canonical JSON: unsupported type ${typeof value}`);
  }
  const obj = value as object;
  if (ancestors.has(obj)) throw new Mip004Error("canonical JSON: cyclic value");
  const isArray = Array.isArray(obj);
  if (!isArray) {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new Mip004Error("canonical JSON: only plain objects are allowed");
  }
  ancestors.add(obj);
  try {
    if (isArray) {
      const arr = obj as unknown[];
      const parts: string[] = [];
      for (let i = 0; i < arr.length; i++) parts.push(canon(arr[i], ancestors)); // holes → throw (undefined)
      return `[${parts.join(",")}]`;
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${canon(k, ancestors)}:${canon(rec[k], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/** MIP-004 input hash: sha256(nonce + ";" + canonicalJson(input_data)). */
export function mip004InputHash(inputData: unknown, nonce: string): string {
  assertNonce(nonce);
  return sha256Hex(`${nonce};${canonicalJson(inputData)}`);
}

/** MIP-004 result hash: sha256(nonce + ";" + result), result as raw UTF-8 text (real newline bytes, no escaping). */
export function mip004ResultHash(result: string, nonce: string): string {
  assertNonce(nonce);
  if (typeof result !== "string" || !isWellFormedText(result)) throw new Mip004Error("result must be valid Unicode text");
  return sha256Hex(`${nonce};${result}`);
}

/** Sokosumi local-helper compatibility: sha256(nonce + ";" + JSON-escaped result without the outer quotes). Not MIP-004. */
export function sokosumiCompatResultHash(result: string, nonce: string): string {
  assertNonce(nonce);
  if (typeof result !== "string" || !isWellFormedText(result)) throw new Mip004Error("result must be valid Unicode text");
  return sha256Hex(`${nonce};${JSON.stringify(result).slice(1, -1)}`);
}

/** Direct Task payment, LIVE rule (path 2a): raw sha256 of the exact UTF-8 text — no nonce, no JSON. Not MIP-004. */
export function taskHashRaw(text: string): string {
  if (typeof text !== "string" || !isWellFormedText(text)) throw new Mip004Error("text must be valid Unicode");
  return sha256Hex(text);
}

/** Direct Task payment, GUIDE rule (path 2b) input hash: sha256(nonce + ";" + canonicalJson({taskId, name, description})). */
export function taskInputHashNonceCanonical(task: { taskId: string; name: string; description: string | null }, nonce: string): string {
  return mip004InputHash({ taskId: task.taskId, name: task.name, description: task.description }, nonce);
}

/** Direct Task payment, GUIDE rule (path 2b) result hash: sha256(nonce + ";" + JSON-escaped result). Same as sokosumiCompatResultHash. */
export function taskResultHashNonceEscaped(result: string, nonce: string): string {
  return sokosumiCompatResultHash(result, nonce);
}

/** MIP-003 /provide_input: input_schema_hash = sha256(canonicalJson(input_schema)). */
export function inputSchemaHash(schema: unknown): string {
  return sha256Hex(canonicalJson(schema));
}

/** True for a 64-char hex SHA-256 digest (what MPS submit-result accepts). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}
