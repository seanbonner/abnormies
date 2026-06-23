// Abnormies post-reveal detail page.
//
// Renders a single revealed Abnormie (?id={n}) alongside its seed Normie.
// Read paths are fully wired against the deployed Abnormies contract (state,
// metadata, ownership) plus the Normies contract (image + owner), the Normies
// canvas storage (customization), and the Normies API (agent binding). The
// "Update from Normies" action pre-checks state and fires pokeSeed and/or
// pokeAwakening only when each would actually change state on-chain — never
// a no-op write. Thunder and Lightning open an inline freeze-target picker
// then call the corresponding contract function; the contract enforces all
// preconditions (no pre-flight pokeSeed). Download GIF remains "Coming soon".
// Function names are taken from the deployed ABI.
//
// The pure parsing helpers (decodeDataUri/parseTokenURI/extractSvgMarkup/
// shortAddr) are exported and DOM-free so scripts/test-parse.mjs can exercise
// the exact same code in Node. Nothing at module scope touches window/document.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  getContract,
  getAddress
} from "viem";
import { mainnet, sepolia } from "viem/chains";

// Canonical client-side renderer (parity-tested against the on-chain renderer).
// DOM-free and Node-safe, so importing it at module scope does not break the
// Node helper test that pulls the pure parsers below. gif.js is NOT imported
// here: it reads navigator at module load, so it is dynamically imported inside
// the browser-only download handler instead.
import { renderCanvas, enumerateSteps, COLOR_HEX } from "./renderer.js";

// Normies API lookups. fetchBinding is shared with the holdings page (clouds.js);
// the rest are detail-page reads (customization count, burned seed image, live
// indexed customization), each best-effort with an on-chain fallback.
import {
  fetchBinding,
  fetchCustomizationCount,
  burnedSeedImageUrl,
  fetchCanvasCustomized
} from "./binding.js";

// ---------------------------------------------------------------------------
// Pure helpers (DOM-free, exported for the Node test)
// ---------------------------------------------------------------------------

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

// Decode a base64 string to UTF-8 text in both the browser (atob) and Node.
function b64ToString(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

// Split a data: URI into its mime type and decoded body. Handles base64 and
// percent-encoded (and raw ";utf8,") payloads.
export function decodeDataUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("data:")) {
    throw new Error("Not a data URI");
  }
  const comma = uri.indexOf(",");
  if (comma === -1) throw new Error("Malformed data URI");
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  const isB64 = /;base64/i.test(meta);
  const mime = meta.split(";")[0] || "";
  let body;
  if (isB64) {
    body = b64ToString(data);
  } else {
    try {
      body = decodeURIComponent(data);
    } catch {
      body = data; // raw ";utf8," JSON with no percent-encoding
    }
  }
  return { mime, body };
}

// tokenURI -> parsed metadata JSON ({ name, description, image, attributes }).
export function parseTokenURI(uri) {
  const { body } = decodeDataUri(uri);
  return JSON.parse(body);
}

// metadata.image (a data: URI holding the SVG) -> raw SVG markup.
export function extractSvgMarkup(imageField) {
  return decodeDataUri(imageField).body;
}

// ---------------------------------------------------------------------------
// Browser bootstrap (skipped when imported in Node)
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  bootstrap();
}

function bootstrap() {
  const CHAINS = { 1: mainnet, 11155111: sepolia };
  const CHAIN_NAMES = { 1: "Ethereum Mainnet", 11155111: "Sepolia" };
  const OPENSEA_CHAIN_SLUG = { 1: "ethereum", 11155111: "sepolia" };
  const OPENSEA_BASE = { 1: "https://opensea.io", 11155111: "https://testnets.opensea.io" };

  const cfg = window.ABNORMIES_CONFIG || {};
  const expectedChainId = Number(cfg.chainId || 1);
  const chain = CHAINS[expectedChainId] || mainnet;
  const contractAddress = cfg.contractAddress;
  // Label for the holdings page the back link / post-action message points at.
  // Configurable so the reorganized site reads "My Abnormies" while the legacy
  // /app/ build keeps "Clouds".
  const cloudsLabel = cfg.cloudsLabel || "Clouds";

  // Sky-colored (#e3e5e4, the renderer's lightest cloud value) stand-in shown at
  // hero size when an Abnormie has not been revealed yet. Single-rect SVG with an
  // explicit xmlns so it renders as an <img> src. The 360px frame, pixelated
  // rendering, and border all come from the existing .detail-hero-img styling.
  const SKY_PLACEHOLDER =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" preserveAspectRatio="none"><rect width="40" height="40" fill="#e3e5e4"/></svg>'
    );

  // Minimal ABI for the Normies canvas storage contract — only the read we need
  // for pre-checking whether a seed Normie has been customized since last poke.
  const CANVAS_STORAGE_ABI = [
    {
      type: "function",
      name: "isTransformed",
      inputs: [{ name: "tokenId", type: "uint256" }],
      outputs: [{ type: "bool" }],
      stateMutability: "view"
    }
  ];
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  let abi = null;
  let normiesAbi = null;
  let publicClient = null;
  let reader = null;
  let normiesReader = null;
  let normiesAddress = null;
  let canvasStorageReader = null;

  let walletClient = null;
  let account = null;
  let walletChainId = null;
  let listenersAttached = false;

  let currentId = null; // BigInt
  let currentSeedId = null; // BigInt
  let currentImageField = null; // data URI for SVG download
  let updateInFlight = false;

  // --- Static / Animated view -------------------------------------------------
  const ALLOWED_VIEWS = ["static", "animated"];
  const ALLOWED_SPEEDS = ["slow", "medium", "fast"];
  const SPEED_MS = { slow: 1000, medium: 300, fast: 100 };
  // The blank starting frame: zero Cirrus and nothing after, so renderCanvas
  // returns all-Sky (or all-Nimbostratus once inversion is applied for aligned).
  const BLANK_STEP = { layer: "cirrus", index: 0 };
  // Above this many steps the build is batched into <=200 frames.
  const FRAME_BUDGET = 200;
  // RGB lookup derived from the renderer palette (Sky, Cirrus, Altocumulus, Nimbostratus).
  const PALETTE = COLOR_HEX.map((hex) => [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16)
  ]);

  let currentView = "static";
  let currentSpeed = "medium";
  // The full global cascade log, fetched once and reused for the page lifetime.
  let cascadeLogCache = null;
  // Render state for the currently loaded Abnormie (null when not renderable,
  // e.g. unrevealed or error). Aligned is captured here at load time.
  let currentAnimState = null;
  // Active playback session, or null. Holds the canvas contexts, the frame list,
  // the cursor, the timer, and any in-flight gif.js encoder.
  let anim = null;

  const $ = (id) => document.getElementById(id);

  function showBanner(kind, msg) {
    const b = $("banner");
    b.className = `banner banner-${kind}`;
    b.textContent = msg;
    b.hidden = false;
  }
  function hideBanner() {
    $("banner").hidden = true;
  }
  function showError(msg) {
    currentAnimState = null;
    teardownAnim();
    $("content").hidden = true;
    const e = $("error-state");
    e.textContent = msg;
    e.hidden = false;
  }
  const describeError = (err) =>
    !err ? "Unknown error." : err.shortMessage || err.details || err.message || String(err);

  // Distinguish a real network/RPC failure from a token that simply is not revealed
  // yet (tokenURI revert). Only the former should surface as an error state.
  function isTransportError(err) {
    const s = `${err?.name || ""} ${err?.details || ""} ${err?.message || ""}`;
    return /HttpRequestError|TimeoutError|RpcRequestError|Failed to fetch|fetch failed|networkerror/i.test(s);
  }

  // -- wallet --------------------------------------------------------------
  function renderWallet() {
    const el = $("wallet-address");
    if (account) {
      el.textContent = shortAddr(account);
      el.classList.add("is-connected");
    } else {
      el.textContent = "Not connected";
      el.classList.remove("is-connected");
    }
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
      account = accs && accs.length ? getAddress(accs[0]) : null;
      walletClient = account
        ? createWalletClient({ account, chain, transport: custom(window.ethereum) })
        : null;
      renderWallet();
      if (currentId != null) await loadAbnormie(currentId);
    });
    window.ethereum.on?.("chainChanged", async () => {
      await refreshWalletChain();
      if (currentId != null) await loadAbnormie(currentId);
    });
  }

  async function setupWallet(addr) {
    account = getAddress(addr);
    walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
    await refreshWalletChain();
    attachListeners();
    renderWallet();
  }

  async function connect() {
    if (!window.ethereum) {
      showBanner("error", "No injected wallet found. Install a browser wallet to continue.");
      return;
    }
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      await setupWallet(accs[0]);
      if (currentId != null) await loadAbnormie(currentId);
    } catch (e) {
      showBanner("error", `Connection rejected: ${describeError(e)}`);
    }
  }

  // -- data load -----------------------------------------------------------
  async function loadAbnormie(id) {
    currentId = id;
    hideBanner();

    // 1. Metadata. Reverts for unminted / unrevealed tokens -> error state.
    let metadata;
    try {
      const uri = await reader.read.tokenURI([id]);
      metadata = parseTokenURI(uri);
    } catch (err) {
      // tokenURI reverts for any id with no live token yet (pre-reveal / unresolved).
      // Show the Sky stand-in rather than an error; only a transport failure is a
      // genuine error worth surfacing.
      if (isTransportError(err)) {
        showError(`Could not load Abnormie #${id}.\n\n${describeError(err)}`);
      } else {
        renderUnrevealed(id);
      }
      return;
    }

    // 2. On-chain state + ownership.
    let abState, ownerAbnormie;
    try {
      [abState, ownerAbnormie] = await Promise.all([
        reader.read.getAbnormieState([id]),
        reader.read.ownerOf([id])
      ]);
    } catch (err) {
      showError(`Failed to read Abnormie state for #${id}.\n\n${describeError(err)}`);
      return;
    }

    const seedId = BigInt(abState.seedNormieId);
    currentSeedId = seedId;
    const isStatic = abState.staticAt !== 0n;

    // 3. Seed state (live): [lastOwner, cirrus, customized, burned, awakened, boundAgent].
    let seed;
    try {
      const s = await reader.read.getSeedState([seedId]);
      seed = {
        lastOwner: s[0],
        cirrus: s[1],
        customized: Boolean(s[2]),
        burned: Boolean(s[3]),
        awakened: Boolean(s[4]),
        boundAgent: s[5]
      };
    } catch {
      seed = { lastOwner: null, cirrus: 0, customized: false, burned: false, awakened: false, boundAgent: 0n };
    }

    // 4. Normies-side reads (image + owner). Burned Normies revert; tolerate it.
    //    customizationCount is the indexed transform-history length (best-effort,
    //    null on failure so the panel falls back to the on-chain boolean).
    const [normieImg, ownerNormie, customizationCount] = await Promise.all([
      normiesReader.read.tokenURI([seedId]).then(parseTokenURI).then((m) => m.image).catch(() => null),
      normiesReader.read.ownerOf([seedId]).then((o) => getAddress(o)).catch(() => null),
      fetchCustomizationCount(seedId)
    ]);

    // 5. Agent binding (off-chain). Called unconditionally: needed both to show
    //    "Agent #n" when awakened and to surface Update Awakening when the
    //    contract is stale (awakened=false but a binding exists). See report.
    const binding = await fetchBinding(seedId);

    // 6. Derive display + gating values.
    const chipDead = isStatic ? Boolean(abState.seedDeadAtFreeze) : seed.burned;
    const chipCustomized = isStatic ? Boolean(abState.seedCustomizedAtFreeze) : seed.customized;
    const awakened = seed.awakened;
    const ownsAbnormie =
      !!account && !!ownerAbnormie && ownerAbnormie.toLowerCase() === account.toLowerCase();
    const aligned =
      awakened &&
      !!ownerNormie &&
      !!ownerAbnormie &&
      ownerNormie.toLowerCase() === ownerAbnormie.toLowerCase();
    const agentId = binding?.agentId != null ? binding.agentId : awakened ? seed.boundAgent : null;
    const apiBinding = binding != null && binding.agentId != null;

    currentImageField = metadata.image || null;

    // 7. Render.
    $("title").textContent = `ABNORMIE #${id}`;
    $("subtitle").textContent = `Paired with Normie #${seedId}`;
    const hero = $("hero-img");
    hero.src = metadata.image || "";
    hero.alt = `Abnormie #${id}`;

    renderChips({ isStatic, chipDead, chipCustomized, aligned });
    renderSeedPanel({ seedId, ownerNormie, burned: seed.burned, customized: seed.customized, customizationCount, awakened, agentId, normieImg });
    renderActions({ seedDead: seed.burned, seedCustomized: seed.customized, isActive: !isStatic, ownsAbnormie });
    renderTraits(metadata.attributes || []);

    // Animation state. Active Abnormies render against live seed values; Static
    // ones against the freeze snapshots, matching the on-chain renderer. Aligned
    // is captured here and frozen for any playback session that starts from it.
    currentAnimState = {
      abnormieId: id,
      seedNormieId: seedId,
      pairedAtCascadeIndex: BigInt(abState.pairedAtCascadeIndex),
      staticAt: BigInt(abState.staticAt),
      staticAtCascadeIndex: BigInt(abState.staticAtCascadeIndex),
      cirrusCount: isStatic ? Number(abState.cirrusCountAtFreeze) : Number(seed.cirrus),
      seedCustomized: isStatic ? Boolean(abState.seedCustomizedAtFreeze) : Boolean(seed.customized),
      aligned
    };
    ensureAnimDom();
    const vc = $("view-controls");
    if (vc) vc.hidden = false;
    reflectView();
    if (currentView === "animated") startAnimated();
    else stopAnimated();

    $("error-state").hidden = true;
    $("content").hidden = false;
  }

  // -- render --------------------------------------------------------------
  function renderChips({ isStatic, chipDead, chipCustomized, aligned }) {
    const chips = [
      { label: isStatic ? "Static" : "Active" },
      { label: chipDead ? "Dead" : "Living" }
    ];
    if (chipCustomized) chips.push({ label: "Customized" });
    if (aligned) chips.push({ label: "Aligned", inverted: true });

    const nodes = chips.map((c) => {
      const span = document.createElement("span");
      span.className = `chip${c.inverted ? " chip--inverted" : ""}`;
      span.textContent = c.label;
      return span;
    });
    $("chips").replaceChildren(...nodes);
  }

  function renderSeedPanel({ seedId, ownerNormie, burned, customized, customizationCount, awakened, agentId, normieImg }) {
    const img = $("seed-img");
    // Drop any placeholder left by a prior render (wallet/chain changes re-run load).
    const prevPlaceholder = img.parentNode.querySelector(".seed-burned-placeholder");
    if (prevPlaceholder) prevPlaceholder.remove();
    img.onerror = null;
    if (normieImg) {
      img.src = normieImg;
      img.hidden = false;
    } else {
      // No live image. A burned seed's on-chain tokenURI reverts (most common
      // case), but any live fetch failure also lands here. Either way the burn
      // history endpoint can still serve the seed's last image, so try it. If
      // even that fails (e.g. a non-burned seed with a transient read error,
      // which 404s here), fall back to the outlined stand-in box.
      img.onerror = () => {
        img.onerror = null;
        img.hidden = true;
        if (!img.parentNode.querySelector(".seed-burned-placeholder")) {
          const placeholder = document.createElement("div");
          placeholder.className = "seed-burned-placeholder";
          img.insertAdjacentElement("afterend", placeholder);
        }
      };
      img.src = burnedSeedImageUrl(seedId);
      img.hidden = false;
    }

    const awakenedText =
      awakened && agentId != null ? `Agent #${agentId}` : awakened ? "Yes" : "No";
    // seedBurned (from getSeedState) is the contract's authoritative burn flag, so
    // a burned seed reads "Burned" definitively rather than inferring it from a
    // reverting ownerOf. Only when not burned does a missing owner fall back to "—".
    const ownerText = burned ? "Burned" : ownerNormie ? shortAddr(ownerNormie) : "—";
    const osUrl = `${OPENSEA_BASE[expectedChainId] || OPENSEA_BASE[1]}/assets/${
      OPENSEA_CHAIN_SLUG[expectedChainId] || "ethereum"
    }/${normiesAddress}/${seedId}`;

    // Prefer the indexed customization count (full transform history length).
    // Falls back to the on-chain customized boolean when the API read failed.
    const customizedText =
      customizationCount != null ? String(customizationCount) : customized ? "Yes" : "No";
    const rows = [
      ["Normie ID", `#${seedId}`],
      ["Owner", ownerText],
      ["Customized", customizedText],
      ["Awakened", awakenedText]
    ];
    const nodes = [];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      nodes.push(dt, dd);
    }
    const link = document.createElement("a");
    link.href = osUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "detail-seed-os";
    link.textContent = "View Normie on OpenSea →";
    nodes.push(link);
    $("seed-info").replaceChildren(...nodes);
  }

  function renderActions({ seedDead, seedCustomized, isActive, ownsAbnormie }) {
    closeFreezePicker();
    // Thunder/Lightning require the Abnormie to be Active: Static Abnormies are
    // frozen and cannot be burned (staticAt == 0 -> isActive).
    // "Update from Normies" covers BOTH pokeSeed and pokeAwakening — it
    // pre-checks state and fires only the writes that actually do something.
    const defs = [
      { label: "Refresh from seed", visible: true, onClick: onUpdateFromNormies },
      { label: "View on OpenSea", visible: true, onClick: onViewOnOpenSea },
      { label: "Download SVG", visible: true, onClick: onDownloadSvg },
      {
        label: "Thunder",
        visible: ownsAbnormie && seedDead && isActive,
        danger: true,
        onClick: () => openFreezePicker("thunder")
      },
      {
        label: "Lightning",
        visible: ownsAbnormie && !seedDead && seedCustomized && isActive,
        danger: true,
        onClick: () => openFreezePicker("lightning")
      }
    ];

    const nodes = [];
    // The destructive (Thunder/Lightning) buttons are always last in `defs`, so
    // insert the header just before the first VISIBLE danger button. If the holder
    // is eligible for neither, the header is never created — non-eligible holders
    // see no section title for actions they can't take.
    let destructiveHeaderAdded = false;
    for (const d of defs) {
      if (!d.visible) continue;
      if (d.danger && !destructiveHeaderAdded) {
        const header = document.createElement("div");
        header.className = "actions-destructive-header";
        header.textContent = "DESTRUCTIVE ACTIONS:";
        nodes.push(header);
        destructiveHeaderAdded = true;
      }
      const btn = document.createElement("button");
      btn.className = `btn btn-sm${d.danger ? " btn-danger" : ""}`;
      btn.textContent = d.label;
      btn.addEventListener("click", d.onClick);
      nodes.push(btn);
    }
    $("actions").replaceChildren(...nodes);
  }

  // -- Freeze-target picker (shared by Thunder + Lightning) -----------------
  // Picker opens inline below the Actions row. The user enters an Abnormie ID
  // to freeze; Validate target reads ownerOf + getAbnormieState and rejects
  // non-existent, self-owned, or Static targets. Confirm-and-burn pops a
  // native confirm() and calls thunder/lightning with [burnId, targetId].
  // On success, navigates to the frozen target's detail page (the burnt
  // Abnormie ceased to exist; the target is now Static and visually preserved).
  let freezePickerState = null;

  function closeFreezePicker() {
    const picker = $("freeze-picker");
    if (!picker) return;
    picker.hidden = true;
    picker.replaceChildren();
    freezePickerState = null;
  }

  function openFreezePicker(action) {
    if (currentId == null) return;
    freezePickerState = {
      action,
      burnId: currentId,
      validatedTargetId: null,
      validatedOwner: null,
      inFlight: false
    };

    const picker = $("freeze-picker");
    picker.replaceChildren();

    const heading = document.createElement("h3");
    heading.className = "freeze-picker-heading";
    heading.textContent = action === "thunder" ? "Thunder: pick a freeze target" : "Lightning: pick a freeze target";

    const note = document.createElement("p");
    note.className = "freeze-picker-note";
    const warning = document.createElement("span");
    warning.className = "freeze-picker-warning";
    warning.textContent = "THIS ACTION WILL BURN YOUR ABNORMIE. THIS IS IRREVERSIBLE.";
    note.append(
      warning,
      "To proceed, enter the Abnormie ID you want to freeze. It must exist, still be Active, and be owned by someone other than you."
    );

    const row = document.createElement("div");
    row.className = "freeze-picker-row";
    const label = document.createElement("label");
    label.setAttribute("for", "freeze-target-input");
    label.textContent = "Target Abnormie ID";
    const input = document.createElement("input");
    input.id = "freeze-target-input";
    input.type = "number";
    input.min = "1";
    input.max = "10000";
    input.step = "1";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    const validateBtn = document.createElement("button");
    validateBtn.id = "freeze-validate-btn";
    validateBtn.className = "btn btn-sm";
    validateBtn.textContent = "Validate target";
    row.append(label, input, validateBtn);

    const status = document.createElement("p");
    status.id = "freeze-status";
    status.className = "detail-action-status";
    status.hidden = true;

    const controls = document.createElement("div");
    controls.className = "freeze-picker-controls";
    const confirmBtn = document.createElement("button");
    confirmBtn.id = "freeze-confirm-btn";
    confirmBtn.className = "btn btn-sm btn-danger";
    confirmBtn.textContent = "Confirm and burn";
    confirmBtn.disabled = true;
    const cancelBtn = document.createElement("button");
    cancelBtn.id = "freeze-cancel-btn";
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Cancel";
    controls.append(confirmBtn, cancelBtn);

    picker.append(heading, note, row, status, controls);
    picker.hidden = false;

    validateBtn.addEventListener("click", onValidateFreezeTarget);
    confirmBtn.addEventListener("click", onConfirmBurn);
    cancelBtn.addEventListener("click", closeFreezePicker);
    input.addEventListener("input", () => {
      if (!freezePickerState) return;
      freezePickerState.validatedTargetId = null;
      freezePickerState.validatedOwner = null;
      confirmBtn.disabled = true;
    });
    input.focus();
  }

  function setFreezeStatus(kind, text) {
    const status = $("freeze-status");
    if (!status) return;
    status.className = `detail-action-status freeze-status-${kind}`;
    status.textContent = text;
    status.hidden = false;
  }

  async function onValidateFreezeTarget() {
    if (!freezePickerState) return;
    const input = $("freeze-target-input");
    const confirmBtn = $("freeze-confirm-btn");
    const validateBtn = $("freeze-validate-btn");
    confirmBtn.disabled = true;
    freezePickerState.validatedTargetId = null;
    freezePickerState.validatedOwner = null;

    const raw = (input.value || "").trim();
    if (!raw || !/^\d+$/.test(raw)) {
      setFreezeStatus("warn", "Enter a non-negative integer Abnormie ID.");
      return;
    }
    let targetId;
    try {
      targetId = BigInt(raw);
    } catch {
      setFreezeStatus("warn", "Invalid Abnormie ID.");
      return;
    }
    if (targetId < 0n || targetId > 9999n) {
      setFreezeStatus("warn", "Abnormie ID must be in [0, 9999].");
      return;
    }
    if (freezePickerState.burnId != null && targetId === freezePickerState.burnId) {
      setFreezeStatus("warn", "Target cannot be the Abnormie you are burning.");
      return;
    }

    validateBtn.disabled = true;
    setFreezeStatus("info", `Checking Abnormie #${targetId}…`);

    let targetOwner, targetState;
    try {
      [targetOwner, targetState] = await Promise.all([
        reader.read.ownerOf([targetId]),
        reader.read.getAbnormieState([targetId])
      ]);
    } catch (err) {
      validateBtn.disabled = false;
      setFreezeStatus(
        "warn",
        `Could not read Abnormie #${targetId}. It may not exist yet. ${describeError(err)}`
      );
      return;
    }
    validateBtn.disabled = false;

    if (!targetState || !targetState.paired) {
      setFreezeStatus("warn", `Abnormie #${targetId} is not yet resolved — it has no seed and cannot be frozen.`);
      return;
    }
    if (targetState.staticAt !== 0n) {
      setFreezeStatus(
        "warn",
        `Abnormie #${targetId} is already Static (frozen at block ${targetState.staticAt}). Pick an Active target.`
      );
      return;
    }
    if (account && targetOwner && targetOwner.toLowerCase() === account.toLowerCase()) {
      setFreezeStatus("warn", "You cannot freeze an Abnormie you own. Pick one owned by someone else.");
      return;
    }

    freezePickerState.validatedTargetId = targetId;
    freezePickerState.validatedOwner = targetOwner;
    confirmBtn.disabled = false;
    setFreezeStatus(
      "ok",
      `Target: Abnormie #${targetId}, owner ${shortAddr(targetOwner)}. Active. Ready to ${freezePickerState.action}.`
    );
  }

  async function onConfirmBurn() {
    if (!freezePickerState || freezePickerState.inFlight) return;
    if (freezePickerState.validatedTargetId == null) return;

    if (!account) {
      await connect();
      if (!account) return;
    }
    if (walletChainId != null && walletChainId !== expectedChainId) {
      showBanner(
        "warn",
        `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}) to ${freezePickerState.action}.`
      );
      return;
    }

    const { action, burnId, validatedTargetId: targetId } = freezePickerState;
    const ok = window.confirm(
      `This will permanently burn Abnormie #${burnId} and freeze Abnormie #${targetId}. This cannot be undone.`
    );
    if (!ok) return;

    const confirmBtn = $("freeze-confirm-btn");
    const cancelBtn = $("freeze-cancel-btn");
    const validateBtn = $("freeze-validate-btn");
    const input = $("freeze-target-input");
    freezePickerState.inFlight = true;
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    validateBtn.disabled = true;
    input.disabled = true;
    setFreezeStatus("info", `Submitting ${action}…`);

    let hash;
    try {
      hash = await walletClient.writeContract({
        address: contractAddress,
        abi,
        functionName: action,
        args: [burnId, targetId],
        account
      });
    } catch (err) {
      freezePickerState.inFlight = false;
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      validateBtn.disabled = false;
      input.disabled = false;
      setFreezeStatus("warn", `${action} failed: ${describeError(err)}`);
      return;
    }

    setFreezeStatus("info", `Tx ${hash} submitted. Waiting for confirmation…`);

    try {
      await publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      freezePickerState.inFlight = false;
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      validateBtn.disabled = false;
      input.disabled = false;
      setFreezeStatus("warn", `Confirmation failed: ${describeError(err)}`);
      return;
    }

    setFreezeStatus("ok", `${action} confirmed. Returning to ${cloudsLabel}…`);
    window.location.href = cfg.cloudsHref || "./clouds.html";
  }

  // Display-only relabel layer for the on-chain trait names. The renderer
  // contract is immutable so the strings in tokenURI / OpenSea metadata can't
  // change — this map gives the site a cleaner, more consistent vocabulary
  // without touching the contract. Order array drives the render order; any
  // on-chain trait not in the order is appended at the end (defensive in case
  // the renderer ever ships a new trait we haven't mapped yet).
  const TRAIT_LABELS = {
    "Mutability": "State",
    "Source Life": "Seed Life",
    "Source Customized": "Seed Customized",
    "Source Awakened": "Seed Awakened",
    "Inverted": "Aligned",
    "Cirrus Events": "Cirrus",
    "Thunder Events Received": "Thunder",
    "Lightning Events Received": "Lightning",
    "Visible Cirrus": "Cirrus Coverage",
    "Visible Altocumulus": "Altocumulus Coverage",
    "Visible Nimbostratus": "Nimbostratus Coverage"
    // "Total Coverage" and "Seed Normie" unchanged — omitted from this map.
  };
  const TRAIT_ORDER = [
    "Seed Normie",
    "Mutability",
    "Source Life",
    "Source Customized",
    "Source Awakened",
    "Inverted",
    "Cirrus Events",
    "Thunder Events Received",
    "Lightning Events Received",
    "Visible Cirrus",
    "Visible Altocumulus",
    "Visible Nimbostratus",
    "Total Coverage"
  ];

  function renderTraits(attributes) {
    if (!Array.isArray(attributes) || attributes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No traits in metadata.";
      $("traits").replaceChildren(empty);
      return;
    }

    // Index attributes by their on-chain key so we can pick them in our own order.
    const byKey = new Map();
    for (const attr of attributes) {
      const key = attr.trait_type ?? attr.traitType ?? "";
      if (key) byKey.set(key, attr);
    }

    const ordered = [];
    const consumed = new Set();
    for (const key of TRAIT_ORDER) {
      const attr = byKey.get(key);
      if (!attr) continue;
      // Seed Awakened renders only when the value is "Yes" (no row at all for "No").
      if (key === "Source Awakened" && String(attr.value) !== "Yes") {
        consumed.add(key);
        continue;
      }
      ordered.push(attr);
      consumed.add(key);
    }
    // Defensive tail: any trait the renderer emits that we haven't mapped yet.
    for (const [key, attr] of byKey) {
      if (!consumed.has(key)) ordered.push(attr);
    }

    const nodes = ordered.map((attr) => {
      const rawKey = attr.trait_type ?? attr.traitType ?? "—";
      const label = TRAIT_LABELS[rawKey] ?? rawKey;
      const value = attr.value != null ? String(attr.value) : "—";
      const row = document.createElement("div");
      row.className = "trait-row";
      const l = document.createElement("span");
      l.className = "trait-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "trait-value";
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      return row;
    });
    $("traits").replaceChildren(...nodes);
  }

  // Pre-reveal stand-in. tokenURI reverts because no token is minted yet (IDs and
  // seed pairings are assigned at reveal), so there is no real canvas, owner, or
  // traits to show. Render the Sky hero plus honest "assigned at reveal" copy in
  // place of the values, keeping the page chrome rather than dropping to an error.
  function renderUnrevealed(id) {
    hideBanner();
    // No canvas for an unrevealed token: tear down any animation, hide the view
    // controls, and force the Sky stand-in back into the static image slot.
    currentAnimState = null;
    teardownAnim();
    const vc = $("view-controls");
    if (vc) vc.hidden = true;
    const ac = $("anim-canvas");
    if (ac) ac.hidden = true;
    const hi = $("hero-img");
    if (hi) hi.hidden = false;
    $("title").textContent = `ABNORMIE #${id}`;
    $("subtitle").textContent = "Unrevealed — token ID and seed Normie are assigned at reveal.";

    const hero = $("hero-img");
    hero.src = SKY_PLACEHOLDER;
    hero.alt = `Unrevealed Abnormie #${id}`;

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "Unrevealed";
    $("chips").replaceChildren(chip);

    $("seed-img").hidden = true;
    const dt = document.createElement("dt");
    dt.textContent = "Status";
    const dd = document.createElement("dd");
    dd.textContent = "Seed Normie assigned at reveal";
    $("seed-info").replaceChildren(dt, dd);

    $("actions").replaceChildren();

    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "Traits appear after reveal.";
    $("traits").replaceChildren(note);

    $("error-state").hidden = true;
    $("content").hidden = false;
  }

  // -- actions -------------------------------------------------------------
  // "Update from Normies" — pre-checks state and fires only the writes that
  // would actually change something on-chain.
  //
  // pokeSeed (Abnormies.sol:551) writes when any of these hold (per _pokeSeed at
  // line 579):
  //   - Normies.ownerOf(normieId) reverts/returns zero AND !seedBurned    → mark burned
  //   - lastObservedSeedOwner == 0x0 (first observation)                  → set it
  //   - currentOwner != lastObservedSeedOwner                             → cirrus++ + update
  //   - NormiesCanvasStorage.isTransformed(normieId) && !seedCustomized   → set it
  //
  // pokeAwakening (line 565) is one-way: it reverts AlreadyAwakened() if
  // seedAwakened is already true. So we only consider it needed when there's a
  // non-zero agentId from the Normies API AND seedAwakened is false.
  // Indexed customization state for a seed, used by the Refresh staleness check.
  // Tries the Normies indexer (api.normies.art) first; on any failure falls back
  // to the on-chain NormiesCanvasStorage.isTransformed read. Returns a boolean or
  // null (null/false both read as "not yet customized" by the caller).
  async function readSeedCustomized(seedId) {
    const indexed = await fetchCanvasCustomized(seedId);
    if (indexed != null) return indexed;
    return canvasStorageReader.read.isTransformed([seedId]).catch(() => null);
  }

  async function onUpdateFromNormies(ev) {
    const btn = ev.currentTarget;
    const status = $("action-status");
    if (!account) {
      await connect();
      if (!account) return;
    }
    if (walletChainId != null && walletChainId !== expectedChainId) {
      showBanner(
        "warn",
        `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}) to update.`
      );
      return;
    }
    if (updateInFlight || currentSeedId == null) return;

    const original = btn.textContent;
    const seedId = currentSeedId;
    let keepDisabled = false; // set in the no-op branch so the finally block doesn't re-enable it
    updateInFlight = true;
    btn.disabled = true;
    btn.textContent = "Checking…";
    status.hidden = true;
    status.textContent = "";

    try {
      // Free pre-flight reads (parallel). All can fail individually; we map
      // failures to the relevant decision input rather than aborting.
      // Customization comes from the indexer first, falling back to the
      // NormiesCanvasStorage.isTransformed RPC read when the API is unavailable.
      const [ownerRes, transformedRes, seedState, binding] = await Promise.all([
        normiesReader.read.ownerOf([seedId]).catch(() => null),
        readSeedCustomized(seedId),
        reader.read.getSeedState([seedId]),
        fetchBinding(seedId)
      ]);

      const currentOwner = ownerRes; // address string, or null if ownerOf reverted
      const isTransformed = transformedRes === true; // null/false both treated as "not yet customized"
      const lastObserved = seedState[0]; // address — ZERO if never observed
      const seedCustomized = Boolean(seedState[2]);
      const seedBurned = Boolean(seedState[3]);
      const seedAwakened = Boolean(seedState[4]);
      const apiAgentId = binding && binding.agentId != null ? binding.agentId : 0n;

      // pokeSeed-needed branches
      const firstObservation =
        currentOwner != null && lastObserved === ZERO_ADDRESS;
      const ownerChanged =
        currentOwner != null &&
        lastObserved !== ZERO_ADDRESS &&
        getAddress(currentOwner) !== getAddress(lastObserved);
      const needsBurnedMark =
        (currentOwner == null || currentOwner === ZERO_ADDRESS) && !seedBurned;
      const needsCustomizedMark = isTransformed && !seedCustomized;
      const needsSeedPoke =
        firstObservation || ownerChanged || needsBurnedMark || needsCustomizedMark;

      // pokeAwakening-needed: only when not yet awakened AND the API surfaces a
      // non-zero agent binding. (Contract reverts AlreadyAwakened if we try
      // again on a seed that's already awakened, so we never re-poke.)
      const needsAwakeningPoke = apiAgentId !== 0n && !seedAwakened;

      if (!needsSeedPoke && !needsAwakeningPoke) {
        // Nothing to write — leave the button disabled and surface inline status
        // (no banner). keepDisabled tells the finally block to leave the
        // disabled state alone so the user can't keep clicking a no-op.
        status.textContent = "Already in sync with Normies.";
        status.hidden = false;
        keepDisabled = true;
        return;
      }

      if (needsSeedPoke) {
        btn.textContent = "Updating from Normies…";
        const hash = await walletClient.writeContract({
          address: contractAddress,
          abi,
          functionName: "pokeSeed",
          args: [seedId],
          account
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      if (needsAwakeningPoke) {
        btn.textContent = "Syncing awakening…";
        const hash = await walletClient.writeContract({
          address: contractAddress,
          abi,
          functionName: "pokeAwakening",
          args: [seedId, apiAgentId],
          account
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      showBanner("ok", "Update complete.");
      await loadAbnormie(currentId);
    } catch (err) {
      showBanner("error", `Update failed: ${describeError(err)}`);
    } finally {
      updateInFlight = false;
      btn.textContent = original;
      if (!keepDisabled) btn.disabled = false;
    }
  }

  // "View on OpenSea" — opens this Abnormie's OpenSea item page in a new tab.
  // Earlier versions tried to GET OpenSea's v2 refresh API directly via
  // window.open, which (a) used the wrong HTTP verb (refresh is POST only) and
  // (b) wouldn't have authenticated anyway (no X-API-KEY available client-side).
  // OpenSea's own "Refresh metadata" button on the item page is the reliable
  // path — it requires zero credentials and is one click from here.
  function onViewOnOpenSea() {
    const slug = OPENSEA_CHAIN_SLUG[expectedChainId] || "ethereum";
    const base = OPENSEA_BASE[expectedChainId] || OPENSEA_BASE[1];
    const url = `${base}/item/${slug}/${contractAddress}/${currentId}`;
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) {
      showBanner("warn", `Popup blocked. Open ${url} to refresh OpenSea metadata.`);
    }
  }

  function onDownloadSvg() {
    if (!currentImageField) {
      showBanner("error", "No image available to download.");
      return;
    }
    let svg;
    try {
      svg = extractSvgMarkup(currentImageField);
    } catch (err) {
      showBanner("error", `Could not extract SVG. ${describeError(err)}`);
      return;
    }
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `abnormie-${currentId}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  // -- Static / Animated view ----------------------------------------------
  // The detail page renders the on-chain SVG by default (Static). The Animated
  // view replays the Abnormie's history frame by frame on an 800x800 canvas
  // (a 20x upscale of the 40x40 art) using the parity-tested renderCanvas. The
  // loop plays the build forward to the final frame, then steps backwards
  // through the same frames to the blank start, then forward again (hard cuts,
  // no fade), plus a GIF export that captures the full forward+reverse cycle.

  // The global cascade log, fetched once and reused for the page lifetime.
  async function getCascades() {
    if (cascadeLogCache) return cascadeLogCache;
    const raw = await reader.read.getAllCascades();
    cascadeLogCache = raw.map((c) => ({
      blockNumber: BigInt(c.blockNumber),
      burnedTokenId: Number(c.burnedTokenId),
      freezeTargetTokenId: Number(c.freezeTargetTokenId),
      action: Number(c.action),
      thunderSize: Number(c.thunderSize)
    }));
    return cascadeLogCache;
  }

  const speedMs = () => SPEED_MS[currentSpeed] || SPEED_MS.medium;

  // Build the ordered frame list from the flat step list. Frame 0 is the blank
  // starting state; the remaining frames are cumulative renders. Past the frame
  // budget the build is batched so at most ~200 frames are produced, but the
  // final frame always shows the full state.
  function buildFrameSteps(steps) {
    const n = steps.length;
    const batchSize = n > FRAME_BUDGET ? Math.ceil(n / FRAME_BUDGET) : 1;
    const frames = [BLANK_STEP];
    for (let i = batchSize; i < n; i += batchSize) frames.push(steps[i - 1]);
    if (n > 0) {
      const last = steps[n - 1];
      if (frames[frames.length - 1] !== last) frames.push(last);
    }
    return { frames, batchSize };
  }

  // Paint a 1600-cell color grid onto an 800x800 context: fill a 40x40 ImageData
  // from the palette, then draw it scaled 20x with smoothing off (crisp pixels).
  function blit(targetCtx, grid) {
    const data = anim.imageData.data;
    for (let i = 0; i < 1600; i++) {
      const rgb = PALETTE[grid[i]] || PALETTE[0];
      const o = i * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
    anim.octx.putImageData(anim.imageData, 0, 0);
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.clearRect(0, 0, 800, 800);
    targetCtx.drawImage(anim.offscreen, 0, 0, 40, 40, 0, 0, 800, 800);
  }

  function renderFrameGrid(frameIndex) {
    return renderCanvas({ ...anim.state, cascadeLog: anim.cascadeLog, step: anim.frames[frameIndex] });
  }

  function paintFrame(frameIndex) {
    blit(anim.ctx, renderFrameGrid(frameIndex));
  }

  function drawLoading(ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = `#${COLOR_HEX[0]}`;
    ctx.fillRect(0, 0, 800, 800);
    ctx.fillStyle = `#${COLOR_HEX[3]}`;
    ctx.font = "48px ui-monospace, 'SF Mono', Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Loading…", 400, 400);
  }

  // Create the canvas (inside the hero, replacing the SVG image in place) and the
  // view toggle + animated controls (below the hero). Idempotent.
  function ensureAnimDom() {
    if ($("anim-canvas")) return;
    const hero = document.querySelector(".detail-hero");
    if (!hero) return;

    const canvas = document.createElement("canvas");
    canvas.id = "anim-canvas";
    canvas.width = 800;
    canvas.height = 800;
    canvas.className = "detail-anim-canvas";
    canvas.hidden = true;
    hero.appendChild(canvas);

    const controls = document.createElement("div");
    controls.id = "view-controls";
    controls.className = "detail-view-controls";
    controls.hidden = true;

    const toggle = document.createElement("div");
    toggle.className = "view-toggle";
    toggle.append(makeToggleBtn("static", "Static"), makeToggleBtn("animated", "Animated"));

    const ac = document.createElement("div");
    ac.id = "anim-controls";
    ac.className = "anim-controls";
    ac.hidden = true;

    const speedSel = document.createElement("select");
    speedSel.id = "anim-speed";
    speedSel.setAttribute("aria-label", "Animation speed");
    for (const s of ALLOWED_SPEEDS) {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s[0].toUpperCase() + s.slice(1);
      speedSel.append(o);
    }
    speedSel.value = currentSpeed;
    speedSel.addEventListener("change", () => setSpeed(speedSel.value));

    const playBtn = document.createElement("button");
    playBtn.id = "anim-play";
    playBtn.className = "btn btn-sm";
    playBtn.textContent = "Pause";
    playBtn.addEventListener("click", togglePlay);

    const restartBtn = document.createElement("button");
    restartBtn.id = "anim-restart";
    restartBtn.className = "btn btn-sm";
    restartBtn.textContent = "Restart";
    restartBtn.addEventListener("click", restartAnim);

    const gifBtn = document.createElement("button");
    gifBtn.id = "anim-gif";
    gifBtn.className = "btn btn-sm";
    gifBtn.textContent = "Download GIF";
    gifBtn.addEventListener("click", onDownloadGif);

    const batch = document.createElement("span");
    batch.id = "anim-batch";
    batch.className = "anim-batch";
    batch.hidden = true;

    ac.append(speedSel, playBtn, restartBtn, gifBtn, batch);
    controls.append(toggle, ac);
    hero.insertAdjacentElement("afterend", controls);
  }

  function makeToggleBtn(view, label) {
    const b = document.createElement("button");
    b.className = "btn btn-sm view-toggle-btn";
    b.dataset.view = view;
    b.textContent = label;
    b.addEventListener("click", () => setView(view));
    return b;
  }

  // Reflect the current view into the DOM: toggle active button, show/hide the
  // animated controls, and swap the canvas for the SVG image (or back).
  function reflectView() {
    const animated = currentView === "animated";
    const canvas = $("anim-canvas");
    const img = $("hero-img");
    const ac = $("anim-controls");
    document.querySelectorAll(".view-toggle-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === currentView);
    });
    if (ac) ac.hidden = !animated;
    if (canvas) canvas.hidden = !animated;
    if (img) img.hidden = animated;
  }

  function updateUrl() {
    const params = new URLSearchParams(window.location.search);
    if (currentId != null) params.set("id", currentId.toString());
    params.set("view", currentView);
    params.set("speed", currentSpeed);
    history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function setView(view) {
    if (!ALLOWED_VIEWS.includes(view)) view = "static";
    if (view === currentView) return;
    currentView = view;
    updateUrl();
    reflectView();
    if (view === "animated") startAnimated();
    else stopAnimated();
  }

  function setSpeed(speed) {
    if (!ALLOWED_SPEEDS.includes(speed)) return;
    currentSpeed = speed;
    const sel = $("anim-speed");
    if (sel && sel.value !== speed) sel.value = speed;
    updateUrl();
    // No cursor reset: the running loop reads speedMs() on its next tick.
  }

  function teardownAnim() {
    if (!anim) return;
    if (anim.timer) clearTimeout(anim.timer);
    if (anim.gif) {
      try {
        anim.gif.abort();
      } catch {
        /* ignore */
      }
    }
    anim = null;
  }

  function stopAnimated() {
    teardownAnim();
  }

  async function startAnimated() {
    teardownAnim();
    if (!currentAnimState) return;
    const canvas = $("anim-canvas");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    drawLoading(ctx);

    let cascadeLog;
    try {
      cascadeLog = await getCascades();
    } catch (err) {
      showBanner("error", `Could not load cascade history for the animation. ${describeError(err)}`);
      return;
    }
    // The user may have switched back to Static (or navigated) while awaiting.
    if (currentView !== "animated" || !currentAnimState) return;

    const state = currentAnimState;
    const steps = enumerateSteps({ ...state, cascadeLog });
    const { frames, batchSize } = buildFrameSteps(steps);

    const offscreen = document.createElement("canvas");
    offscreen.width = 40;
    offscreen.height = 40;
    const octx = offscreen.getContext("2d");

    anim = {
      canvas,
      ctx,
      offscreen,
      octx,
      imageData: octx.createImageData(40, 40),
      state,
      cascadeLog,
      frames,
      frameIndex: 0,
      direction: 1, // +1 forward (build), -1 reverse (unbuild)
      playing: true,
      timer: null,
      gif: null
    };

    const batch = $("anim-batch");
    if (batch) {
      batch.hidden = batchSize <= 1;
      batch.textContent = batchSize > 1 ? `${batchSize} events per frame` : "";
    }

    const playBtn = $("anim-play");
    if (playBtn) playBtn.textContent = "Pause";

    step();
  }

  // Paint the current frame, hold for one interval, then advance in the current
  // direction. Hard cut, no fade.
  function step() {
    if (!anim || !anim.playing) return;
    paintFrame(anim.frameIndex);
    anim.timer = setTimeout(() => {
      if (!anim || !anim.playing) return;
      advance();
      step();
    }, speedMs());
  }

  // Move one frame in the current direction, reversing at each end. The final
  // frame and frame 0 are each held for exactly one interval before the
  // direction flips, so neither is shown twice at the turn.
  function advance() {
    const last = anim.frames.length - 1;
    if (anim.direction > 0) {
      if (anim.frameIndex >= last) {
        anim.direction = -1;
        anim.frameIndex = last - 1;
      } else {
        anim.frameIndex += 1;
      }
    } else {
      if (anim.frameIndex <= 0) {
        anim.direction = 1;
        anim.frameIndex = 1;
      } else {
        anim.frameIndex -= 1;
      }
    }
    // Single-frame builds (zero-event Abnormies) have last == 0: clamp back so
    // the loop simply re-holds frame 0 each interval.
    if (anim.frameIndex < 0) anim.frameIndex = 0;
    if (anim.frameIndex > last) anim.frameIndex = last;
  }

  function togglePlay() {
    if (!anim) return;
    const btn = $("anim-play");
    if (anim.playing) {
      anim.playing = false;
      if (anim.timer) {
        clearTimeout(anim.timer);
        anim.timer = null;
      }
      if (btn) btn.textContent = "Play";
    } else {
      anim.playing = true;
      if (btn) btn.textContent = "Pause";
      step();
    }
  }

  function restartAnim() {
    if (!anim) return;
    if (anim.timer) {
      clearTimeout(anim.timer);
      anim.timer = null;
    }
    anim.frameIndex = 0;
    anim.direction = 1;
    anim.playing = true;
    const btn = $("anim-play");
    if (btn) btn.textContent = "Pause";
    step();
  }

  // Encode every build frame (frame 0 through final, no fade) to a looping GIF at
  // the current speed and download it. gif.js is dynamically imported so it never
  // loads in Node, and runs its workers off the main thread to keep the UI live.
  async function onDownloadGif() {
    if (!anim) return;
    const btn = $("anim-gif");
    const delay = speedMs();

    let GIF;
    try {
      ({ default: GIF } = await import("gif.js/dist/gif.js"));
    } catch (err) {
      showBanner("error", `Could not load the GIF encoder. ${describeError(err)}`);
      return;
    }
    if (!anim) return; // torn down while loading the encoder

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Encoding…";
    }

    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: 800,
      height: 800,
      repeat: 0,
      workerScript: cfg.gifWorkerUrl || "./gif.worker.js"
    });
    anim.gif = gif;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = 800;
    exportCanvas.height = 800;
    const ectx = exportCanvas.getContext("2d");
    const addGifFrame = (f) => {
      blit(ectx, renderFrameGrid(f));
      gif.addFrame(ectx, { copy: true, delay });
    };
    // Full loop: frame 0, forward build through the final frame, then reverse
    // back excluding the final frame and frame 0 (each appears exactly once, so
    // there is no duplicate at either seam). gif.js loops the result forever.
    const last = anim.frames.length - 1;
    for (let f = 0; f <= last; f++) addGifFrame(f);
    for (let f = last - 1; f >= 1; f--) addGifFrame(f);

    const reset = () => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Download GIF";
      }
      if (anim) anim.gif = null;
    };

    const tokenId = currentId;
    gif.on("finished", (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `abnormie-${tokenId}.gif`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      reset();
    });
    gif.on("abort", reset);
    gif.render();
  }

  // -- init ----------------------------------------------------------------
  async function init() {
    renderWallet();
    $("wallet-address").addEventListener("click", connect);
    // Back link returns to the Clouds page. Path comes from the runtime config
    // (cfg.cloudsHref) so the same bundle serves both the /app/ build and the
    // reorganized site; falls back to the sibling clouds.html when unset.
    $("back-link").setAttribute("href", cfg.cloudsHref || "./clouds.html");

    if (!contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      showError("No contract address configured. Set FRONTEND_CONTRACT_ADDRESS and rebuild.");
      return;
    }

    try {
      const [a1, a2] = await Promise.all([
        fetch("./abi/Abnormies.json").then((r) => r.json()),
        fetch("./abi/Normies.json").then((r) => r.json())
      ]);
      abi = a1.abi;
      normiesAbi = a2.abi;
    } catch {
      showError("Failed to load contract ABIs.");
      return;
    }

    publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl || undefined) });
    reader = getContract({ address: contractAddress, abi, client: publicClient });

    try {
      normiesAddress = getAddress(await reader.read.NORMIES());
      normiesReader = getContract({ address: normiesAddress, abi: normiesAbi, client: publicClient });
      const canvasStorageAddress = getAddress(await reader.read.NORMIES_CANVAS_STORAGE());
      canvasStorageReader = getContract({
        address: canvasStorageAddress,
        abi: CANVAS_STORAGE_ABI,
        client: publicClient
      });
    } catch (err) {
      showError(`Failed to resolve the Normies contract address. ${describeError(err)}`);
      return;
    }

    // Silent reconnect if the wallet already authorized this site.
    if (window.ethereum) {
      try {
        const accs = await window.ethereum.request({ method: "eth_accounts" });
        if (accs && accs.length) await setupWallet(accs[0]);
      } catch {
        /* ignore */
      }
    }

    const params = new URLSearchParams(window.location.search);
    const rawView = params.get("view");
    if (ALLOWED_VIEWS.includes(rawView)) currentView = rawView;
    const rawSpeed = params.get("speed");
    if (ALLOWED_SPEEDS.includes(rawSpeed)) currentSpeed = rawSpeed;

    const raw = params.get("id");
    if (raw == null || raw.trim() === "" || !/^\d+$/.test(raw.trim())) {
      showError("Provide an Abnormie id, e.g. abnormie.html?id=234");
      return;
    }
    await loadAbnormie(BigInt(raw.trim()));
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => showError(e.message || String(e)));
  });
  // Stop the animation timer and abort any in-flight gif.js encoder when the page
  // is hidden or unloaded, so nothing keeps running in the background.
  window.addEventListener("pagehide", teardownAnim);
}
