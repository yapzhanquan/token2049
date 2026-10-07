// Browser-only glue for the trust-receipt verifier (lib/verify-proof.ts stays environment-agnostic).
import type { CstLike } from "./verify-proof";

/** Mesh's core-cst (`import { cst } from "@meshsdk/core"`), loaded on demand in the browser. */
export async function loadBrowserCst(): Promise<CstLike> {
  // The `typeof window` guard is constant-folded by Next per layer, so the server bundle never resolves
  // @meshsdk/core (its ESM provider chain does not link on the server; see packages/chain/src/mesh.ts).
  if (typeof window !== "undefined") {
    const m = await import("@meshsdk/core");
    return m.cst as unknown as CstLike;
  }
  throw new Error("the on-chain verifier runs in the browser");
}
