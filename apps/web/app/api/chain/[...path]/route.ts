// Read-only Blockfrost (preprod) proxy for the in-browser trust-receipt verifier (lib/verify-proof.ts).
// It ONLY adds the project key (server secret, never sent to the browser) and forwards a tiny GET allowlist of
// public chain reads; every comparison happens client-side. Nothing here talks to the engine.
//   GET /api/chain/txs/{hash}[/utxos|/metadata|/redeemers]
//   GET /api/chain/addresses/{addr_test1…}/transactions?order=&count=&page=
//   GET /api/chain/addresses/{addr_test1…}/utxos?count=&page=
// Endpoints: blockfrost-openapi src/paths/api/txs/{hash}/*, src/paths/api/addresses/* (cardano-dev-skills docs/sources).
import { currentUser } from "@/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";
const HASH = "[0-9a-f]{64}";
const ADDR = "addr_test1[02-9ac-hj-np-z]{20,120}";
const ALLOW: RegExp[] = [
  new RegExp(`^/txs/${HASH}$`),
  new RegExp(`^/txs/${HASH}/(utxos|metadata|redeemers)$`),
  new RegExp(`^/addresses/${ADDR}/(transactions|utxos)$`),
];
const QUERY: Record<string, RegExp> = { order: /^(asc|desc)$/, count: /^\d{1,3}$/, page: /^\d{1,3}$/ };

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const p = `/${path.join("/")}`;
  if (!ALLOW.some((re) => re.test(p))) return Response.json({ error: `Not allowed: GET ${p}` }, { status: 404 });
  // Signed-in users only: the key's quota is the operator's.
  if (!(await currentUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) return Response.json({ error: "On-chain verification needs BLOCKFROST_PREPROD_PROJECT_ID on the server" }, { status: 503 });

  const qs = new URLSearchParams();
  for (const [k, v] of new URL(req.url).searchParams) {
    if (!QUERY[k] || !QUERY[k].test(v)) return Response.json({ error: `Bad query parameter: ${k}` }, { status: 400 });
    qs.set(k, v);
  }
  const q = qs.toString();
  let upstream: Response;
  try {
    upstream = await fetch(`${BLOCKFROST}${p}${q ? `?${q}` : ""}`, { headers: { project_id: key }, cache: "no-store", signal: req.signal });
  } catch (e) {
    return Response.json({ error: `Blockfrost unreachable: ${(e as Error).message}` }, { status: 502 });
  }
  // Confirmed tx data never changes; address views do.
  const cacheable = upstream.ok && p.startsWith("/txs/");
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": cacheable ? "private, max-age=300" : "no-store" },
  });
}
