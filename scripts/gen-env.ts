// Create/complete .env for Bulkhead (PREPROD only).
//
//   pnpm --filter @bulkhead/chain exec tsx ../../scripts/gen-env.ts      (or `pnpm gen:env` once wired)
//
// - Creates .env from .env.example if it does not exist; appends any variable from .env.example
//   that .env lacks (with the example's default value).
// - Generates, ONLY where the value is empty: MASTER_SECRET (32 random bytes, hex), ENGINE_TOKEN,
//   NEXTAUTH_SECRET, and a NEW 24-word OPERATOR_MNEMONIC (Mesh). Existing values are never overwritten.
// - Never prints secrets. Prints only the names of generated variables, the operator ADDRESS to fund,
//   and the faucet URL.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbeddedWallet } from "../packages/chain/src/mesh";
import { operatorInfo } from "../packages/chain/src/index";

// --root <dir> (tests) overrides the repo root.
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 && process.argv[rootArg + 1] ? process.argv[rootArg + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");
const FAUCET = "https://docs.cardano.org/cardano-testnets/tools/faucet";

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t.replace(/\s+#.*$/, "");
}

function parse(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of text.split(/\r?\n/)) {
    const r = LINE.exec(l);
    if (r) m.set(r[1]!, unquote(r[2]!));
  }
  return m;
}

/** Set KEY=value in the file text: fills an existing empty `KEY=` line, else appends. */
function setVar(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => LINE.exec(l)?.[1] === key);
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join("\n");
}

async function main() {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";
  let created = false;
  let text: string;
  if (existsSync(ENV_PATH)) text = readFileSync(ENV_PATH, "utf8");
  else {
    text = example;
    created = true;
  }
  let vars = parse(text);

  // Append variables the example has but .env lacks (non-destructive).
  const added: string[] = [];
  for (const [k, v] of parse(example)) {
    if (!vars.has(k)) {
      text = setVar(text, k, v);
      added.push(k);
    }
  }
  vars = parse(text);

  const generated: string[] = [];
  const gen = (key: string, make: () => string) => {
    if ((vars.get(key) ?? "").trim() === "") {
      text = setVar(text, key, make());
      generated.push(key);
    }
  };
  gen("MASTER_SECRET", () => randomBytes(32).toString("hex"));
  gen("ENGINE_TOKEN", () => randomBytes(32).toString("base64url"));
  gen("NEXTAUTH_SECRET", () => randomBytes(32).toString("base64url"));
  gen("OPERATOR_MNEMONIC", () => `"${EmbeddedWallet.generateMnemonic(256).join(" ")}"`);

  if (created || added.length || generated.length) {
    writeFileSync(ENV_PATH, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(ENV_PATH, 0o600);
    } catch {
      /* not supported on Windows */
    }
  }

  vars = parse(text);
  console.log(created ? `Created ${ENV_PATH}` : `Using existing ${ENV_PATH}`);
  if (added.length) console.log(`Added missing variables from .env.example: ${added.join(", ")}`);
  console.log(generated.length ? `Generated (values not shown): ${generated.join(", ")}` : "No secrets generated (all already set; nothing overwritten).");

  const mnemonic = vars.get("OPERATOR_MNEMONIC") ?? "";
  if (mnemonic) {
    const op = await operatorInfo({ OPERATOR_MNEMONIC: mnemonic });
    console.log("");
    console.log(`Operator address (PREPROD) — fund it with test ADA:`);
    console.log(`  ${op.address}`);
    console.log(`Faucet: ${FAUCET}  (network: Preprod)`);
    console.log(`Explorer: https://preprod.cardanoscan.io/address/${op.address}`);
    console.log(`Then run: pnpm setup:chain`);
  }
}

main().catch((e) => {
  console.error(`gen-env failed: ${(e as Error).message}`);
  process.exit(1);
});
