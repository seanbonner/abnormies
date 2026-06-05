// Abnormies site build.
//
// Produces the complete static site at app/dist/ — the Cloudflare Pages publish
// root, served at abnormies.art/. The reorganized site (unified header/footer,
// clean URLs, no /app/ folder) is emitted directly at the root: the
// index/about/collection/home/abnormie pages, the rendered spec, the
// viem-bundled wallet scripts, and the static root assets. Old /app/* URLs are
// 301'd to the new clean URLs via _redirects.
//
// Run with the deploy values exported in your shell, e.g.:
//   set -a; source .env; set +a
//   npm run build

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..");
const publicDir = resolve(appRoot, "public");
const newsiteSrc = resolve(appRoot, "newsite");
const dist = resolve(appRoot, "dist");

// Every internal link, asset reference, and runtime route derives from this one
// constant. The site lives at the publish root, so it is empty: links resolve as
// /about, /home, etc. (Set NEWSITE_BASE to re-emit under a subpath if needed.)
const BASE_PATH = process.env.NEWSITE_BASE ?? "";
// Canonical origin for absolute social/canonical URLs.
const ORIGIN = "https://abnormies.art";

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

// Repo-root files shipped verbatim at the publish root. index.html and spec.html
// are NOT here — they are rendered below. _redirects carries the /app/* ->
// clean-URL promotion rules. Explicit allowlist: nothing else from the repo root
// (README.md, CLAUDE.md, .git, app/ source, node_modules) is deployed.
const staticRootFiles = [
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
await mkdir(resolve(dist, "abi"), { recursive: true });

// Bundle the wallet scripts (viem inlined, self-contained, no CDN at runtime).
//   clouds.js   -> /home holdings grid + composite/share controls
//   abnormie.js -> /abnormie detail page
// No mint bundle: minting is closed and there is no mint page.
await esbuild.build({
  entryPoints: [resolve(publicDir, "clouds.js"), resolve(publicDir, "abnormie.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outdir: dist
});

// App stylesheet (wallet bar, panels, detail layout) used by /home and /abnormie.
await cp(resolve(publicDir, "styles.css"), resolve(dist, "styles.css"));

// Slim the vendored Foundry artifact to just its ABI for the runtime fetch; copy
// the Normies ABI the detail page reads.
const artifact = JSON.parse(await readFile(resolve(publicDir, "abi/Abnormies.json"), "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error("public/abi/Abnormies.json has no `abi` array — is it a Foundry artifact?");
}
await writeFile(resolve(dist, "abi/Abnormies.json"), `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`);
await cp(resolve(publicDir, "abi/Normies.json"), resolve(dist, "abi/Normies.json"));

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

// --- Asset contents + cache-busting version --------------------------------
// Cloudflare serves CSS/JS with a multi-hour max-age, so without a versioned
// URL a visitor on an earlier build keeps the stale asset until the cache
// expires. The HTML is always revalidated, so referencing each asset as
// <name>?v=<hash> means any change to an asset produces a new URL the browser
// has to fetch — updates land immediately, no hard reload needed.
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

const cloudsBundle = await readFile(resolve(dist, "clouds.js"), "utf8");
const abnormieBundle = await readFile(resolve(dist, "abnormie.js"), "utf8");

const BUILDID = createHash("sha256")
  .update(siteCssContent)
  .update(stylesCssSrc)
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

// Prose pages.
await writeFile(resolve(dist, "index.html"), renderDoc({
  title: "Abnormies",
  description: "A fully on-chain derivative collection paired 1:1 with Normies.",
  path: "",
  active: null,
  body: await pageBody("index")
}));

await writeFile(resolve(dist, "about.html"), renderDoc({
  title: "About — Abnormies",
  description: "About Abnormies: a constantly evolving on-chain art experiment.",
  path: "about",
  active: "about",
  body: await pageBody("about")
}));

await writeFile(resolve(dist, "collection.html"), renderDoc({
  title: "Collection — Abnormies",
  description: "Browse the full Abnormies collection.",
  path: "collection",
  active: "collection",
  body: await pageBody("collection")
}));

// App pages: also load the app stylesheet, the runtime config, and their bundle.
await writeFile(resolve(dist, "home.html"), renderDoc({
  title: "My Abnormies",
  description: "Your Abnormies holdings.",
  path: "home",
  active: "login",
  extraHead: appHead,
  body: await pageBody("home"),
  scripts: `<script src="{{BASE}}/config.js${V}"></script>\n<script type="module" src="{{BASE}}/clouds.js${V}"></script>`
}));

await writeFile(resolve(dist, "abnormie.html"), renderDoc({
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
  await writeFile(resolve(dist, "spec.html"), spec.replaceAll("{{BASE}}", BASE_PATH));
}

// Shared stylesheet (the @font-face rule is prepended from styles.css so
// Robotastic stays defined in exactly one place) and the runtime config.
await writeFile(resolve(dist, "site.css"), siteCssContent);
await writeFile(resolve(dist, "config.js"), configContent);

// Static repo-root files shipped verbatim (favicons, og.png, spec.md, robots,
// llms, _headers, _redirects). Rendered index.html/spec.html are not overwritten.
for (const file of staticRootFiles) {
  await cp(resolve(repoRoot, file), resolve(dist, file));
}

console.log(`Built dist/ at BASE_PATH "${BASE_PATH || "/"}" (assets ?v=${BUILDID}).`);

if (!config.contractAddress) {
  console.warn("WARNING: FRONTEND_CONTRACT_ADDRESS is empty. The app will show a config error until rebuilt with it set.");
}
console.log(`Chain ${chainId} (contract ${config.contractAddress || "unset"}, rpc ${config.rpcUrl || "chain default"}).`);
