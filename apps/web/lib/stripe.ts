// Stripe (TEST mode only). Server-only.
import Stripe from "stripe";

export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    // Preprod project: never take real money.
    throw new Error("Refusing a live Stripe key: Bulkhead runs on Cardano preprod and accepts Stripe TEST keys only");
  }
  client ??= new Stripe(key);
  return client;
}

export function publicUrl(req: Request): string {
  return (process.env.PUBLIC_WEB_URL ?? new URL(req.url).origin).replace(/\/+$/, "");
}
