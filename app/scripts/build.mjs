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
// app/dist/ is the Cloudflare Pages publish root (served at the site root). This
// script assembles the COMPLETE site there: the allowlisted repo-root teaser/spec
// files are copied to dist/ (so abnormies.art/ is the teaser, /spec.html the spec),
// and the app build is placed under dist/app/ (so the app resolves at
// /app/mint.html with its assets as siblings). The entry HTML is mint.html (not
// index.html) so the repo-root teaser keeps abnormies.art/; the detail page is
// /app/abnormie.html.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..");
const publicDir = resolve(appRoot, "public");
const dist = resolve(appRoot, "dist");
const appOut = resolve(dist, "app");

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

// Repo-root files that ship at the publish root (the teaser site). Explicit
// allowlist — nothing else from the repo root (README.md, CLAUDE.md, .gitignore,
// .git, app/ source, node_modules, etc.) is copied into the deploy.
const rootFiles = [
  "index.html",
  "spec.html",
  "spec.md",
  "favicon.ico",
  "favicon.svg",
  "og.png",
  "_headers",
  "robots.txt",
  "llms.txt"
];

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(appOut, "abi"), { recursive: true });

// Copy static app assets but skip main.js — esbuild emits the bundled version
// below. Everything lands under dist/app/ (served at /app/).
await cp(publicDir, appOut, {
  recursive: true,
  filter: (src) => !src.endsWith("/main.js")
});

// Slim the vendored Foundry artifact to just its ABI for the runtime fetch.
const artifact = JSON.parse(await readFile(resolve(publicDir, "abi/Abnormies.json"), "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error("public/abi/Abnormies.json has no `abi` array — is it a Foundry artifact?");
}
await writeFile(resolve(appOut, "abi/Abnormies.json"), `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`);

// Runtime config, read by main.js via window.ABNORMIES_CONFIG.
await writeFile(resolve(appOut, "config.js"), `window.ABNORMIES_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

// Bundle the entry: viem inlined, single self-contained module, no CDN at runtime.
await esbuild.build({
  entryPoints: [resolve(publicDir, "main.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outfile: resolve(appOut, "main.js")
});

// Assemble the teaser site at the publish root: copy only the allowlisted
// repo-root files into dist/.
for (const file of rootFiles) {
  await cp(resolve(repoRoot, file), resolve(dist, file));
}

if (!config.contractAddress) {
  console.warn("WARNING: FRONTEND_CONTRACT_ADDRESS is empty. The app will show a config error until rebuilt with it set.");
}
console.log(`Built dist/ for chainId ${chainId} (contract ${config.contractAddress || "unset"}, rpc ${config.rpcUrl || "chain default"}).`);
