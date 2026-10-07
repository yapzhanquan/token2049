import { redirect } from "next/navigation";
import { auth, demoEnabled, googleEnabled, signIn, walletLoginEnabled } from "@/auth";
import WalletLogin from "./WalletLogin";
import { isFixtureMode } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  const fixture = isFixtureMode();

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="panel w-full max-w-[420px] p-6 flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <BrandMark />
          <h1 className="text-lg font-semibold">Bulkhead</h1>
          <span className="tag ml-auto">preprod</span>
        </div>
        <p className="mid text-[13px]">
          Parallel, isolated AI agent sessions, each with its own Cardano wallet and mandate. Sign in to get a treasury.
        </p>

        {walletLoginEnabled && <WalletLogin />}

        {googleEnabled && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button className="btn btn-primary w-full h-10" type="submit">
              Continue with Google
            </button>
          </form>
        )}

        {demoEnabled && (
          <form
            className="flex flex-col gap-2"
            action={async (fd: FormData) => {
              "use server";
              await signIn("demo", { name: String(fd.get("name") ?? ""), redirectTo: "/" });
            }}
          >
            <label className="label" htmlFor="name">
              Demo login (testnet demo, no password)
            </label>
            <input id="name" name="name" className="input" placeholder="Your name" defaultValue="Demo user" maxLength={40} />
            <button className="btn w-full h-10" type="submit">
              Demo login
            </button>
          </form>
        )}

        {!googleEnabled && !demoEnabled && !walletLoginEnabled && (
          <div className="banner banner-warn">
            <span>
              <b>No sign-in method configured.</b> Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or DEMO_LOGIN=1 for a testnet demo login.
            </span>
          </div>
        )}

        <div className="banner">
          <span>
            <b>Wallet sign-in = self-custody.</b> Signing in with a Cardano wallet makes that wallet your treasury: you sign funding and
            approvals yourself. <b>Google / demo login = custodial on testnet:</b> the server derives your treasury key and stores it encrypted
            (preprod only); you can still “Connect wallet” later and switch to self-custody (that also asks for a wallet signature).
          </span>
        </div>
        {fixture && (
          <div className="banner banner-warn">
            <span>
              <b>Fixture mode.</b> ENGINE_URL is unset or MOCK_ENGINE=1: the app shows sample data. Nothing is on-chain.
            </span>
          </div>
        )}
      </div>
    </main>
  );
}

function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1.5" y="1.5" width="15" height="15" rx="4" fill="none" stroke="var(--good)" strokeWidth="1.6" />
      <path d="M6 1.5v15M12 1.5v15" stroke="var(--good)" strokeWidth="1.6" />
    </svg>
  );
}
