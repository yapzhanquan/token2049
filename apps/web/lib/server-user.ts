// Resolve the signed-in user's engine id for a route handler (server-only).
//
// The engine user is looked up by EMAIL (POST /users is an idempotent upsert that keeps custody),
// not taken from the id stored in the login cookie: that id goes stale if the engine's database is
// reset or replaced, and every request would then fail with "unknown user". Results are cached
// briefly so this costs one engine call per user per minute.
import { currentUser } from "@/auth";
import { ensureEngineUser } from "./engine";

const TTL_MS = 60_000;
const cache = new Map<string, { userId: string; at: number }>();

export async function requireEngineUser(): Promise<{ userId: string; email: string; name: string | null } | Response> {
  const u = await currentUser();
  if (!u) return Response.json({ error: "Not signed in" }, { status: 401 });
  const hit = cache.get(u.email);
  if (hit && Date.now() - hit.at < TTL_MS) return { userId: hit.userId, email: u.email, name: u.name };
  try {
    const e = await ensureEngineUser({ email: u.email, name: u.name });
    cache.set(u.email, { userId: e.userId, at: Date.now() });
    return { userId: e.userId, email: u.email, name: u.name };
  } catch (err) {
    // Engine unreachable: fall back to the id from sign-in, if any (fixture mode / brief outages).
    if (u.engineUserId) return { userId: u.engineUserId, email: u.email, name: u.name };
    return Response.json({ error: `Engine user not available: ${(err as Error).message}` }, { status: 502 });
  }
}
