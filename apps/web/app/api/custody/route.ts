// Switch custody.
//   "self": a CIP-30 wallet becomes the treasury. Requires proof of control: the browser got a one-time
//           nonce from /api/wallet-auth/nonce {purpose:"link", address}, signed the returned message with
//           CIP-30 signData, and sends { walletAddress, nonce, signature, key }. The ENGINE verifies the
//           COSE_Sign1 against the address (Mesh checkSignature), burns the nonce, then links the wallet.
//           Mainnet addresses are refused.
//   "custodial": back to the server-derived treasury (unchanged).
import { engineJson, EngineError } from "@/lib/engine";
import { requireEngineUser } from "@/lib/server-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireEngineUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as { walletAddress?: string; custody?: string; nonce?: string; signature?: string; key?: string };
  const custody = body.custody === "custodial" ? "custodial" : "self";
  try {
    if (custody === "self") {
      const address = String(body.walletAddress ?? "");
      if (/^(addr1|stake1)/.test(address)) return Response.json({ error: "Mainnet address refused: connect a PREPROD wallet" }, { status: 400 });
      if (!/^addr_test1[0-9a-z]{20,}$/.test(address)) return Response.json({ error: "Connect a PREPROD wallet (address must start with addr_test1)" }, { status: 400 });
      if (![body.nonce, body.signature, body.key].every((v) => typeof v === "string" && v.length > 0)) {
        return Response.json({ error: "Linking a wallet needs a wallet signature (nonce, signature, key from CIP-30 signData)" }, { status: 400 });
      }
      const out = await engineJson<unknown>({
        method: "POST",
        path: "/wallet/link",
        userId: user.userId,
        body: { address, nonce: body.nonce, signature: body.signature, key: body.key },
      });
      return Response.json(out);
    }
    const out = await engineJson<unknown>({ method: "POST", path: "/users", userId: user.userId, body: { email: user.email, name: user.name, custody } });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof EngineError ? e.status : 500 });
  }
}
