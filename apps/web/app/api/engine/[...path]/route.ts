// Browser → engine proxy. Adds x-engine-token (server secret) and x-user-id (from the Auth.js
// session); the browser never sees the token. Only the routes below are reachable from the browser:
// POST /users and POST /topups/:id/confirm are server-only (custody + Stripe webhook routes).
// text/event-stream responses (events/stream, sessions/:id/peek) are streamed through.
import { engineRequest } from "@/lib/engine";
import { requireEngineUser } from "@/lib/server-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SEG = "[A-Za-z0-9_:.-]+";
const ALLOW: [string, RegExp][] = [
  ["GET", /^\/health$/],
  ["GET", /^\/me$/],
  ["GET", /^\/goals$/],
  ["POST", /^\/goals$/],
  ["POST", new RegExp(`^/goals/${SEG}/approve$`)],
  ["GET", new RegExp(`^/goals/${SEG}/tree$`)],
  ["GET", new RegExp(`^/goals/${SEG}/proof$`)], // trust receipt (read-only)
  ["POST", /^\/sessions\/pause-all$/],
  ["GET", new RegExp(`^/sessions/${SEG}$`)],
  ["POST", new RegExp(`^/sessions/${SEG}/(pause|resume|kill|extend|raise|narrow)$`)],
  ["POST", new RegExp(`^/sessions/${SEG}/messages$`)],
  ["GET", new RegExp(`^/sessions/${SEG}/peek$`)],
  ["GET", new RegExp(`^/sessions/${SEG}/proof$`)], // trust receipt (read-only)
  ["POST", new RegExp(`^/payments/${SEG}/(approve|reject)$`)],
  ["GET", /^\/decisions$/],
  ["POST", new RegExp(`^/decisions/${SEG}$`)],
  ["POST", /^\/captain\/messages$/],
  ["GET", /^\/captain\/log$/],
  ["GET", /^\/agents$/],
  ["GET", /^\/agent-map$/],
  ["GET", /^\/spending$/],
  ["GET", /^\/logbook$/],
  ["GET", /^\/activity$/],
  ["GET", /^\/events\/stream$/],
  // Bridge (captain digest): Bearings + Ahoy.
  ["GET", /^\/bearings$/],
  ["POST", /^\/bearings\/file$/],
  ["GET", /^\/ahoy$/],
  ["POST", /^\/ahoy\/seen$/],
  ["POST", new RegExp(`^/signatures/${SEG}$`)],
];

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const p = `/${path.map(encodeURIComponent).join("/")}`;
  if (!ALLOW.some(([m, re]) => m === req.method && re.test(p))) {
    return Response.json({ error: `Not allowed: ${req.method} ${p}` }, { status: 404 });
  }
  const user = await requireEngineUser();
  if (user instanceof Response) return user;

  const search = new URL(req.url).search;
  let body: unknown;
  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > 64_000) return Response.json({ error: "Body too large" }, { status: 413 });
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return Response.json({ error: "Body must be JSON" }, { status: 400 });
    }
  }

  const upstream = await engineRequest({ method: req.method, path: `${p}${search}`, userId: user.userId, body, signal: req.signal });
  const type = upstream.headers.get("content-type") ?? "application/json";
  if (type.includes("text/event-stream")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": type, "cache-control": "no-store" } });
}

export { proxy as GET, proxy as POST };
