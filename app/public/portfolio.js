// Abnormies portfolio page — shows the connected wallet's holdings and
// nothing else (no claim, mint, seal, or reveal UI). Reuses the same receipts-
// loading shape as main.js but lives in its own file so this page stays
// scoped to portfolio rendering.

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
  if (resolved) cell.href = `/app/abnormie.html?id=${abnormieId}`;
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
// Init / wallet
// ---------------------------------------------------------------------------
async function init() {
  $("connect-btn").addEventListener("click", connect);
  $("refresh-btn").addEventListener("click", refreshAll);

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
    showBanner("error", "No injected wallet found. Install a browser wallet to view your portfolio.");
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
    } else {
      account = getAddress(accs[0]);
      walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
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
  await loadReceipts();
}

// ---------------------------------------------------------------------------
// Receipts — scan all receipts for the connected wallet, render the grid.
// Same logic as main.js loadReceipts but without the delegate-vault path
// (portfolio is purely "what does THIS wallet hold").
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

  let len = 0;
  try {
    len = Number(await reader.read.receiptsLength());
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not load Abnormies.";
    return;
  }

  if (len === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    return;
  }

  const targetLower = account.toLowerCase();
  const owned = []; // { resolved, abnormieId } in queue order
  const CHUNK = 400;
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(start + CHUNK, len);
    const contracts = [];
    for (let i = start; i < end; i++) {
      contracts.push({ address: contractAddress, abi, functionName: "receiptAt", args: [BigInt(i)] });
    }
    let results;
    try {
      results = await publicClient.multicall({ contracts });
    } catch {
      results = [];
      for (let i = start; i < end; i++) {
        try {
          results.push({ status: "success", result: await reader.read.receiptAt([BigInt(i)]) });
        } catch {
          results.push({ status: "failure" });
        }
      }
    }
    results.forEach((r) => {
      if (r.status !== "success") return;
      // Receipt tuple: (claimant, normieId, fromPhase1, snapshotCustomized, resolved, abnormieId)
      if (r.result[0].toLowerCase() !== targetLower) return;
      owned.push({ resolved: Boolean(r.result[4]), abnormieId: Number(r.result[5]) });
    });
  }

  if (owned.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
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
    listEl.appendChild(makeReceiptCell({ resolved: o.resolved, abnormieId: o.abnormieId, image: images[o.abnormieId] }));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showBanner("error", e.message || String(e)));
});
