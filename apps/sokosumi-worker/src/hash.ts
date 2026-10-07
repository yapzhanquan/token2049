// Hash rules for Sokosumi Task results.
// Direct Task payments (the user's brief, LIVE demo rule): SHA-256 over the exact raw UTF-8 bytes,
// no nonce, no JSON escaping. The rule is pluggable and its name is journaled per Task, because an
// earlier demo branch used a nonce + JSON-escaped pre-image (docs/SOKOSUMI-PROTOCOL.md §6.4).
import { createHash } from "node:crypto";

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");

export interface HashRule {
  /** Journaled with every hash so a later audit knows the pre-image rule. */
  name: string;
  input(text: string): string;
  result(bytes: Uint8Array): string;
}

export const RAW_UTF8_SHA256: HashRule = {
  name: "raw-utf8-sha256",
  input: (text) => sha256Hex(text),
  result: (bytes) => sha256Hex(bytes),
};

export const HASH_RULES: Record<string, HashRule> = { [RAW_UTF8_SHA256.name]: RAW_UTF8_SHA256 };

export function hashRule(name: string | undefined): HashRule {
  const rule = HASH_RULES[name ?? RAW_UTF8_SHA256.name];
  if (!rule) throw new Error(`Unknown hash rule ${name}`);
  return rule;
}
