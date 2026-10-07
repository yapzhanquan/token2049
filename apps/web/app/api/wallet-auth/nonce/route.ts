// One-time nonce for a CIP-30 signData proof (sign-in, wallet link, self-custody decision approval).
// The engine stores it with an expiry and returns the exact message the wallet must sign.
//   { purpose: "login", address }          — no session needed (this IS the sign-in)
//   { purpose: "link", address }           — signed-in user linking a wallet as treasury
//   { purpose: "decision", decisionId }    — signed-in self-custody user approving a decision
import { engineJson, EngineError, isFixtureMode } from "@/lib/engine";
import { requireEngineUser } from "@/lib/server-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (isFixtureMode()) return Response.json({ error: "Wallet signatures are verified by the engine; fixture mode has no engine (set ENGINE_URL)." }, { status: 501 });
  const b = (await req.json().catch(() => ({}))) as { purpose?: unknown; address?: unknown; decisionId?: unknown };
  const purpose = b.purpose === "login" || b.purpose === "link" || b.purpose === "decision" ? b.purpose : null;
  if (!purpose) return Response.json({ error: "purpose must be login | link | decision" }, { status: 400 });
  const address = typeof b.address === "string" ? b.address.slice(0, 200) : undefined;
  const decisionId = typeof b.decisionId === "string" ? b.decisionId.slice(0, 100) : undefined;
  if (purpose !== "decision" && address && /^(addr1|stake1)/.test(address)) {
    return Response.json({ error: "Mainnet address refused: Bulkhead runs on Cardano preprod only. Switch your wallet to preprod." }, { status: 400 });
  }
  let userId: string | undefined;
  if (purpose !== "login") {
    const user = await requireEngineUser();
    if (user instanceof Response) return user;
    userId = user.userId;
  }
  try {
    const out = await engineJson<{ nonce: string; payload: string; address: string; expiresAt: number }>({
      method: "POST",
      path: "/wallet/nonce",
      userId,
      body: { purpose, ...(address ? { address } : {}), ...(decisionId ? { decisionId } : {}) },
    });
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof EngineError ? e.status : 500 });
  }
}
