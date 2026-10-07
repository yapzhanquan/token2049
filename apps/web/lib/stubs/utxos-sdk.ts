// Browser stand-in for `@utxos/sdk`. @meshsdk/react imports only `Web3Wallet` from it, for UTXOS
// social-login wallets, which Bulkhead never uses. The real package pulls the Node build of
// @buildonspark/spark-sdk (gRPC, OpenTelemetry) into the browser, where it crashes on load and
// breaks the whole "Connect wallet" chunk. Normal CIP-30 extensions (Eternl, Lace, …) don't need it.
export class Web3Wallet {
  static async enable(): Promise<never> {
    throw new Error("UTXOS social-login wallets are not supported in Bulkhead; connect a CIP-30 browser wallet instead.");
  }
}
