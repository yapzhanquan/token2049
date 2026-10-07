// Run `next <dev|start>` bound to loopback by default (127.0.0.1:3000), never 0.0.0.0.
// Override with WEB_HOST / WEB_PORT (e.g. WEB_HOST=0.0.0.0 to expose it on purpose).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const [cmd = "dev", ...rest] = process.argv.slice(2);
const host = process.env.WEB_HOST || "127.0.0.1";
const port = process.env.WEB_PORT || "3000";

const child = spawn(process.execPath, [nextBin, cmd, "-H", host, "-p", port, ...rest], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
