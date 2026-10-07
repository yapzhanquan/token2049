// Start a top-up: engine POST /topups, then Stripe Checkout (test mode) or, without Stripe keys,
// a clearly labelled simulated checkout (see ./simulate). Both end at engine POST /topups/:id/confirm.
import { engineJson, EngineError } from "@/lib/engine";
import type { TopupStartResponse } from "@bulkhead/shared";
import { requireEngineUser } from "@/lib/server-user";
import { publicUrl, stripe, stripeEnabled } from "@/lib/stripe";
import { TICKER } from "@/lib/money";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireEngineUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as { amountMYR?: number };
  const amountMYR = Number(body.amountMYR ?? 50);
  if (!Number.isFinite(amountMYR) || amountMYR < 5 || amountMYR > 500) {
    return Response.json({ error: "Amount must be between RM5 and RM500" }, { status: 400 });
  }
  try {
    const topup = await engineJson<TopupStartResponse>({ method: "POST", path: "/topups", userId: user.userId, body: { amountMYR } });
    if (!stripeEnabled()) return Response.json({ mode: "simulated", topup });
    const base = publicUrl(req);
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "myr",
            unit_amount: Math.round(amountMYR * 100),
            product_data: { name: `Bulkhead top-up RM${amountMYR.toFixed(2)} (testnet)`, description: `Converted to ${TICKER} on Cardano preprod` },
          },
        },
      ],
      client_reference_id: topup.topupId,
      customer_email: user.email.endsWith(".local") ? undefined : user.email,
      metadata: { topupId: topup.topupId, userId: user.userId },
      success_url: `${base}/?topup=success&topupId=${encodeURIComponent(topup.topupId)}`,
      cancel_url: `${base}/?topup=cancelled`,
    });
    return Response.json({ mode: "stripe", topup, url: session.url });
  } catch (e) {
    const status = e instanceof EngineError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
