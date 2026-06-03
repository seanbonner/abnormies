// Abnormies post-reveal detail page.
//
// Renders a single revealed Abnormie (?id={n}) alongside its seed Normie.
// Read paths are fully wired against the deployed Abnormies contract (state,
// metadata, ownership) plus the Normies contract (image + owner), the Normies
// canvas storage (customization), and the Normies API (agent binding). The
// "Update from Normies" action pre-checks state and fires pokeSeed and/or
// pokeAwakening only when each would actually change state on-chain — never
// a no-op write. Thunder, Lightning, and Download GIF remain "Coming soon"
// pending the next prompt. Function names are taken from the deployed ABI.
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
    const [normieImg, ownerNormie] = await Promise.all([
      normiesReader.read.tokenURI([seedId]).then(parseTokenURI).then((m) => m.image).catch(() => null),
      normiesReader.read.ownerOf([seedId]).then((o) => getAddress(o)).catch(() => null)
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
    renderSeedPanel({ seedId, ownerNormie, burned: seed.burned, customized: seed.customized, awakened, agentId, normieImg });
    renderActions({ seedDead: seed.burned, seedCustomized: seed.customized, isActive: !isStatic, ownsAbnormie });
    renderTraits(metadata.attributes || []);

    $("error-state").hidden = true;
    $("content").hidden = false;
  }

  // api.normies.art shape (as of 2026-06-03):
  //   { "binding": { "agentId": "32512", "tokenId": "994", ... } }
  // agentId is a NESTED, CAMEL-CASE, STRING field. Earlier readers looked for a
  // top-level snake-case `agent_id`, which silently always evaluated to null,
  // making `apiAgentId` always 0n and `needsAwakeningPoke` always false even
  // for seeds that ARE bound upstream. Normalised return shape: { agentId: BigInt }
  // or null. Callers use only `binding.agentId` from this point forward.
  async function fetchBinding(seedId) {
    try {
      const res = await fetch(`https://api.normies.art/agents/binding/${seedId}`);
      if (!res.ok) return null;
      const j = await res.json();
      const raw = j && typeof j === "object" ? j.binding?.agentId : null;
      if (raw == null || raw === "") return null;
      try {
        return { agentId: BigInt(raw) };
      } catch {
        return null;
      }
    } catch {
      return null; // network/CORS failure -> treat as no binding
    }
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

  function renderSeedPanel({ seedId, ownerNormie, burned, customized, awakened, agentId, normieImg }) {
    const img = $("seed-img");
    if (normieImg) {
      img.src = normieImg;
      img.hidden = false;
    } else {
      img.hidden = true;
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

    const rows = [
      ["Normie ID", `#${seedId}`],
      ["Owner", ownerText],
      ["Customized", customized ? "Yes" : "No"],
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
    const comingSoon = () => alert("Coming soon");
    // Thunder/Lightning require the Abnormie to be Active: Static Abnormies are
    // frozen and cannot be burned (staticAt == 0 -> isActive).
    // "Update from Normies" covers BOTH pokeSeed and pokeAwakening — it
    // pre-checks state and fires only the writes that actually do something.
    const defs = [
      { label: "Refresh from seed", visible: true, onClick: onUpdateFromNormies },
      { label: "View on OpenSea", visible: true, onClick: onViewOnOpenSea },
      { label: "Download SVG", visible: true, onClick: onDownloadSvg },
      { label: "Download GIF", visible: true, onClick: comingSoon },
      { label: "Thunder", visible: ownsAbnormie && seedDead && isActive, danger: true, onClick: comingSoon },
      {
        label: "Lightning",
        visible: ownsAbnormie && !seedDead && seedCustomized && isActive,
        danger: true,
        onClick: comingSoon
      }
    ];

    const nodes = [];
    for (const d of defs) {
      if (!d.visible) continue;
      const btn = document.createElement("button");
      btn.className = `btn btn-sm${d.danger ? " btn-danger" : ""}`;
      btn.textContent = d.label;
      btn.addEventListener("click", d.onClick);
      nodes.push(btn);
    }
    $("actions").replaceChildren(...nodes);
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
      const [ownerRes, transformedRes, seedState, binding] = await Promise.all([
        normiesReader.read.ownerOf([seedId]).catch(() => null),
        canvasStorageReader.read.isTransformed([seedId]).catch(() => null),
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

  // -- init ----------------------------------------------------------------
  async function init() {
    renderWallet();
    $("wallet-address").addEventListener("click", connect);
    // Back link returns to the Clouds page (sibling under /app/).
    $("back-link").setAttribute("href", "./clouds.html");

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

    const raw = new URLSearchParams(window.location.search).get("id");
    if (raw == null || raw.trim() === "" || !/^\d+$/.test(raw.trim())) {
      showError("Provide an Abnormie id, e.g. abnormie.html?id=234");
      return;
    }
    await loadAbnormie(BigInt(raw.trim()));
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => showError(e.message || String(e)));
  });
}
