// Abnormies Clouds page — shows the connected wallet's holdings and nothing
// else (no claim, mint, seal, or reveal UI). Reuses the same receipts-loading
// shape as main.js but lives in its own file so this page stays scoped to
// holdings rendering.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  getAddress,
  getContract
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { getHoldings } from "./holdings.js";

const cfg = window.ABNORMIES_CONFIG || {};
const CHAINS = { 1: mainnet, 11155111: sepolia };
const CHAIN_NAMES = { 1: "Ethereum Mainnet", 11155111: "Sepolia" };
const expectedChainId = Number(cfg.chainId || 1);
const chain = CHAINS[expectedChainId] || mainnet;
const contractAddress = cfg.contractAddress;

let abi = null;
let publicClient = null;
let reader = null;
let walletClient = null;
let account = null;
let walletChainId = null;
let listenersAttached = false;

// --- Grid view state + shared-composite mode -------------------------------
// These features are driven by controls that exist only on the reorganized
// site's /home page. On the legacy /app/clouds.html page (no #grid-controls)
// applyGridLayout() no-ops, so that page's behavior is unchanged.
const ALLOWED_COLS = [1, 2, 3, 4, 5, 6, 8, 10];
const _params = new URLSearchParams(window.location.search);
const _idsParam = _params.get("ids");
// Shared-composite mode: an explicit, wallet-independent set of token IDs to
// render (ascending). Present only when the URL carries ?ids=...
const sharedIds = _idsParam
  ? _idsParam
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0)
  : null;
const clampCols = (n) => (ALLOWED_COLS.includes(n) ? n : null);
let gridCols = clampCols(parseInt(_params.get("cols"), 10)) || 5;
let gridComposite = _params.get("composite") === "1";
let displayedIds = []; // resolved token IDs in current display order (ascending)

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function showBanner(kind, msg) {
  const b = $("banner");
  b.className = `banner banner-${kind}`;
  b.textContent = msg;
  b.hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}

// Sky-colored stand-in for unrevealed Abnormies (matches main.js).
function skyThumb(className) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Unrevealed Abnormie");
  if (className) svg.setAttribute("class", className);
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "40");
  rect.setAttribute("height", "40");
  rect.setAttribute("fill", "#e3e5e4");
  svg.appendChild(rect);
  return svg;
}

// Decode an on-chain tokenURI (data:application/json...) -> image data URI.
function parseTokenURIImage(uri) {
  const comma = uri.indexOf(",");
  const meta = uri.slice(5, comma);
  let body = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    body = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } else {
    try {
      body = decodeURIComponent(body);
    } catch {
      /* raw JSON */
    }
  }
  return JSON.parse(body).image;
}

function makeReceiptCell({ resolved, abnormieId, image }) {
  const labelText = resolved ? `Abnormie #${abnormieId}` : "[unrevealed]";
  const cell = document.createElement(resolved ? "a" : "div");
  cell.className = "receipt-cell";
  if (resolved) cell.href = `${cfg.abnormieHref || "/app/abnormie.html"}?id=${abnormieId}`;
  if (resolved && image) {
    const img = document.createElement("img");
    img.className = "receipt-thumb";
    img.src = image;
    img.alt = labelText;
    img.loading = "lazy";
    cell.appendChild(img);
  } else {
    cell.appendChild(skyThumb("receipt-thumb"));
  }
  const label = document.createElement("span");
  label.className = "receipt-label";
  label.textContent = labelText;
  cell.appendChild(label);
  return cell;
}

// ---------------------------------------------------------------------------
// Grid layout + controls (reorganized /home only)
// ---------------------------------------------------------------------------
function applyGridLayout() {
  const listEl = $("receipts-list");
  // Scope the column/composite overrides to the page that actually has the
  // controls. The legacy clouds page keeps its CSS-driven (and responsive) grid.
  if (!listEl || !$("grid-controls")) return;
  // Set the column count as a CSS custom property rather than an inline
  // grid-template-columns, so the site.css mobile media query can cap the
  // rendered columns at 3 under 600px while the selector keeps the user's value.
  listEl.style.setProperty("--abn-cols", String(gridCols));
  listEl.classList.toggle("composite", gridComposite);
}

function buildShareUrl() {
  const path = cfg.cloudsHref || window.location.pathname;
  const qs = new URLSearchParams();
  qs.set("ids", displayedIds.join(","));
  qs.set("cols", String(gridCols));
  qs.set("composite", gridComposite ? "1" : "0");
  return `${window.location.origin}${path}?${qs.toString()}`;
}

let shareResetTimer = null;
async function copyShareUrl() {
  const btn = $("share-btn");
  const url = buildShareUrl();
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    // Fallback for non-secure contexts where the Clipboard API is unavailable.
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  // Brief visual confirmation: flip the button label, restore it after 2s.
  if (btn) {
    btn.textContent = ok ? "Copied" : "Copy failed";
    if (shareResetTimer) clearTimeout(shareResetTimer);
    shareResetTimer = setTimeout(() => {
      btn.textContent = "Share";
    }, 2000);
  }
}

function wireGridControls() {
  const colsSel = $("cols-select");
  const compToggle = $("composite-toggle");
  const shareBtn = $("share-btn");
  if (colsSel) {
    colsSel.value = String(gridCols);
    colsSel.addEventListener("change", () => {
      const n = clampCols(parseInt(colsSel.value, 10));
      if (n) {
        gridCols = n;
        applyGridLayout();
      }
    });
  }
  if (compToggle) {
    compToggle.checked = gridComposite;
    compToggle.addEventListener("change", () => {
      gridComposite = compToggle.checked;
      applyGridLayout();
    });
  }
  if (shareBtn) shareBtn.addEventListener("click", copyShareUrl);
}

// Tell the shared header script when the wallet connection state changes, so it
// can swap the "Login" nav label to "My Abnormies". Reuses the existing
// injected-wallet flow; no separate state store.
function notifyWallet(connected) {
  try {
    window.dispatchEvent(new CustomEvent("abnormies:wallet", { detail: { connected } }));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Init / wallet
// ---------------------------------------------------------------------------
async function init() {
  $("connect-btn").addEventListener("click", connect);
  $("refresh-btn").addEventListener("click", refreshAll);
  wireGridControls();

  if (!contractAddress || !isAddress(contractAddress)) {
    showBanner("error", "No contract address configured. Set FRONTEND_CONTRACT_ADDRESS and rebuild.");
    return;
  }

  try {
    const res = await fetch("./abi/Abnormies.json");
    abi = (await res.json()).abi;
  } catch {
    showBanner("error", "Failed to load contract ABI.");
    return;
  }

  publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl || undefined) });
  reader = getContract({ address: contractAddress, abi, client: publicClient });

  if (window.ethereum) {
    try {
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (accs && accs.length) await setupWallet(accs[0]);
    } catch {
      /* ignore */
    }
  }

  await refreshAll();
}

async function connect() {
  if (!window.ethereum) {
    showBanner("error", "No injected wallet found. Install a browser wallet to view your Clouds.");
    return;
  }
  try {
    const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
    await setupWallet(accs[0]);
    await refreshAll();
  } catch (e) {
    showBanner("error", `Connection rejected: ${e.shortMessage || e.message || e}`);
  }
}

async function setupWallet(addr) {
  account = getAddress(addr);
  walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
  await refreshWalletChain();
  attachListeners();
  $("connect-btn").textContent = "Reconnect";
  notifyWallet(true);
}

async function refreshWalletChain() {
  try {
    const hex = await window.ethereum.request({ method: "eth_chainId" });
    walletChainId = parseInt(hex, 16);
  } catch {
    walletChainId = null;
  }
}

function attachListeners() {
  if (listenersAttached || !window.ethereum) return;
  listenersAttached = true;
  window.ethereum.on?.("accountsChanged", async (accs) => {
    if (!accs || !accs.length) {
      account = null;
      walletClient = null;
      $("connect-btn").textContent = "Connect";
      notifyWallet(false);
    } else {
      account = getAddress(accs[0]);
      walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
      notifyWallet(true);
    }
    await refreshAll();
  });
  window.ethereum.on?.("chainChanged", async () => {
    await refreshWalletChain();
    await refreshAll();
  });
}

function renderWalletBar() {
  hideBanner();
  $("wallet-address").textContent = account ? short(account) : "Not connected";
  if (account && walletChainId != null && walletChainId !== expectedChainId) {
    showBanner("warn", "Wrong network. Switch your wallet to Ethereum to continue.");
  }
}

async function refreshAll() {
  renderWalletBar();
  // Shared-composite mode renders the URL's token IDs and needs no wallet.
  if (sharedIds) {
    await loadSharedComposite();
  } else {
    await loadReceipts();
  }
}

// ---------------------------------------------------------------------------
// Shared-composite mode — render an explicit set of token IDs from the URL,
// ascending, with no wallet connection required. Independent of whoever is
// (or isn't) connected in the current browser.
// ---------------------------------------------------------------------------
async function loadSharedComposite() {
  const section = $("receipts-section");
  const listEl = $("receipts-list");
  const empty = $("receipts-empty");
  section.hidden = false;

  const ids = [...new Set(sharedIds)].sort((a, b) => a - b);
  displayedIds = ids;

  if (ids.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No Abnormies in this composite.";
    applyGridLayout();
    return;
  }

  listEl.innerHTML = "<div class='loading'>Loading Abnormies…</div>";
  empty.hidden = true;

  const images = {};
  const calls = ids.map((id) => ({
    address: contractAddress,
    abi,
    functionName: "tokenURI",
    args: [BigInt(id)]
  }));
  let uriResults;
  try {
    uriResults = await publicClient.multicall({ contracts: calls });
  } catch {
    uriResults = ids.map(() => ({ status: "failure" }));
  }
  uriResults.forEach((r, k) => {
    if (r.status !== "success") return;
    try {
      images[ids[k]] = parseTokenURIImage(r.result);
    } catch {
      /* fall back to Sky stand-in */
    }
  });

  listEl.innerHTML = "";
  for (const id of ids) {
    listEl.appendChild(makeReceiptCell({ resolved: true, abnormieId: id, image: images[id] }));
  }
  applyGridLayout();
}

// ---------------------------------------------------------------------------
// Holdings — sourced from the shared getHoldings() helper, which unions
// (a) RESOLVED tokens currently owned per ERC-721 Transfer events — catches
// secondary-market moves like OpenSea purchases — with (b) UNRESOLVED claims
// recorded against the wallet's address as claimant.
// ---------------------------------------------------------------------------
async function loadReceipts() {
  const section = $("receipts-section");
  const listEl = $("receipts-list");
  const empty = $("receipts-empty");

  if (!account) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  listEl.innerHTML = "<div class='loading'>Loading Abnormies…</div>";
  empty.hidden = true;

  let owned;
  try {
    owned = await getHoldings(account, { address: contractAddress, abi }, publicClient);
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not load Abnormies.";
    return;
  }

  if (owned.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    displayedIds = [];
    return;
  }

  // Fetch images for resolved holdings in one multicall.
  const resolvedIds = owned.filter((o) => o.resolved).map((o) => o.abnormieId);
  const images = {};
  if (resolvedIds.length) {
    const calls = resolvedIds.map((id) => ({
      address: contractAddress,
      abi,
      functionName: "tokenURI",
      args: [BigInt(id)]
    }));
    let uriResults;
    try {
      uriResults = await publicClient.multicall({ contracts: calls });
    } catch {
      uriResults = resolvedIds.map(() => ({ status: "failure" }));
    }
    uriResults.forEach((r, k) => {
      if (r.status !== "success") return;
      try {
        images[resolvedIds[k]] = parseTokenURIImage(r.result);
      } catch {
        /* fall back to Sky stand-in */
      }
    });
  }

  listEl.innerHTML = "";
  for (const o of owned) {
    listEl.appendChild(
      makeReceiptCell({ resolved: o.resolved, abnormieId: o.abnormieId, image: images[o.abnormieId] })
    );
  }
  // Resolved token IDs (ascending) are what a Share URL can encode; unresolved
  // holdings have no token ID yet and are omitted from the shareable set.
  displayedIds = resolvedIds;
  applyGridLayout();
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showBanner("error", e.message || String(e)));
});
