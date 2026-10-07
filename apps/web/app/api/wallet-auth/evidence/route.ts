// Wallet-signature evidence for the signed-in user's decisions (Decisions list: "Signed by wallet ✓").
import { engineJson, EngineError, isFixtureMode } from "@/lib/engine";
import { requireEngineUser } from "@/lib/server-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (isFixtureMode()) return Response.json({});
  const user = await requireEngineUser();
  if (user instanceof Response) return user;
  try {
    const out = await engineJson<Record<string, unknown>>({ method: "GET", path: "/wallet/evidence", userId: user.userId });
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof EngineError ? e.status : 500 });
  }
}
