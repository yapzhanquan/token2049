import type { NextConfig } from "next";
import NodePolyfillPlugin from "node-polyfill-webpack-plugin";
import path from "node:path";

// The monorepo keeps one .env at the root; Next only reads apps/web/.env*. Load the root one too
// (existing variables win, so a local .env.local or the shell still overrides it).
for (const file of [path.resolve(process.cwd(), "../../.env"), path.resolve(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* optional */
  }
}

// Settlement asset ticker for the UI (mirrors settlementTickerFromEnv in @bulkhead/shared settlement.ts; default tUSDM).
function settlementTicker(env: NodeJS.ProcessEnv): string {
  if (env.SETTLEMENT_UNIT?.trim()) {
    const u = env.SETTLEMENT_UNIT.trim().toLowerCase();
    return u === "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" ? "tUSDM" : env.SETTLEMENT_TICKER?.trim() || "units";
  }
  return env.SETTLEMENT_ASSET?.trim().toLowerCase() === "tusd" ? "tUSD" : "tUSDM";
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_SETTLEMENT_TICKER: settlementTicker(process.env) },
  // NEXT_DIST_DIR lets a verification build run while `next dev` holds .next (they must not share it).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Several lockfiles exist above this folder; trace from the monorepo root.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // @bulkhead/shared ships TypeScript source.
  transpilePackages: ["@bulkhead/shared"],
  // Server-only SDK; never bundled for the browser.
  serverExternalPackages: ["stripe"],
  eslint: { ignoreDuringBuilds: true },
  experimental: { webpackMemoryOptimizations: true },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // Mesh uses Node built-ins (Buffer, crypto, stream); polyfill them for the browser bundle.
      config.plugins.push(new NodePolyfillPlugin());
      // Strip the `node:` scheme so the polyfills above are used (node:buffer -> buffer).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      // Webpack otherwise takes @meshsdk/react's CommonJS entry, which pulls the Node build of
      // a gRPC-based dependency (net, http2) into the browser. The ESM entry resolves browser builds.
      config.resolve.alias = {
        ...config.resolve.alias,
        "@meshsdk/react$": path.join(process.cwd(), "node_modules/@meshsdk/react/dist/index.js"),
        // Even the ESM entry imports @utxos/sdk, whose dependency resolves to a Node-only build
        // (spark-sdk/index.node.js) that crashes in the browser. See lib/stubs/utxos-sdk.ts.
        "@utxos/sdk$": path.join(process.cwd(), "lib/stubs/utxos-sdk.ts"),
      };
    }
    // Mesh's serialisation libs ship wasm-bindgen "bundler" builds.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true, layers: true };
    config.module.rules.push({ test: /\.m?js$/, resolve: { fullySpecified: false } });
    return config;
  },
};

export default nextConfig;
