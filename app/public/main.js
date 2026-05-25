// Abnormies Phase 1 app — read paths wired, write paths stubbed.
//
// Reads contract state with viem (public client over the configured RPC) and
// the connected wallet's eligible Normies (from prebuilt proof shards) and
// receipts. Claim and mint are intentionally STUBBED; see onClaimClick /
// onMintClick. All function names below were taken from the deployed ABI.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
  parseEther,
  isAddress,
  getAddress,
  getContract
} from "viem";
import { mainnet, sepolia } from "viem/chains";

const cfg = window.ABNORMIES_CONFIG || {};
const CHAINS = { 1: mainnet, 11155111: sepolia };
const CHAIN_NAMES = { 1: "Ethereum Mainnet", 11155111: "Sepolia" };

const expectedChainId = Number(cfg.chainId || 1);
const chain = CHAINS[expectedChainId] || sepolia;
const contractAddress = cfg.contractAddress;

let abi = null;
let publicClient = null;
let reader = null; // getContract bound to the public client
let walletClient = null;
let account = null;
let walletChainId = null;
let listenersAttached = false;

let currentPhase = null;
let mintPrice = 0n;
let maxPerCall = 50n;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
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
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  $("expected-chain").textContent = `${CHAIN_NAMES[expectedChainId] || `chain ${expectedChainId}`} (${expectedChainId})`;
  $("connect-btn").addEventListener("click", connect);
  $("refresh-btn").addEventListener("click", refreshAll);
  $("mint-count").addEventListener("input", updateMintTotal);
  $("mint-btn").addEventListener("click", onMintClick);

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

  // Silent reconnect if the wallet already authorized this site.
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

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function connect() {
  if (!window.ethereum) {
    showBanner("error", "No injected wallet found. Install a browser wallet to claim.");
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
  if (account) {
    $("wallet-address").textContent = short(account);
    $("wallet-chain").textContent = walletChainId != null ? `chain ${walletChainId}` : "";
  } else {
    $("wallet-address").textContent = "Not connected";
    $("wallet-chain").textContent = "";
  }
  if (account && walletChainId != null && walletChainId !== expectedChainId) {
    showBanner(
      "warn",
      `Wrong network. Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------
async function refreshAll() {
  renderWalletBar();
  try {
    await refreshPhaseAndSupply();
  } catch (e) {
    showBanner("error", `Failed to read contract state: ${e.shortMessage || e.message || e}`);
    return;
  }

  if (account) {
    await Promise.allSettled([loadEligible(), loadReceipts()]);
  } else {
    $("receipts-section").hidden = true;
    $("claim-empty").hidden = true;
    $("claim-list").innerHTML =
      currentPhase === 0 ? "<div class='note'>Connect your wallet to check Phase 1 eligibility.</div>" : "";
  }
}

// Phase: derived from phase() + isSealed() + revealed().
//   0                         -> "Phase 1: claims open"
//   1 && !sealed              -> "Phase 2: mint open"
//   1 && sealed (unrevealed)  -> "Reveal pending"
//   2 (revealed)              -> "Revealed"
async function refreshPhaseAndSupply() {
  const [phase, sealed, revealed, receiptsLen, maxSupply] = await Promise.all([
    reader.read.phase(),
    reader.read.isSealed(),
    reader.read.revealed(),
    reader.read.receiptsLength(),
    reader.read.MAX_SUPPLY()
  ]);

  currentPhase = Number(phase);
  let label;
  if (currentPhase === 0) label = "Phase 1: claims open";
  else if (currentPhase === 1 && !sealed) label = "Phase 2: mint open";
  else if (currentPhase === 1 && sealed) label = "Reveal pending";
  else label = "Revealed";
  $("phase-label").textContent = label;

  // Remaining supply framed as a countdown: total cap minus receipts created
  // so far (claims in Phase 1; claims + mints + airdrops once Phase 2 opens).
  const remaining = maxSupply - receiptsLen;
  $("progress-counter").textContent = `${remaining.toString()} of ${maxSupply.toString()} remaining`;

  $("claim-section").hidden = currentPhase !== 0;
  $("mint-section").hidden = !(currentPhase === 1 && !sealed);

  if (currentPhase === 1 && !sealed) await prepareMint();
}

// ---------------------------------------------------------------------------
// Mint (Phase 2)
// ---------------------------------------------------------------------------
async function prepareMint() {
  try {
    const [price, cap] = await Promise.all([reader.read.MINT_PRICE(), reader.read.PHASE2_MAX_PER_CALL()]);
    mintPrice = price;
    maxPerCall = cap;
    $("mint-count").max = Number(cap);
  } catch {
    /* keep defaults */
  }
  updateMintTotal();
}

function clampedCount() {
  const raw = Number($("mint-count").value || 1);
  return Math.max(1, Math.min(raw, Number(maxPerCall)));
}

function updateMintTotal() {
  const total = mintPrice * BigInt(clampedCount());
  $("mint-total").textContent = `${formatEther(total)} ETH`;
}

function onMintClick() {
  const count = clampedCount();
  const value = mintPrice * BigInt(count);
  // STUB: write path not wired yet.
  // TODO(write): await walletClient.writeContract({
  //   address: contractAddress, abi, functionName: "mintPhase2",
  //   args: [BigInt(count)], value,
  // });  // value must equal count * MINT_PRICE (no refunds)
  console.log("[STUB] mintPhase2 payload:", {
    functionName: "mintPhase2",
    count,
    value: value.toString(),
    valueEth: formatEther(value)
  });
  showBanner("ok", `Mint stubbed for ${count} (${formatEther(value)} ETH). Params logged to console; write path not wired yet.`);
}

// ---------------------------------------------------------------------------
// Eligible Normies (Phase 1)
// ---------------------------------------------------------------------------
async function loadEligible() {
  if (currentPhase !== 0) {
    $("claim-list").innerHTML = "";
    return;
  }
  const list = $("claim-list");
  const empty = $("claim-empty");
  list.innerHTML = "<div class='loading'>Loading eligible Normies…</div>";
  empty.hidden = true;

  let shard = null;
  try {
    const res = await fetch(`./proofs/owner/${account.toLowerCase()}.json`);
    if (res.status === 404) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    shard = await res.json();
  } catch {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }

  if (!Array.isArray(shard) || shard.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }

  // Already-claimed status per Normie (claimed(normieId)).
  let claimedFlags;
  try {
    const results = await publicClient.multicall({
      contracts: shard.map((s) => ({
        address: contractAddress,
        abi,
        functionName: "claimed",
        args: [BigInt(s.normieId)]
      }))
    });
    claimedFlags = results.map((r) => (r.status === "success" ? Boolean(r.result) : false));
  } catch {
    claimedFlags = await Promise.all(
      shard.map((s) => reader.read.claimed([BigInt(s.normieId)]).catch(() => false))
    );
  }

  list.innerHTML = "";
  shard.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "claim-row";
    row.innerHTML = `<span class="normie-id">Normie #${s.normieId}</span>
      <span class="badge">${s.customizedAtSnapshot ? "Customized" : "Uncustomized"}</span>`;
    const btn = document.createElement("button");
    if (claimedFlags[i]) {
      btn.className = "btn btn-disabled btn-sm";
      btn.textContent = "Claimed";
      btn.disabled = true;
    } else {
      btn.className = "btn btn-primary btn-sm";
      btn.textContent = "Claim";
      btn.addEventListener("click", () => onClaimClick(s));
    }
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function onClaimClick(leaf) {
  // STUB: write path not wired yet.
  // claim() takes parallel arrays; here we claim a single leaf.
  // TODO(write): await walletClient.writeContract({
  //   address: contractAddress, abi, functionName: "claim",
  //   args: [[BigInt(leaf.normieId)], [leaf.customizedAtSnapshot], [leaf.proof]],
  // });  // caller must equal ownerAtSnapshot on every leaf
  const payload = {
    functionName: "claim",
    normieIds: [leaf.normieId],
    customizedFlags: [leaf.customizedAtSnapshot],
    proofs: [leaf.proof]
  };
  console.log("[STUB] claim payload:", payload);
  showBanner("ok", `Claim stubbed for Normie #${leaf.normieId}. Proof logged to console; write path not wired yet.`);
}

// ---------------------------------------------------------------------------
// Receipts (connected wallet)
// ---------------------------------------------------------------------------
// No per-owner receipt index exists on-chain, so we scan receiptsLength() and
// filter receiptAt(i) by claimant. Batched via multicall (Multicall3).
async function loadReceipts() {
  const section = $("receipts-section");
  const listEl = $("receipts-list");
  const empty = $("receipts-empty");
  section.hidden = false;
  listEl.innerHTML = "<div class='loading'>Loading receipts…</div>";
  empty.hidden = true;

  let len = 0;
  try {
    len = Number(await reader.read.receiptsLength());
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not read receipts.";
    return;
  }

  if (len === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No receipts yet.";
    return;
  }

  const mine = [];
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

    results.forEach((r, k) => {
      if (r.status !== "success") return;
      // Receipt: (claimant, normieId, fromPhase1, snapshotCustomized, resolved, abnormieId)
      const [claimant, , fromPhase1, , resolved, abnormieId] = r.result;
      if (claimant.toLowerCase() === account.toLowerCase()) {
        mine.push({ index: start + k, fromPhase1, resolved, abnormieId: Number(abnormieId) });
      }
    });
  }

  if (mine.length === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No receipts for this wallet.";
    return;
  }

  listEl.innerHTML = "";
  mine.forEach((m) => {
    const row = document.createElement("div");
    row.className = "receipt-row";
    const status = m.resolved ? `Revealed → Abnormie #${m.abnormieId}` : "Unrevealed";
    row.innerHTML = `<span class="receipt-id">Receipt #${m.index}</span>
      <span class="badge">${m.fromPhase1 ? "Phase 1" : "Phase 2"}</span>
      <span class="receipt-status">${status}</span>`;
    listEl.appendChild(row);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showBanner("error", e.message || String(e)));
});
