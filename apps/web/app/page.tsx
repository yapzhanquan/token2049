import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { isFixtureMode } from "@/lib/engine";
import { stripeEnabled } from "@/lib/stripe";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <AppShell user={{ name: user.name, email: user.email }} fixture={isFixtureMode()} stripe={stripeEnabled()} />;
}
