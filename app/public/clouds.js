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
  getContract,
  encodeFunctionData
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { getHoldings } from "./holdings.js";
import { fetchBinding } from "./binding.js";

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

// Adapter8004 (ERC-8217) binding lookup. Used to confirm, on-chain, that the
// agent the Normies API reports for a seed actually binds back to that seed
// Normie before we treat the seed as awakening-stale. The adapter address is
// resolved at runtime from Abnormies.ADAPTER8004(). bindingOf returns a
// (standard, tokenContract, tokenId) tuple; TokenStandard.ERC721 == 0.
const ADAPTER8004_ABI = [
  {
    type: "function",
    name: "bindingOf",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "standard", type: "uint8" },
          { name: "tokenContract", type: "address" },
          { name: "tokenId", type: "uint256" }
        ]
      }
    ],
    stateMutability: "view"
  }
];

// Canonical Multicall3 deployment (same address on every chain). Used by Resync
// to send one transaction that batches the pokeSeed-style pokeMany and the
// per-seed pokeAwakening calls. Both are permissionless and do not check
// msg.sender, so routing through Multicall3 is semantically inert.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" }
        ]
      }
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" }
        ]
      }
    ]
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
let adapterAddress = null;
// Seed Normies behind the wallet's resolved holdings that have upstream activity
// not yet reflected on-chain. Two disjoint sets, populated by enrichHoldings():
//   pokeSeedStaleSeeds — BigInt seed IDs needing a pokeSeed/pokeMany refresh.
//   awakeningStale     — { seedId, agentId } pairs needing a pokeAwakening.
let pokeSeedStaleSeeds = [];
let awakeningStale = [];
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

// --- Holdings filter state -------------------------------------------------
// Multi-select within and across the four groups; AND across groups, OR within.
// Persisted in the URL with short param names (life, mut, cast, aln). Filters
// only act on wallet holdings (shared-composite tiles have no on-chain state).
const ALLOWED_LIFE = ["living", "dead"];
const ALLOWED_MUT = ["active", "static"];
function parseSet(name, allowed) {
  const raw = _params.get(name);
  const s = new Set();
  if (raw) for (const v of raw.split(",")) if (allowed.includes(v)) s.add(v);
  return s;
}
let filterLife = parseSet("life", ALLOWED_LIFE);
let filterMut = parseSet("mut", ALLOWED_MUT);
let filterCast = _params.get("cast") === "1";
let filterAligned = _params.get("aln") === "1";

// Holdings counts for the note line. totalOwned is the wallet's full count;
// visibleCount is how many survive the active filters.
let totalOwned = 0;
let visibleCount = 0;

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
// matching Composite static order. Each: { id, resolved, image, hasState, ... }.
// Filter-relevant booleans (isStatic, isDead, isCustomized, hasCastAbility,
// isAligned) are added by enrichHoldings once seed state has been read.
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

// Run fn over items with at most `limit` in flight at once. Chunked rather than
// a sliding window: simple, and holding counts are small. fn must not throw
// (fetchBinding swallows its own errors), so a bad item never aborts the batch.
// ponytail: chunked cap, swap for a sliding window if a wallet ever holds
// hundreds of awakening candidates.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const res = await Promise.all(chunk.map((it, j) => fn(it, i + j)));
    out.push(...res);
  }
  return out;
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

// Holdings note. Only present on the /home page (id="holdings-note"); a no-op
// elsewhere. Reads the filter state: with filters active it shows "Showing M of
// N", otherwise the plain owned count. A zero count restores the generic prompt.
const DEFAULT_HOLDINGS_NOTE = "Click any Abnormie to see its detail page.";
function refreshHoldingsNote() {
  const note = $("holdings-note");
  if (!note) return;
  if (totalOwned === 0) {
    note.textContent = DEFAULT_HOLDINGS_NOTE;
    return;
  }
  const word = totalOwned === 1 ? "Abnormie" : "Abnormies";
  if (anyFilterActive()) {
    note.textContent = `Showing ${visibleCount} of ${totalOwned} ${word}.`;
  } else {
    note.textContent = `You own ${totalOwned} ${word}. Click any one to see its detail page.`;
  }
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
// Filtering (reorganized /home only)
// ---------------------------------------------------------------------------
function anyFilterActive() {
  return filterLife.size > 0 || filterMut.size > 0 || filterCast || filterAligned;
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

// A cell matches the active filters. Stateless cells (unrevealed holdings, or
// state that failed to load) only show when no filter is active. Filter state
// is read from data-* attributes set by enrichHoldings.
function cellMatches(cell) {
  const ds = cell.dataset;
  if (ds.state !== "1") return !anyFilterActive();
  if (filterLife.size && !filterLife.has(ds.life)) return false;
  if (filterMut.size && !filterMut.has(ds.mut)) return false;
  if (filterCast && ds.cast !== "1") return false;
  if (filterAligned && ds.aligned !== "1") return false;
  return true;
}

// Toggle each grid cell's visibility against the active filters. Hides via
// display:none rather than re-rendering. Recomputes visibleCount and the note.
function applyFilters() {
  const listEl = $("receipts-list");
  if (!listEl) return;
  let visible = 0;
  for (const cell of listEl.children) {
    const show = cellMatches(cell);
    cell.style.display = show ? "" : "none";
    if (show) visible++;
  }
  visibleCount = visible;
  refreshHoldingsNote();
}

// Per-chip match counts, computed once per holdings load (not per interaction).
// Each count is that chip's predicate alone, not combined with other filters.
function setFilterCounts() {
  const counts = { living: 0, dead: 0, active: 0, static: 0, cast: 0, aligned: 0 };
  for (const t of tiles) {
    if (!t.hasState) continue;
    counts[t.isDead ? "dead" : "living"]++;
    counts[t.isStatic ? "static" : "active"]++;
    if (t.hasCastAbility) counts.cast++;
    if (t.isAligned) counts.aligned++;
  }
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const f = chip.dataset.filter;
    const v = chip.dataset.value;
    let c = 0;
    if (f === "life" || f === "mut") c = counts[v] || 0;
    else if (f === "cast") c = counts.cast;
    else if (f === "aligned") c = counts.aligned;
    const span = chip.querySelector(".chip-count");
    if (span) span.textContent = `(${c})`;
  });
}

// Reflect the current filter state onto a chip's pressed appearance.
function reflectChip(chip) {
  const f = chip.dataset.filter;
  const v = chip.dataset.value;
  const on =
    (f === "life" && filterLife.has(v)) ||
    (f === "mut" && filterMut.has(v)) ||
    (f === "cast" && filterCast) ||
    (f === "aligned" && filterAligned);
  chip.setAttribute("aria-pressed", on ? "true" : "false");
  chip.classList.toggle("active", on);
}

// Persist filter state in the URL alongside ?view/?cols/?ids. replaceState so
// it survives reload without adding history entries on every chip toggle.
function updateFilterUrl() {
  const url = new URL(window.location.href);
  const p = url.searchParams;
  const setList = (name, values) => {
    if (values.length) p.set(name, values.join(","));
    else p.delete(name);
  };
  setList("life", [...filterLife]);
  setList("mut", [...filterMut]);
  if (filterCast) p.set("cast", "1");
  else p.delete("cast");
  if (filterAligned) p.set("aln", "1");
  else p.delete("aln");
  history.replaceState(null, "", url);
}

function wireFilterControls() {
  const fc = $("filter-controls");
  if (!fc) return;
  fc.querySelectorAll(".filter-chip").forEach(reflectChip);
  fc.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    const f = chip.dataset.filter;
    const v = chip.dataset.value;
    if (f === "life") toggleSet(filterLife, v);
    else if (f === "mut") toggleSet(filterMut, v);
    else if (f === "cast") filterCast = !filterCast;
    else if (f === "aligned") filterAligned = !filterAligned;
    else return;
    reflectChip(chip);
    updateFilterUrl();
    applyFilters();
  });
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
  wireFilterControls();
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

  // Resolve the upstream contract addresses once, for the staleness diff and
  // filter state. Non-fatal: if this fails the resync banner and the filters
  // simply never appear.
  try {
    normiesAddress = getAddress(await reader.read.NORMIES());
    canvasStorageAddress = getAddress(await reader.read.NORMIES_CANVAS_STORAGE());
    adapterAddress = getAddress(await reader.read.ADAPTER8004());
  } catch {
    normiesAddress = null;
    canvasStorageAddress = null;
    adapterAddress = null;
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
  // the banner never applies. Filters need per-tile on-chain state these tiles
  // do not carry, so disable them too (reset state and hide the row).
  hideStaleBanner();
  filterLife.clear();
  filterMut.clear();
  filterCast = false;
  filterAligned = false;
  const filterCtl = $("filter-controls");
  if (filterCtl) filterCtl.hidden = true;

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
  tiles = ids.map((id) => ({ id, resolved: true, image: images[id], hasState: false }));
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
  const filterCtl = $("filter-controls");

  if (!account) {
    section.hidden = true;
    hideStaleBanner();
    if (filterCtl) filterCtl.hidden = true;
    totalOwned = 0;
    refreshHoldingsNote();
    tiles = [];
    stopAnimation();
    return;
  }
  section.hidden = false;

  listEl.innerHTML = "<div class='loading'>Loading Abnormies…</div>";
  empty.hidden = true;
  // Hide any prior banner and the filters while the new holdings (and their
  // diff) load. Both reappear once enrichHoldings settles.
  hideStaleBanner();
  if (filterCtl) filterCtl.hidden = true;

  let owned;
  try {
    owned = await getHoldings(account, { address: contractAddress, abi }, publicClient);
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not load Abnormies.";
    totalOwned = 0;
    refreshHoldingsNote();
    tiles = [];
    applyView();
    return;
  }

  if (owned.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    displayedIds = [];
    totalOwned = 0;
    refreshHoldingsNote();
    tiles = [];
    applyView();
    return;
  }

  totalOwned = owned.length;
  refreshHoldingsNote();

  // Phase 1 — one multicall fetches BOTH the image (tokenURI) and the Abnormie
  // state (getAbnormieState, which yields the seed Normie ID) for every resolved
  // holding. tokenURI needs no seed; getAbnormieState.seedNormieId feeds the
  // phase-2 seed reads. Folding them into a single round trip keeps image
  // rendering as fast as the old image-only path.
  const resolvedIds = owned.filter((o) => o.resolved).map((o) => o.abnormieId);
  const images = {};
  const abStateById = {}; // abnormieId -> { seedId, isStatic, seedDeadAtFreeze, seedCustomizedAtFreeze }
  if (resolvedIds.length) {
    const uriCalls = resolvedIds.map((id) => ({
      address: contractAddress,
      abi,
      functionName: "tokenURI",
      args: [BigInt(id)]
    }));
    const stateCalls = resolvedIds.map((id) => ({
      address: contractAddress,
      abi,
      functionName: "getAbnormieState",
      args: [BigInt(id)]
    }));
    let results;
    try {
      results = await publicClient.multicall({ contracts: [...uriCalls, ...stateCalls] });
    } catch {
      results = [...uriCalls, ...stateCalls].map(() => ({ status: "failure" }));
    }
    const n = resolvedIds.length;
    results.slice(0, n).forEach((r, k) => {
      if (r.status !== "success") return;
      try {
        images[resolvedIds[k]] = parseTokenURIImage(r.result);
      } catch {
        /* fall back to Sky stand-in */
      }
    });
    results.slice(n).forEach((r, k) => {
      if (r.status !== "success") return;
      const st = r.result;
      abStateById[resolvedIds[k]] = {
        seedId: BigInt(st.seedNormieId),
        isStatic: st.staticAt !== 0n,
        seedDeadAtFreeze: Boolean(st.seedDeadAtFreeze),
        seedCustomizedAtFreeze: Boolean(st.seedCustomizedAtFreeze)
      };
    });
  }

  // Paint the grid now (images), so the art shows before the seed-level diff.
  listEl.innerHTML = "";
  const cellById = new Map();
  for (const o of owned) {
    const cell = makeReceiptCell({ resolved: o.resolved, abnormieId: o.abnormieId, image: images[o.abnormieId] });
    if (o.resolved) cellById.set(o.abnormieId, cell);
    listEl.appendChild(cell);
  }
  // Resolved token IDs (ascending) are what a Share URL can encode; unresolved
  // holdings have no token ID yet and are omitted from the shareable set.
  displayedIds = resolvedIds;
  // Animated tiles mirror Composite order: resolved ascending, then unresolved.
  // Filter state (hasState + booleans) is filled in by enrichHoldings.
  tiles = owned.map((o) => ({ id: o.abnormieId, resolved: o.resolved, image: images[o.abnormieId], hasState: false }));
  applyView();

  // Phase 2 — seed-level reads, per-tile filter state, and the staleness diff
  // (pokeSeed + awakening). Awaited but the grid is already painted; failures
  // are swallowed so the page still works (filters and banner stay hidden).
  try {
    await enrichHoldings(resolvedIds, abStateById, cellById);
  } catch {
    /* leave filters/banner disabled */
  }
}

// ---------------------------------------------------------------------------
// Holdings enrichment + staleness diff.
//
// For each resolved holding's seed Normie, reads stored seed state, the live
// Normies owner, and live customization (one multicall per source), then:
//   - derives the per-tile filter booleans and attaches them to tiles + cells,
//   - flags pokeSeed-stale seeds (matching abnormie.js onUpdateFromNormies),
//   - flags awakening-stale seeds: not yet awakened on-chain, owned by the
//     connected wallet, and bound upstream (api.normies.art) to an agent whose
//     Adapter8004 binding confirms it points back at this seed Normie.
// Both stale categories drive the single resync banner.
// ---------------------------------------------------------------------------
async function enrichHoldings(resolvedIds, abStateById, cellById) {
  if (!normiesAddress || !canvasStorageAddress) return; // can't derive state or diff

  const uniqueSeeds = [
    ...new Set(resolvedIds.map((id) => abStateById[id]).filter(Boolean).map((ab) => ab.seedId.toString()))
  ].map((s) => BigInt(s));
  if (uniqueSeeds.length === 0) return;

  const seedStateCalls = uniqueSeeds.map((s) => ({
    address: contractAddress,
    abi,
    functionName: "getSeedState",
    args: [s]
  }));
  const ownerCalls = uniqueSeeds.map((s) => ({
    address: normiesAddress,
    abi: NORMIES_ABI,
    functionName: "ownerOf",
    args: [s]
  }));
  const transformedCalls = uniqueSeeds.map((s) => ({
    address: canvasStorageAddress,
    abi: CANVAS_STORAGE_ABI,
    functionName: "isTransformed",
    args: [s]
  }));
  const [seedStates, owners, transformed] = await Promise.all([
    publicClient.multicall({ contracts: seedStateCalls }),
    publicClient.multicall({ contracts: ownerCalls }),
    publicClient.multicall({ contracts: transformedCalls })
  ]);

  // Per-seed derived state, keyed by seed id string. pokeSeed staleness mirrors
  // the existing conditions exactly.
  const seedInfo = new Map();
  const pokeSeedStale = [];
  uniqueSeeds.forEach((seedId, i) => {
    const ss = seedStates[i];
    const ok = ss.status === "success";
    const lastObserved = ok ? ss.result[0] : null; // address — ZERO if never observed
    const seedCustomized = ok ? Boolean(ss.result[2]) : false;
    const seedBurned = ok ? Boolean(ss.result[3]) : false;
    const seedAwakened = ok ? Boolean(ss.result[4]) : false;

    // ownerOf reverts (multicall failure) or returns zero for a burned/dead
    // Normie; both map to "no current owner".
    const ownerRes = owners[i];
    const currentOwner =
      ownerRes.status === "success" && ownerRes.result !== ZERO_ADDRESS ? ownerRes.result : null;
    const isTransformed = transformed[i].status === "success" && transformed[i].result === true;

    let needsSeedPoke = false;
    if (ok && !seedBurned) {
      const firstObservation = currentOwner != null && lastObserved === ZERO_ADDRESS;
      const ownerChanged =
        currentOwner != null &&
        lastObserved !== ZERO_ADDRESS &&
        getAddress(currentOwner) !== getAddress(lastObserved);
      const needsBurnedMark = currentOwner == null; // seedBurned already false here
      const needsCustomizedMark = isTransformed && !seedCustomized;
      needsSeedPoke = firstObservation || ownerChanged || needsBurnedMark || needsCustomizedMark;
      if (needsSeedPoke) pokeSeedStale.push(seedId);
    }

    seedInfo.set(seedId.toString(), { ok, seedCustomized, seedBurned, seedAwakened, currentOwner, needsSeedPoke });
  });

  // Awakening staleness: seeds NOT already pokeSeed-stale, not burned, owned by
  // the connected wallet, and not yet awakened on-chain. For those, resolve the
  // upstream agent binding (api.normies.art) and confirm it on-chain via
  // Adapter8004 before flagging. API calls are off the multicall path; capped
  // at 8 concurrent. fetchBinding never throws, so a failed lookup just yields
  // agentId 0n and is skipped.
  const awoken = [];
  const candidates = uniqueSeeds.filter((seedId) => {
    const info = seedInfo.get(seedId.toString());
    if (!info || !info.ok || info.needsSeedPoke) return false;
    if (info.seedBurned || info.seedAwakened) return false;
    if (!info.currentOwner || getAddress(info.currentOwner) !== getAddress(account)) return false;
    return true;
  });
  if (candidates.length && adapterAddress) {
    const bindings = await mapLimit(candidates, 8, async (seedId) => {
      const b = await fetchBinding(seedId);
      return { seedId, agentId: b && b.agentId != null ? b.agentId : 0n };
    });
    const withAgent = bindings.filter((b) => b.agentId !== 0n);
    if (withAgent.length) {
      const bindCalls = withAgent.map((b) => ({
        address: adapterAddress,
        abi: ADAPTER8004_ABI,
        functionName: "bindingOf",
        args: [b.agentId]
      }));
      let bindResults;
      try {
        bindResults = await publicClient.multicall({ contracts: bindCalls });
      } catch {
        bindResults = withAgent.map(() => ({ status: "failure" }));
      }
      bindResults.forEach((r, k) => {
        if (r.status !== "success") return;
        const bnd = r.result; // { standard, tokenContract, tokenId }
        if (
          Number(bnd.standard) === 0 && // TokenStandard.ERC721
          getAddress(bnd.tokenContract) === getAddress(normiesAddress) &&
          BigInt(bnd.tokenId) === withAgent[k].seedId
        ) {
          awoken.push({ seedId: withAgent[k].seedId, agentId: withAgent[k].agentId });
        }
      });
    }
  }

  // Publish stale sets and the banner (either category counts toward it).
  pokeSeedStaleSeeds = pokeSeedStale;
  awakeningStale = awoken;
  const banner = $("resync-banner");
  if (banner) banner.hidden = pokeSeedStale.length + awoken.length === 0;

  // Derive per-tile filter booleans from abnormie + seed state, attach to the
  // tile objects (counts / animation) and the cells (filter visibility).
  for (const t of tiles) {
    if (!t.resolved) continue;
    const ab = abStateById[t.id];
    if (!ab) continue;
    const info = seedInfo.get(ab.seedId.toString());
    if (!info || !info.ok) continue;

    const isStatic = ab.isStatic;
    const isDead = isStatic ? ab.seedDeadAtFreeze : info.seedBurned;
    const isCustomized = isStatic ? ab.seedCustomizedAtFreeze : info.seedCustomized;
    const canCastThunder = !isStatic && isDead;
    const canCastLightning = !isStatic && !isDead && isCustomized;
    const hasCastAbility = canCastThunder || canCastLightning;
    const isAligned =
      info.seedAwakened &&
      info.currentOwner != null &&
      getAddress(info.currentOwner) === getAddress(account);

    Object.assign(t, {
      hasState: true,
      seedId: ab.seedId,
      isStatic,
      isDead,
      isCustomized,
      canCastThunder,
      canCastLightning,
      hasCastAbility,
      isAligned
    });

    const cell = cellById.get(t.id);
    if (cell) {
      cell.dataset.state = "1";
      cell.dataset.life = isDead ? "dead" : "living";
      cell.dataset.mut = isStatic ? "static" : "active";
      cell.dataset.cast = hasCastAbility ? "1" : "0";
      cell.dataset.aligned = isAligned ? "1" : "0";
    }
  }

  setFilterCounts();
  const fc = $("filter-controls");
  if (fc) fc.hidden = false;
  applyFilters();
}

// ---------------------------------------------------------------------------
// Resync banner reset.
// ---------------------------------------------------------------------------
function hideStaleBanner() {
  pokeSeedStaleSeeds = [];
  awakeningStale = [];
  const el = $("resync-banner");
  if (el) el.hidden = true;
}

// "Resync now" — writes the pending pokeSeed and pokeAwakening updates, then
// reloads holdings so the banner clears once the chain reflects the activity.
//
// pokeSeed-only: a direct pokeMany() (cheapest path). Mixed (any awakening-stale
// seed present): one Multicall3.aggregate3() that batches the pokeMany and a
// per-seed pokeAwakening, each with allowFailure so a single stale binding does
// not revert the whole tx. Both pokes are permissionless, so routing through
// Multicall3 has no effect on Abnormies state.
async function onResync() {
  const btn = $("resync-btn");
  if (resyncInFlight) return;
  if (pokeSeedStaleSeeds.length + awakeningStale.length === 0) return;
  if (!account) {
    await connect();
    if (!account) return;
  }
  if (walletChainId != null && walletChainId !== expectedChainId) {
    showBanner("warn", `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} to resync.`);
    return;
  }

  const seeds = pokeSeedStaleSeeds.slice();
  const awakenings = awakeningStale.slice();
  const original = btn ? btn.textContent : "";
  resyncInFlight = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Resyncing…";
  }

  try {
    let hash;
    if (awakenings.length === 0) {
      hash = await walletClient.writeContract({
        address: contractAddress,
        abi,
        functionName: "pokeMany",
        args: [seeds],
        account
      });
    } else {
      const calls = [];
      if (seeds.length) {
        calls.push({
          target: contractAddress,
          allowFailure: true,
          callData: encodeFunctionData({ abi, functionName: "pokeMany", args: [seeds] })
        });
      }
      for (const a of awakenings) {
        calls.push({
          target: contractAddress,
          allowFailure: true,
          callData: encodeFunctionData({ abi, functionName: "pokeAwakening", args: [a.seedId, a.agentId] })
        });
      }
      hash = await walletClient.writeContract({
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [calls],
        account
      });
    }
    await publicClient.waitForTransactionReceipt({ hash });
    // Reload against the now-updated chain state; the banner should hide.
    await loadReceipts();
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
