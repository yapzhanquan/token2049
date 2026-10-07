// Mesh 1.9.1 loader.
//
// WHY THIS SHIM: `import "@meshsdk/core"` crashes at load time in this workspace
// (@meshsdk/provider → @utxorpc/sdk → @connectrpc/connect@1.4.0 resolved against
// @bufbuild/protobuf@2.16.0, which no longer exports `protoBase64` / `Message`).
// We do not use any Mesh provider (our own ChainProvider classes talk HTTP), so we load
// only the Mesh sub-packages we need — common, core-cst, transaction, wallet — through
// CommonJS `require`, resolved from @meshsdk/core's own location (they are its deps).
// All TYPES still come from "@meshsdk/core" via `import type` (erased at runtime).
// One CJS instance of each package => one libsodium instance for derive/sign.
import { createRequire } from "node:module";
import type * as MeshCore from "@meshsdk/core";
import type * as MeshCst from "@meshsdk/core-cst";

const localRequire = createRequire(import.meta.url);
const meshRequire = createRequire(localRequire.resolve("@meshsdk/core"));

export const cst = meshRequire("@meshsdk/core-cst") as typeof MeshCst;
const txPkg = meshRequire("@meshsdk/transaction") as Pick<typeof MeshCore, "MeshTxBuilder">;
const walletPkg = meshRequire("@meshsdk/wallet") as Pick<typeof MeshCore, "EmbeddedWallet" | "MeshWallet">;
const commonPkg = meshRequire("@meshsdk/common") as Pick<
  typeof MeshCore,
  "SLOT_CONFIG_NETWORK" | "slotToBeginUnixTime" | "unixTimeToEnclosingSlot" | "castProtocol" | "DEFAULT_PROTOCOL_PARAMETERS"
>;

export const MeshTxBuilder = txPkg.MeshTxBuilder;
export const EmbeddedWallet = walletPkg.EmbeddedWallet;
export const { SLOT_CONFIG_NETWORK, slotToBeginUnixTime, unixTimeToEnclosingSlot, castProtocol, DEFAULT_PROTOCOL_PARAMETERS } = commonPkg;

export type MeshUTxO = MeshCore.UTxO;
export type MeshAsset = MeshCore.Asset;
export type MeshProtocol = MeshCore.Protocol;
export type MeshNativeScript = MeshCore.NativeScript;
export type MeshTxBuilderT = InstanceType<typeof MeshCore.MeshTxBuilder>;

let ready: Promise<void> | null = null;
/**
 * BIP32-Ed25519 derivation needs libsodium initialised (cardano-js-sdk `Crypto.ready()`).
 * Mesh's EmbeddedWallet.init() awaits exactly that; we use a throwaway wallet to trigger it.
 */
export function ensureCryptoReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const w = new EmbeddedWallet({ networkId: 0, key: { type: "bip32Bytes", bip32Bytes: new Uint8Array(96).fill(1) } });
      await w.init();
    })();
  }
  return ready;
}
