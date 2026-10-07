// "Simulated checkout (testnet)": only when Stripe is NOT configured. Calls the same engine path the
// Stripe webhook calls (POST /topups/:id/confirm), idempotent by the synthetic event id.
import { engineJson, EngineError } from "@/lib/engine";
import { requireEngineUser } from "@/lib/server-user";
import { stripeEnabled } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (stripeEnabled()) return Response.json({ error: "Stripe is configured; use Stripe Checkout" }, { status: 409 });
  const user = await requireEngineUser();
  if (user instanceof Response) return user;
  const { topupId } = (await req.json().catch(() => ({}))) as { topupId?: string };
  if (!topupId || !/^[A-Za-z0-9_:-]+$/.test(topupId)) return Response.json({ error: "topupId required" }, { status: 400 });
  try {
    const out = await engineJson<unknown>({
      method: "POST",
      path: `/topups/${topupId}/confirm`,
      userId: user.userId,
      body: { stripeEventId: `simulated_${topupId}`, simulated: true },
    });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof EngineError ? e.status : 500 });
  }
}
