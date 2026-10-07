// Auth.js (next-auth v5). Google when GOOGLE_CLIENT_ID/SECRET are set; a "Demo login" credentials
// provider when DEMO_LOGIN=1 (or in fixture mode, where nothing touches the chain). "Sign in with Cardano wallet"
// (credentials provider "wallet") whenever a real engine is configured: the browser signs a server-issued
// one-time nonce with CIP-30 signData; the ENGINE verifies the COSE_Sign1 against the claimed preprod address
// (Mesh checkSignature), burns the nonce and upserts the user (identity wallet:<stake_test1…>, custody self).
// On first sign-in the engine user is created (POST /users); its id rides in the JWT.
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { engineJson, ensureEngineUser, isFixtureMode } from "./lib/engine";

export const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const demoEnabled = process.env.DEMO_LOGIN === "1" || isFixtureMode();
/** Wallet sign-in needs the real engine (it verifies the signature and owns the nonce store). */
export const walletLoginEnabled = !isFixtureMode();

const providers: NextAuthConfig["providers"] = [];
if (googleEnabled) {
  providers.push(Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }));
}
if (demoEnabled) {
  providers.push(
    Credentials({
      id: "demo",
      name: "Demo login (testnet)",
      credentials: { name: { label: "Your name", type: "text" } },
      authorize: async (creds) => {
        const raw = String(creds?.name ?? "").trim().slice(0, 40) || "Demo user";
        const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo";
        return { id: `demo-${slug}`, name: raw, email: `${slug}@demo.bulkhead.local` };
      },
    }),
  );
}

if (walletLoginEnabled) {
  providers.push(
    Credentials({
      id: "wallet",
      name: "Cardano wallet (CIP-30)",
      credentials: { address: {}, nonce: {}, signature: {}, key: {} },
      authorize: async (creds) => {
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        const body = { address: str(creds?.address), nonce: str(creds?.nonce), signature: str(creds?.signature), key: str(creds?.key) };
        if (!body.address || !body.nonce || !body.signature || !body.key) return null;
        try {
          const r = await engineJson<{ userId: string; identity: string; email: string; name: string }>({ method: "POST", path: "/wallet/login", body });
          return { id: r.identity, name: r.name, email: r.email };
        } catch (e) {
          console.warn("[auth] wallet sign-in refused:", (e as Error).message);
          return null;
        }
      },
    }),
  );
}

function secret(): string | undefined {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (s) return s;
  // Local development convenience only; production requires NEXTAUTH_SECRET.
  if (process.env.NODE_ENV !== "production" || isFixtureMode()) return "bulkhead-dev-only-secret-change-me-0123456789";
  return undefined;
}

async function linkEngineUser(token: Record<string, unknown>) {
  if (token.engineUserId || !token.email) return;
  try {
    const u = await ensureEngineUser({ email: String(token.email), name: (token.name as string | null) ?? null });
    token.engineUserId = u.userId;
  } catch (e) {
    // Engine down: the user can still sign in; we retry on the next request.
    console.warn("[auth] could not create engine user:", (e as Error).message);
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  secret: secret(),
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token }) {
      await linkEngineUser(token as Record<string, unknown>);
      return token;
    },
    async session({ session, token }) {
      (session.user as unknown as Record<string, unknown>).engineUserId = token.engineUserId ?? null;
      return session;
    },
  },
});

/** The signed-in user + their engine id, or null. Server-side only. */
export async function currentUser(): Promise<{ engineUserId: string | null; email: string; name: string | null } | null> {
  const session = await auth();
  if (!session?.user?.email) return null;
  const engineUserId = ((session.user as unknown as Record<string, unknown>).engineUserId as string | null) ?? null;
  return { engineUserId, email: session.user.email, name: session.user.name ?? null };
}
