// Captain collateral: Plutus (vault) txs need one ADA-only collateral UTxO from the captain wallet.
// Idempotent: funds the captain with `lovelace` (default 10 tADA) from the operator only when it has
// no ADA-only UTxO ≥ MIN_COLLATERAL_LOVELACE.
import type { KeyVault } from "../keys";
import type { ChainProvider, TxResult } from "../types";
import { pickCollateral } from "./service";

export async function ensureCaptainCollateral(
  chain: { provider: ChainProvider; keys: KeyVault; tx: { operatorSend(a: { toAddress: string; tusdMicro: bigint; lovelace: bigint; reference: string }): Promise<TxResult> } },
  lovelace = 10_000_000n,
): Promise<{ address: string; existing?: { txHash: string; outputIndex: number; lovelace: bigint }; funded?: TxResult }> {
  const captain = await chain.keys.captain();
  const have = pickCollateral(await chain.provider.fetchUtxos(captain.address));
  if (have)
    return {
      address: captain.address,
      existing: { txHash: have.txHash, outputIndex: have.outputIndex, lovelace: BigInt(have.amount.find((a) => a.unit === "lovelace")!.quantity) },
    };
  const funded = await chain.tx.operatorSend({ toAddress: captain.address, tusdMicro: 0n, lovelace, reference: "Bulkhead captain collateral (vault txs)" });
  return { address: captain.address, funded };
}
