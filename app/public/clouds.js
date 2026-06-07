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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Minimal ABIs for the upstream Normies contracts — only the reads the
// staleness diff needs. The contract addresses are resolved at runtime from the
// Abnormies contract (NORMIES() / NORMIES_CANVAS_STORAGE()) so they track the
// configured deployment rather than being hardcoded here.
const NORMIES_ABI = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view"
  }
];
const CANVAS_STORAGE_ABI = [
  {
    type: "function",
    name: "isTransformed",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view"
  }
];

let abi = null;
let publicClient = null;
let reader = null;
let walletClient = null;
let account = null;
let walletChainId = null;
let listenersAttached = false;

// Resolved upstream addresses for the staleness diff. Null until init resolves
// them; if resolution fails the resync banner simply never shows.
let normiesAddress = null;
let canvasStorageAddress = null;
// Seed Normie IDs behind the wallet's resolved holdings that have upstream
// activity not yet reflected on-chain. Populated by refreshStaleBanner().
let staleSeedIds = [];
let resyncInFlight = false;

// --- Grid view state + shared-composite mode -------------------------------
// These features are driven by controls that exist only on the reorganized
// site's /home page. On the legacy /app/clouds.html page (no #grid-controls)
// applyView() / applyGridLayout() no-op, so that page's behavior is unchanged.
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
let displayedIds = []; // resolved token IDs in current display order (ascending)

// Three-way view selector: "grid" (default), "composite", "animated". Replaces
// the old boolean composite toggle; legacy ?composite=1 links still resolve to
// the composite view.
const ALLOWED_VIEWS = ["grid", "composite", "animated"];
function readInitialView() {
  const v = _params.get("view");
  if (ALLOWED_VIEWS.includes(v)) return v;
  if (_params.get("composite") === "1") return "composite";
  return "grid";
}
let gridView = readInitialView();

// Animated sub-controls (only meaningful when gridView === "animated").
const ALLOWED_ANIM_TYPES = ["random", "snake", "single"];
const ALLOWED_ANIM_SPEEDS = ["slow", "medium", "fast"];
let animType = ALLOWED_ANIM_TYPES.includes(_params.get("type")) ? _params.get("type") : "random";
let animSpeed = ALLOWED_ANIM_SPEEDS.includes(_params.get("speed")) ? _params.get("speed") : "fast";

// Speed presets shared across all three animated sub-modes. Slow crossfades
// (1500ms) with a per-tile random stagger (0 to 1800ms); Medium and Fast hard
// cut with no stagger.
const SPEED_PRESETS = {
  slow: { tick: 2500, crossfade: true, stagger: 1800 },
  medium: { tick: 600, crossfade: false, stagger: 0 },
  fast: { tick: 50, crossfade: false, stagger: 0 }
};

// Rendered tiles for the current data set, token ID ascending then unresolved,
// matching Composite static order. Each: { id, resolved, image }.
let tiles = [];

// Animation runtime state.
let animTimer = null;     // setInterval handle for the tick loop
let animCellTimers = [];  // pending per-tile stagger setTimeouts (Slow only)
let animOrder = [];       // grid-position index -> tile index (Random/Snake)
let animCells = [];       // .anim-cell DOM nodes in grid order
let animActiveLayer = []; // per-cell index of the currently visible layer (0|1)
let singlePerm = [];      // random permutation of tile indices (Single)
let singlePos = 0;        // cursor into singlePerm (Single)

// Fisher-Yates in place.
function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

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

// Set the holdings note to reflect the wallet's count. Only present on the
// /home page (the element carries id="holdings-note"); a no-op elsewhere. A
// zero count restores the generic prompt.
const DEFAULT_HOLDINGS_NOTE = "Click any Abnormie to see its detail page.";
function setHoldingsNote(count) {
  const note = $("holdings-note");
  if (!note) return;
  note.textContent =
    count > 0
      ? `You own ${count} ${count === 1 ? "Abnormie" : "Abnormies"}. Click any one to see its detail page.`
      : DEFAULT_HOLDINGS_NOTE;
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
  // The static list reads as a composite (gutterless, label-free) only in the
  // Composite view; Grid keeps the default gapped layout.
  listEl.classList.toggle("composite", gridView === "composite");
}

// ---------------------------------------------------------------------------
// View switching (reorganized /home only)
// ---------------------------------------------------------------------------
// Reflect the current view: show the right container, toggle the animated
// sub-controls, and start or stop the animation. Safe to call repeatedly.
function applyView() {
  const listEl = $("receipts-list");
  const stage = $("animated-stage");
  // Legacy clouds page (no controls): leave its CSS-driven grid untouched.
  if (!listEl || !$("grid-controls")) return;

  applyGridLayout();

  const animated = gridView === "animated";
  const typeCtl = $("type-control");
  const speedCtl = $("speed-control");
  if (typeCtl) typeCtl.hidden = !animated;
  if (speedCtl) speedCtl.hidden = !animated;

  if (!animated) {
    stopAnimation();
    if (stage) stage.hidden = true;
    listEl.hidden = false;
    return;
  }

  // Animated view: hide the static list, show the stage, (re)build and run.
  // With no tiles (still loading or empty holdings) keep the square collapsed.
  listEl.hidden = true;
  if (stage) stage.hidden = tiles.length === 0;
  startAnimation();
}

// ---------------------------------------------------------------------------
// Animation engine. All sub-modes start on load, loop indefinitely, and have
// no stop toggle. No on-chain state is refreshed during animation.
// ---------------------------------------------------------------------------
function stopAnimation() {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  for (const t of animCellTimers) clearTimeout(t);
  animCellTimers = [];
}

function startAnimation() {
  stopAnimation();
  const stage = $("animated-stage");
  if (!stage) return;
  // Nothing to animate yet (data still loading or empty holdings).
  if (!tiles.length) {
    stage.replaceChildren();
    return;
  }
  const preset = SPEED_PRESETS[animSpeed] || SPEED_PRESETS.slow;
  // The 1500ms opacity transition is gated by this class so Medium/Fast hard cut.
  stage.classList.toggle("crossfade", preset.crossfade);

  if (animType === "single") {
    buildSingleStage();
  } else {
    buildGridStage();
  }

  // The starting frame (built above) holds for one interval, then the loop runs
  // forever at the preset tick.
  animTimer = setInterval(() => tick(preset), preset.tick);
}

// Build the visual content for an animated tile: the same render Composite uses
// (the token image, or the Sky stand-in for an unrevealed holding). Animated
// tiles are purely visual: no anchor, no label, not clickable.
function makeTileContent(tile) {
  if (tile && tile.resolved && tile.image) {
    const img = document.createElement("img");
    img.className = "anim-thumb";
    img.src = tile.image;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    return img;
  }
  return skyThumb("anim-thumb");
}

// Two stacked layers per cell so a content change can crossfade: set the
// incoming layer first, then flip .visible (Slow). Medium/Fast carry no
// transition, so the visible layer is just repainted in place.
function makeCell(extraClass) {
  const cell = document.createElement("div");
  cell.className = extraClass ? `anim-cell ${extraClass}` : "anim-cell";
  cell.appendChild(Object.assign(document.createElement("div"), { className: "anim-layer" }));
  cell.appendChild(Object.assign(document.createElement("div"), { className: "anim-layer" }));
  return cell;
}

// Paint a cell's starting frame instantly into layer 0 (no crossfade/stagger).
function paintCellInstant(cellIndex, tileIndex) {
  const layers = animCells[cellIndex].children;
  layers[0].replaceChildren(makeTileContent(tiles[tileIndex]));
  layers[0].classList.add("visible");
  layers[1].classList.remove("visible");
  layers[1].replaceChildren();
  animActiveLayer[cellIndex] = 0;
}

// Paint a cell during a tick. Slow: set the inactive layer's content, then flip
// visibility so the old layer fades out as the new fades in. Medium/Fast: hard
// cut by repainting the visible layer in place.
function paintCell(cellIndex, tileIndex, preset) {
  const layers = animCells[cellIndex].children;
  if (preset.crossfade) {
    const activeIdx = animActiveLayer[cellIndex];
    const inactiveIdx = activeIdx === 0 ? 1 : 0;
    layers[inactiveIdx].replaceChildren(makeTileContent(tiles[tileIndex]));
    layers[inactiveIdx].classList.add("visible");
    layers[activeIdx].classList.remove("visible");
    animActiveLayer[cellIndex] = inactiveIdx;
  } else {
    layers[animActiveLayer[cellIndex]].replaceChildren(makeTileContent(tiles[tileIndex]));
  }
}

function buildGridStage() {
  const stage = $("animated-stage");
  const grid = document.createElement("div");
  grid.className = "anim-grid";
  grid.style.setProperty("--abn-cols", String(gridCols));
  animCells = [];
  animActiveLayer = [];
  for (let i = 0; i < tiles.length; i++) {
    const cell = makeCell();
    grid.appendChild(cell);
    animCells.push(cell);
    animActiveLayer.push(0);
  }
  stage.replaceChildren(grid);
  // Initial order: identity (token ID ascending, matching Composite static).
  animOrder = tiles.map((_, i) => i);
  for (let i = 0; i < animCells.length; i++) paintCellInstant(i, animOrder[i]);
}

function buildSingleStage() {
  const stage = $("animated-stage");
  const cell = makeCell("anim-single");
  stage.replaceChildren(cell);
  animCells = [cell];
  animActiveLayer = [0];
  singlePerm = tiles.map((_, i) => i);
  fisherYates(singlePerm);
  singlePos = 0;
  paintCellInstant(0, singlePerm[0]);
}

function tick(preset) {
  if (!tiles.length) return;
  if (animType === "single") {
    tickSingle(preset);
    return;
  }
  if (animType === "random") {
    fisherYates(animOrder);
  } else {
    // Snake: pop the last element of the order array, unshift it to index 0.
    animOrder.unshift(animOrder.pop());
  }
  scheduleRepaint(preset);
}

// Repaint every grid cell from animOrder. Slow staggers each cell's swap by a
// fresh random 0 to 1800ms; Medium/Fast repaint synchronously. Pending stagger
// timers from the previous tick are cleared first (1800ms < the 2500ms Slow
// tick, so they normally settle anyway).
function scheduleRepaint(preset) {
  for (const t of animCellTimers) clearTimeout(t);
  animCellTimers = [];
  for (let i = 0; i < animCells.length; i++) {
    const cellIndex = i;
    const tileIndex = animOrder[i];
    if (preset.stagger > 0) {
      animCellTimers.push(
        setTimeout(() => paintCell(cellIndex, tileIndex, preset), Math.random() * preset.stagger)
      );
    } else {
      paintCell(cellIndex, tileIndex, preset);
    }
  }
}

// Single: advance to the next index in the random permutation; when exhausted,
// generate a fresh permutation and continue.
function tickSingle(preset) {
  singlePos += 1;
  if (singlePos >= singlePerm.length) {
    singlePerm = tiles.map((_, i) => i);
    fisherYates(singlePerm);
    singlePos = 0;
  }
  const tileIndex = singlePerm[singlePos];
  if (preset.stagger > 0) {
    for (const t of animCellTimers) clearTimeout(t);
    animCellTimers = [];
    animCellTimers.push(
      setTimeout(() => paintCell(0, tileIndex, preset), Math.random() * preset.stagger)
    );
  } else {
    paintCell(0, tileIndex, preset);
  }
}

function buildShareUrl() {
  const path = cfg.cloudsHref || window.location.pathname;
  const qs = new URLSearchParams();
  qs.set("ids", displayedIds.join(","));
  qs.set("cols", String(gridCols));
  qs.set("view", gridView);
  // Type and speed only matter for the animated view; omit them otherwise so
  // shared grid/composite URLs stay minimal.
  if (gridView === "animated") {
    qs.set("type", animType);
    qs.set("speed", animSpeed);
  }
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
  const viewSel = $("view-select");
  const typeSel = $("type-select");
  const speedSel = $("speed-select");
  const shareBtn = $("share-btn");
  if (colsSel) {
    colsSel.value = String(gridCols);
    colsSel.addEventListener("change", () => {
      const n = clampCols(parseInt(colsSel.value, 10));
      if (n) {
        gridCols = n;
        // Columns drive the static grid and the Random/Snake animated grids.
        applyView();
      }
    });
  }
  if (viewSel) {
    viewSel.value = gridView;
    viewSel.addEventListener("change", () => {
      gridView = ALLOWED_VIEWS.includes(viewSel.value) ? viewSel.value : "grid";
      applyView();
    });
  }
  if (typeSel) {
    typeSel.value = animType;
    typeSel.addEventListener("change", () => {
      animType = ALLOWED_ANIM_TYPES.includes(typeSel.value) ? typeSel.value : "random";
      if (gridView === "animated") startAnimation();
    });
  }
  if (speedSel) {
    speedSel.value = animSpeed;
    speedSel.addEventListener("change", () => {
      animSpeed = ALLOWED_ANIM_SPEEDS.includes(speedSel.value) ? speedSel.value : "fast";
      if (gridView === "animated") startAnimation();
    });
  }
  if (shareBtn) shareBtn.addEventListener("click", copyShareUrl);
  // Reflect the initial view (also toggles the animated sub-controls' visibility).
  applyView();
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
  const resyncBtn = $("resync-btn");
  if (resyncBtn) resyncBtn.addEventListener("click", onResync);
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

  // Resolve the upstream Normies contract addresses once, for the staleness
  // diff. Non-fatal: if this fails the resync banner just never appears.
  try {
    normiesAddress = getAddress(await reader.read.NORMIES());
    canvasStorageAddress = getAddress(await reader.read.NORMIES_CANVAS_STORAGE());
  } catch {
    normiesAddress = null;
    canvasStorageAddress = null;
  }

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
  // Shared-composite mode is wallet-independent; resync is a holder action, so
  // the banner never applies here.
  hideStaleBanner();

  const ids = [...new Set(sharedIds)].sort((a, b) => a - b);
  displayedIds = ids;

  if (ids.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No Abnormies in this composite.";
    tiles = [];
    applyView();
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
  tiles = ids.map((id) => ({ id, resolved: true, image: images[id] }));
  applyView();
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
    hideStaleBanner();
    setHoldingsNote(0);
    tiles = [];
    stopAnimation();
    return;
  }
  section.hidden = false;

  listEl.innerHTML = "<div class='loading'>Loading Abnormies…</div>";
  empty.hidden = true;
  // Hide any prior banner while the new holdings (and their diff) load. The
  // banner only reappears once the diff completes and finds stale seeds.
  hideStaleBanner();

  let owned;
  try {
    owned = await getHoldings(account, { address: contractAddress, abi }, publicClient);
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not load Abnormies.";
    setHoldingsNote(0);
    tiles = [];
    applyView();
    return;
  }

  if (owned.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    displayedIds = [];
    setHoldingsNote(0);
    tiles = [];
    applyView();
    return;
  }

  setHoldingsNote(owned.length);

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
  // Animated tiles mirror Composite order: resolved ascending, then unresolved.
  tiles = owned.map((o) => ({ id: o.abnormieId, resolved: o.resolved, image: images[o.abnormieId] }));
  applyView();

  // Compute the seed-staleness diff for the resolved holdings and surface the
  // resync banner if any seed Normie has unreflected activity. Fire-and-forget:
  // the holdings grid is already rendered; the banner appears when the diff
  // settles. Unresolved holdings have no seed pairing yet and are excluded.
  refreshStaleBanner(resolvedIds);
}

// ---------------------------------------------------------------------------
// Resync banner — compares each resolved holding's seed Normie against live
// upstream state (Normies.ownerOf + NormiesCanvasStorage.isTransformed) and
// surfaces a one-line banner when any seed has activity not yet reflected
// on-chain. Clicking "Resync now" sends a single pokeMany() for every stale
// seed. Mirrors the per-seed needsSeedPoke logic in abnormie.js
// onUpdateFromNormies (awakening is intentionally out of scope here).
// ---------------------------------------------------------------------------
function hideStaleBanner() {
  staleSeedIds = [];
  const el = $("resync-banner");
  if (el) el.hidden = true;
}

// Recompute the staleness diff for the given resolved Abnormie IDs and toggle
// the banner. Hides the banner while computing (no spinner) and only shows it
// if at least one seed is stale.
async function refreshStaleBanner(resolvedIds) {
  const banner = $("resync-banner");
  if (!banner) return; // page has no banner slot — nothing to do
  // The diff needs the upstream contract addresses; if they didn't resolve,
  // skip the feature entirely (banner stays hidden).
  if (!normiesAddress || !canvasStorageAddress) {
    hideStaleBanner();
    return;
  }
  if (!resolvedIds || resolvedIds.length === 0) {
    hideStaleBanner();
    return;
  }

  banner.hidden = true;

  let stale;
  try {
    stale = await computeStaleSeeds(resolvedIds);
  } catch {
    // Diff failed (RPC hiccup, etc.) — leave the banner hidden rather than
    // showing a misleading state.
    hideStaleBanner();
    return;
  }

  staleSeedIds = stale;
  banner.hidden = stale.length === 0;
}

// Returns the deduped list of seed Normie IDs (as BigInt) behind the resolved
// holdings that need a pokeSeed. All reads go through publicClient.multicall.
async function computeStaleSeeds(resolvedIds) {
  // 1. Resolve each Abnormie's seed Normie ID.
  const stateCalls = resolvedIds.map((id) => ({
    address: contractAddress,
    abi,
    functionName: "getAbnormieState",
    args: [BigInt(id)]
  }));
  const stateResults = await publicClient.multicall({ contracts: stateCalls });
  const seedIds = [];
  for (const r of stateResults) {
    if (r.status !== "success") continue;
    // AbnormieState.seedNormieId is the first field.
    seedIds.push(BigInt(r.result.seedNormieId));
  }
  // Dedupe — distinct Abnormies always have distinct seeds, but guard anyway.
  const uniqueSeeds = [...new Set(seedIds.map((s) => s.toString()))].map((s) => BigInt(s));
  if (uniqueSeeds.length === 0) return [];

  // 2. Read stored seed state, live owner, and live customization in parallel,
  //    one multicall per source.
  const seedStateCalls = uniqueSeeds.map((seedId) => ({
    address: contractAddress,
    abi,
    functionName: "getSeedState",
    args: [seedId]
  }));
  const ownerCalls = uniqueSeeds.map((seedId) => ({
    address: normiesAddress,
    abi: NORMIES_ABI,
    functionName: "ownerOf",
    args: [seedId]
  }));
  const transformedCalls = uniqueSeeds.map((seedId) => ({
    address: canvasStorageAddress,
    abi: CANVAS_STORAGE_ABI,
    functionName: "isTransformed",
    args: [seedId]
  }));
  const [seedStates, owners, transformed] = await Promise.all([
    publicClient.multicall({ contracts: seedStateCalls }),
    publicClient.multicall({ contracts: ownerCalls }),
    publicClient.multicall({ contracts: transformedCalls })
  ]);

  // 3. Per-seed staleness, matching abnormie.js onUpdateFromNormies.
  const stale = [];
  uniqueSeeds.forEach((seedId, i) => {
    const ss = seedStates[i];
    if (ss.status !== "success") return; // can't judge without stored state
    const lastObserved = ss.result[0]; // address — ZERO if never observed
    const seedCustomized = Boolean(ss.result[2]);
    const seedBurned = Boolean(ss.result[3]);

    // A seed already marked burned no-ops on pokeSeed — never stale.
    if (seedBurned) return;

    // ownerOf reverts (multicall failure) or returns zero for a burned/dead
    // Normie; both map to "no current owner".
    const ownerRes = owners[i];
    const currentOwner =
      ownerRes.status === "success" && ownerRes.result !== ZERO_ADDRESS ? ownerRes.result : null;
    const isTransformed = transformed[i].status === "success" && transformed[i].result === true;

    const firstObservation = currentOwner != null && lastObserved === ZERO_ADDRESS;
    const ownerChanged =
      currentOwner != null &&
      lastObserved !== ZERO_ADDRESS &&
      getAddress(currentOwner) !== getAddress(lastObserved);
    const needsBurnedMark = currentOwner == null; // seedBurned already false here
    const needsCustomizedMark = isTransformed && !seedCustomized;

    if (firstObservation || ownerChanged || needsBurnedMark || needsCustomizedMark) {
      stale.push(seedId);
    }
  });
  return stale;
}

// "Resync now" — sends one pokeMany() for every stale seed, then re-runs the
// diff so the banner hides once the chain reflects the activity. No size cap.
async function onResync() {
  const btn = $("resync-btn");
  if (resyncInFlight || !staleSeedIds.length) return;
  if (!account) {
    await connect();
    if (!account) return;
  }
  if (walletChainId != null && walletChainId !== expectedChainId) {
    showBanner("warn", `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} to resync.`);
    return;
  }

  const seeds = staleSeedIds.slice();
  const original = btn ? btn.textContent : "";
  resyncInFlight = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Resyncing…";
  }

  try {
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi,
      functionName: "pokeMany",
      args: [seeds],
      account
    });
    await publicClient.waitForTransactionReceipt({ hash });
    // Re-run the diff against the now-updated chain state and re-render the
    // banner (which should now hide).
    await refreshStaleBanner(displayedIds);
  } catch (e) {
    showBanner("error", `Resync failed: ${e.shortMessage || e.message || e}`);
  } finally {
    resyncInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = original || "Resync now";
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showBanner("error", e.message || String(e)));
});
