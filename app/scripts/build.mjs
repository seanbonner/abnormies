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
import { createHash } from "node:crypto";
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
// Canonical origin for absolute social/canonical URLs. Combined with BASE_PATH
// so og:url stays correct both under /newsitedemo and after promotion to root.
const ORIGIN = "https://abnormies.art";

const newsiteSrc = resolve(appRoot, "newsite");
const newsiteOut = resolve(dist, "newsitedemo");
await mkdir(resolve(newsiteOut, "abi"), { recursive: true });

const headerTemplate = await readFile(resolve(newsiteSrc, "partials/header.html"), "utf8");
const footerTemplate = await readFile(resolve(newsiteSrc, "partials/footer.html"), "utf8");

// Primary nav. Labels and route paths are deliberately decoupled: the "Login"
// label points at the /home route (the wallet view). The login item is marked
// with data-nav-login so the shared header script can swap its label to
// "My Abnormies" when a wallet is connected.
const NAV_ITEMS = [
  { key: "about", label: "About", href: "{{BASE}}/about" },
  { key: "collection", label: "Collection", href: "{{BASE}}/collection" },
  { key: "login", label: "Login", href: "{{BASE}}/home", login: true }
];

function buildNav(active) {
  return NAV_ITEMS.map((item) => {
    const attrs = [];
    if (item.key === active) attrs.push('class="active"', 'aria-current="page"');
    if (item.login) attrs.push("data-nav-login");
    const a = attrs.length ? ` ${attrs.join(" ")}` : "";
    return `<a href="${item.href}"${a}>${item.label}</a>`;
  }).join("\n    ");
}

// Shared header script, injected on every page. Swaps the Login nav label to
// "My Abnormies" based on the existing injected-wallet connection state — it
// reads eth_accounts (no prompt), listens to accountsChanged, and to the
// abnormies:wallet event the /home script dispatches. No new state store.
const HEADER_SCRIPT = `<script>
(function () {
  var el = document.querySelector("[data-nav-login]");
  if (!el) return;
  function set(connected) { el.textContent = connected ? "My Abnormies" : "Login"; }
  var eth = window.ethereum;
  if (eth && eth.request) {
    eth.request({ method: "eth_accounts" })
      .then(function (a) { set(!!(a && a.length)); })
      .catch(function () {});
    if (eth.on) eth.on("accountsChanged", function (a) { set(!!(a && a.length)); });
  }
  window.addEventListener("abnormies:wallet", function (e) {
    set(!!(e.detail && e.detail.connected));
  });
})();
</script>`;

// Wrap a page body in the shared document chrome. {{BASE}} tokens anywhere in
// the result are resolved to BASE_PATH as the final step.
function renderDoc({ title, description, path = "", active = null, extraHead = "", body, scripts = "" }) {
  const header = headerTemplate.replace("{{NAV}}", buildNav(active)).trimEnd();
  // Social card: title + image only. No description tag, by request — the old
  // social copy carried launch/minting language that no longer applies.
  const og = `<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}{{BASE}}/${path}">
<meta property="og:title" content="${title}">
<meta property="og:image" content="${ORIGIN}/og.png${ogV}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${ORIGIN}/og.png${ogV}">`;
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
${og}
${extraHead}<link rel="stylesheet" href="{{BASE}}/site.css${V}">
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
${HEADER_SCRIPT}
${scripts ? `${scripts}\n` : ""}</body>
</html>
`;
  return doc.replaceAll("{{BASE}}", BASE_PATH);
}

async function pageBody(name) {
  return readFile(resolve(newsiteSrc, "pages", `${name}.html`), "utf8");
}

// --- Asset contents + cache-busting version --------------------------------
// Cloudflare serves CSS/JS with a multi-hour max-age, so without a versioned
// URL a reviewer who visited an earlier build keeps the stale asset until the
// cache expires. The HTML is always revalidated, so referencing each asset as
// <name>?v=<hash> means any change to an asset produces a new URL the browser
// has to fetch — updates land immediately, no hard reload needed. The version
// is a content hash of every cache-sensitive asset, so it only changes when one
// of them changes.
const stylesCssSrc = await readFile(resolve(publicDir, "styles.css"), "utf8");
const fontFaceMatch = stylesCssSrc.match(/@font-face\s*\{[\s\S]*?\}/);
if (!fontFaceMatch) throw new Error("Could not extract @font-face from styles.css");
const siteCssContent = `${fontFaceMatch[0]}\n\n${await readFile(resolve(newsiteSrc, "site.css"), "utf8")}`;

const newsiteConfig = {
  ...config,
  abnormieHref: `${BASE_PATH}/abnormie`,
  cloudsHref: `${BASE_PATH}/home`,
  cloudsLabel: "My Abnormies"
};
const configContent = `window.ABNORMIES_CONFIG = ${JSON.stringify(newsiteConfig, null, 2)};\n`;

const appStylesContent = await readFile(resolve(appOut, "styles.css"), "utf8");
const cloudsBundle = await readFile(resolve(appOut, "clouds.js"), "utf8");
const abnormieBundle = await readFile(resolve(appOut, "abnormie.js"), "utf8");

const BUILDID = createHash("sha256")
  .update(siteCssContent)
  .update(appStylesContent)
  .update(cloudsBundle)
  .update(abnormieBundle)
  .update(configContent)
  .digest("hex")
  .slice(0, 10);
const V = `?v=${BUILDID}`;

// Separate version for the social image: X / Discord cache og:image by URL, so
// a content-hashed query makes the new card pull through. Kept distinct from V
// so a CSS/JS change doesn't needlessly invalidate the cached social image.
const ogV = `?v=${createHash("sha256").update(await readFile(resolve(repoRoot, "og.png"))).digest("hex").slice(0, 10)}`;

const appHead = `<link rel="stylesheet" href="{{BASE}}/styles.css${V}">\n`;

// Prose pages.
await writeFile(resolve(newsiteOut, "index.html"), renderDoc({
  title: "Abnormies",
  description: "A fully on-chain derivative collection paired 1:1 with Normies.",
  path: "",
  active: null,
  body: await pageBody("index")
}));

await writeFile(resolve(newsiteOut, "about.html"), renderDoc({
  title: "About — Abnormies",
  description: "About Abnormies: a constantly evolving on-chain art experiment.",
  path: "about",
  active: "about",
  body: await pageBody("about")
}));

await writeFile(resolve(newsiteOut, "collection.html"), renderDoc({
  title: "Collection — Abnormies",
  description: "Browse the full Abnormies collection.",
  path: "collection",
  active: "collection",
  body: await pageBody("collection")
}));

// App pages: also load the app stylesheet, the runtime config, and their bundle.
await writeFile(resolve(newsiteOut, "home.html"), renderDoc({
  title: "My Abnormies",
  description: "Your Abnormies holdings.",
  path: "home",
  active: "login",
  extraHead: appHead,
  body: await pageBody("home"),
  scripts: `<script src="{{BASE}}/config.js${V}"></script>\n<script type="module" src="{{BASE}}/clouds.js${V}"></script>`
}));

await writeFile(resolve(newsiteOut, "abnormie.html"), renderDoc({
  title: "Abnormie — Detail",
  description: "A single revealed Abnormie and its seed Normie.",
  path: "abnormie",
  active: null,
  extraHead: appHead,
  body: await pageBody("abnormie"),
  scripts: `<script src="{{BASE}}/config.js${V}"></script>\n<script type="module" src="{{BASE}}/abnormie.js${V}"></script>`
}));

// Spec: keep the existing document and its body intact, inject the shared
// stylesheet, header, and footer. The header sits inside .wrap so it inherits
// the centered column; the spec's own back-link and bespoke footer are swapped
// for the shared chrome.
{
  const sharedHeader = headerTemplate.replace("{{NAV}}", buildNav(null)).trimEnd();
  const specOg = `<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}{{BASE}}/spec.html">
<meta property="og:title" content="Abnormies — Specification">
<meta property="og:image" content="${ORIGIN}/og.png${ogV}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Abnormies — Specification">
<meta name="twitter:image" content="${ORIGIN}/og.png${ogV}">`;
  let spec = await readFile(resolve(repoRoot, "spec.html"), "utf8");
  spec = spec.replace("</head>", `${specOg}\n<link rel="stylesheet" href="{{BASE}}/site.css${V}">\n</head>`);
  spec = spec.replace(/<a href="index\.html" class="back-link">[^<]*<\/a>/, sharedHeader);
  spec = spec.replace(
    /<hr class="footer-rule">[\s\S]*?<div class="footer">[\s\S]*?<\/div>/,
    footerTemplate.trimEnd()
  );
  await writeFile(resolve(newsiteOut, "spec.html"), spec.replaceAll("{{BASE}}", BASE_PATH));
}
await cp(resolve(repoRoot, "spec.md"), resolve(newsiteOut, "spec.md"));

// Write the cache-busted assets. Contents were produced above so the version
// hash could be computed before the pages were rendered. The shared stylesheet
// carries the @font-face rule extracted from styles.css, so Robotastic stays
// defined in exactly one place.
await writeFile(resolve(newsiteOut, "site.css"), siteCssContent);
await writeFile(resolve(newsiteOut, "config.js"), configContent);

// App assets the home/abnormie pages need at runtime. The bundles are the same
// ones the live /app/ build emits; behavior diverges only via config.js, which
// carries the reorganized routes (abnormieHref, cloudsHref).
await cp(resolve(appOut, "styles.css"), resolve(newsiteOut, "styles.css"));
await cp(resolve(appOut, "clouds.js"), resolve(newsiteOut, "clouds.js"));
await cp(resolve(appOut, "abnormie.js"), resolve(newsiteOut, "abnormie.js"));
await cp(resolve(appOut, "abi/Abnormies.json"), resolve(newsiteOut, "abi/Abnormies.json"));
await cp(resolve(appOut, "abi/Normies.json"), resolve(newsiteOut, "abi/Normies.json"));

console.log(`Built dist/newsitedemo/ with BASE_PATH "${BASE_PATH}" (assets ?v=${BUILDID}).`);

if (!config.contractAddress) {
  console.warn("WARNING: FRONTEND_CONTRACT_ADDRESS is empty. The app will show a config error until rebuilt with it set.");
}
console.log(`Built dist/ for chainId ${chainId} (contract ${config.contractAddress || "unset"}, rpc ${config.rpcUrl || "chain default"}).`);
