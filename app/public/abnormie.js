// Abnormies post-reveal detail page.
//
// Renders a single revealed Abnormie (?id={n}) alongside its seed Normie.
// Read paths are fully wired against the deployed Abnormies contract (state,
// metadata, ownership) plus the Normies contract (image + owner) and the
// Normies API (agent binding). The one wired write is Refresh -> pokeSeed,
// which is permissionless and non-destructive. Thunder, Lightning, Update
// Awakening, and Download GIF are gated/rendered but stubbed ("Coming soon")
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
  const chain = CHAINS[expectedChainId] || sepolia;
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

  let abi = null;
  let normiesAbi = null;
  let publicClient = null;
  let reader = null;
  let normiesReader = null;
  let normiesAddress = null;

  let walletClient = null;
  let account = null;
  let walletChainId = null;
  let listenersAttached = false;

  let currentId = null; // BigInt
  let currentSeedId = null; // BigInt
  let currentImageField = null; // data URI for SVG download
  let refreshInFlight = false;

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
    const agentId = binding?.agent_id != null ? binding.agent_id : awakened ? seed.boundAgent : null;
    const apiBinding = binding != null && binding.agent_id != null;

    currentImageField = metadata.image || null;

    // 7. Render.
    $("title").textContent = `ABNORMIE #${id}`;
    $("subtitle").textContent = `Paired with Normie #${seedId}`;
    const hero = $("hero-img");
    hero.src = metadata.image || "";
    hero.alt = `Abnormie #${id}`;

    renderChips({ isStatic, chipDead, chipCustomized, aligned });
    renderSeedPanel({ seedId, ownerNormie, customized: seed.customized, awakened, agentId, normieImg });
    renderActions({ seedDead: seed.burned, seedCustomized: seed.customized, isActive: !isStatic, ownsAbnormie, awakened, apiBinding });
    renderTraits(metadata.attributes || []);

    $("error-state").hidden = true;
    $("content").hidden = false;
  }

  async function fetchBinding(seedId) {
    try {
      const res = await fetch(`https://api.normies.art/agents/binding/${seedId}`);
      if (!res.ok) return null;
      const j = await res.json();
      return j && typeof j === "object" ? j : null;
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

  function renderSeedPanel({ seedId, ownerNormie, customized, awakened, agentId, normieImg }) {
    const img = $("seed-img");
    if (normieImg) {
      img.src = normieImg;
      img.hidden = false;
    } else {
      img.hidden = true;
    }

    const awakenedText =
      awakened && agentId != null ? `Agent #${agentId}` : awakened ? "Yes" : "No";
    const ownerText = ownerNormie ? shortAddr(ownerNormie) : "— (burned?)";
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
    link.textContent = "View on OpenSea →";
    nodes.push(link);
    $("seed-info").replaceChildren(...nodes);
  }

  function renderActions({ seedDead, seedCustomized, isActive, ownsAbnormie, awakened, apiBinding }) {
    const comingSoon = () => alert("Coming soon");
    // Thunder/Lightning require the Abnormie to be Active: Static Abnormies are
    // frozen and cannot be burned (staticAt == 0 -> isActive).
    const defs = [
      { label: "Refresh", visible: true, onClick: onRefresh },
      { label: "Refresh OS", visible: true, onClick: onRefreshOS },
      { label: "Download SVG", visible: true, onClick: onDownloadSvg },
      { label: "Download GIF", visible: true, onClick: comingSoon },
      { label: "Thunder", visible: ownsAbnormie && seedDead && isActive, danger: true, onClick: comingSoon },
      {
        label: "Lightning",
        visible: ownsAbnormie && !seedDead && seedCustomized && isActive,
        danger: true,
        onClick: comingSoon
      },
      { label: "Update Awakening", visible: !awakened && apiBinding, onClick: comingSoon }
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

  function renderTraits(attributes) {
    if (!Array.isArray(attributes) || attributes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No traits in metadata.";
      $("traits").replaceChildren(empty);
      return;
    }
    const nodes = attributes.map((attr) => {
      const label = attr.trait_type ?? attr.traitType ?? "—";
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
  // Refresh: wired, real. pokeSeed is permissionless and gas-only.
  async function onRefresh(ev) {
    const btn = ev.currentTarget;
    if (!account) {
      await connect();
      if (!account) return;
    }
    if (walletChainId != null && walletChainId !== expectedChainId) {
      showBanner(
        "warn",
        `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}) to refresh.`
      );
      return;
    }
    if (refreshInFlight || currentSeedId == null) return;

    const original = btn.textContent;
    refreshInFlight = true;
    btn.disabled = true;
    btn.textContent = "Confirm in wallet…";
    try {
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi,
        functionName: "pokeSeed",
        args: [currentSeedId],
        account
      });
      btn.textContent = "Waiting…";
      await publicClient.waitForTransactionReceipt({ hash });
      showBanner("ok", `Refreshed Normie #${currentSeedId} state on-chain.`);
      await loadAbnormie(currentId);
    } catch (err) {
      showBanner("error", `Refresh failed. ${describeError(err)}`);
      btn.textContent = original;
      btn.disabled = false;
    } finally {
      refreshInFlight = false;
    }
  }

  // Refresh OS: opens OpenSea's metadata-refresh endpoint in a new tab. The URL
  // shape is per the prompt; it is acknowledged as approximate and likely needs
  // to become the marketplace item URL or an authenticated API call. See report.
  function onRefreshOS() {
    const slug = OPENSEA_CHAIN_SLUG[expectedChainId] || "ethereum";
    const url = `https://api.opensea.io/api/v2/chain/${slug}/contract/${contractAddress}/nfts/${currentId}/refresh`;
    window.open(url, "_blank", "noopener");
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
    // Portfolio page is the next prompt; stub the back link for now.
    $("back-link").setAttribute("href", "./portfolio.html");

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
