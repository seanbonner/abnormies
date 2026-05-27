// Abnormies Phase 1 app build.
//
// Mirrors EtherPool's pattern: copy static assets, bundle the entry with
// esbuild (viem inlined), slim the Foundry ABI artifact down to its `abi`
// field, and emit a runtime config from environment variables.
//
// Run with the deploy values exported in your shell, e.g.:
//   set -a; source .env; set +a
//   npm run build
//
// Output lands in app/dist/ and is what Cloudflare Pages serves.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const publicDir = resolve(appRoot, "public");
const dist = resolve(appRoot, "dist");

const chainId = Number(process.env.FRONTEND_CHAIN_ID || "1");

// Per-chain fallbacks so the build still produces a working config when only
// FRONTEND_CHAIN_ID is set. Explicit env vars always win.
const etherscanBaseUrls = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io"
};
const defaultRpcUrls = {
  1: "https://ethereum-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com"
};

const config = {
  contractAddress: process.env.FRONTEND_CONTRACT_ADDRESS || "",
  chainId,
  etherscanBaseUrl:
    process.env.FRONTEND_ETHERSCAN_BASE_URL || etherscanBaseUrls[chainId] || "https://etherscan.io",
  rpcUrl: process.env.FRONTEND_RPC_URL || defaultRpcUrls[chainId] || ""
};

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "abi"), { recursive: true });

// Copy static assets but skip the JS entry points — esbuild emits the bundled
// versions below.
await cp(publicDir, dist, {
  recursive: true,
  filter: (src) => !src.endsWith("/main.js") && !src.endsWith("/abnormie.js")
});

// Slim the vendored Foundry artifact to just its ABI for the runtime fetch.
const artifact = JSON.parse(await readFile(resolve(publicDir, "abi/Abnormies.json"), "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error("public/abi/Abnormies.json has no `abi` array — is it a Foundry artifact?");
}
await writeFile(resolve(dist, "abi/Abnormies.json"), `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`);

// Runtime config, read by main.js via window.ABNORMIES_CONFIG.
await writeFile(resolve(dist, "config.js"), `window.ABNORMIES_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

// Bundle the entries: viem inlined, self-contained modules, no CDN at runtime.
//   main.js     -> Phase 1/2 claim + mint app (index.html)
//   abnormie.js -> post-reveal detail page (abnormie.html)
await esbuild.build({
  entryPoints: [resolve(publicDir, "main.js"), resolve(publicDir, "abnormie.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outdir: dist
});

if (!config.contractAddress) {
  console.warn("WARNING: FRONTEND_CONTRACT_ADDRESS is empty. The app will show a config error until rebuilt with it set.");
}
console.log(`Built dist/ for chainId ${chainId} (contract ${config.contractAddress || "unset"}, rpc ${config.rpcUrl || "chain default"}).`);
