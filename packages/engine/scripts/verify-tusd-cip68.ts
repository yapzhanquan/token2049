// Read-only PREPROD check of tUSD as a CIP-68 fungible token (no tx is built or submitted).
//   tsx --env-file-if-exists=../../.env scripts/verify-tusd-cip68.ts
// 1. Blockfrost /assets/{ref unit}: the (100) reference NFT exists, quantity 1, its CIP-14 fingerprint.
// 2. /assets/{ref unit}/addresses → the holder; /addresses/{holder}/utxos/{ref unit} → inline_datum CBOR,
//    decoded locally with decodeCip68Datum and compared to TUSD_METADATA.
// 3. /assets/{333 unit}: total supply, fingerprint (and Blockfrost's own CIP-68 parse, if it indexes one).
import { decodeCip68Datum, operatorInfo, TUSD_METADATA, assetFingerprint } from "@bulkhead/chain";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";

async function bf<T>(path: string): Promise<T> {
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) throw new Error("BLOCKFROST_PREPROD_PROJECT_ID is not set");
  const r = await fetch(BF + path, { headers: { project_id: key } });
  if (!r.ok) throw new Error(`Blockfrost ${path} → HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function main() {
  const info = await operatorInfo();
  const ok = (c: boolean, m: string) => {
    console.log(`${c ? "✓" : "✗"} ${m}`);
    if (!c) process.exitCode = 1;
  };
  console.log(`policy ${info.policyId}\n333 unit ${info.tusdUnit}\n100 unit ${info.tusdReferenceUnit}`);

  const ref = await bf<{ quantity: string; fingerprint: string; initial_mint_tx_hash: string; onchain_metadata_standard?: string | null }>(`/assets/${info.tusdReferenceUnit}`);
  ok(ref.quantity === "1", `reference NFT quantity = ${ref.quantity}`);
  ok(ref.fingerprint === assetFingerprint(info.policyId, info.tusdReferenceUnit.slice(56)), `reference NFT fingerprint ${ref.fingerprint} (CIP-14, matches local)`);
  console.log(`  minted in tx ${ref.initial_mint_tx_hash}`);

  const holders = await bf<{ address: string; quantity: string }[]>(`/assets/${info.tusdReferenceUnit}/addresses`);
  ok(holders.length === 1 && holders[0]!.address === info.address, `reference NFT held at the operator address ${holders[0]?.address}`);
  const utxos = await bf<{ tx_hash: string; output_index: number; inline_datum: string | null; data_hash: string | null }[]>(
    `/addresses/${holders[0]!.address}/utxos/${info.tusdReferenceUnit}`,
  );
  const u = utxos[0]!;
  console.log(`  UTxO ${u.tx_hash}#${u.output_index}\n  inline_datum ${u.inline_datum}`);
  ok(!!u.inline_datum, "reference UTxO carries an inline datum");
  const d = decodeCip68Datum(u.inline_datum!);
  console.log(`  decoded: version ${d.version}, metadata ${JSON.stringify(d.metadata, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  ok(d.version === 1, "CIP-68 version 1");
  ok(
    d.metadata.name === TUSD_METADATA.name &&
      d.metadata.ticker === TUSD_METADATA.ticker &&
      d.metadata.description === TUSD_METADATA.description &&
      d.metadata.decimals === BigInt(TUSD_METADATA.decimals),
    "datum metadata = { name, ticker tUSD, decimals 6 (int), description }",
  );

  const ft = await bf<{ quantity: string; fingerprint: string; onchain_metadata?: unknown; onchain_metadata_standard?: string | null; metadata?: unknown }>(`/assets/${info.tusdUnit}`);
  ok(ft.fingerprint === info.tusdFingerprint, `333 fingerprint ${ft.fingerprint} (CIP-14, matches local)`);
  console.log(`  333 total supply ${ft.quantity} µtUSD; Blockfrost onchain_metadata_standard=${ft.onchain_metadata_standard ?? "null"} onchain_metadata=${JSON.stringify(ft.onchain_metadata ?? null)}`);
}

main().catch((e) => {
  console.error(`verify failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
