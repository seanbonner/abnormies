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
  "_redirects",
  "robots.txt",
  "llms.txt"
];

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(appOut, "abi"), { recursive: true });

// Copy static app assets but skip the JS entry points — esbuild emits the
// bundled versions below. Everything lands under dist/app/ (served at /app/).
await cp(publicDir, appOut, {
  recursive: true,
  filter: (src) =>
    !src.endsWith("/main.js") &&
    !src.endsWith("/abnormie.js") &&
    !src.endsWith("/clouds.js") &&
    !src.endsWith("/holdings.js")
});

// Slim the vendored Foundry artifact to just its ABI for the runtime fetch.
const artifact = JSON.parse(await readFile(resolve(publicDir, "abi/Abnormies.json"), "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error("public/abi/Abnormies.json has no `abi` array — is it a Foundry artifact?");
}
await writeFile(resolve(appOut, "abi/Abnormies.json"), `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`);

// Runtime config, read by main.js via window.ABNORMIES_CONFIG.
await writeFile(resolve(appOut, "config.js"), `window.ABNORMIES_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

// Bundle the entries: viem inlined, self-contained modules, no CDN at runtime.
//   main.js      -> Phase 1/2/3 claim + mint + reveal app (mint.html)
//   abnormie.js  -> post-reveal detail page (abnormie.html)
//   clouds.js    -> holdings page (clouds.html)
await esbuild.build({
  entryPoints: [
    resolve(publicDir, "main.js"),
    resolve(publicDir, "abnormie.js"),
    resolve(publicDir, "clouds.js")
  ],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outdir: appOut
});

// Assemble the teaser site at the publish root: copy only the allowlisted
// repo-root files into dist/.
for (const file of rootFiles) {
  await cp(resolve(repoRoot, file), resolve(dist, file));
}

// ---------------------------------------------------------------------------
// Reorganized site demo (dist/newsitedemo/).
//
// A parallel, self-contained build of the restructured site: unified header +
// footer, clean URLs, no /app/ folder. It ships ALONGSIDE the live site so it
// can be reviewed without disturbing anything currently at the root.
//
// Promotion = move dist/newsitedemo/* to the publish root and flip BASE_PATH to
// "". Every internal link, asset reference, and the runtime route config are
// derived from this one constant, so nothing else changes on promotion.
// ---------------------------------------------------------------------------
const BASE_PATH = process.env.NEWSITE_BASE ?? "/newsitedemo";

const newsiteSrc = resolve(appRoot, "newsite");
const newsiteOut = resolve(dist, "newsitedemo");
await mkdir(resolve(newsiteOut, "abi"), { recursive: true });

const headerTemplate = await readFile(resolve(newsiteSrc, "partials/header.html"), "utf8");
const footerTemplate = await readFile(resolve(newsiteSrc, "partials/footer.html"), "utf8");

// Primary nav. Labels and route paths are deliberately decoupled: the "Clouds"
// label points at the /home route (the wallet view).
const NAV_ITEMS = [
  { key: "about", label: "About", href: "{{BASE}}/about" },
  { key: "collection", label: "Collection", href: "{{BASE}}/collection" },
  { key: "clouds", label: "Clouds", href: "{{BASE}}/home" }
];

function buildNav(active) {
  return NAV_ITEMS.map((item) => {
    const activeAttr = item.key === active ? ' class="active" aria-current="page"' : "";
    return `<a href="${item.href}"${activeAttr}>${item.label}</a>`;
  }).join("\n    ");
}

// Wrap a page body in the shared document chrome. {{BASE}} tokens anywhere in
// the result are resolved to BASE_PATH as the final step.
function renderDoc({ title, description, active = null, extraHead = "", body, scripts = "" }) {
  const header = headerTemplate.replace("{{NAV}}", buildNav(active)).trimEnd();
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
${extraHead}<link rel="stylesheet" href="{{BASE}}/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
</head>
<body>

<div class="wrap">

${header}

<main class="site-main">
${body.trimEnd()}
</main>

${footerTemplate.trimEnd()}

</div>
${scripts ? `${scripts}\n` : ""}</body>
</html>
`;
  return doc.replaceAll("{{BASE}}", BASE_PATH);
}

async function pageBody(name) {
  return readFile(resolve(newsiteSrc, "pages", `${name}.html`), "utf8");
}

const appHead = `<link rel="stylesheet" href="{{BASE}}/styles.css">\n`;

// Prose pages.
await writeFile(resolve(newsiteOut, "index.html"), renderDoc({
  title: "Abnormies",
  description: "A fully on-chain derivative collection paired 1:1 with Normies.",
  active: null,
  body: await pageBody("index")
}));

await writeFile(resolve(newsiteOut, "about.html"), renderDoc({
  title: "About — Abnormies",
  description: "About Abnormies: a constantly evolving on-chain art experiment.",
  active: "about",
  body: await pageBody("about")
}));

await writeFile(resolve(newsiteOut, "collection.html"), renderDoc({
  title: "Collection — Abnormies",
  description: "Browse the full Abnormies collection.",
  active: "collection",
  body: await pageBody("collection")
}));

// App pages: also load the app stylesheet, the runtime config, and their bundle.
await writeFile(resolve(newsiteOut, "home.html"), renderDoc({
  title: "Clouds — Abnormies",
  description: "Your Abnormies holdings.",
  active: "clouds",
  extraHead: appHead,
  body: await pageBody("home"),
  scripts: '<script src="{{BASE}}/config.js"></script>\n<script type="module" src="{{BASE}}/clouds.js"></script>'
}));

await writeFile(resolve(newsiteOut, "abnormie.html"), renderDoc({
  title: "Abnormie — Detail",
  description: "A single revealed Abnormie and its seed Normie.",
  active: null,
  extraHead: appHead,
  body: await pageBody("abnormie"),
  scripts: '<script src="{{BASE}}/config.js"></script>\n<script type="module" src="{{BASE}}/abnormie.js"></script>'
}));

// Spec: keep the existing document and its body intact, inject the shared
// stylesheet, header, and footer. The header sits inside .wrap so it inherits
// the centered column; the spec's own back-link and bespoke footer are swapped
// for the shared chrome.
{
  const sharedHeader = headerTemplate.replace("{{NAV}}", buildNav(null)).trimEnd();
  let spec = await readFile(resolve(repoRoot, "spec.html"), "utf8");
  spec = spec.replace("</head>", '<link rel="stylesheet" href="{{BASE}}/site.css">\n</head>');
  spec = spec.replace(/<a href="index\.html" class="back-link">[^<]*<\/a>/, sharedHeader);
  spec = spec.replace(
    /<hr class="footer-rule">[\s\S]*?<div class="footer">[\s\S]*?<\/div>/,
    footerTemplate.trimEnd()
  );
  await writeFile(resolve(newsiteOut, "spec.html"), spec.replaceAll("{{BASE}}", BASE_PATH));
}
await cp(resolve(repoRoot, "spec.md"), resolve(newsiteOut, "spec.md"));

// Shared stylesheet: prepend the @font-face rule extracted from the app's
// styles.css so Robotastic stays defined in exactly one place.
const stylesCss = await readFile(resolve(publicDir, "styles.css"), "utf8");
const fontFaceMatch = stylesCss.match(/@font-face\s*\{[\s\S]*?\}/);
if (!fontFaceMatch) throw new Error("Could not extract @font-face from styles.css");
const siteCssSrc = await readFile(resolve(newsiteSrc, "site.css"), "utf8");
await writeFile(resolve(newsiteOut, "site.css"), `${fontFaceMatch[0]}\n\n${siteCssSrc}`);

// App assets the home/abnormie pages need at runtime. The bundles are the same
// ones the live /app/ build emits; behavior diverges only via config.js, which
// carries the reorganized routes (abnormieHref, cloudsHref).
await cp(resolve(appOut, "styles.css"), resolve(newsiteOut, "styles.css"));
await cp(resolve(appOut, "clouds.js"), resolve(newsiteOut, "clouds.js"));
await cp(resolve(appOut, "abnormie.js"), resolve(newsiteOut, "abnormie.js"));
await cp(resolve(appOut, "abi/Abnormies.json"), resolve(newsiteOut, "abi/Abnormies.json"));
await cp(resolve(appOut, "abi/Normies.json"), resolve(newsiteOut, "abi/Normies.json"));

const newsiteConfig = {
  ...config,
  abnormieHref: `${BASE_PATH}/abnormie`,
  cloudsHref: `${BASE_PATH}/home`
};
await writeFile(
  resolve(newsiteOut, "config.js"),
  `window.ABNORMIES_CONFIG = ${JSON.stringify(newsiteConfig, null, 2)};\n`
);

console.log(`Built dist/newsitedemo/ with BASE_PATH "${BASE_PATH}".`);

if (!config.contractAddress) {
  console.warn("WARNING: FRONTEND_CONTRACT_ADDRESS is empty. The app will show a config error until rebuilt with it set.");
}
console.log(`Built dist/ for chainId ${chainId} (contract ${config.contractAddress || "unset"}, rpc ${config.rpcUrl || "chain default"}).`);
