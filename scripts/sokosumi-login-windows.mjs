// Sokosumi CLI 1.0.0 browser login, fixed for Windows.
//
// The CLI opens the OAuth URL with `cmd /c start "" <url>`; cmd treats every "&" as a command separator,
// so the browser receives only `?client_id=…` and the server answers "response_type is required".
// This launcher runs the CLI's OWN login (same preprod config, PKCE, loopback callback, credential vault)
// and only replaces the browser opener with one that passes the full URL without a shell.
// It never reads, prints or stores tokens — the CLI saves them in its own secure store.
//
// Usage:  node scripts/sokosumi-login-windows.mjs
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const cliSrc = join(execSync("npm root -g", { encoding: "utf8" }).trim(), "sokosumi", "dist", "src");
const load = (p) => import(pathToFileURL(join(cliSrc, p)).href);
const { runAuthLogin } = await load("cli/auth-login.js");
const { loginWithBrowser } = await load("auth/oauth.js");
const { resolveCliConfig } = await load("auth/config.js");

const config = resolveCliConfig({ env: process.env, preprod: true });
if (config.target !== "preprod") throw new Error("refusing: target is not preprod");

const openUrl = (url) => {
  // No shell: the URL is a single argv entry, so "&" is passed through intact.
  const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" });
  child.unref();
  console.log("\nIf the browser did not open, paste this full link into it (sign in on preprod.sokosumi.com):\n" + url + "\n");
};

await runAuthLogin({
  env: process.env,
  config,
  targetExplicit: true,
  loginFn: (request) => loginWithBrowser({ ...request, openUrl }),
});
