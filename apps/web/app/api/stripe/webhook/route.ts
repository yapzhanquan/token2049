// Stripe webhook (test mode). Verifies the signature, then forwards checkout.session.completed to the
// engine (POST /topups/:id/confirm), which is idempotent by Stripe event id, so retries never double-pay.
import { engineJson, EngineError } from "@/lib/engine";
import { stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !secret) {
    return Response.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return Response.json({ error: "Missing stripe-signature" }, { status: 400 });
  const payload = await req.text(); // raw body: required for signature verification
  let event;
  try {
    event = await stripe().webhooks.constructEventAsync(payload, sig, secret);
  } catch (e) {
    return Response.json({ error: `Bad signature: ${(e as Error).message}` }, { status: 400 });
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return Response.json({ received: true, ignored: event.type });
  }
  const session = event.data.object;
  if (session.payment_status !== "paid") return Response.json({ received: true, pending: session.payment_status });
  const topupId = session.metadata?.topupId ?? session.client_reference_id;
  const userId = session.metadata?.userId;
  if (!topupId || !userId) return Response.json({ error: "Session has no topupId/userId metadata" }, { status: 400 });
  try {
    const out = await engineJson<unknown>({
      method: "POST",
      path: `/topups/${encodeURIComponent(topupId)}/confirm`,
      userId,
      body: { stripeEventId: event.id, stripeSessionId: session.id, amountTotal: session.amount_total, currency: session.currency },
    });
    return Response.json({ received: true, result: out });
  } catch (e) {
    // A 5xx makes Stripe retry; the engine dedupes by event id.
    return Response.json({ error: (e as Error).message }, { status: e instanceof EngineError && e.status < 500 ? 400 : 500 });
  }
}
